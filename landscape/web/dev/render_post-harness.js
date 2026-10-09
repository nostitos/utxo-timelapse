// Dev harness for render_post pages (not part of the app).
// URL parameters: preset=High, terrain=stub|real, data=/dataset/, block=N, webgl=1, overlay=0|1,
// cam=overview|close|low|far|top, set=id:value,id:value, w/h (fixed canvas CSS size).
import { SCHEMA, PRESETS } from '../settings.schema.js';
import { createSettingsStore } from '../settings.js';
import { createLandscapeView, probeCapabilities } from '../render/index.js';

// Camera placements as fractions of the landscape width (x = block / 1000).
export const CAMERAS = {
  overview: { pos: [0.5, 170, 360], look: [0.5, 0, 100] },
  close: { pos: [0.662, 22, 175], look: [0.62, 3, 130] },
  low: { pos: [0.54, 6, 150], look: [0.58, 4, 100] },
  far: { pos: [0.12, 60, 260], look: [0.62, 0, 80] },
  top: { pos: [0.5, 420, 103.7], look: [0.5, 0, 103.6] },
};

function parseValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text);
  return text;
}

export function setCamera(view, name, width = 966.848) {
  const c = CAMERAS[name] || CAMERAS.overview;
  view.camera.position.set(c.pos[0] * width, c.pos[1], c.pos[2]);
  view.camera.lookAt(c.look[0] * width, c.look[1], c.look[2]);
  view.camera.updateMatrixWorld();
}

