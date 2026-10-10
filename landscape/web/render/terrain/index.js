// Terrain for the UTXO Timelapse landscape (landscape/SPEC.md §6).
//
// createTerrain({ renderer, scene, camera, settings, manifest, rows, blocktimes, capabilities,
//   labelsElement }) → { object3d, applyFrame, setBlock, update, pick, heightAt, focusDistance,
//   stats, dispose }
import {
  Group, Mesh, PlaneGeometry, MeshStandardNodeMaterial, MeshBasicNodeMaterial, DoubleSide, Vector3, Matrix4,
  Color,
} from 'three/webgpu';
import { vec3, vec4, uniform, float, positionLocal, smoothstep, mix } from 'three/tsl';
import { gridFromManifest, tileInfo, tileOfCell, SLOT, SLOT_CELLS } from '../../data/grid.js';
import { cellArea } from '../../data/grid.js';
import { TileAtlas, FLOATS_PER_SLOT } from './atlas.js';
import { createShading } from './shading.js';
import { heightOfCpu, heightBoundCpu } from './curve.js';
import {
  buildPatchGeometry, buildTerrainMaterial, createPatchInstances, createHeightfieldMesh, MAX_PATCH_INSTANCES,
} from './heightfield.js';
import {
  selectTiles, cellSize, patchBounds, boxVisible, boxDistance, PATCH_CELLS, PATCHES_PER_SIDE,
} from './lod.js';
import { createColumns, NEAR_PX } from './columns.js';
import { createAxisLabels } from './labels.js';
import { createFlashes } from './flashes.js';

// Fallback values for ids the settings store might not provide (SPEC §7 defaults).
export const TERRAIN_DEFAULTS = Object.freeze({
  'color.palette': 'film', 'color.gradient': null, 'color.reverse': false, 'color.offset': 30,
  'color.upper': 500, 'color.gamma': 1, 'color.whiteHot': true, 'color.whiteHotBTC': 10,
  'color.ground': '#000000', 'color.heat': '#ffe9c4', 'color.heatGain': 2.5,
  'amp.curve': 'log', 'amp.exponent': 0.5, 'amp.exposure': 1, 'amp.reference': 500,
  'amp.exaggeration': 10, 'amp.floor': 0.05, 'amp.whale': 1, 'amp.heatHalfLife': 30,
  'amp.heatFloor': 0.35, 'amp.heatReference': 100, 'amp.heatEdge': 0.15, 'amp.heatEdgeBlocks': 4032,
  'amp.flashSize': 1, 'amp.flashThreshold': 0.0001, 'amp.edgeGlow': 0.25, 'amp.edgeBlocks': 1008,
  'amp.nowPlane': 0.15,
  'geo.smoothing': 'bilinear', 'geo.stepped': false, 'geo.subdivision': 1, 'geo.columns': true,
  'geo.columnRadius': 512, 'geo.instanceBudget': 1000000, 'geo.columnGap': 0.12, 'geo.lodBias': 0,
  'geo.columnShape': 'cylinder', 'geo.cylinderSides': 12, 'geo.coinEdges': 0.4, 'geo.coinThickness': 0.15,
  'geo.columnPixels': 4,
  'geo.pixelsPerCell': 3, 'geo.tileBudget': 225, 'geo.skirts': true, 'geo.wireframe': false,
  'light.emissive': 0.4, 'light.albedo': 0.85, 'light.rim': 0.35, 'light.rimColor': '#99bbff',
  'light.roughness': 0.65, 'light.metalness': 0.05, 'light.floorReflection': 0,
  'display.labels': true, 'display.grid': false,
});
const CONSUMED_PREFIXES = ['color.', 'amp.', 'geo.', 'light.', 'display.'];

