// Column cells (WebGPU): near the camera every occupied L0 cell is its own column, a coin
// stack by default (geo.columnShape 'cylinder'), an oval cylinder that fills the cell, or a
// box. index.js decides the disc that gets columns (cells at least geo.columnPixels wide on
// screen, around the camera); the heightfield hides itself inside the disc and draws the rest.
//
// A compute pass scans the resident L0 tiles in range, appends occupied cells with an atomic
// counter and writes the indirect draw arguments; the vertex stage reads heights live from
// the atlas, so playback needs no CPU work. Columns come in two levels of detail drawn from
// one instance buffer: cells wider than NEAR_PX on screen use geo.cylinderSides, smaller ones
// a 4-sided prism with the circle's area (near list from the start of the buffer, far list
// from the end). When the occupied cells exceed geo.instanceBudget, the disc shrinks
// (measured by an asynchronous read of the counter) so the heightfield never shows holes.
import {
  Group, InstancedBufferGeometry, BufferAttribute, Mesh, StorageBufferAttribute, IndirectStorageBufferAttribute,
  Vector2,
} from 'three/webgpu';
import {
  Fn, uniform, int, uint, float, vec3, vec4, uvec2, storage, instanceIndex, atomicAdd, atomicLoad,
  Loop, If, max, mix, abs, fract, smoothstep, select, normalize, length, round, positionGeometry, positionWorld,
  varying, normalView, transformNormalToView, fwidth, dFdx, dFdy,
} from 'three/tsl';
import { tileInfo, SLOT, SLOT_CELLS } from '../../data/grid.js';
import { TerrainNodeMaterial } from './heightfield.js';

export const MAX_COLUMN_TILES = 512;
export const COLUMN_SHAPES = Object.freeze(['cylinder', 'oval', 'box']);
/**
 * Cells at least this many pixels wide get the full cylinder; smaller ones a 4-sided stack
 * of the same footprint, still shaded round (radial normals), whose square outline does not
 * show at that size.
 */
export const NEAR_PX = 20;
export const FAR_SIDES = 4;
/**
 * Spend flashes light the top of a stack: the cap and the top HEAT_TOP of the side at full
 * strength, fading to HEAT_SIDE further down. Whole glowing columns made busy areas near the
 * creation edge look like a bright haze.
 */
export const HEAT_TOP = 0.25;
export const HEAT_SIDE = 0.3;
const COL_W = 0.064;
const ROW_D = 0.1;

function boxGeometry() {
  // Unit box x, z in [0, 1], y in [0, 1] without the bottom face: 8 shared corners and
  // 10 outward triangles; normals come from screen-space derivatives (flat shading), so
  // each column costs 8 vertex invocations instead of 20.
  const pos = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, // v0..v3 (z = 0)
    0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, // v4..v7 (z = 1)
  ]);
  const index = new Uint32Array([
    2, 6, 7, 2, 7, 3, // +y
    0, 2, 3, 0, 3, 1, // -z
    4, 5, 7, 4, 7, 6, // +z
    0, 4, 6, 0, 6, 2, // -x
    1, 3, 7, 1, 7, 5, // +x
  ]);
  const out = new InstancedBufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setIndex(new BufferAttribute(index, 1));
  out.userData = { shape: 'box', sides: 4, triangles: index.length / 3, vertices: pos.length / 3 };
  return out;
}

/**
 * Unit cylinder without a bottom: x, z in [0, 1] (radius 0.5 around 0.5, 0.5), y in [0, 1].
 * Two rings and the cap centre, 2 * sides + 1 vertices and 3 * sides triangles. No normals:
 * the fragment stage derives them (flat for the cap, radial for the sides), so the side and
 * cap faces share the top ring and each column costs fewer vertex invocations.
 */
