// Browser checks for the terrain (render_terrain). Used with landscape/tools/browser-check.mjs:
//   --url 'http://127.0.0.1:12992/dev/render_terrain-real.html?...' --wait-for 'window.__ready'
//   --script FILE  where FILE contains e.g.
//   const m = await import('/dev/render_terrain-checks.js'); return m.atlasConsistency(window.__dev);
import * as P from '../render/terrain/palette.js';
import { tileInfo, cellArea, SLOT_CELLS } from '../data/grid.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GPU atlas buffer == CPU copy (every float of every used slot), and CPU copy == the
 * worker's exact cell state for random cells (values, colour values and decayed heat). */
export async function atlasConsistency(d, { samples = 400, seed = 99 } = {}) {
  const atlas = d.terrain.atlas;
  const out = { block: d.replay.block };
  if (d.backend === 'webgpu') {
    const buf = await d.renderer.getArrayBufferAsync(atlas.attribute);
    const gpu = new Float32Array(buf);
    const cpu = atlas.data;
    let mism = 0;
    let checked = 0;
    let slots = 0;
    for (let s = 0; s < atlas.capacity; s++) {
      if (atlas.slotTile[s] < 0) continue;
      slots++;
      const base = s * SLOT_CELLS * 4;
      for (let i = 0; i < SLOT_CELLS * 4; i++) {
        checked++;
        if (gpu[base + i] !== cpu[base + i]) mism++;
      }
    }
    out.gpuVsCpu = { slots, checked, mismatches: mism };
  }
  const grid = d.terrain.grid;
  const resident = [];
  for (let s = 0; s < atlas.capacity; s++) if (atlas.slotTile[s] >= 0) resident.push(atlas.slotTile[s]);
  let st = seed >>> 0;
  const rnd = () => (st = (Math.imul(st, 1103515245) + 12345) >>> 0) / 4294967296;
  const meas = d.replay.measures;
  const H = d.settings.get('amp.heatHalfLife');
  let checked = 0;
  let occupied = 0;
  let mismatches = 0;
  let heatCells = 0;
  let heatMismatches = 0;
  for (let k = 0; k < samples; k++) {
    const id = resident[Math.floor(rnd() * resident.length)];
    const t = tileInfo(grid, id);
    const lx = Math.floor(rnd() * t.cols);
    const ly = Math.floor(rnd() * t.rows);
    const col = t.col0 + lx;
    const row = t.row0 + ly;
    const ex = await d.replay.cell(t.level, col, row);
    if (!ex) continue;
    const area = cellArea(grid, t.level, col, row);
    const m = (name) => (name === 'count' ? ex.countSmall + ex.countLarge
      : name === 'value' ? (ex.satsSmall + ex.satsLarge) / 1e8 : ex.countSmall + ex.satsLarge / 5e8);
    const hv = Math.fround(m(meas.height) / area);
    const cv = Math.fround(m(meas.color) / area);
    const c = atlas.cell(id, lx, ly);
    checked++;
    if (hv > 0) occupied++;
    if (!c || Math.abs(c[0] - hv) > 1e-6 * Math.max(1, hv) || Math.abs(c[3] - cv) > 1e-6 * Math.max(1, cv)) mismatches++;
    if (c && ex.heat !== undefined) {
      const mine = c[1] > 0 ? c[1] * Math.pow(2, -(d.replay.block - c[2]) / H) : 0;
      const theirs = ex.heat / area;
      if (ex.heat > 0) heatCells++;
      if (Math.abs(mine - theirs) > 1e-5 * Math.max(1e-3, theirs)) heatMismatches++;
    }
  }
  out.cpuVsWorker = { checked, occupied, mismatches, heatCells, heatMismatches };
  return out;
}

/** Film exactness: samples screen pixels of an orthographic top-down view (cell interiors
 * at least 3 px wide) and returns the expected palette bytes from transferIndex and the
 * palettes; compare them with the screenshot PNG. */
