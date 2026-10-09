// UTXO Timelapse Landscape: app shell (landscape/SPEC.md §8).
//
// Creates the settings store, the replay client and the view, wires worker frames to the
// view, settings to their consumers, and runs the frame loop:
//   controls -> playback -> view.update -> replay.setTiles (when desired tiles change) -> view.render
// ?webgl=1 forces WebGL2, ?data=URL picks the dataset (default: the current dataset named by
// /dataset/index.json online, /dataset/ locally), ?explorer=URL the cell API (default: the
// native explorer on 127.0.0.1:12989 locally, this site online), ?explorer2d=URL the 2D link,
// ?startup=adaptive|high the first-visit quality (ui/online.js). The URL hash keeps b, cam,
// mode and the settings preset and overrides.

import { createPlayback, SPEEDS, STEP_LARGE } from './ui/playback.js';
import { decodeHash, encodeHash } from './ui/hash.js';
import { resolvePlace } from './ui/places.js';
import { createControls, isTypingTarget } from './ui/controls.js';
import { createHud } from './ui/hud.js';
import { createTimeline } from './ui/timeline.js';
import { createPlacesMenu } from './ui/places-menu.js';
import { createLegend } from './ui/legend.js';
import { createMinimap } from './ui/minimap.js';
import { createInspector } from './ui/inspector.js';
import { createHelp } from './ui/help.js';
import { createToast } from './ui/toast.js';
import { createLoading } from './ui/loading.js';
import { fmtInt, escapeHtml } from './ui/format.js';
import { resolveEndpoints, resolveDataUrl, startupMode, chooseStartup, deviceTraits } from './ui/online.js';
import { gridFromManifest, worldX, worldZ } from './data/grid.js';
import { FILM_AXIS } from './data/axis.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The real modules; a dev page can pass stubs to startApp instead. */
export async function loadDeps() {
  const [client, render, schema, settings, panel] = await Promise.all([
    import('./client/replay-client.js'),
    import('./render/index.js'),
    import('./settings.schema.js'),
    import('./settings.js'),
    import('./ui/panel.js'),
  ]);
  return {
    createReplayClient: client.createReplayClient,
    createLandscapeView: render.createLandscapeView,
    probeCapabilities: render.probeCapabilities,
    SCHEMA: schema.SCHEMA,
    PRESETS: schema.PRESETS,
    createSettingsStore: settings.createSettingsStore,
    createPanel: panel.createPanel,
  };
}