export function cylinderGeometry(sides = 12) {
  const S = Math.max(3, Math.round(sides));
  const V = 2 * S + 1;
  const pos = new Float32Array(V * 3);
  const put = (i, x, y, z) => pos.set([x, y, z], i * 3);
  for (let i = 0; i < S; i++) {
    const a = (2 * Math.PI * i) / S;
    // Four sides: an axis-aligned square (corners at 45 degrees) with the circle's area.
    const a0 = S === 4 ? a + Math.PI / 4 : a;
    const r = S === 4 ? 0.5 * Math.sqrt(Math.PI / 2) : 0.5;
    const x = 0.5 + r * Math.cos(a0);
    const z = 0.5 + r * Math.sin(a0);
    put(i, x, 0, z); // bottom ring
    put(S + i, x, 1, z); // top ring
  }
  put(2 * S, 0.5, 1, 0.5); // cap centre
  const index = new Uint32Array(9 * S);
  let k = 0;
  for (let i = 0; i < S; i++) {
    const j = (i + 1) % S;
    // Counter-clockwise seen from outside (outward normals).
    index[k++] = i; index[k++] = S + i; index[k++] = S + j;
    index[k++] = i; index[k++] = S + j; index[k++] = j;
    index[k++] = 2 * S; index[k++] = S + j; index[k++] = S + i;
  }
  const out = new InstancedBufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setIndex(new BufferAttribute(index, 1));
  out.userData = { shape: 'cylinder', sides: S, triangles: index.length / 3, vertices: V };
  return out;
}

export function columnGeometry(shape = 'cylinder', sides = 12) {
  return shape === 'box' ? boxGeometry() : cylinderGeometry(sides);
}

/** Sides of the near and far levels of detail for a shape and the geo.cylinderSides setting. */
export function columnLevels(shape, sides) {
  if (shape === 'box') return { near: 4, far: 4 };
  const S = Math.max(3, Math.round(sides));
  return { near: S, far: Math.min(S, FAR_SIDES) };
}