export function filmExpectations(d, { n = 4000, seed = 12345 } = {}) {
  const s = d.settings;
  const cam = d.camera;
  const W = innerWidth;
  const Hh = innerHeight;
  const transfer = { offset: s.get('color.offset'), upper: s.get('color.upper'), gamma: s.get('color.gamma') };
  const base = P.paletteRGB(s.get('color.palette'), { gradient: s.get('color.gradient'), reverse: s.get('color.reverse') });
  const hot = s.get('color.whiteHot') ? P.paletteRGB(s.get('color.palette'), { gradient: s.get('color.gradient'), reverse: s.get('color.reverse'), whiteHot: true }) : base;
  const whiteRow = d.terrain.shading.state.whiteRow;
  const ground = P.parseColor(s.get('color.ground'));
  const grid = d.terrain.grid;
  const left = cam.position.x + cam.left / cam.zoom;
  const right = cam.position.x + cam.right / cam.zoom;
  const topZ = cam.position.z - cam.top / cam.zoom;
  const botZ = cam.position.z - cam.bottom / cam.zoom;
  let st = seed >>> 0;
  const rnd = () => (st = (Math.imul(st, 1103515245) + 12345) >>> 0) / 4294967296;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const px = Math.floor(rnd() * W);
    const py = Math.floor(rnd() * Hh);
    const x = left + ((px + 0.5) / W) * (right - left);
    const z = topZ + ((py + 0.5) / Hh) * (botZ - topZ);
    const c = d.terrain.cellAt(x, z);
    if (!c) continue;
    const L = grid.levels[c.level];
    const cw = 0.064 * 2 ** L.columnShift;
    const ch = 0.1 * 2 ** L.rowShift;
    const pxPerCell = cw / ((right - left) / W);
    if (pxPerCell < 3) continue;
    const fx = x / cw - c.col;
    const fz = z / ch - c.row;
    const m = 1.0 / pxPerCell + 0.02;
    if (fx < m || fx > 1 - m || fz < m || fz > 1 - m) continue;
    const idx = P.transferIndex(c.colorValue, transfer);
    const l0row = c.row * 2 ** L.rowShift;
    let rgb;
    if (idx < 0) rgb = ground;
    else {
      const t = l0row <= whiteRow ? hot : base;
      rgb = [t[idx * 3], t[idx * 3 + 1], t[idx * 3 + 2]];
    }
    pts.push({ px, py, rgb, idx, level: c.level, row: c.row, col: c.col, whale: l0row <= whiteRow });
  }
  return { n: pts.length, whiteRow, pts };
}

/** GPU and CPU timing over a window (needs ?ts=1 on the dev page). */
export async function timing(d, { warmMs = 2500, ms = 4000 } = {}) {
  await sleep(warmMs);
  const g = window.__gpu;
  g.render.length = 0;
  g.compute.length = 0;
  g.cpuUpdate.length = 0;
  await sleep(ms);
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
  };
  const s = d.terrain.stats;
  return {
    frames: g.render.length, gpuMs: q(g.render, 0.5), gpuP90: q(g.render, 0.9), computeMs: q(g.compute, 0.5),
    updateCpuMs: q(g.cpuUpdate, 0.5), triangles: s.triangles, patches: s.patches, patchesBySub: s.patchesBySub,
    columns: s.columns, columnRadius: s.columnRadius, tiles: s.tiles, resident: s.resident,
    width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio, mode: d.terrain.mode,
  };
}

/** Switches presets and structural settings at runtime, then disposes the terrain. */
export async function runtimeSwitches(d, { names = ['Film', 'Performance', 'Balanced', 'High', 'Ultra', 'Extreme', 'High'] } = {}) {
  const log = [];
  for (const name of names) {
    d.settings.applyPreset(name);
    await sleep(700);
    log.push({ preset: name, mode: d.terrain.mode, instances: d.terrain.stats.instances, capacity: d.terrain.stats.capacity });
  }
  for (const [id, v] of [['geo.stepped', true], ['geo.stepped', false], ['geo.subdivision', 4], ['geo.smoothing', 'none'],
    ['geo.wireframe', true], ['geo.wireframe', false], ['geo.skirts', false], ['display.labels', false], ['display.labels', true],
    ['color.palette', 'magma'], ['amp.curve', 'linear'], ['geo.tileBudget', 64]]) {
    d.settings.set(id, v);
    await sleep(300);
  }
  log.push({ after: 'settings', mode: d.terrain.mode, instances: d.terrain.stats.instances });
  return log;
}

