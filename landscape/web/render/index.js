// createLandscapeView (render_post): renderer, camera, environment, terrain, post-processing,
// resolution scale and the performance overlay behind one object. See landscape/SPEC.md §6.
import { Scene, PerspectiveCamera, Raycaster, Vector2, Vector3, Matrix4 } from 'three/webgpu';
import { createRenderContext, probeCapabilities } from './context.js';
import { createEnvironment } from './env.js';
import { createPost } from './post.js';
import { createOverlay, createGpuTimer } from './overlay.js';
import { AutoScaler, clampScale, internalSize } from './scale.js';
import { readSettings } from './post-plan.js';

export { probeCapabilities };

const CAMERA_FAR = 6000;
// Ground to the horizon (Earth's sea): from high up the far plane would cut the sea a few
// degrees below the horizon, and the thin haze along those rays would leave the cut visible
// as a line with the sky's colour beneath the horizon. The far plane then moves out until the
// haze between the camera and the sea at that distance is opaque (optical depth 5), at most
// this far. The near plane sets the depth precision, so a farther far plane costs little.
const HORIZON_FAR_MAX = 400000;
const HORIZON_OPTICAL_DEPTH = 5;

/**
 * Far plane for a camera at height y over a floor that reaches the horizon, under the
 * exponential height fog of render/env.js (density at the ground, falloff per unit height).
 * The fog's optical depth from height y to the ground over a distance d is about
 * density × d × (1 − e^(−falloff·y)) / (falloff·y).
 */
