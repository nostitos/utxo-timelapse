// Column cells (WebGPU): near the camera every occupied L0 cell is its own column, a plain
// cylinder by default (geo.columnShape 'cylinder'), an oval cylinder that fills the cell, or a
// box. index.js decides the disc that gets columns (cells at least geo.columnPixels wide on
// screen, around the camera, or moved ahead of it in plane mode); the heightfield hides
// itself inside the disc and draws the rest.
//
// A compute pass scans the resident L0 tiles in range, appends occupied cells with an atomic
// counter and writes the indirect draw arguments; the vertex stage reads heights live from
// the atlas, so playback needs no CPU work. Columns come in two levels of detail drawn from
// one instance buffer: cells wider than NEAR_PX on screen (measured from the eye, the ground
// under the camera) use geo.cylinderSides, smaller ones a 4-sided prism with the circle's
// area or the cheaper far style of geo.farColumns (near list from the start of the buffer,
// far list from the end). When the occupied cells exceed geo.instanceBudget, the disc shrinks
// (measured by an asynchronous read of the counter) so the heightfield never shows holes, and
// it grows back toward the budget while there is room.
import {
  Group, InstancedBufferGeometry, BufferAttribute, Mesh, StorageBufferAttribute, IndirectStorageBufferAttribute,
  Vector2, DoubleSide, FrontSide,
} from 'three/webgpu';
import {
  Fn, uniform, int, uint, float, vec3, vec4, uvec2, storage, instanceIndex, atomicAdd, atomicLoad,
  Loop, If, max, mix, abs, smoothstep, select, normalize, length, round, positionGeometry, positionWorld,
  varying, normalView, transformNormalToView, dFdx, dFdy, vec2, dot, clamp, sqrt, cameraPosition,
} from 'three/tsl';
import { tileInfo, SLOT, SLOT_CELLS } from '../../data/grid.js';
import { TerrainNodeMaterial } from './heightfield.js';

export const MAX_COLUMN_TILES = 512;
export const COLUMN_SHAPES = Object.freeze(['cylinder', 'oval', 'box']);
/**
 * Cells at least this many pixels wide get the full cylinder; smaller ones a 4-sided prism
 * of the same footprint, still shaded round (radial normals), whose square outline does not
 * show at that size.
 */
export const NEAR_PX = 20;
export const FAR_SIDES = 4;
/**
 * How the far level is drawn (geo.farColumns). prism: the 4-sided prism above (12 triangles);
 * card: one rectangle turned about its axis to face the camera, with a flat top (4 triangles);
 * flat: that rectangle alone (2 triangles); cross: two crossed rectangles that do not turn
 * (4 triangles). The rectangles are shaded as if round, from the direction of the camera.
 */
export const FAR_STYLES = Object.freeze(['prism', 'card', 'flat', 'cross']);
/** The disc grows back while fewer than GROW_BELOW of the budget's columns are drawn, aiming at FILL. */
const FILL = 0.97;
const GROW_BELOW = 0.93;
const GROW_MAX = 1.25;
/**
 * Spend flashes light the top of a cylinder: the cap and the top HEAT_TOP of the side at full
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

/**
 * A rectangle (and with cap a square top) in billboard coordinates: x across the column
 * (0..1), y up (0..1), z along the direction to the camera (0..1; the rectangle at 0.5).
 */
export function cardGeometry(cap = true) {
  const pos = [0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5, 1, 1, 0.5];
  const index = [0, 1, 2, 2, 1, 3];
  if (cap) {
    pos.push(0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1);
    index.push(4, 6, 5, 5, 6, 7);
  }
  const out = new InstancedBufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setIndex(new BufferAttribute(new Uint32Array(index), 1));
  out.userData = { shape: cap ? 'card' : 'flat', sides: 0, triangles: index.length / 3, vertices: pos.length / 3 };
  return out;
}