export async function startApp(deps = null, { query = new URLSearchParams(location.search) } = {}) {
  const $ = (id) => document.getElementById(id);
  const loading = createLoading($('loading'));
  const toast = createToast($('toast'));
  const notice = (message, kind = 'info', key = null) => toast.show(message, kind, key);
  const hook = (window.__landscape = { ready: false, error: null });
  const forceWebGL = query.get('webgl') === '1';
  const endpoints = resolveEndpoints({ hostname: location.hostname, origin: location.origin, query });
  const explorerBase = endpoints.apiBase;
  let dataUrl = new URL(query.get('data') || '/dataset/', location.href).href;
  let stage = 'modules';

  try {
    loading.set('Loading modules');
    deps = deps || (await loadDeps());

    stage = 'gpu';
    loading.set('Checking the GPU');
    const caps = deps.probeCapabilities
      ? await deps.probeCapabilities({ forceWebGL })
      : { webgpu: !forceWebGL && 'gpu' in navigator, backend: !forceWebGL && 'gpu' in navigator ? 'webgpu' : 'webgl2' };
    hook.capabilities = caps;

    // Settings precedence: startup preset (High, capped on WebGL2) < localStorage < URL hash.
    // Online, a first visit (nothing saved, nothing in the link) starts at an adaptive quality.
    const store = deps.createSettingsStore(deps.SCHEMA, deps.PRESETS, { capabilities: caps });
    let stored = false;
    try {
      stored = store.load() === true;
    } catch (err) {
      console.warn('settings: stored values ignored', err);
    }
    const initial = decodeHash(location.hash);
    const startup = chooseStartup({
      mode: startupMode({ query, local: endpoints.local }), firstVisit: !stored && !initial.settings,
      backend: forceWebGL ? 'webgl2' : caps.backend || (caps.webgpu ? 'webgpu' : 'webgl2'), ...deviceTraits(),
    });
    if (startup) {
      store.applyPreset(startup.preset);
      store.setMany(startup.settings);
      hook.startup = startup;
    }
    if (initial.settings) {
      try {
        store.fromURL(location.hash);
      } catch (err) {
        notice('Some settings in the link were not applied', 'warn');
      }
    }

    stage = 'data';
    loading.set('Opening the dataset');
    dataUrl = await resolveDataUrl({ query, href: location.href });
    const replay = await deps.createReplayClient({ dataUrl, maxResidentTiles: store.get('geo.tileBudget'), chunkCacheMB: 512 });
    const manifest = replay.manifest;
    const grid = gridFromManifest(manifest);
    const tip = manifest.tip;
    const axis = manifest.axis || FILM_AXIS;
    let lastStatus = null;
    replay.onStatus((s) => {
      lastStatus = s;
      if (!hook.ready) loading.status(s);
    });
    replay.onError((err) => {
      console.error('replay', err);
      notice('Replay: ' + (err && err.message ? err.message : String(err)), 'error', 'replay-error');
    });

    stage = 'renderer';
    loading.set('Starting the renderer');
    const canvas = $('view');
    const view = await deps.createLandscapeView({
      canvas, settings: store, manifest, rows: replay.rows, blocktimes: replay.blocktimes,
      forceWebGL, labelsElement: $('labels'), overlayElement: $('overlay'),
    });
    if (typeof store.setCapabilities === 'function') {
      store.setCapabilities({ ...(view.capabilities || {}), backend: view.backend, webgpu: view.backend === 'webgpu' });
    }
    if (view.backend === 'webgl2' && !forceWebGL) notice('WebGPU is unavailable here; using WebGL2 with presets up to High', 'warn');

    // ---- settings -> worker ----------------------------------------------------
    const applyMeasures = () => {
      const height = store.get('amp.measure');
      const colour = store.get('color.measure');
      replay.setMeasures({ height, color: colour === 'height' ? height : colour });
    };
    applyMeasures();
    replay.setHeatHalfLife(store.get('amp.heatHalfLife'));
    replay.setMaxResidentTiles(store.get('geo.tileBudget'));

    // ---- UI --------------------------------------------------------------------
    const playback = createPlayback({ replay, tip, snapshots: replay.snapshotBlocks || [] });
    const crosshair = $('crosshair');
    let hashDirty = true;

    const controls = createControls({
      view, canvas, settings: store,
      onInspect: (x, y) => inspectAt(x, y),
      onNotice: notice,
      onModeChange: (mode) => {
        crosshair.hidden = mode !== 'flight';
        document.body.classList.toggle('flight', mode === 'flight');
        hashDirty = true;
        notice(mode === 'flight' ? 'Flight: mouse to look, WASD to fly, E/Q up and down, Esc for map mode' : 'Map mode', 'info', 'mode');
      },
    });
    const hud = createHud($('hud'));
    const help = createHelp($('help'));
    const legend = createLegend({ container: $('legend'), settings: store });
    const minimap = createMinimap({
      container: $('minimap'), grid, rows: replay.rows, settings: store,
      onNavigate: (x, z, { dragging }) => moveViewTo(x, z, dragging),
    });
    const inspector = createInspector({
      container: $('inspector'), marker: $('marker'), replay, grid, rows: replay.rows, blocktimes: replay.blocktimes,
      axis, explorerBase, link2d: endpoints.link2d, local: endpoints.local,
      camera: view.camera, canvas, heightAt: (x, z) => view.heightAt(x, z),
    });
    const placesMenu = createPlacesMenu({
      container: $('places'), tip, blocktimes: replay.blocktimes, rows: replay.rows,
      onPlace: (id) => flyToPlace(id).catch((err) => notice(String(err.message || err), 'warn')),
    });
    const panel = deps.createPanel({
      container: $('panel'), store, schema: deps.SCHEMA, presets: deps.PRESETS, capabilities: view.capabilities,
      onExport: (json) => ({ ...json, view: viewState() }),
      onImport: (json) => restoreView(json && json.view),
      getShareURL: () => location.origin + location.pathname + location.search + currentHash(),
    });
    const timeline = createTimeline({
      container: $('timeline'), tip, blocktimes: replay.blocktimes, playback,
      onSeek: (b) => playback.seek(b),
      onNotice: notice,
      onPlaces: () => placesMenu.toggle(),
      onSettings: () => togglePanel(),
      onHelp: () => help.toggle(),
    });

    const panelOpen = () => !!(panel && typeof panel.isOpen === 'function' && panel.isOpen());
    // The panel is either open or fully hidden: a collapsed lil-gui title bar would sit on top
    // of the inspector. syncPanel also catches a collapse from the panel's own title bar.
    let panelShown = null;
    function syncPanel() {
      const open = panelOpen();
      if (open === panelShown) return;
      panelShown = open;
      if (!open && typeof panel.hide === 'function') panel.hide();
      $('panel').classList.toggle('open', open);
      document.body.classList.toggle('panel-open', open);
    }
    function togglePanel(force) {
      if (!panel) return;
      const want = force === undefined ? !panelOpen() : force;
      if (want) panel.open();
      else panel.close();
      syncPanel();
    }
    if (panel) {
      panel.close();
      syncPanel();
    }

    function applyDisplay() {
      $('hud').hidden = !store.get('display.hud');
      $('legend').hidden = !store.get('display.legend');
      $('minimap').hidden = !store.get('display.minimap');
    }
    applyDisplay();

    store.subscribe('*', (changes) => {
      const ids = new Set(changes.map((c) => c.id));
      if (ids.has('amp.measure') || ids.has('color.measure')) applyMeasures();
      if (ids.has('amp.heatHalfLife')) replay.setHeatHalfLife(store.get('amp.heatHalfLife'));
      if (ids.has('geo.tileBudget')) replay.setMaxResidentTiles(store.get('geo.tileBudget'));
      if (ids.has('display.hud') || ids.has('display.legend') || ids.has('display.minimap')) applyDisplay();
      hashDirty = true;
    });

    playback.onEvent((type, detail) => {
      if (type === 'end') notice('Reached block ' + fmtInt(detail.block) + ', the last block in this dataset', 'info', 'end');
      if (type === 'error') notice('Playback stopped: ' + (detail && detail.message ? detail.message : String(detail)), 'error');
    });

    // ---- frames -> view ----------------------------------------------------------
    let gotData = false;
    replay.onFrame((frame) => {
      minimap.applyFrame(frame);
      view.applyFrame(frame);
      view.setBlock(frame.block);
      if (!frame.partial && frame.block != null) gotData = true;
      hook.lastFrame = { seq: frame.seq, block: frame.block, reason: frame.reason, partial: frame.partial, full: (frame.full || []).length, deltas: frame.deltas && frame.deltas.ids ? frame.deltas.ids.length : 0, stats: frame.stats };
    });

    // ---- camera helpers ----------------------------------------------------------
    function focus() {
      const p = controls.centerPoint();
      return p ? { x: p.x, y: p.y, z: p.z } : { x: worldX(tip) / 2, y: 0, z: worldZ(grid.rows / 2) };
    }
    function ground(x, z) {
      let h = 0;
      try {
        h = view.heightAt(x, z);
      } catch {
        h = 0;
      }
      return Number.isFinite(h) ? h : 0;
    }
    function overviewPose() {
      // The whole chain on a diagonal: genesis far away at the upper left, recent eras close at
      // the lower right, so the relief reads in 3D. Distance scales with the dataset length and
      // is widened for narrow windows and narrow fields of view.
      const w = worldX(tip + 1);
      const target = { x: w * 0.58, y: 0, z: worldZ(grid.rows) * 0.5 };
      const cam = view.camera;
      const vfov = ((cam.fov || 50) * Math.PI) / 180;
      const aspect = cam.aspect || canvas.clientWidth / Math.max(1, canvas.clientHeight);
      const fit = Math.max(1, 16 / 9 / Math.max(0.2, aspect)) * (Math.tan((25 * Math.PI) / 180) / Math.tan(vfov / 2));
      const distance = Math.max(40, w * 0.66 * fit);
      return controls.poseLookingAt(target, { distance, yaw: 36, pitch: -31 });
    }
    function moveViewTo(x, z, immediate) {
      const pose = controls.getPose();
      const c = focus();
      const pos = { x: pose.x + (x - c.x), y: pose.y, z: pose.z + (z - c.z) };
      pos.y = Math.max(pos.y, ground(pos.x, pos.z) + 0.05);
      if (immediate) controls.setPose({ ...pos, yaw: pose.yaw, pitch: pose.pitch });
      else controls.flyTo({ position: pos, duration: 0.6 });
    }

    async function flyToPlace(place) {
      const p = resolvePlace(place, { tip, minAmt: replay.rows });
      if (!p) throw new Error('Unknown place: ' + place);
      if (controls.mode === 'flight') controls.setMode('map');
      if (p.kind === 'era') {
        const f = focus();
        const target = { x: worldX(p.block) - 9, y: 0, z: clamp(f.z, worldZ(300), worldZ(1900)) };
        target.y = ground(target.x, target.z);
        const pose = controls.poseLookingAt(target, { distance: 75, yaw: 28, pitch: -30 });
        notice(p.title + ' \u00b7 block ' + fmtInt(p.block), 'info', 'place');
        await Promise.all([playback.seek(p.block), controls.flyTo(pose)]);
      } else {
        const f = focus();
        const edge = worldX((replay.block ?? tip) + 1);
        const span = (p.rowMax - p.rowMin + 1) / 10;
        const target = { x: clamp(f.x, 4, Math.max(4, edge - 4)), y: 0, z: worldZ((p.rowMin + p.rowMax + 1) / 2) };
        target.y = ground(target.x, target.z);
        const pose = controls.poseLookingAt(target, { distance: clamp(span * 3, 16, 170), yaw: 0, pitch: -26 });
        notice(p.label + ' \u00b7 ' + (p.rowMin === p.rowMax ? 'row ' + fmtInt(p.rowMin) : 'rows ' + fmtInt(p.rowMin) + '\u2013' + fmtInt(p.rowMax)), 'info', 'place');
        await controls.flyTo(pose);
      }
      hashDirty = true;
      return p;
    }

    async function inspectAt(x, y) {
      let hit = null;
      try {
        hit = view.pick(x, y);
      } catch (err) {
        notice('Pick failed: ' + (err && err.message ? err.message : err), 'error');
        return null;
      }
      if (!hit) {
        notice('No terrain under the cursor', 'info', 'inspect');
        return null;
      }
      return inspector.open(hit);
    }

    // ---- URL hash ---------------------------------------------------------------------
    const currentHash = () => encodeHash({ block: replay.block, mode: controls.mode, cam: controls.getPose() }, store.toURL());
    const viewState = () => ({ b: replay.block, cam: controls.getPose(), mode: controls.mode });
    function restoreView(v) {
      if (!v) return;
      if (v.cam) controls.setPose(v.cam);
      if (v.mode === 'flight' || v.mode === 'map') controls.setMode(v.mode);
      if (Number.isInteger(v.b)) playback.seek(clamp(v.b, 0, tip));
    }
    let written = location.hash;
    let lastHashCheck = 0;
    let lastBlockForHash = null;
    function syncHash(now) {
      if (now - lastHashCheck < 400) return;
      lastHashCheck = now;
      const block = replay.block;
      if (!hashDirty && block === lastBlockForHash && !controls.moving) return;
      if (controls.moving && now - (syncHash.lastWrite || 0) < 1500) return;
      const h = currentHash();
      lastBlockForHash = block;
      hashDirty = false;
      if (h !== written) {
        history.replaceState(null, '', h || location.pathname + location.search);
        written = h;
        syncHash.lastWrite = now;
      }
    }
    window.addEventListener('hashchange', () => {
      if (location.hash === written) return;
      written = location.hash;
      const h = decodeHash(location.hash);
      if (h.settings) store.fromURL(location.hash);
      if (h.cam) controls.flyTo({ position: h.cam, yaw: h.cam.yaw, pitch: h.cam.pitch });
      if (h.mode) controls.setMode(h.mode);
      if (h.block != null && h.block !== replay.block) playback.seek(clamp(h.block, 0, tip));
    });

    // ---- keyboard -------------------------------------------------------------------
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || (e.target && e.target.closest && e.target.closest('#panel input, #panel select, #panel textarea'))) return;
      if (help.open && !['Escape', 'KeyH', 'Slash'].includes(e.code)) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          playback.toggle();
          break;
        case 'BracketLeft':
          e.preventDefault();
          playback.step(e.shiftKey ? -STEP_LARGE : -1);
          break;
        case 'BracketRight':
          e.preventDefault();
          playback.step(e.shiftKey ? STEP_LARGE : 1);
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4': {
          const s = SPEEDS[Number(e.code.slice(5)) - 1];
          playback.setSpeed(s.id);
          notice('Speed ' + s.label, 'info', 'speed');
          break;
        }
        case 'KeyI': {
          const p = controls.inspectPoint();
          if (p) inspectAt(p.x, p.y);
          break;
        }
        case 'KeyF':
          controls.toggleFlight();
          break;
        case 'KeyG':
          togglePanel();
          break;
        case 'KeyP':
          placesMenu.toggle();
          break;
        case 'KeyH':
          help.toggle();
          break;
        case 'Slash':
          if (e.shiftKey) help.toggle();
          break;
        case 'Escape':
          if (controls.mode === 'flight') controls.setMode('map');
          else if (help.open) help.close();
          else if (placesMenu.open) placesMenu.close();
          else if (inspector.isOpen) inspector.close();
          else if (panelOpen()) togglePanel(false);
          break;
        default:
      }
    });
    window.addEventListener('resize', () => {
      try {
        view.resize();
      } catch (err) {
        console.warn(err);
      }
    });

    // ---- start -------------------------------------------------------------------------
    if (initial.cam) controls.setPose(initial.cam);
    else {
      const o = overviewPose();
      controls.setPose({ x: o.position.x, y: o.position.y, z: o.position.z, yaw: o.yaw, pitch: o.pitch });
    }
    if (initial.mode === 'flight') controls.setMode('flight');
    controls.update(0);
    const first = view.update(0);
    if (first && first.desiredTiles) replay.setTiles(first.desiredTiles);
    const startBlock = clamp(initial.block ?? tip, 0, tip);
    stage = 'seek';
    loading.set('Replaying to block ' + fmtInt(startBlock));
    playback.seek(startBlock).catch((err) => {
      hook.error = String(err && err.message ? err.message : err);
      notice('Seek failed: ' + hook.error, 'error');
    });

    Object.assign(hook, {
      settings: store, replay, view, controls, playback, panel, manifest, grid,
      ui: { hud, timeline, legend, minimap, inspector, placesMenu, help, toast },
      seek: (b) => playback.seek(b),
      flyTo: (place) => flyToPlace(place),
      inspect: (x, y) => inspectAt(x, y),
      hash: () => currentHash(),
      state: () => ({
        ready: hook.ready, block: replay.block, busy: replay.busy, playback: playback.state,
        mode: controls.mode, pose: controls.getPose(), backend: view.backend, preset: store.preset,
        inspector: inspector.isOpen ? inspector.current : null, status: lastStatus,
      }),
      idle: () => !replay.busy && !playback.state.op && replay.block != null,
    });

    let last = performance.now();
    let lastDesired = '';
    let lastBlockSeen = null;
    let errors = 0;
    const seenErrors = new Map(); // message -> last time logged (dedupe per 5 s)
    function frame(now) {
      requestAnimationFrame(frame);
      const dt = clamp((now - last) / 1000, 0, 0.1);
      last = now;
      try {
        controls.update(dt);
        playback.tick(dt);
        const u = view.update(dt);
        const desired = u && u.desiredTiles;
        if (desired) {
          const key = desired.join(',');
          if (key !== lastDesired) {
            lastDesired = key;
            replay.setTiles(desired);
          }
        }
        const r = view.render();
        if (r && typeof r.catch === 'function') r.catch((err) => console.error('render', err));
        if (gotData && !hook.ready) {
          hook.ready = true;
          loading.done();
          if (startup && startup.notice) notice(startup.notice, 'info', 'startup');
        }
        const block = replay.block;
        const pstate = playback.state;
        hud.update({ block, meta: replay.meta, playback: pstate, status: lastStatus, backend: view.backend, preset: store.preset, scale: view.stats && view.stats.scale });
        timeline.update(block, pstate);
        if (block !== lastBlockSeen) {
          lastBlockSeen = block;
          inspector.onBlock(block, { playing: pstate.playing });
        }
        inspector.updateMarker();
        syncPanel();
        if (!$('minimap').hidden) minimap.draw({ block, pose: controls.getPose(), footprint: controls.footprint() });
        syncHash(now);
        errors = 0;
      } catch (err) {
        errors++;
        const msg = err && err.message ? err.message : String(err);
        const lastLogged = seenErrors.get(msg);
        if (lastLogged === undefined || now - lastLogged > 5000) {
          seenErrors.set(msg, now);
          console.error('frame', err);
          notice('Frame error: ' + msg, 'error', 'frame-error');
        }
        hook.frameError = { message: msg, count: errors };
        if (!hook.ready && errors === 30) loading.problem('The renderer fails on every frame: ' + msg);
      }
    }
    requestAnimationFrame(frame);
    return hook;
  } catch (err) {
    hook.error = String(err && err.stack ? err.stack : err);
    showFatal(loading, stage, err, dataUrl, endpoints.local);
    throw err;
  }
}