export function horizonFar(y, density, falloff) {
  if (!(density > 0)) return HORIZON_FAR_MAX;
  const ky = Math.max(0, falloff) * Math.max(0, y);
  const perUnit = ky > 1e-6 ? -Math.expm1(-ky) / ky : 1;
  return Math.min(HORIZON_FAR_MAX, Math.max(CAMERA_FAR, HORIZON_OPTICAL_DEPTH / (density * perUnit)));
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {object} o.settings store with get(id) and subscribe(filter, fn)
 * @param {object} [o.manifest] @param {Float64Array} [o.rows] @param {Uint32Array} [o.blocktimes]
 * @param {boolean} [o.forceWebGL]
 * @param {HTMLElement} [o.labelsElement] @param {HTMLElement} [o.overlayElement]
 * @param {Function} [o.createTerrain] terrain factory override (dev pages use the stub)
 */
export async function createLandscapeView({
  canvas, settings, manifest = null, rows = null, blocktimes = null, forceWebGL = false,
  labelsElement = null, overlayElement = null, createTerrain = null,
} = {}) {
  if (!canvas) throw new Error('createLandscapeView: canvas required');
  const ctx = await createRenderContext({ canvas, forceWebGL });
  const { renderer, capabilities } = ctx;

  const scene = new Scene();
  scene.name = 'utxo-landscape';
  const readGroundHorizon = () => {
    try { return !!(settings && typeof settings.get === 'function' && settings.get('geo.groundHorizon')); } catch { return false; }
  };
  let s = readSettings(settings);
  let groundHorizon = readGroundHorizon();
  const camera = new PerspectiveCamera(Number(s['camera.fov']) || 50, 16 / 9, 0.05, CAMERA_FAR);
  camera.name = 'view-camera';
  camera.position.set(483, 170, 360);
  camera.lookAt(483, 0, 100);
  camera.updateMatrixWorld();

  const env = createEnvironment({ renderer, scene, camera, capabilities });
  env.sync(s, { groundHorizon });

  let terrainFactory = createTerrain;
  if (!terrainFactory) terrainFactory = (await import('./terrain/index.js')).createTerrain;
  const terrain = await terrainFactory({ renderer, scene, camera, settings, manifest, rows, blocktimes, capabilities, labelsElement });
  if (terrain.object3d && !terrain.object3d.parent) scene.add(terrain.object3d);

  // Ambient occlusion stops at the landscape's edge (the ground beyond it is flat).
  const g = terrain.grid;
  const aoBounds = g && g.numBlocks > 0 && g.rows > 0 ? [0, 0, g.numBlocks / 1000, g.rows / 10] : null;
  const post = createPost({ renderer, scene, camera, env, capabilities, aoBounds });
  const timer = capabilities.timestamp ? createGpuTimer(renderer, { resolveLabel: (rt) => post.labelForTarget(rt) }) : null;
  const overlay = createOverlay(overlayElement, { capabilities });
  const scaler = new AutoScaler({
    enabled: !!s['display.autoScale'], min: Number(s['display.scaleMin']), max: Number(s['display.scaleMax']),
    targetFps: Number(s['display.targetFps']), scale: Number(s['display.scale']),
  });

  let scale = clampScale(Number(s['display.scale']) || 1);
  let lastCss = '';
  let dirty = true;
  let rebuilds = 0;
  let workerStats = null;
  const stats = {
    backend: capabilities.backend, fps: NaN, frameMs: NaN, cpuMs: NaN, gpuMs: NaN, gpuPasses: {},
    triangles: 0, drawCalls: 0, instances: 0, tiles: 0, resident: 0, maxTiles: capabilities.maxTileBudget,
    scale, dpr: 1, width: 0, height: 0, autoScale: false, targetFps: 60, stages: [], worker: null,
    rebuilds: 0, error: null,
  };

  function cssSize() {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    return [w, h, (typeof window !== 'undefined' && window.devicePixelRatio) || 1];
  }

  function resize(force = false) {
    const [w, h, dpr] = cssSize();
    const key = w + 'x' + h + '@' + dpr + '*' + scale;
    if (!force && key === lastCss) return false;
    lastCss = key;
    const size = internalSize(w, h, dpr, scale, capabilities.maxDimension || 16384);
    renderer.setPixelRatio(size.pixelRatio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const db = renderer.getDrawingBufferSize(new Vector2());
    stats.width = db.x;
    stats.height = db.y;
    stats.dpr = dpr;
    stats.scale = scale;
    return true;
  }

  function syncSettings() {
    s = readSettings(settings);
    groundHorizon = readGroundHorizon();
    env.sync(s, { groundHorizon });
    if (post.sync(s)) {
      rebuilds++;
      scaler.reset(performance.now());
    }
    ctx.setDisplayP3(!!(post.plan && post.plan.p3));
    const fov = Number(s['camera.fov']);
    if (Number.isFinite(fov) && fov > 1 && fov < 170 && fov !== camera.fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    const autoScale = !!s['display.autoScale'];
    scaler.configure({
      enabled: autoScale, min: Number(s['display.scaleMin']), max: Number(s['display.scaleMax']),
      targetFps: Number(s['display.targetFps']), scale: autoScale ? scale : Number(s['display.scale']),
    });
    const nextScale = autoScale ? scaler.scale : clampScale(Number(s['display.scale']) || 1);
    if (nextScale !== scale) { scale = nextScale; resize(true); }
    stats.autoScale = autoScale;
    stats.targetFps = Number(s['display.targetFps']);
    overlay.setVisible(!!s['display.overlay']);
    stats.stages = post.stages;
    stats.error = post.lastError;
    dirty = false;
  }

  let unsubscribe = null;
  if (settings && typeof settings.subscribe === 'function') {
    unsubscribe = settings.subscribe('*', () => { dirty = true; });
  }

  syncSettings();
  resize(true);

  // Camera near plane follows the height above the terrain (depth precision for close flight);
  // over a floor that reaches the horizon the far plane follows the height too (horizonFar).
  // Both move in quarter-octave steps, so the projection only changes now and then.
  let nearKey = 0;
  let farKey = 0;
  function adaptClipPlanes() {
    let ground = 0;
    try { ground = terrain.heightAt(camera.position.x, camera.position.z) || 0; } catch { ground = 0; }
    const above = Math.max(0.005, camera.position.y - Math.max(0, ground));
    const near = Math.min(2, Math.max(0.01, above * 0.01));
    const k = Math.round(Math.log2(near) * 4);
    const far = groundHorizon
      ? horizonFar(camera.position.y, Number(s['light.fogDensity']), Number(s['light.fogHeightFalloff']))
      : CAMERA_FAR;
    const fk = Math.ceil(Math.log2(far / CAMERA_FAR) * 4);
    if (k !== nearKey || fk !== farKey) {
      nearKey = k;
      farKey = fk;
      camera.near = Math.pow(2, k / 4);
      camera.far = CAMERA_FAR * Math.pow(2, fk / 4);
      camera.updateProjectionMatrix();
    }
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const viewProjection = new Matrix4();
  let lastFrameTime = NaN;
  let fpsEMA = NaN;
  let frameEMA = NaN;
  let cpuEMA = NaN;
  let lastDt = 1 / 60;

  const view = {
    get backend() { return capabilities.backend; },
    capabilities,
    renderer,
    scene,
    camera,
    terrain,
    env,
    post,
    stats,

    setBlock(block) { if (terrain.setBlock) terrain.setBlock(block); },
    /** Plane mode: column detail reach times farther, moved shift radii ahead (0, 1 = centred on the camera). */
    setDetailAhead(shift, reach) { if (terrain.setDetailAhead) terrain.setDetailAhead(shift, reach); },
    /** fn(list, {block, reason, now}) for each frame's new flash sprites (ui/flash-sound.js); returns an unsubscribe function. */
    onFlashes(fn) { return terrain.onFlashes ? terrain.onFlashes(fn) : () => {}; },
    /** Camera position and view-projection matrix (column-major, valid until the next call). */
    cameraView() {
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      return { x: camera.position.x, y: camera.position.y, z: camera.position.z, elements: viewProjection.elements };
    },
    applyFrame(frame) {
      if (frame && frame.stats) workerStats = frame.stats;
      if (terrain.applyFrame) terrain.applyFrame(frame);
    },
    setWorkerStats(ws) { workerStats = ws; },

    update(dt) {
      lastDt = Number.isFinite(dt) && dt > 0 ? dt : lastDt;
      if (dirty) syncSettings();
      resize();
      adaptClipPlanes();
      camera.updateMatrixWorld();
      env.update(camera, stats.height || 1);
      const [, h, dpr] = cssSize();
      const desiredTiles = terrain.update ? terrain.update(camera, h * dpr) : null;
      if (post.plan && post.plan.dof) {
        let fd = null;
        if (s['fx.dofAutoFocus']) { try { fd = terrain.focusDistance(camera); } catch { fd = null; } }
        post.setFocus(fd, s);
      }
      return { desiredTiles: desiredTiles || null };
    },

    render() {
      const t0 = performance.now();
      post.render(lastDt);
      const t1 = performance.now();
      const cpu = t1 - t0;
      if (Number.isFinite(lastFrameTime)) {
        const frameMs = t0 - lastFrameTime;
        frameEMA = Number.isFinite(frameEMA) ? frameEMA * 0.9 + frameMs * 0.1 : frameMs;
        fpsEMA = 1000 / frameEMA;
        if (timer) timer.poll();
        const gpu = timer ? timer.last.total : NaN;
        const next = scaler.sample(frameMs, gpu, t0);
        if (next !== null && next !== scale) { scale = next; resize(true); }
      }
      lastFrameTime = t0;
      cpuEMA = Number.isFinite(cpuEMA) ? cpuEMA * 0.9 + cpu * 0.1 : cpu;
      stats.fps = fpsEMA;
      stats.frameMs = frameEMA;
      stats.cpuMs = cpuEMA;
      if (timer) {
        stats.gpuMs = timer.last.total;
        stats.gpuSpanMs = timer.last.span;
        stats.gpuSumMs = timer.last.sum;
        stats.gpuPasses = timer.last.passes;
        stats.gpuPassesInclusive = timer.last.inclusive;
      }
      const info = renderer.info.render;
      stats.triangles = info.triangles;
      stats.drawCalls = info.drawCalls;
      const ts = terrain.stats || {};
      stats.instances = ts.instances || 0;
      stats.columns = ts.columns || 0;
      stats.columnRadius = ts.columnRadius || 0;
      stats.columnRequested = ts.columnRequested || 0;
      stats.columnNeeded = ts.columnNeeded || 0;
      stats.columnBudget = ts.columnBudget || 0;
      stats.uniformLevel = ts.uniformLevel ?? null;
      stats.uniformDeferred = ts.uniformDeferred || 0;
      stats.uniformCoarser = ts.uniformCoarser || 0;
      stats.columnAhead = ts.columnAhead || 0;
      stats.tiles = ts.tiles ?? 0;
      stats.resident = ts.resident ?? 0;
      stats.terrainTriangles = ts.triangles;
      stats.ssaa = post.plan ? post.plan.ssaa : 1;
      if (ts.maxTiles) stats.maxTiles = ts.maxTiles;
      stats.scale = scale;
      stats.worker = workerStats;
      stats.rebuilds = rebuilds;
      stats.textures = renderer.info.memory ? renderer.info.memory.textures : undefined;
      stats.geometries = renderer.info.memory ? renderer.info.memory.geometries : undefined;
      if (typeof performance !== 'undefined' && performance.memory) stats.memory = performance.memory.usedJSHeapSize;
      overlay.update(stats, t1);
    },

    resize() { resize(true); },

    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      return terrain.pick ? terrain.pick(raycaster.ray) : null;
    },

    heightAt(x, z) { return terrain.heightAt ? terrain.heightAt(x, z) : 0; },

    focusDistance() { return terrain.focusDistance ? terrain.focusDistance(camera) : null; },

    /** Optional: drive frames with three's animation loop (plain rAF in main.js also works). */
    setAnimationLoop(fn) { return renderer.setAnimationLoop(fn); },

    /** Current GPU timing breakdown and pipeline description (tests, benchmarks). */
    describe() {
      return {
        backend: capabilities.backend, plan: post.plan, stages: post.stages, error: post.lastError,
        width: stats.width, height: stats.height, scale, rebuilds,
        gpuMs: stats.gpuMs, gpuSpanMs: stats.gpuSpanMs, gpuSumMs: stats.gpuSumMs, gpuPasses: stats.gpuPasses,
        gpuPassesInclusive: stats.gpuPassesInclusive, gpuMedianMs: timer ? timer.median() : NaN,
        gpuDetail: timer ? timer.detail : null,
      };
    },

    dispose() {
      if (unsubscribe) unsubscribe();
      renderer.setAnimationLoop(null);
      if (timer) timer.dispose();
      post.dispose();
      if (terrain.dispose) terrain.dispose();
      env.dispose();
      ctx.dispose();
    },
  };
  return view;
}