export function createTerrain({ renderer, scene, camera, settings, manifest, rows, blocktimes, capabilities = {}, labelsElement = null }) {
  const grid = gridFromManifest(manifest);
  const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  const get = (id) => {
    const v = settings && typeof settings.get === 'function' ? settings.get(id) : undefined;
    return v === undefined ? TERRAIN_DEFAULTS[id] : v;
  };

  // ---- capacity --------------------------------------------------------------------------
  const limits = capabilities.limits || (renderer.backend && renderer.backend.device && renderer.backend.device.limits) || {};
  const slotBytes = FLOATS_PER_SLOT * 4;
  let maxSlots = 400;
  if (backend === 'webgpu') {
    const bind = Math.min(limits.maxStorageBufferBindingSize || 134217728, limits.maxBufferSize || 268435456);
    maxSlots = Math.min(400, Math.floor(bind / slotBytes));
  } else {
    maxSlots = Math.min(400, limits.maxArrayTextureLayers || 256);
  }
  if (capabilities.maxTileBudget) maxSlots = Math.min(maxSlots, capabilities.maxTileBudget);
  const budgetFromSettings = () => Math.max(1, Math.min(maxSlots, Math.round(get('geo.tileBudget'))));

  const shading = createShading({ rows });
  const atlas = new TileAtlas({ renderer, grid, backend, capacity: budgetFromSettings() });
  const object3d = new Group();
  object3d.name = 'Terrain';

  // ---- heightfield ---------------------------------------------------------------------
  // One instanced mesh per subdivision level in use (1, 2, 4). Each visible patch gets the
  // smallest level whose sub-quads stay below SUB_TARGET_PX on screen, capped by
  // geo.subdivision, so subdivision is spent only where cells are large on screen.
  const SUB_TARGET_PX = 6;
  let mode = null;
  let layoutVersion = -1;
  const hfLevels = new Map(); // sub -> {sub, inst, geometry, material, mesh}
  const instCapacity = Math.min(MAX_PATCH_INSTANCES, maxSlots * 16);
  function currentMode() {
    const stepped = !!get('geo.stepped');
    return {
      stepped, sub: stepped ? 1 : Number(get('geo.subdivision')) || 1, smoothing: get('geo.smoothing') || 'bilinear',
      columns: backend === 'webgpu' && !!get('geo.columns'),
    };
  }
  function disposeLevels() {
    for (const L of hfLevels.values()) {
      L.mesh.removeFromParent();
      L.geometry.dispose();
      L.material.dispose();
    }
    hfLevels.clear();
  }
  function hfLevel(sub) {
    let L = hfLevels.get(sub);
    if (!L) {
      const inst = createPatchInstances(instCapacity);
      const geometry = buildPatchGeometry({ sub, stepped: mode.stepped });
      const material = buildTerrainMaterial({ atlas, shading, instances: inst, mode: { ...mode, sub } });
      material.wireframe = !!get('geo.wireframe');
      const m = createHeightfieldMesh(geometry, material);
      m.name = 'TerrainHeightfield' + (mode.stepped ? 'Stepped' : 'Sub' + sub);
      object3d.add(m);
      L = { sub, inst, geometry, material, mesh: m };
      hfLevels.set(sub, L);
    }
    return L;
  }
  function rebuildHeightfield() {
    disposeLevels();
    mode = currentMode();
    layoutVersion = atlas.layoutVersion;
  }
  rebuildHeightfield();

  // ---- floor and now plane ---------------------------------------------------------------
  const U = shading.uniforms;
  const floorReflection = uniform(0);
  const floorMat = new MeshStandardNodeMaterial();
  floorMat.name = 'TerrainFloor';
  floorMat.colorNode = vec4(U.ground.mul(U.albedo), 1);
  floorMat.emissiveNode = U.ground.mul(U.emissive);
  floorMat.metalnessNode = floorReflection;
  floorMat.roughnessNode = mix(float(1), float(0.04), floorReflection);
  floorMat.fog = true;
  // The terrain's empty ground is at y = 0; push the floor behind it in depth so they never
  // z-fight at distance (depth precision with a small near plane is coarse).
  floorMat.polygonOffset = true;
  floorMat.polygonOffsetFactor = 4;
  floorMat.polygonOffsetUnits = 16;
  const worldW = grid.numBlocks / 1000;
  const worldD = grid.rows / 10;
  const floor = new Mesh(new PlaneGeometry(1, 1), floorMat);
  floor.name = 'TerrainFloor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(worldW / 2, -0.004, worldD / 2);
  floor.scale.set(worldW + 40, worldD + 40, 1);
  floor.receiveShadow = true;
  object3d.add(floor);

  const nowOpacity = uniform(0.15);
  const nowMat = new MeshBasicNodeMaterial();
  nowMat.name = 'TerrainNowPlane';
  nowMat.transparent = true;
  nowMat.depthWrite = false;
  nowMat.side = DoubleSide;
  nowMat.fog = true;
  // Strongest at the ground, fading to nothing at the top (plane spans y -0.5..0.5 locally).
  const up = positionLocal.y.add(0.5);
  const fade = float(1).sub(smoothstep(0, 1, up)).pow(2);
  nowMat.colorNode = vec4(vec3(0.75, 0.9, 1), nowOpacity.mul(fade));
  const nowPlane = new Mesh(new PlaneGeometry(1, 1), nowMat);
  nowPlane.name = 'TerrainNowPlane';
  nowPlane.rotation.y = Math.PI / 2;
  nowPlane.renderOrder = 10;
  object3d.add(nowPlane);
  function placeNowPlane() {
    const h = Math.max(2, get('amp.exaggeration') * Math.max(1, get('amp.whale')) * 1.25);
    nowPlane.scale.set(worldD, h, 1);
    nowPlane.position.set(currentBlock / 1000, h / 2, worldD / 2);
    nowPlane.visible = nowOpacity.value > 0.001;
  }

  // ---- settings --------------------------------------------------------------------------
  let currentBlock = 0;
  // ---- labels and columns ----------------------------------------------------------------
  const labels = labelsElement ? createAxisLabels({ element: labelsElement, grid, rows, blocktimes }) : null;
  let lastAmountRows = null;
  const flashes = createFlashes({ shading });
  object3d.add(flashes.sprite);
  let columns = null; // created on first use (its instance buffer is budget-sized)
  const columnBudgetCap = Math.max(1, Math.min(8000000, capabilities.maxInstances || 8000000));
  function ensureColumns() {
    if (!columns && backend === 'webgpu') {
      columns = createColumns({ renderer, atlas, shading, grid, maxBudget: columnBudgetCap });
      object3d.add(columns.mesh);
    }
    return columns;
  }
  /**
   * Where columns stand: every cell at most dMax from the camera, where a cell (64 blocks
   * wide) still covers geo.columnPixels on screen; farther cells are too small for their
   * shape to show, and the stepped heightfield draws them. Measured from the ground under
   * the camera, that is a disc of radius sqrt(dMax^2 - h^2) around it (h = height above the
   * terrain there), capped by geo.columnRadius. Cells at least NEAR_PX wide get the full
   * cylinder (nearCells). Returns {focus: [x, z], radiusCells, nearCells}.
   */
  function columnRegion(cam, projScale) {
    const o = cam.position;
    const h = Math.max(0, o.y - Math.max(0, heightAt(o.x, o.z)));
    const reach = (px) => {
      const d = (0.064 * projScale) / Math.max(0.5, px);
      return d > h ? Math.sqrt(d * d - h * h) / 0.064 : 0;
    };
    return { focus: [o.x, o.z], radiusCells: Math.min(get('geo.columnRadius'), reach(get('geo.columnPixels'))), nearCells: reach(NEAR_PX) };
  }
  const needs = { rebuild: false, capacity: false };
  function applySetting(id, value) {
    if (value === undefined) value = TERRAIN_DEFAULTS[id];
    if (shading.set(id, value)) {
      if (id.startsWith('amp.')) placeNowPlane();
      return;
    }
    switch (id) {
      case 'geo.smoothing': case 'geo.stepped': case 'geo.subdivision': case 'geo.columns': needs.rebuild = true; break;
      case 'display.labels': if (labels) labels.setVisible(!!value); break;
      case 'geo.wireframe': for (const L of hfLevels.values()) { L.material.wireframe = !!value; L.material.needsUpdate = true; } break;
      case 'geo.tileBudget': needs.capacity = true; break;
      case 'amp.nowPlane': nowOpacity.value = value; placeNowPlane(); break;
      case 'amp.flashSize': if (!(value > 0)) flashes.clear(); break;
      case 'light.floorReflection': floorReflection.value = value; break;
      default: break;
    }
  }
  for (const id of Object.keys(TERRAIN_DEFAULTS)) applySetting(id, get(id));
  let unsubscribe = null;
  if (settings && typeof settings.subscribe === 'function') {
    unsubscribe = settings.subscribe('*', (changes) => {
      for (const ch of changes) if (CONSUMED_PREFIXES.some((p) => ch.id.startsWith(p))) applySetting(ch.id, ch.value);
    });
  }

  // ---- per-frame selection ---------------------------------------------------------------
  const tmpM = new Matrix4();
  const stats = {
    instances: 0, patches: 0, tiles: 0, resident: 0, selected: 0, desired: 0, triangles: 0, maxTiles: maxSlots,
    capacity: atlas.capacity, atlasBytes: atlas.bytes, backend, lodMs: 0, deltaCells: 0, fullTiles: 0,
    columns: 0,
  };
  let previousSplit = null;
  let lastDesiredKey = '';
  let lastDesired = [];
  let drawn = new Map();
  const tileCount = grid.tiles;

  function heightBound(maxV) {
    if (!(maxV > 0)) return 0.05;
    return heightBoundCpu(maxV, shading.heightParams()) + 0.05;
  }

  function sidePlanes(cam) {
    tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = tmpM.elements;
    const raw = [
      [e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]],
      [e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]],
      [e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]],
      [e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]],
    ];
    const out = new Float64Array(24);
    raw.forEach((p, i) => {
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      out[i * 4] = p[0] / len;
      out[i * 4 + 1] = p[1] / len;
      out[i * 4 + 2] = p[2] / len;
      out[i * 4 + 3] = p[3] / len;
    });
    // near/far: always inside (zero normal, d = 1)
    out[19] = 1;
    out[23] = 1;
    return out;
  }

  function update(cam = camera, viewportHeightPx = 1080) {
    const t0 = performance.now();
    if (needs.capacity) {
      needs.capacity = false;
      if (atlas.ensureCapacity(budgetFromSettings())) needs.rebuild = true;
      stats.capacity = atlas.capacity;
      stats.atlasBytes = atlas.bytes;
    }
    if (needs.rebuild || layoutVersion !== atlas.layoutVersion) {
      needs.rebuild = false;
      rebuildHeightfield();
    }
    const planes = sidePlanes(cam);
    const orthographic = !!cam.isOrthographicCamera;
    let projScale;
    if (orthographic) projScale = viewportHeightPx / Math.max(1e-6, (cam.top - cam.bottom) / (cam.zoom || 1));
    else projScale = viewportHeightPx / (2 * Math.tan(((cam.fov || 50) * Math.PI) / 360));
    const threshold = get('geo.pixelsPerCell') * 2 ** -get('geo.lodBias');
    const budget = Math.min(budgetFromSettings(), atlas.capacity);
    const pos = cam.position;
    const tileMaxH = (id) => (atlas.isResident(id) ? heightBound(atlas.tileMaxValue[id]) : -1);
    let globalMax = 1;
    for (let id = 0; id < tileCount; id++) if (atlas.tileMaxValue[id] > globalMax) globalMax = atlas.tileMaxValue[id];
    const sel = selectTiles(grid, { position: [pos.x, pos.y, pos.z], planes, projScale, orthographic }, {
      threshold, budget, previousSplit, isResident: (id) => atlas.isResident(id), isEmpty: (id) => atlas.isEmpty(id),
      tileMaxHeight: tileMaxH, defaultMaxHeight: heightBound(globalMax * 4),
    });
    previousSplit = sel.split;

    // Patch instances (front to back), each assigned a subdivision level.
    const list = [];
    drawn = new Map();
    const maxSub = mode.stepped ? 1 : mode.sub;
    // Columns stand in a disc around the camera, where the heightfield hides itself; patches
    // entirely inside it (on resident L0 tiles) are skipped instead of drawn and discarded.
    const region = mode.columns ? columnRegion(cam, projScale) : null;
    const colR = region ? Math.min(region.radiusCells, columns ? columns.state.budgetCells : Infinity) * 0.064 : 0;
    const L0 = grid.levels[0];
    const insideColumns = (t, px, py) => {
      if (!(colR > 0)) return false;
      const { cw, ch } = cellSize(grid, t.level);
      const x0 = (t.col0 + px * PATCH_CELLS) * cw;
      const z0 = (t.row0 + py * PATCH_CELLS) * ch;
      const x1 = (t.col0 + Math.min(t.cols, (px + 1) * PATCH_CELLS)) * cw;
      const z1 = (t.row0 + Math.min(t.rows, (py + 1) * PATCH_CELLS)) * ch;
      const fx = Math.max(Math.abs(x0 - region.focus[0]), Math.abs(x1 - region.focus[0]));
      const fz = Math.max(Math.abs(z0 - region.focus[1]), Math.abs(z1 - region.focus[1]));
      if (fx * fx + fz * fz >= colR * colR) return false;
      if (t.level === 0) return true;
      // A coarser patch hides only where every L0 tile under it is resident (the mask's test).
      const tx0 = Math.floor(x0 / 0.064 / 256);
      const tx1 = Math.min(L0.tilesX - 1, Math.floor((x1 / 0.064 - 1e-6) / 256));
      const tz0 = Math.floor(z0 / 0.1 / 256);
      const tz1 = Math.min(L0.tilesY - 1, Math.floor((z1 / 0.1 - 1e-6) / 256));
      for (let ty = tz0; ty <= tz1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) if (!atlas.isResident(L0.firstTile + ty * L0.tilesX + tx)) return false;
      }
      return true;
    };
    let hiddenPatches = 0;
    for (const { id, mask } of sel.draw) {
      const slot = atlas.slotOf(id);
      if (slot < 0) continue;
      atlas.touch(id);
      drawn.set(id, mask);
      const pm = atlas.patchMax(id);
      const t = tileInfo(grid, id);
      const { cw, ch } = cellSize(grid, t.level);
      const cellWorld = Math.max(cw, ch);
      for (let b = 0; b < 16; b++) {
        if (!(mask & (1 << b))) continue;
        const maxV = pm[b];
        if (!(maxV > 0)) continue; // all zero: the floor shows the same ground
        const px = b % PATCHES_PER_SIDE;
        const py = (b / PATCHES_PER_SIDE) | 0;
        const bb = patchBounds(grid, id, px, py, heightBound(maxV));
        if (!boxVisible(planes, bb)) continue;
        if (insideColumns(t, px, py)) {
          hiddenPatches++;
          continue;
        }
        const d = boxDistance(pos.x, pos.y, pos.z, bb);
        let sub = 1;
        if (maxSub > 1) {
          const cellPx = orthographic ? cellWorld * projScale : (cellWorld * projScale) / Math.max(d, 1e-3);
          while (sub < maxSub && cellPx / sub > SUB_TARGET_PX) sub *= 2;
        }
        list.push({ id, slot, px, py, d, sub, t });
      }
    }
    list.sort((a, b) => a.d - b.d);
    const counts = new Map();
    let n = 0;
    let triangles = 0;
    for (const sub of [1, 2, 4]) {
      if (sub > maxSub) {
        const L = hfLevels.get(sub);
        if (L) { L.mesh.visible = false; L.geometry.instanceCount = 0; }
        continue;
      }
      let k = 0;
      for (const p of list) if (p.sub === sub) k++;
      if (!k) {
        const L = hfLevels.get(sub);
        if (L) { L.mesh.visible = false; L.geometry.instanceCount = 0; }
        continue;
      }
      const L = hfLevel(sub);
      const A = L.inst.a.array;
      const B = L.inst.b.array;
      const C = L.inst.c.array;
      const D = L.inst.d.array;
      let i = 0;
      for (const p of list) {
        if (p.sub !== sub || i >= L.inst.capacity) continue;
        const { id, slot, px, py, t } = p;
        const Lv = grid.levels[t.level];
        const { cw, ch } = cellSize(grid, t.level);
        const o = i * 4;
        A[o] = slot; A[o + 1] = px * PATCH_CELLS; A[o + 2] = py * PATCH_CELLS; A[o + 3] = 2 ** Lv.rowShift;
        B[o] = t.col0; B[o + 1] = t.row0; B[o + 2] = cw; B[o + 3] = ch;
        C[o] = id; C[o + 1] = Lv.tilesX; C[o + 2] = t.tx; C[o + 3] = t.ty;
        D[o] = Lv.tilesY; D[o + 1] = t.level; D[o + 2] = t.cols; D[o + 3] = t.rows;
        i++;
      }
      for (const attr of [L.inst.a, L.inst.b, L.inst.c, L.inst.d]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, i * 4);
        attr.needsUpdate = true;
      }
      L.inst.count = i;
      L.geometry.instanceCount = i;
      L.mesh.visible = i > 0;
      counts.set(sub, i);
      n += i;
      triangles += i * L.geometry.userData.triangles;
    }

    atlas.flush();
    if (mode.columns) {
      ensureColumns().update({
        enabled: true, focus: region.focus, radiusCells: region.radiusCells, nearCells: region.nearCells,
        budget: Math.round(get('geo.instanceBudget')), gap: get('geo.columnGap'), dataVersion: atlas.version,
        shape: get('geo.columnShape'), sides: Number(get('geo.cylinderSides')), edges: get('geo.coinEdges'),
        thickness: get('geo.coinThickness'),
      });
    } else if (columns) {
      columns.update({ enabled: false, gap: get('geo.columnGap') });
    }
    if (labels && get('display.labels')) {
      const r = labels.update(cam, labelsElement.clientWidth, labelsElement.clientHeight);
      if (r && r.blockStep) U.gridBlockStep.value = r.blockStep;
      if (r && r.amountRows && r.amountRows !== lastAmountRows) {
        lastAmountRows = r.amountRows;
        shading.setGridRows(r.amountRows);
      }
    }
    let resident = 0;
    for (let id = 0; id < tileCount; id++) if (atlas.isResident(id)) resident++;
    flashes.update(performance.now(), 1 / projScale);
    stats.flashes = flashes.stats.active;
    stats.columns = columns && mode.columns ? columns.state.drawn : 0;
    stats.columnTiles = columns && mode.columns ? columns.state.tiles : 0;
    stats.columnRadius = columns && mode.columns ? columns.state.effectiveCells : 0;
    stats.instances = n + stats.columns;
    stats.patches = n;
    stats.patchesUnderColumns = hiddenPatches;
    stats.tiles = drawn.size;
    stats.resident = resident;
    stats.selected = sel.selected;
    stats.desired = sel.desired.length;
    stats.columnShape = columns && mode.columns ? columns.state.shape : null;
    const cs = columns && mode.columns && columns.state.tiles > 0 ? columns.state : null;
    stats.triangles = triangles + (cs ? cs.near * cs.trianglesPerColumn + cs.far * cs.trianglesFar : 0);
    stats.patchesBySub = { 1: counts.get(1) || 0, 2: counts.get(2) || 0, 4: counts.get(4) || 0 };
    stats.lodMs = performance.now() - t0;

    const key = sel.desired.join(',');
    if (key !== lastDesiredKey) {
      lastDesiredKey = key;
      lastDesired = sel.desired;
      return sel.desired;
    }
    return null;
  }

  // ---- frames ----------------------------------------------------------------------------
  function applyFrame(frame) {
    if (!frame) return;
    const tA = performance.now();
    const protect = new Set(lastDesired);
    const blk = frame.block;
    const flashSize = get('amp.flashSize');
    let onDeltaCell = null;
    const candidates = [];
    if (flashSize > 0 && Number.isFinite(blk) && frame.deltas && frame.deltas.ids && frame.deltas.ids.length) {
      const H = Math.max(1e-3, get('amp.heatHalfLife'));
      const thr = get('amp.flashThreshold');
      const infoCache = new Map();
      onDeltaCell = (id, li, cpu, o, nd, src) => {
        const hb = nd[src + 2];
        if (hb !== blk) return;
        const newHeat = nd[src + 1];
        if (!(newHeat > 0)) return;
        if (!drawn.has(id)) return;
        const oldHeat = cpu[o + 1];
        const decayed = oldHeat > 0 ? oldHeat * 2 ** (-(hb - cpu[o + 2]) / H) : 0;
        const added = newHeat - decayed;
        if (!(added > 0)) return;
        const sy = (li / SLOT) | 0;
        const lx = li - sy * SLOT - 1;
        const ly = sy - 1;
        if (lx < 0 || ly < 0 || lx > 255 || ly > 255) return; // border copies belong to the neighbour
        let t = infoCache.get(id);
        if (!t) infoCache.set(id, (t = tileInfo(grid, id)));
        const col = t.col0 + lx;
        const row = t.row0 + ly;
        const btc = added; // heat is the cell's raw BTC sum (SPEC §3)
        if (btc < thr) return;
        const { cw, ch } = cellSize(grid, t.level);
        // xEnd: world x of the cell's newest block, so a wide coarse cell touching the
        // creation edge counts as young (its spends are mostly of young coins).
        // btcCell: mean per L0 cell, so a coarse cell's sum does not look like one whale spend.
        candidates.push({ x: (col + 0.5) * cw, xEnd: (col + 1) * cw, z: (row + 0.5) * ch, btc,
          btcCell: btc / cellArea(grid, t.level, col, row), h: nd[src] });
      };
    }
    const r = atlas.applyFrame(frame, { protectSet: protect, onDeltaCell });
    stats.deltaCells = r.deltaCells;
    stats.fullTiles += r.fullIds.length;
    if (Number.isFinite(blk)) {
      if (blk < currentBlock || frame.reason === 'seek') flashes.clear();
      setBlock(blk);
    }
    if (candidates.length) {
      for (const c of candidates) c.y = heightAt(c.x, c.z);
      flashes.spawn(candidates, { size: flashSize, reference: get('amp.heatReference'), edge: get('amp.heatEdge'), block: blk, edgeBlocks: get('amp.heatEdgeBlocks') });
    }
    stats.applyMs = performance.now() - tA;
    stats.applyMsTotal = (stats.applyMsTotal || 0) + stats.applyMs;
    stats.framesApplied = (stats.framesApplied || 0) + 1;
  }

  function setBlock(block) {
    currentBlock = block;
    U.block.value = block;
    placeNowPlane();
  }

  // ---- CPU sampling: heightAt / pick / focusDistance -------------------------------------
  function drawnTileAt(x, z) {
    for (let l = 0; l < grid.levels.length; l++) {
      const { cw, ch } = cellSize(grid, l);
      const col = Math.floor(x / cw);
      const row = Math.floor(z / ch);
      const id = tileOfCell(grid, l, col, row);
      if (id < 0) return null;
      const mask = drawn.get(id);
      if (mask === undefined) continue;
      const t = tileInfo(grid, id);
      const b = (((row - t.row0) / PATCH_CELLS) | 0) * PATCHES_PER_SIDE + (((col - t.col0) / PATCH_CELLS) | 0);
      if (mask & (1 << b)) return { id, level: l, t, cw, ch, col, row };
    }
    // Fall back to the finest resident level.
    for (let l = 0; l < grid.levels.length; l++) {
      const { cw, ch } = cellSize(grid, l);
      const col = Math.floor(x / cw);
      const row = Math.floor(z / ch);
      const id = tileOfCell(grid, l, col, row);
      if (id >= 0 && atlas.isResident(id)) return { id, level: l, t: tileInfo(grid, id), cw, ch, col, row };
    }
    return null;
  }

  function cellHeightCpu(id, t, lx, ly, p) {
    const c = atlas.cell(id, Math.max(-1, Math.min(256, lx)), Math.max(-1, Math.min(256, ly)));
    if (!c) return 0;
    const L = grid.levels[t.level];
    return heightOfCpu(c[0], (t.row0 + ly) * 2 ** L.rowShift, p);
  }

  function heightAt(x, z) {
    if (!(x >= 0 && z >= 0 && x < worldW && z < worldD)) return 0;
    const d = drawnTileAt(x, z);
    if (!d) return 0;
    const p = shading.heightParams();
    const { id, t, cw, ch } = d;
    if (mode.stepped) return cellHeightCpu(id, t, d.col - t.col0, d.row - t.row0, p);
    const u = x / cw - 0.5 - t.col0;
    const v = z / ch - 0.5 - t.row0;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fx = u - i0;
    const fy = v - j0;
    const h00 = cellHeightCpu(id, t, i0, j0, p);
    const h10 = cellHeightCpu(id, t, i0 + 1, j0, p);
    const h01 = cellHeightCpu(id, t, i0, j0 + 1, p);
    const h11 = cellHeightCpu(id, t, i0 + 1, j0 + 1, p);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  function cellAt(x, z) {
    const d = drawnTileAt(x, z);
    if (!d) return null;
    const { id, t, level } = d;
    const c = atlas.cell(id, d.col - t.col0, d.row - t.row0);
    const H = Math.max(1e-3, get('amp.heatHalfLife'));
    const heatNow = c && c[1] > 0 ? c[1] * 2 ** (-Math.max(0, currentBlock - c[2]) / H) : 0;
    return {
      level, col: d.col, row: d.row, l0Col: Math.floor(x / 0.064), l0Row: Math.floor(z / 0.1),
      value: c ? c[0] : 0, heat: heatNow, heatBlock: c ? c[2] : 0, colorValue: c ? c[3] : 0, tile: id,
    };
  }

  // March a ray against the drawn surface; returns the ray distance of the first hit or null.
  // Steps never exceed half a cell of the level drawn at the current point (horizontally),
  // so thin prisms and spikes are not skipped; the crossing is refined by bisection.
  function intersect(ray, { maxDist = 5000, coarse = false } = {}) {
    const o = ray.origin;
    const dir = ray.direction;
    let gmax = 0;
    for (let id = 0; id < tileCount; id++) if (atlas.tileMaxValue[id] > gmax) gmax = atlas.tileMaxValue[id];
    const top = heightBound(gmax) + 0.5;
    let t0 = 0;
    let t1 = maxDist;
    const lo = [0, -0.02, 0];
    const hi = [worldW, top, worldD];
    const oo = [o.x, o.y, o.z];
    const dd = [dir.x, dir.y, dir.z];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dd[k]) < 1e-12) {
        if (oo[k] < lo[k] || oo[k] > hi[k]) return null;
        continue;
      }
      let a = (lo[k] - oo[k]) / dd[k];
      let b = (hi[k] - oo[k]) / dd[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    const horiz = Math.hypot(dd[0], dd[2]);
    const f = (t) => oo[1] + dd[1] * t - heightAt(oo[0] + dd[0] * t, oo[2] + dd[2] * t);
    const stepAt = (t) => {
      if (coarse) return 0.5 / Math.max(horiz, 0.05);
      const dTile = drawnTileAt(oo[0] + dd[0] * t, oo[2] + dd[2] * t);
      const cell = dTile ? Math.min(dTile.cw, dTile.ch) : 0.064;
      return Math.max(1e-4, (0.45 * cell) / Math.max(horiz, 1e-6));
    };
    let prevT = t0;
    if (f(t0) <= 0) return t0;
    let steps = 0;
    for (let t = t0 + Math.min(stepAt(t0), t1 - t0); ; ) {
      const ft = f(t);
      if (ft <= 0) {
        let a = prevT;
        let b = t;
        for (let i = 0; i < 30; i++) {
          const m = (a + b) / 2;
          if (f(m) > 0) a = m;
          else b = m;
        }
        return b;
      }
      if (t >= t1 || ++steps > 200000) break;
      prevT = t;
      t = Math.min(t1, t + stepAt(t));
    }
    return null;
  }

  function pick(ray) {
    const t = intersect(ray);
    if (t === null) return null;
    const p = new Vector3().copy(ray.direction).multiplyScalar(t).add(ray.origin);
    const c = cellAt(p.x, p.z);
    if (!c) return null;
    return { x: p.x, y: p.y, z: p.z, ...c };
  }

  const _ray = { origin: new Vector3(), direction: new Vector3() };
  function focusDistance(cam = camera) {
    cam.getWorldPosition(_ray.origin);
    cam.getWorldDirection(_ray.direction);
    const t = intersect(_ray, { coarse: true });
    if (t !== null) return t;
    // Ground plane fallback.
    if (_ray.direction.y < -1e-6) return -_ray.origin.y / _ray.direction.y;
    return 100;
  }

  function dispose() {
    if (unsubscribe) unsubscribe();
    object3d.removeFromParent();
    disposeLevels();
    floor.geometry.dispose();
    floorMat.dispose();
    nowPlane.geometry.dispose();
    nowMat.dispose();
    shading.dispose();
    atlas.dispose();
    columns?.dispose();
    labels?.dispose();
    flashes.dispose();
  }

  return {
    object3d, applyFrame, setBlock, update, pick, heightAt, focusDistance, stats, dispose,
    // extras for dev pages and tests
    atlas, shading, grid, cellAt, get mode() { return mode; }, get drawn() { return drawn; },
    get meshes() { return { heightfield: [...hfLevels.values()].map((L) => L.mesh), floor, nowPlane, columns: columns ? columns.mesh : null }; },
    get flashes() { return flashes; },
    get columnState() { return columns ? columns.state : null; },
  };
}