function showFatal(loading, stage, err, dataUrl, local) {
  const msg = escapeHtml(err && err.message ? err.message : String(err));
  const hints = local ? {
    modules: '<p>A module failed to load. Serve the app with <code>node landscape/tools/serve.mjs</code> from the repository root, then reload.</p>',
    gpu: '<p>The GPU check failed. Try another browser, or force the fallback with <code>?webgl=1</code>.</p>',
    data: '<p>No landscape dataset answered at <code>' + escapeHtml(dataUrl) + '</code>. Start the server with a built dataset:</p>' +
      '<pre>node landscape/tools/serve.mjs --data "/Volumes/4T Data/buv_render/landscape_966827"</pre>',
    renderer: '<p>The renderer could not start. WebGPU needs Safari 26+ or a current Chrome; <code>?webgl=1</code> uses WebGL2.</p>',
    seek: '<p>The first replay failed.</p>',
  } : {
    modules: '<p>Part of the app failed to load. Reload the page.</p>',
    gpu: '<p>The GPU check failed. Try a current Chrome or Safari, or add <code>?webgl=1</code> to the address to use WebGL2.</p>',
    data: '<p>The dataset could not be loaded. Reload the page; if this persists, try again later.</p>',
    renderer: '<p>The renderer could not start. WebGPU needs Safari 26+ or a current Chrome; <code>?webgl=1</code> uses WebGL2.</p>',
    seek: '<p>The first replay failed. Reload the page.</p>',
  };
  loading.fatal(stage === 'data' ? 'The dataset is not available.' : 'The landscape could not start.',
    (hints[stage] || '') + '<p class="loading-error">' + msg + '</p>');
}

if (!globalThis.__LANDSCAPE_NO_AUTOSTART__) {
  startApp().catch((err) => console.error('startApp', err));
}