export async function startHarness({ canvas, overlayElement = null, labelsElement = null, params = new URLSearchParams(location.search) }) {
  const forceWebGL = params.get('webgl') === '1';
  const probe = await probeCapabilities({ forceWebGL });
  const store = createSettingsStore(SCHEMA, PRESETS, { capabilities: probe, storage: null });
  const preset = params.get('preset') || 'High';
  store.applyPreset(preset);
  if (params.get('overlay') !== '0') store.set('display.overlay', true);
  const sets = params.get('set');
  if (sets) {
    for (const part of sets.split(',')) {
      const i = part.indexOf(':');
      if (i > 0) store.set(part.slice(0, i), parseValue(part.slice(i + 1)));
    }
  }
  store.flush && store.flush();
  const terrainMode = params.get('terrain') || 'stub';
  let createTerrain = null;
  let replay = null;
  let manifest = null;
  let rows = null;
  let blocktimes = null;
  if (terrainMode === 'stub') {
    createTerrain = (await import('../render/stub-terrain.js')).createTerrain;
  } else {
    const { createReplayClient } = await import('../client/replay-client.js');
    replay = await createReplayClient({ dataUrl: params.get('data') || '/dataset/', maxResidentTiles: store.get('geo.tileBudget') });
    ({ manifest, rows, blocktimes } = replay);
    const hm = store.get('amp.measure');
    const cm = store.get('color.measure');
    replay.setMeasures({ height: hm, color: cm === 'height' ? hm : cm });
    replay.setHeatHalfLife(store.get('amp.heatHalfLife'));
  }
  const view = await createLandscapeView({ canvas, settings: store, forceWebGL, overlayElement, labelsElement, createTerrain, manifest, rows, blocktimes });
  if (store.setCapabilities) store.setCapabilities(view.capabilities);
  const width = manifest ? manifest.numBlocks / 1000 : 966.848;
  setCamera(view, params.get('cam') || 'overview', width);
  let framesIn = 0;
  if (replay) {
    replay.onFrame((f) => { framesIn++; view.applyFrame(f); if (f.block !== null && f.block !== undefined) view.setBlock(f.block); });
    replay.onError((e) => console.error('replay', e));
  }

  let frames = 0;
  let last = performance.now();
  const frameLog = [];
  let logging = false;
  view.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const { desiredTiles } = view.update(dt);
    if (replay && desiredTiles) replay.setTiles(desiredTiles);
    view.render();
    frames++;
    if (logging) frameLog.push({ t: now, frameMs: view.stats.frameMs, cpuMs: view.stats.cpuMs, gpuMs: view.stats.gpuMs, passes: { ...view.stats.gpuPasses } });
  });

  const median = (a) => {
    const v = a.filter(Number.isFinite).sort((x, y) => x - y);
    return v.length ? v[v.length >> 1] : NaN;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFrames(n) {
    const target = frames + n;
    const t0 = performance.now();
    while (frames < target && performance.now() - t0 < 60000) await wait(16);
    return frames;
  }

  /** Measures for the given time: frame interval, CPU encode time and GPU timestamps. */
  async function measure(ms = 4000) {
    frameLog.length = 0;
    const t0 = performance.now();
    const f0 = frames;
    logging = true;
    await wait(ms);
    logging = false;
    const elapsed = performance.now() - t0;
    const n = frames - f0;
    const intervals = [];
    for (let i = 1; i < frameLog.length; i++) intervals.push(frameLog[i].t - frameLog[i - 1].t);
    const passNames = new Set();
    for (const f of frameLog) for (const k of Object.keys(f.passes || {})) passNames.add(k);
    const passes = {};
    for (const k of passNames) passes[k] = Number(median(frameLog.map((f) => f.passes[k])).toFixed(3));
    return {
      frames: n, seconds: Number((elapsed / 1000).toFixed(2)), fps: Number(((n * 1000) / elapsed).toFixed(1)),
      frameMs: Number(median(intervals).toFixed(2)), cpuMs: Number(median(frameLog.map((f) => f.cpuMs)).toFixed(2)),
      gpuMs: Number(median(frameLog.map((f) => f.gpuMs)).toFixed(2)), passes,
      width: view.stats.width, height: view.stats.height, scale: view.stats.scale,
      triangles: view.stats.triangles, drawCalls: view.stats.drawCalls, instances: view.stats.instances,
      stages: view.stats.stages, error: view.stats.error,
    };
  }

  async function applyPreset(name, extra = {}) {
    store.applyPreset(name);
    if (params.get('overlay') !== '0') store.set('display.overlay', true);
    for (const [k, v] of Object.entries(extra)) store.set(k, v);
    store.flush && store.flush();
    await waitFrames(3);
  }

  async function settle(maxMs = 30000) {
    const t0 = performance.now();
    while (replay && replay.busy && performance.now() - t0 < maxMs) await wait(100);
  }

  /**
   * Renders each preset in turn and measures it. Returns one row per preset with wall-clock
   * window bounds (epoch ms) so external GPU-utilisation samples can be matched.
   */
  async function runBench({ presets = ['Film', 'Performance', 'Balanced', 'High', 'Ultra', 'Extreme'], warmMs = 2500, measureMs = 4000, cam = null, extra = {} } = {}) {
    if (cam) setCamera(view, cam, width);
    // Throwaway warm-up: tile streaming, shader compilation and caches settle first.
    await applyPreset('High', extra);
    await settle();
    await wait(Number(params.get('initialWarm') || 8000));
    await settle();
    const rows = [];
    const repeat = Math.max(1, Number(params.get('repeat') || 1));
    const overrideTable = params.get('override') ? JSON.parse(params.get('override')) : {};
    for (let pass = 0; pass < repeat; pass++) for (const entry of presets) {
      // "Preset:alias" applies the preset, then overrideTable[alias] (candidate definitions).
      const [name, alias] = entry.split(':');
      const overrides = overrideTable[alias || name] || {};
      await applyPreset(name, { ...extra, ...overrides });
      await settle();
      await wait(warmMs);
      await settle();
      const startEpoch = Date.now();
      const m = await measure(measureMs);
      const ts = view.terrain.stats || {};
      rows.push({ preset: alias ? name + ':' + alias : name, pass, overrides, startEpoch, endEpoch: Date.now(), ...m,
        terrain: { instances: ts.instances, columns: ts.columns, tiles: ts.tiles, resident: ts.resident, triangles: ts.triangles } });
    }
    return rows;
  }

  /**
   * Cost sweep: measures a base preset, then the base with each delta applied on its own.
   * deltas: [{name, set: {id: value}}]. Rows carry gpuMs and the difference to the base.
   */
  async function runSweep({ base = 'High', baseSet = {}, deltas = [], warmMs = 2000, measureMs = 3000, cam = null } = {}) {
    if (cam) setCamera(view, cam, width);
    const rows = [];
    const one = async (name, set) => {
      await applyPreset(base, { ...baseSet, ...set });
      await settle();
      await wait(warmMs);
      await settle();
      const startEpoch = Date.now();
      const m = await measure(measureMs);
      const ts = view.terrain.stats || {};
      return { name, set, startEpoch, endEpoch: Date.now(), ...m,
        terrain: { instances: ts.instances, columns: ts.columns, tiles: ts.tiles, resident: ts.resident, triangles: ts.triangles } };
    };
    const b = await one('base:' + base, {});
    rows.push(b);
    for (const d of deltas) {
      const r = await one(d.name, d.set);
      r.deltaGpuMs = Number((r.gpuMs - b.gpuMs).toFixed(2));
      rows.push(r);
    }
    return rows;
  }

  const dev = { view, store, probe, replay, setCamera: (n) => setCamera(view, n, width), measure, waitFrames, applyPreset, settle, runBench, runSweep, CAMERAS,
    get frames() { return frames; }, get framesIn() { return framesIn; } };
  window.__dev = dev;
  await waitFrames(5);
  if (replay) {
    const block = Math.min(Number(params.get('block') || 314000), manifest.tip);
    const t0 = performance.now();
    dev.seek = await replay.seek(block);
    dev.seekMs = performance.now() - t0;
    const tw = performance.now();
    while ((replay.busy || !(view.terrain.stats && view.terrain.stats.instances > 0)) && performance.now() - tw < 30000) await wait(100);
    await waitFrames(10);
  }
  window.__ready = true;
  return dev;
}