export function createColumns({ renderer, atlas, shading, grid, maxBudget = 8000000 }) {
  const U = shading.uniforms;
  const budgetCap = Math.max(1, maxBudget | 0);
  const tilesAttr = new StorageBufferAttribute(new Float32Array(MAX_COLUMN_TILES * 4), 4);
  const counterAttr = new StorageBufferAttribute(new Uint32Array(3), 1); // total, near, far
  const instAttr = new StorageBufferAttribute(new Uint32Array(budgetCap * 2), 2);

  const uFocus = uniform(new Vector2());
  const uR2 = uniform(0);
  const uNear2 = uniform(0);
  const uBudget = uniform(0, 'uint');
  const uGap = uniform(0.12);
  const uEdges = uniform(0.4); // coin edge strength
  const uThickness = uniform(0.15); // coin thickness, as a fraction of the coin diameter

  const tilesNode = storage(tilesAttr, 'vec4', MAX_COLUMN_TILES).toReadOnly();
  const counterAtomic = storage(counterAttr, 'uint', 3).toAtomic();
  const instWrite = storage(instAttr, 'uvec2', budgetCap);
  const instRead = storage(instAttr, 'uvec2', budgetCap).toReadOnly();

  // One level of detail: its own geometry, indirect arguments and mesh.
  function makeLevel(name, first) {
    const geometry = columnGeometry('cylinder', first);
    const args = new IndirectStorageBufferAttribute(new Uint32Array([geometry.index.count, 0, 0, 0, 0]), 1);
    const level = {
      name, geometry, args, argsNode: storage(args, 'uint', 5), indexCount: uniform(geometry.index.count, 'uint'),
      mesh: new Mesh(geometry, null), material: null,
    };
    level.adopt = (g) => {
      g.setIndirect(args);
      // The indirect arguments decide what is drawn. three.js uses instanceCount only to skip
      // a draw at 0 and to count triangles in renderer.info, so it follows the last count
      // read back from the GPU (at least 1, which keeps the draw alive).
      g.instanceCount = Math.max(1, level.drawn || 0);
      level.indexCount.value = g.index.count;
    };
    level.adopt(geometry);
    level.mesh.name = 'TerrainColumns' + name;
    level.mesh.frustumCulled = false;
    level.mesh.castShadow = true;
    level.mesh.receiveShadow = true;
    return level;
  }
  const near = makeLevel('Near', 12);
  const far = makeLevel('Far', FAR_SIDES);
  const group = new Group();
  group.name = 'TerrainColumns';
  group.add(near.mesh, far.mesh);
  group.visible = false;

  let append = null;
  let layout = -1;
  function buildAppend() {
    const atlasRead = atlas.readNode;
    append = Fn(() => {
      const ti = instanceIndex.div(uint(256));
      const ly = int(instanceIndex.mod(uint(256)));
      const T = tilesNode.element(ti);
      const slot = int(T.x);
      const col0 = int(T.y);
      const row0 = int(T.z);
      const rowBase = slot.mul(int(SLOT_CELLS)).add(ly.add(int(1)).mul(int(SLOT))).add(int(1));
      const row = row0.add(ly);
      const cz = float(row).add(0.5).mul(ROW_D).sub(uFocus.y);
      const cz2 = cz.mul(cz).toVar();
      If(cz2.lessThan(uR2), () => {
        Loop(256, ({ i }) => {
          const lx = int(i);
          const raw = atlasRead.element(rowBase.add(lx));
          If(raw.x.greaterThan(0), () => {
            const col = col0.add(lx);
            const cx = float(col).add(0.5).mul(COL_W).sub(uFocus.x);
            const d2 = cx.mul(cx).add(cz2).toVar();
            If(d2.lessThan(uR2), () => {
              const t = atomicAdd(counterAtomic.element(0), uint(1)).toVar();
              If(t.lessThan(uBudget), () => {
                const ref = uvec2(uint(rowBase.add(lx)), uint(col).mul(uint(4096)).add(uint(row)));
                If(d2.lessThan(uNear2), () => {
                  const k = atomicAdd(counterAtomic.element(1), uint(1));
                  instWrite.element(k).assign(ref);
                }).Else(() => {
                  const k = atomicAdd(counterAtomic.element(2), uint(1));
                  instWrite.element(uint(budgetCap - 1).sub(k)).assign(ref);
                });
              });
            });
          });
        });
      });
    })().compute(256, [64]);
    append.name = 'terrainColumnsAppend';
  }
  const finalize = Fn(() => {
    // Index counts are written here too, so swapping shapes needs no buffer upload.
    near.argsNode.element(0).assign(near.indexCount);
    near.argsNode.element(1).assign(atomicLoad(counterAtomic.element(1)));
    far.argsNode.element(0).assign(far.indexCount);
    far.argsNode.element(1).assign(atomicLoad(counterAtomic.element(2)));
  })().compute(1, [1]);
  finalize.name = 'terrainColumnsFinalize';

  function buildMaterial(shape, level) {
    const m = new TerrainNodeMaterial();
    m.name = 'TerrainColumns' + level.name;
    m.fog = true;
    m.flatShading = true;
    // The far list fills the instance buffer from its end.
    const slot = level === near ? instanceIndex : uint(budgetCap - 1).sub(instanceIndex);
    const ref = instRead.element(slot);
    const raw = atlas.readNode.element(int(ref.x));
    // Footprint (world units): a round coin as wide as the cell (its narrower side, 64 blocks),
    // or an oval or a box filling the cell; geo.columnGap leaves a margin either way.
    const w = float(1).sub(uGap);
    const sx = w.mul(COL_W);
    const sz = shape === 'cylinder' ? sx : w.mul(ROW_D);
    m.positionNode = Fn(() => {
      const r = instRead.element(slot);
      const v = atlas.readNode.element(int(r.x));
      const col = r.y.div(uint(4096));
      const row = r.y.mod(uint(4096));
      const h = shading.heightOf(v.x, float(row));
      const x0 = float(col).add(0.5).mul(COL_W).sub(sx.mul(0.5));
      const z0 = float(row).add(0.5).mul(ROW_D).sub(sz.mul(0.5));
      const p = positionGeometry;
      return vec3(x0.add(p.x.mul(sx)), p.y.mul(h), z0.add(p.z.mul(sz)));
    })();
    const fRaw = varying(raw, 'vColRaw');
    fRaw.setInterpolation('flat');
    const fRow = varying(float(ref.y.mod(uint(4096))), 'vColRow');
    fRow.setInterpolation('flat');
    const fCol = varying(float(ref.y.div(uint(4096))), 'vColCol');
    fCol.setInterpolation('flat');
    // One palette colour per column, looked up per vertex instead of per pixel.
    const colV = varying(shading.cellColor(raw.w, float(ref.y.mod(uint(4096)))), 'vColColor');
    colV.setInterpolation('flat');
    const hV = varying(shading.heightOf(raw.x, float(ref.y.mod(uint(4096)))), 'vColHeight');
    hV.setInterpolation('flat');
    let col = vec3(colV).toVar();
    // Side or cap: the faces are exactly vertical or horizontal, so the screen-space facet
    // normal in world space tells them apart.
    const wp = positionWorld;
    const facet = dFdx(wp).cross(dFdy(wp));
    const side = select(abs(facet.y).lessThan(length(facet).mul(0.5)), float(1), float(0));
    if (shape !== 'box') {
      // Smooth sides: the gradient of the (elliptic) cross-section at this point; the cap keeps
      // the flat facet normal.
      const cx = round(fCol).add(0.5).mul(COL_W);
      const cz = round(fRow).add(0.5).mul(ROW_D);
      const radial = normalize(vec3(wp.x.sub(cx).div(sx.mul(sx)), 0, wp.z.sub(cz).div(sz.mul(sz))));
      m.normalNode = select(side.greaterThan(0.5), transformNormalToView(radial), normalView);
      // Coin edges: thin dark lines across the sides, one per coin thickness. Decorative only:
      // heights follow the height curve, not a count of outputs. They fade out once a coin is
      // thinner than about two pixels, so distant stacks do not shimmer.
      const s = wp.y.div(max(sx.mul(uThickness), 1e-5));
      const d = abs(fract(s).sub(0.5)).mul(2); // 1 at a coin boundary, 0 mid-coin
      const fw = fwidth(s);
      const line = smoothstep(float(0.8).sub(fw), float(0.8).add(fw), d);
      const fade = float(1).sub(smoothstep(0.2, 0.5, fw));
      col = col.mul(float(1).sub(uEdges.mul(line).mul(fade).mul(side)));
    }
    const below = max(hV.sub(wp.y), 0);
    const top = float(1).sub(smoothstep(0, max(hV.mul(HEAT_TOP), 1e-4), below));
    const heatShape = mix(float(1), mix(float(HEAT_SIDE), float(1), top), side);
    const heat = shading.heatEmissive(fRaw.y, fRaw.z, wp.x).mul(heatShape);
    const glow = shading.edgeGlow(wp.x);
    m.colorNode = vec4(col.mul(U.albedo), 1);
    m.emissiveNode = col.mul(U.emissive).add(col.mul(glow)).add(heat).add(shading.rimTerm(normalView));
    m.roughnessNode = U.roughness;
    m.metalnessNode = U.metalness;
    return m;
  }

  const state = { tiles: 0, candidates: 0, key: '', needed: 0, drawn: 0, near: 0, far: 0, readPending: false,
    dispatches: 0, radiusCells: 0, effectiveCells: 0, budgetCells: Infinity, enabled: false, shape: 'cylinder',
    sides: 12, farSides: FAR_SIDES, trianglesPerColumn: near.geometry.userData.triangles,
    trianglesFar: far.geometry.userData.triangles };
  let built = { shape: 'cylinder', near: 12, far: FAR_SIDES };

  function setMaterials() {
    for (const level of [near, far]) {
      if (level.material) level.material.dispose();
      level.material = buildMaterial(built.shape, level);
      level.mesh.material = level.material;
    }
  }

  function ensureBuilt(shape, sides) {
    const want = columnLevels(shape, sides);
    if (shape !== built.shape || want.near !== built.near || want.far !== built.far) {
      // Same instance list and indirect buffers; only the meshes and the materials change.
      for (const [level, S] of [[near, want.near], [far, want.far]]) {
        const g = columnGeometry(shape, S);
        level.adopt(g);
        level.mesh.geometry = g;
        level.geometry.dispose();
        level.geometry = g;
      }
      const shapeChanged = shape !== built.shape;
      built = { shape, near: want.near, far: want.far };
      Object.assign(state, { shape, sides: want.near, farSides: want.far, trianglesPerColumn: near.geometry.userData.triangles,
        trianglesFar: far.geometry.userData.triangles, key: '' }); // key '' rewrites the indirect arguments
      if (shapeChanged && append) setMaterials();
    }
    if (append === null || layout !== atlas.layoutVersion) {
      buildAppend();
      setMaterials();
      layout = atlas.layoutVersion;
    }
  }

  /**
   * Rebuilds the instance list when needed. focus: [x, z] world (the disc centre, which may lie
   * outside the landscape); radiusCells: disc radius in L0 column widths (0 = no columns);
   * nearCells: radius of the full-detail cylinders; shape: 'cylinder' | 'oval' | 'box';
   * sides: cylinder sides; edges, thickness: coin edges.
   */
  function update({ enabled, focus, radiusCells, nearCells = Infinity, budget, gap, dataVersion, shape = 'cylinder',
    sides = 12, edges = 0.4, thickness = 0.15 }) {
    uGap.value = gap;
    uEdges.value = Math.min(1, Math.max(0, edges));
    uThickness.value = Math.max(0.01, thickness);
    state.enabled = !!enabled;
    if (!enabled) {
      group.visible = false;
      U.columnFocus.value.set(0, 0, 0);
      state.key = '';
      return;
    }
    ensureBuilt(COLUMN_SHAPES.includes(shape) ? shape : 'cylinder', sides);
    // The requested radius follows the camera; budgetCells is the radius the instance budget
    // allows, learned from the counter read back after each rebuild.
    state.radiusCells = Math.max(0, radiusCells);
    state.effectiveCells = Math.min(state.radiusCells, state.budgetCells);
    const R = state.effectiveCells * COL_W;
    const Rn = Math.min(state.effectiveCells, Math.max(0, nearCells)) * COL_W;
    U.columnFocus.value.set(focus[0], focus[1], R);
    if (!(R > 0)) {
      group.visible = false;
      state.tiles = 0;
      state.drawn = 0;
      return;
    }
    const L0 = grid.levels[0];
    const c0 = Math.max(0, Math.floor(Math.floor((focus[0] - R) / COL_W) / 256));
    const c1 = Math.min(L0.tilesX - 1, Math.floor(Math.floor((focus[0] + R) / COL_W) / 256));
    const r0 = Math.max(0, Math.floor(Math.floor((focus[1] - R) / ROW_D) / 256));
    const r1 = Math.min(L0.tilesY - 1, Math.floor(Math.floor((focus[1] + R) / ROW_D) / 256));
    const T = tilesAttr.array;
    let n = 0;
    let ids = '';
    for (let ty = r0; ty <= r1 && n < MAX_COLUMN_TILES; ty++) {
      for (let tx = c0; tx <= c1 && n < MAX_COLUMN_TILES; tx++) {
        const id = L0.firstTile + ty * L0.tilesX + tx;
        const s = atlas.slotOf(id);
        if (s < 0) continue;
        const t = tileInfo(grid, id);
        const x0 = t.col0 * COL_W;
        const x1 = (t.col0 + t.cols) * COL_W;
        const z0 = t.row0 * ROW_D;
        const z1 = (t.row0 + t.rows) * ROW_D;
        const dx = Math.max(x0 - focus[0], 0, focus[0] - x1);
        const dz = Math.max(z0 - focus[1], 0, focus[1] - z1);
        if (dx * dx + dz * dz >= R * R) continue;
        T[n * 4] = s;
        T[n * 4 + 1] = t.col0;
        T[n * 4 + 2] = t.row0;
        T[n * 4 + 3] = id;
        ids += id + ',';
        n++;
      }
    }
    state.tiles = n;
    group.visible = n > 0;
    if (!n) {
      state.drawn = 0;
      return;
    }
    const key = ids + '|' + focus[0].toFixed(3) + ',' + focus[1].toFixed(3) + '|' + R.toFixed(3) + '|' + Rn.toFixed(3) + '|' +
      budget + '|' + dataVersion;
    if (key === state.key) return;
    state.key = key;
    tilesAttr.clearUpdateRanges();
    tilesAttr.addUpdateRange(0, n * 4);
    tilesAttr.needsUpdate = true;
    counterAttr.array.fill(0);
    counterAttr.needsUpdate = true;
    uR2.value = R * R;
    uNear2.value = Rn * Rn;
    uBudget.value = Math.min(budget, budgetCap);
    uFocus.value.set(focus[0], focus[1]);
    append.count = n * 256;
    state.candidates = n * 65536;
    renderer.compute(append);
    renderer.compute(finalize);
    state.dispatches++;
    if (!state.readPending && renderer.getArrayBufferAsync) {
      state.readPending = true;
      const b = Math.min(budget, budgetCap);
      const asked = state.effectiveCells;
      renderer.getArrayBufferAsync(counterAttr).then((buf) => {
        const c = new Uint32Array(buf);
        const needed = c[0];
        state.needed = needed;
        state.near = c[1];
        state.far = c[2];
        near.drawn = c[1];
        far.drawn = c[2];
        near.mesh.geometry.instanceCount = Math.max(1, c[1]);
        far.mesh.geometry.instanceCount = Math.max(1, c[2]);
        state.drawn = Math.min(needed, b);
        // Keep every masked cell covered: shrink when over budget, regrow while well under it.
        if (needed > b) state.budgetCells = Math.max(8, asked * Math.sqrt(b / needed) * 0.95);
        else if (needed < 0.8 * b && Number.isFinite(state.budgetCells)) {
          state.budgetCells *= 1.1;
          if (state.budgetCells > 1e6) state.budgetCells = Infinity;
        }
        state.readPending = false;
      }).catch(() => { state.readPending = false; });
    }
  }

  function dispose() {
    near.geometry.dispose();
    far.geometry.dispose();
    near.material?.dispose();
    far.material?.dispose();
  }

  return { mesh: group, update, state, dispose, budgetCap };
}
