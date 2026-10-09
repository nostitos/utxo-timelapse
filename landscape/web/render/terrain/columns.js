// Column mode (WebGPU): one instanced box per occupied L0 cell within geo.columnRadius of the
// camera focus, up to geo.instanceBudget boxes. A compute pass scans the resident L0 tiles
// in range, appends occupied cells with an atomic counter and writes the indirect draw count;
// the vertex stage reads heights live from the atlas, so playback needs no CPU work.
// When the occupied cells exceed the budget, the effective radius shrinks (measured by an
// asynchronous read of the counter) so the heightfield never shows holes.
import {
  InstancedBufferGeometry, BufferAttribute, Mesh, StorageBufferAttribute,
  IndirectStorageBufferAttribute, Vector2,
} from 'three/webgpu';
import {
  Fn, uniform, int, uint, float, vec3, vec4, uvec2, storage, instanceIndex, atomicAdd, atomicLoad,
  Loop, If, min, round, positionGeometry, positionWorld, varying, normalView,
} from 'three/tsl';
import { tileInfo, SLOT, SLOT_CELLS } from '../../data/grid.js';
import { TerrainNodeMaterial } from './heightfield.js';

export const MAX_COLUMN_TILES = 512;
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
  return out;
}

export function createColumns({ renderer, atlas, shading, grid, maxBudget = 8000000 }) {
  const U = shading.uniforms;
  const budgetCap = Math.max(1, maxBudget | 0);
  const tilesAttr = new StorageBufferAttribute(new Float32Array(MAX_COLUMN_TILES * 4), 4);
  const counterAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
  const instAttr = new StorageBufferAttribute(new Uint32Array(budgetCap * 2), 2);
  const geometry = boxGeometry();
  const indexCount = geometry.index.count;
  const argsAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
  geometry.setIndirect(argsAttr);
  geometry.instanceCount = budgetCap; // the indirect count decides; this keeps the draw alive

  const uFocus = uniform(new Vector2());
  const uR2 = uniform(0);
  const uBudget = uniform(0, 'uint');
  const uGap = uniform(0.12);

  const tilesNode = storage(tilesAttr, 'vec4', MAX_COLUMN_TILES).toReadOnly();
  const counterAtomic = storage(counterAttr, 'uint', 1).toAtomic();
  const instWrite = storage(instAttr, 'uvec2', budgetCap);
  const instRead = storage(instAttr, 'uvec2', budgetCap).toReadOnly();
  const argsNode = storage(argsAttr, 'uint', 5);

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
            If(cx.mul(cx).add(cz2).lessThan(uR2), () => {
              const k = atomicAdd(counterAtomic.element(0), uint(1)).toVar();
              If(k.lessThan(uBudget), () => {
                instWrite.element(k).assign(uvec2(uint(rowBase.add(lx)), uint(col).mul(uint(4096)).add(uint(row))));
              });
            });
          });
        });
      });
    })().compute(256, [64]);
    append.name = 'terrainColumnsAppend';
  }
  const finalize = Fn(() => {
    argsNode.element(1).assign(min(atomicLoad(counterAtomic.element(0)), uBudget));
  })().compute(1, [1]);
  finalize.name = 'terrainColumnsFinalize';

  function buildMaterial() {
    const m = new TerrainNodeMaterial();
    m.name = 'TerrainColumns';
    m.fog = true;
    m.flatShading = true;
    const ref = instRead.element(instanceIndex);
    const raw = atlas.readNode.element(int(ref.x));
    m.positionNode = Fn(() => {
      const r = instRead.element(instanceIndex);
      const v = atlas.readNode.element(int(r.x));
      const col = r.y.div(uint(4096));
      const row = r.y.mod(uint(4096));
      const h = shading.heightOf(v.x, float(row));
      const w = float(1).sub(uGap);
      const x0 = float(col).add(uGap.mul(0.5)).mul(COL_W);
      const z0 = float(row).add(uGap.mul(0.5)).mul(ROW_D);
      const p = positionGeometry;
      return vec3(x0.add(p.x.mul(w).mul(COL_W)), p.y.mul(h), z0.add(p.z.mul(w).mul(ROW_D)));
    })();
    const fRaw = varying(raw, 'vColRaw');
    fRaw.setInterpolation('flat');
    const fRow = varying(float(ref.y.mod(uint(4096))), 'vColRow');
    fRow.setInterpolation('flat');
    const col = shading.cellColor(fRaw.w, round(fRow)).toVar();
    const heat = shading.heatEmissive(fRaw.y, fRaw.z, positionWorld.x);
    m.colorNode = vec4(col.mul(U.albedo), 1);
    m.emissiveNode = col.mul(U.emissive).add(heat).add(shading.rimTerm(normalView));
    m.roughnessNode = U.roughness;
    m.metalnessNode = U.metalness;
    return m;
  }

  let material = null;
  const mesh = new Mesh(geometry, null);
  mesh.name = 'TerrainColumns';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.visible = false;

  const state = { tiles: 0, candidates: 0, key: '', needed: 0, drawn: 0, readPending: false, dispatches: 0,
    radiusCells: 0, effectiveCells: 0, enabled: false };

  function ensureBuilt() {
    if (append === null || layout !== atlas.layoutVersion) {
      buildAppend();
      if (material) material.dispose();
      material = buildMaterial();
      mesh.material = material;
      layout = atlas.layoutVersion;
    }
  }

  /** Rebuilds the instance list when needed. focus: [x, z] world; radiusCells: L0 columns. */
  function update({ enabled, focus, radiusCells, budget, gap, dataVersion }) {
    uGap.value = gap;
    state.enabled = !!enabled;
    if (!enabled) {
      mesh.visible = false;
      U.columnFocus.value.set(0, 0, 0);
      state.key = '';
      return;
    }
    ensureBuilt();
    if (state.radiusCells !== radiusCells) {
      state.radiusCells = radiusCells;
      state.effectiveCells = radiusCells;
    }
    const R = state.effectiveCells * COL_W;
    U.columnFocus.value.set(focus[0], focus[1], R);
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
    mesh.visible = n > 0;
    if (!n) {
      state.drawn = 0;
      return;
    }
    const key = ids + '|' + focus[0].toFixed(3) + ',' + focus[1].toFixed(3) + '|' + R + '|' + budget + '|' + dataVersion;
    if (key === state.key) return;
    state.key = key;
    tilesAttr.clearUpdateRanges();
    tilesAttr.addUpdateRange(0, n * 4);
    tilesAttr.needsUpdate = true;
    counterAttr.array[0] = 0;
    counterAttr.needsUpdate = true;
    uR2.value = R * R;
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
      renderer.getArrayBufferAsync(counterAttr).then((buf) => {
        const needed = new Uint32Array(buf)[0];
        state.needed = needed;
        state.drawn = Math.min(needed, b);
        // Keep every masked cell covered: shrink when over budget, regrow toward the setting.
        if (needed > b) state.effectiveCells = Math.max(8, state.effectiveCells * Math.sqrt(b / needed) * 0.95);
        else if (needed < 0.8 * b && state.effectiveCells < state.radiusCells) {
          state.effectiveCells = Math.min(state.radiusCells, state.effectiveCells * 1.1);
        }
        state.readPending = false;
      }).catch(() => { state.readPending = false; });
    }
  }

  function dispose() {
    geometry.dispose();
    material?.dispose();
  }

  return { mesh, update, state, dispose, budgetCap };
}