/** Two crossed rectangles in the footprint coordinates of cylinderGeometry (x, z 0..1, y 0..1). */
export function crossGeometry() {
  const pos = new Float32Array([
    0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5, 1, 1, 0.5,
    0.5, 0, 0, 0.5, 0, 1, 0.5, 1, 0, 0.5, 1, 1,
  ]);
  const index = new Uint32Array([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  const out = new InstancedBufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setIndex(new BufferAttribute(index, 1));
  out.userData = { shape: 'cross', sides: 0, triangles: 4, vertices: 8 };
  return out;
}

/** Geometry of the far level for a far style and the cell shape. */
export function farGeometry(style, shape, sides) {
  if (style === 'card') return cardGeometry(true);
  if (style === 'flat') return cardGeometry(false);
  if (style === 'cross') return crossGeometry();
  return columnGeometry(shape, columnLevels(shape, sides).far);
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
  const uEye = uniform(new Vector2());
  const uR2 = uniform(0);
  const uNear2 = uniform(0);
  const uBudget = uniform(0, 'uint');
  const uGap = uniform(0.12);

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
                const ex = float(col).add(0.5).mul(COL_W).sub(uEye.x);
                const ez = float(row).add(0.5).mul(ROW_D).sub(uEye.y);
                If(ex.mul(ex).add(ez.mul(ez)).lessThan(uNear2), () => {
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

  function buildMaterial(shape, level, farStyle = 'prism') {
    // The far level's rectangles (card, flat, cross) are drawn from both sides and shaded
    // round from the camera; the prism and the near level keep their own faces.
    const style = level === far && FAR_STYLES.includes(farStyle) ? farStyle : 'prism';
    const billboard = style === 'card' || style === 'flat';
    const m = new TerrainNodeMaterial();
    m.name = 'TerrainColumns' + level.name;
    m.fog = true;
    m.flatShading = true;
    m.side = style === 'prism' ? FrontSide : DoubleSide;
    // The far list fills the instance buffer from its end.
    const slot = level === near ? instanceIndex : uint(budgetCap - 1).sub(instanceIndex);
    const ref = instRead.element(slot);
    const raw = atlas.readNode.element(int(ref.x));
    // Footprint (world units): a round cylinder as wide as the cell (its narrower side, 64
    // blocks), or an oval or a box filling the cell; geo.columnGap leaves a margin either way.
    const w = float(1).sub(uGap);
    const sx = w.mul(COL_W);
    const sz = shape === 'cylinder' ? sx : w.mul(ROW_D);
    m.positionNode = Fn(() => {
      const r = instRead.element(slot);
      const v = atlas.readNode.element(int(r.x));
      const col = r.y.div(uint(4096));
      const row = r.y.mod(uint(4096));
      const h = shading.heightOf(v.x, float(row));
      const p = positionGeometry;
      if (billboard) {
        // Turned about the column's axis to face the camera (in the shadow pass, the light).
        const cxW = float(col).add(0.5).mul(COL_W);
        const czW = float(row).add(0.5).mul(ROW_D);
        const d = vec2(cameraPosition.x.sub(cxW), cameraPosition.z.sub(czW));
        const t = d.div(max(length(d), 1e-4));
        const a = p.x.sub(0.5).mul(sx);
        const b = p.z.sub(0.5).mul(sx);
        return vec3(cxW.add(t.y.mul(a)).add(t.x.mul(b)), p.y.mul(h), czW.sub(t.x.mul(a)).add(t.y.mul(b)));
      }
      const x0 = float(col).add(0.5).mul(COL_W).sub(sx.mul(0.5));
      const z0 = float(row).add(0.5).mul(ROW_D).sub(sz.mul(0.5));
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
    const col = vec3(colV);
    // Side or cap: the faces are exactly vertical or horizontal, so the screen-space facet
    // normal in world space tells them apart.
    const wp = positionWorld;
    const facet = dFdx(wp).cross(dFdy(wp));
    const side = select(abs(facet.y).lessThan(length(facet).mul(0.5)), float(1), float(0));
    if (style !== 'prism') {
      // Round shading on flat rectangles: the normal turns across the column as on a cylinder
      // seen from the camera (u = -1 at its left edge, 0 in the middle, 1 at its right edge).
      const cx = round(fCol).add(0.5).mul(COL_W);
      const cz = round(fRow).add(0.5).mul(ROW_D);
      const d = vec2(cameraPosition.x.sub(cx), cameraPosition.z.sub(cz));
      const t = d.div(max(length(d), 1e-4));
      const r = vec2(t.y, t.x.negate());
      const u = clamp(dot(vec2(wp.x.sub(cx), wp.z.sub(cz)), r).div(sx.mul(0.5)), -1, 1);
      const s = sqrt(max(float(1).sub(u.mul(u)), 0));
      const round3 = normalize(vec3(r.x.mul(u).add(t.x.mul(s)), 0, r.y.mul(u).add(t.y.mul(s))));
      m.normalNode = select(side.greaterThan(0.5), transformNormalToView(round3), normalView);
    } else if (shape !== 'box') {
      // Smooth sides: the gradient of the (elliptic) cross-section at this point; the cap keeps
      // the flat facet normal.
      const cx = round(fCol).add(0.5).mul(COL_W);
      const cz = round(fRow).add(0.5).mul(ROW_D);
      const radial = normalize(vec3(wp.x.sub(cx).div(sx.mul(sx)), 0, wp.z.sub(cz).div(sz.mul(sz))));
      m.normalNode = select(side.greaterThan(0.5), transformNormalToView(radial), normalView);
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
    sides: 12, farSides: FAR_SIDES, farStyle: 'prism', farShadows: true, budget: 0,
    trianglesPerColumn: near.geometry.userData.triangles, trianglesFar: far.geometry.userData.triangles };
  let built = { shape: 'cylinder', near: 12, far: FAR_SIDES, farStyle: 'prism' };

  function setMaterials() {
    for (const level of [near, far]) {
      if (level.material) level.material.dispose();
      level.material = buildMaterial(built.shape, level, built.farStyle);
      level.mesh.material = level.material;
    }
  }

  function ensureBuilt(shape, sides, farStyle) {
    const want = columnLevels(shape, sides);
    if (shape !== built.shape || want.near !== built.near || want.far !== built.far || farStyle !== built.farStyle) {
      // Same instance list and indirect buffers; only the meshes and the materials change.
      for (const [level, make] of [[near, () => columnGeometry(shape, want.near)], [far, () => farGeometry(farStyle, shape, sides)]]) {
        const g = make();
        level.adopt(g);
        level.mesh.geometry = g;
        level.geometry.dispose();
        level.geometry = g;
      }
      const materialsChanged = shape !== built.shape || farStyle !== built.farStyle;
      built = { shape, near: want.near, far: want.far, farStyle };
      Object.assign(state, { shape, sides: want.near, farSides: want.far, farStyle, trianglesPerColumn: near.geometry.userData.triangles,
        trianglesFar: far.geometry.userData.triangles, key: '' }); // key '' rewrites the indirect arguments
      if (materialsChanged && append) setMaterials();
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
   * nearCells: radius of the full-detail cylinders around eye ([x, z], default focus); shape:
   * 'cylinder' | 'oval' | 'box'; sides: cylinder sides; farStyle: one of FAR_STYLES; farShadows:
   * whether the far level casts shadows.
   */
  function update({ enabled, focus, eye = focus, radiusCells, nearCells = Infinity, budget, gap, dataVersion, shape = 'cylinder',
    sides = 12, farStyle = 'prism', farShadows = true }) {
    uGap.value = gap;
    state.enabled = !!enabled;
    if (!enabled) {
      group.visible = false;
      U.columnFocus.value.set(0, 0, 0);
      state.key = '';
      return;
    }
    ensureBuilt(COLUMN_SHAPES.includes(shape) ? shape : 'cylinder', sides, FAR_STYLES.includes(farStyle) ? farStyle : 'prism');
    far.mesh.castShadow = farShadows !== false;
    state.farShadows = far.mesh.castShadow;
    state.budget = Math.min(budget, budgetCap);
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
    const key = ids + '|' + focus[0].toFixed(3) + ',' + focus[1].toFixed(3) + '|' + eye[0].toFixed(3) + ',' + eye[1].toFixed(3) +
      '|' + R.toFixed(3) + '|' + Rn.toFixed(3) + '|' + budget + '|' + dataVersion;
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
    uEye.value.set(eye[0], eye[1]);
    append.count = n * 256;
    state.candidates = n * 65536;
    renderer.compute(append);
    renderer.compute(finalize);
    state.dispatches++;
    if (!state.readPending && renderer.getArrayBufferAsync) {
      state.readPending = true;
      const b = Math.min(budget, budgetCap);
      const asked = state.effectiveCells;
      const requested = state.radiusCells;
      const dispatch = state.dispatches;
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
        // Keep every masked cell covered: shrink when over budget; while the budget limits the
        // disc and leaves room, grow it back toward FILL of the budget. Columns are not spread
        // evenly (the disc runs past the landscape's edges), so each step uses the measured count
        // and growth is capped per step; the next rebuild measures again.
        if (needed > b) {
          state.budgetCells = Math.max(8, asked * Math.sqrt((FILL * b) / needed));
        } else if (Number.isFinite(state.budgetCells) && asked >= state.budgetCells - 1e-6 && needed < GROW_BELOW * b) {
          const next = asked * Math.min(GROW_MAX, Math.sqrt((FILL * b) / Math.max(1, needed)));
          state.budgetCells = next >= requested ? Infinity : next;
        }
        // Rebuilt while this count was read: rebuild once more so the latest disc is measured.
        if (dispatch !== state.dispatches) state.key = '';
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
