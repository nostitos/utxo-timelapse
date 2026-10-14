// UTXO Timelapse Landscape: app shell (landscape/SPEC.md §8).
//
// Creates the settings store, the replay client and the view, wires worker frames to the
// view, settings to their consumers, and runs the frame loop:
//   follow tip -> controls -> playback -> view.update -> replay.setTiles (when desired tiles change) -> view.render
// ?webgl=1 forces WebGL2, ?data=URL picks the dataset (default: the current dataset named by
// /dataset/index.json online, /dataset/ locally), ?explorer=URL the cell API (default: the
// native explorer on 127.0.0.1:12989 locally, this site online), ?explorer2d=URL the 2D link,
// ?startup=adaptive|high the first-visit quality (ui/online.js). The URL hash keeps b, cam,
// mode, follow and the settings preset and overrides.

import { createPlayback, defaultStartBlock, SPEEDS, STEP_LARGE } from './ui/playback.js';
import { createTipFollow } from './ui/follow.js';
import { decodeHash, encodeHash } from './ui/hash.js';
import { resolvePlace } from './ui/places.js';
import { createControls, isTypingTarget } from './ui/controls.js';
import { createPlaneHud } from './ui/plane-hud.js';
import { createPlaneSound } from './ui/plane-sound.js';
import { createPlaneModel } from './render/plane-model.js';
import { CRAFTS, CRAFT_ORDER, craftSpec, nextCraft } from './ui/plane.js';
import { createStackSats, startStackSats, stopStackSats, stepStackSats } from './ui/stack-sats.js';
import { loadFun, saveFun, recordBest, bestOf } from './ui/fun-store.js';
import { createFunMenu, createFunCard } from './ui/fun-menu.js';
import { createCoins } from './render/coins.js';
import { createHud } from './ui/hud.js';
import { createTimeline } from './ui/timeline.js';
import { createPlacesMenu } from './ui/places-menu.js';
import { createLegend } from './ui/legend.js';
import { createMinimap } from './ui/minimap.js';
import { createInspector } from './ui/inspector.js';
import { createHover } from './ui/hover.js';
import { createHelp } from './ui/help.js';
import { createToast } from './ui/toast.js';
import { createLoading } from './ui/loading.js';
import { fmtInt, fmtAmount, escapeHtml } from './ui/format.js';
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
    // Follow tip: map and flight mode move along x with the delivered block (ui/follow.js).
    const follow = createTipFollow();
    const crosshair = $('crosshair');
    let hashDirty = true;
    // Plane mode needs a keyboard or mouse to steer; touch-only devices keep the map controls.
    const touchOnly = deviceTraits().coarseOnly;
    const MODE_NOTICES = {
      map: 'Map mode',
      flight: 'Flight: mouse to look, WASD to fly, E/Q up and down, Esc for map mode',
    };
    const planeSound = createPlaneSound();
    // Plane mode draws cylinders farther out and moves that disc ahead of the camera, by the
    // craft's detailReach and detailShift (the plane: 1.6x and 0.6 radii, so the sharp area
    // reaches about 2.5x as far in front of it).
    function applyDetail(mode) {
      if (typeof view.setDetailAhead !== 'function') return;
      if (mode === 'plane') {
        const S = craftSpec(controls.craft);
        view.setDetailAhead(S.detailShift, S.detailReach);
      } else view.setDetailAhead(0, 1);
    }
    let timeline = null;

    const controls = createControls({
      view, canvas, settings: store,
      extent: { minX: 0, maxX: worldX(tip + 1), minZ: 0, maxZ: worldZ(grid.rows) },
      canFly: !touchOnly,
      onInspect: (x, y) => inspectAt(x, y),
      onNotice: notice,
      onPad: (action) => {
        if (action === 'craft') cycleCraft();
        else if (action === 'game') startRun();
      },
      onModeChange: (mode) => {
        // Plane mode marks the nose with its own circle; the centre crosshair is flight mode's.
        crosshair.hidden = mode !== 'flight';
        document.body.classList.toggle('flight', mode === 'flight');
        document.body.classList.toggle('plane', mode === 'plane');
        applyDetail(mode);
        if (timeline) timeline.setFly(mode === 'flight');
        // Called inside the key press or click that takes off, so the browser lets the sound start.
        if (mode === 'plane') planeSound.start();
        else planeSound.stop();
        // Landing (or switching to flight mode) abandons a Stack sats run and closes its card.
        if (mode !== 'plane') abandonRun();
        hashDirty = true;
        const message = mode === 'plane' ? craftSpec(controls.craft).name + ' \u00b7 Enter stacks sats \u00b7 Esc to land' : MODE_NOTICES[mode] || 'Map mode';
        notice(message, 'info', 'mode');
      },
    });
    // The craft models and the coins need the real scene; dev pages with a stub view run without them.
    const planeModel = view.scene ? createPlaneModel({ scene: view.scene }) : null;
    const coinModels = view.scene ? createCoins({ scene: view.scene }) : null;
    const planeHud = createPlaneHud({
      container: $('planehud'), nose: $('plane-nose'), keys: $('planekeys'), pops: $('funpops'), camera: view.camera, canvas, grid,
      rows: replay.rows, blocktimes: replay.blocktimes, settings: store, sound: planeSound,
    });

    // ---- Fun: crafts and Stack sats (ui/fun-menu.js, ui/stack-sats.js) ------------------------
    const funData = loadFun();
    controls.setCraft(funData.craft);
    const game = createStackSats({ rows: replay.rows });
    const groundExtent = { minX: 0, maxX: worldX(tip + 1), minZ: 0, maxZ: worldZ(grid.rows) };
    const funMenu = createFunMenu({
      container: $('fun'),
      getCraft: () => controls.craft,
      getBest: (craft) => bestOf(funData, 'stack-sats', craft),
      onCraft: (id) => setCraft(id),
      onPlay: (kind) => {
        if (kind === 'stack-sats') startRun();
        else if (controls.mode !== 'plane') controls.setMode('plane');
      },
    });
    const funCard = createFunCard({
      container: $('funcard'),
      onAgain: () => startRun(),
      onLand: () => controls.setMode('map'),
    });

    /** Choose the craft (remembered); in flight it changes at once. Not during a Stack sats run. */
    function setCraft(id, { quiet = false } = {}) {
      if (!CRAFTS[id] || touchOnly) return false;
      if (game.running) {
        if (!quiet) notice('Change craft after this run', 'info', 'craft');
        return false;
      }
      controls.setCraft(id);
      funData.craft = id;
      saveFun(undefined, funData);
      if (controls.mode === 'plane') applyDetail('plane');
      funMenu.render();
      if (!quiet) notice(craftSpec(id).name + (controls.mode === 'plane' ? '' : ' \u00b7 T takes off'), 'info', 'craft');
      return true;
    }
    function cycleCraft() {
      return setCraft(nextCraft(controls.craft));
    }
    /** Start (or restart) a Stack sats run, taking off first in map or flight mode. */
    function startRun() {
      if (touchOnly) return;
      funCard.hide();
      funMenu.close();
      placesMenu.close();
      if (controls.mode !== 'plane') controls.setMode('plane');
      else controls.lock();
      if (controls.mode !== 'plane') return;
      startStackSats(game, controls.craft);
      notice('Stack sats: 60 s \u00b7 follow the coin trails', 'info', 'mode');
    }
    /** The minute is up: record the best for the craft and show the end card with a free cursor. */
    function finishRun() {
      const result = { sats: game.score, coins: game.collected };
      const r = recordBest(funData, 'stack-sats', game.craft, result);
      if (r.isBest) saveFun(undefined, funData);
      funMenu.render();
      controls.releaseLock();
      funCard.show({ ...result, seconds: game.duration, craft: game.craft, best: r.best, isBest: r.isBest });
    }
    function abandonRun() {
      stopStackSats(game);
      funCard.hide();
    }

    // Boxes closed with their × stay hidden until the page reloads; nothing is saved. Changing
    // the box's Overlays setting clears it, so Settings can bring it back without a reload.
    const dismissed = new Set();
    const dismiss = (id) => {
      dismissed.add(id);
      applyDisplay();
    };
    const hud = createHud($('hud'), { onDismiss: () => dismiss('hud') });
    const help = createHelp($('help'), { touchFirst: touchOnly });
    const legend = createLegend({ container: $('legend'), settings: store, onDismiss: () => dismiss('legend') });
    const minimap = createMinimap({
      container: $('minimap'), grid, rows: replay.rows, settings: store,
      onNavigate: (x, z, { dragging }) => moveViewTo(x, z, dragging),
      onDismiss: () => dismiss('minimap'),
    });
    const inspector = createInspector({
      container: $('inspector'), marker: $('marker'), replay, grid, rows: replay.rows, blocktimes: replay.blocktimes,
      axis, explorerBase, link2d: endpoints.link2d, local: endpoints.local,
      camera: view.camera, canvas, heightAt: (x, z) => view.heightAt(x, z),
    });
    // What the pointer (the crosshair in flight mode) is aimed at, from local data only, in a
    // card docked under the HUD.
    const hover = createHover({
      container: $('hover'), canvas, pick: (x, y) => view.pick(x, y), replay, grid, rows: replay.rows, blocktimes: replay.blocktimes,
      mode: () => controls.mode, anchor: $('hud'), enabled: !touchOnly,
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
      // The Performance section's live readout (ui/quick.js).
      perf: () => {
        const s = view.stats || {};
        const uniform = !!store.get('geo.uniform');
        const columnsOn = !uniform && view.backend === 'webgpu' && !!store.get('geo.columns');
        return {
          gpuMs: s.gpuMs, frameMs: s.frameMs, fps: s.fps,
          columns: columnsOn ? { drawn: s.columns || 0, needed: s.columnNeeded || 0, budget: s.columnBudget || store.get('geo.instanceBudget'),
            reach: s.columnRadius || 0, requested: s.columnRequested || 0 } : null,
          uniform: uniform && Number.isInteger(s.uniformLevel)
            ? { level: s.uniformLevel, short: (s.uniformDeferred || 0) > 0, coarser: s.uniformCoarser || 0 } : null,
        };
      },
    });
    timeline = createTimeline({
      container: $('timeline'), tip, blocktimes: replay.blocktimes, playback,
      onSeek: (b) => playback.seek(b),
      onNotice: notice,
      onPlaces: () => {
        funMenu.close();
        placesMenu.toggle();
      },
      onSettings: () => togglePanel(),
      onHelp: () => help.toggle(),
      onFollow: () => setFollow(!follow.active),
      onFly: touchOnly ? null : () => controls.toggleFlight(),
      onFun: touchOnly ? null : () => {
        // The menu needs the cursor: land first, as G, P and H do.
        if (controls.mode === 'plane') controls.setMode('map');
        placesMenu.close();
        funMenu.toggle();
      },
    });

    /** Turn Follow tip on or off; on, the camera stays put and moves on with the tip from here. */
    function setFollow(on, { quiet = false } = {}) {
      const want = !!on;
      if (want === follow.active) return;
      if (want) follow.enable(replay.block);
      else follow.disable();
      timeline.setFollow(want);
      hashDirty = true;
      if (!quiet) notice(want ? 'Following the tip' : 'Stopped following the tip', 'info', 'follow');
    }

    /**
     * Seek for an action that places the camera itself (Places, links, imported views, startup):
     * Follow tip starts again from the new block instead of moving the camera there. Every other
     * seek (scrubber, block and date fields, steps) moves a following camera with the tip.
     */
    function seekPlacingCamera(block) {
      follow.beginJump();
      const p = playback.seek(block);
      const done = () => follow.endJump(replay.block);
      p.then(done, done);
      return p;
    }

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
      $('hud').hidden = !store.get('display.hud') || dismissed.has('hud');
      $('legend').hidden = !store.get('display.legend') || dismissed.has('legend');
      $('minimap').hidden = !store.get('display.minimap') || dismissed.has('minimap');
    }
    applyDisplay();

    store.subscribe('*', (changes) => {
      const ids = new Set(changes.map((c) => c.id));
      if (ids.has('amp.measure') || ids.has('color.measure')) applyMeasures();
      if (ids.has('amp.heatHalfLife')) replay.setHeatHalfLife(store.get('amp.heatHalfLife'));
      if (ids.has('geo.tileBudget')) replay.setMaxResidentTiles(store.get('geo.tileBudget'));
      if (ids.has('display.hud')) dismissed.delete('hud');
      if (ids.has('display.legend')) dismissed.delete('legend');
      if (ids.has('display.minimap')) dismissed.delete('minimap');
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
      // Follow tip: every change of block moves a following camera. Plane mode holds it at every
      // frame, so no tip motion while flying (not even a frame just before landing) moves the
      // camera afterwards.
      if (controls.mode === 'plane') follow.hold(frame.block);
      else follow.frame(frame.block);
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
      // the lower right, so the relief reads in 3D. The view is aimed past the middle so the tip
      // edge and the amount scale beside it stay above the timeline and left of the screen edge.
      // Distance scales with the dataset length and is widened for narrow windows and narrow
      // fields of view.
      const w = worldX(tip + 1);
      const cam = view.camera;
      const vfov = ((cam.fov || 50) * Math.PI) / 180;
      const aspect = cam.aspect || canvas.clientWidth / Math.max(1, canvas.clientHeight);
      if (aspect < 1) {
        // Portrait (phones): look down the block axis from beyond the tip, recent eras in front and
        // genesis toward the top. The tip edge spans the width just above the timeline (leaving room
        // for the amount labels), and the pitch is solved so block 0 lands near the top. In camera
        // terms a ground point at horizontal distance d sits at depth d*cos + h*sin and height
        // d*sin - h*cos on the view axis (camera height h, downward pitch).
        const across = worldZ(grid.rows);
        const t = Math.tan(vfov / 2);
        const r = canvas.getBoundingClientRect();
        const tl = $('timeline');
        const tlTop = tl && !tl.hidden ? tl.getBoundingClientRect().top : r.bottom;
        const yNear = r.height > 0 ? clamp(1 - (2 * (tlTop - 44 - r.top)) / r.height, -0.9, -0.4) : -0.66;
        const yFar = 0.7;
        const nearDepth = across / (2 * aspect * t);
        const nearUp = yNear * nearDepth * t;
        const solve = (p) => {
          const c = Math.cos(p);
          const s = Math.sin(p);
          const back = nearDepth * c + nearUp * s;
          const h = nearDepth * s - nearUp * c;
          const far = back + w;
          return { back, h, y: (far * s - h * c) / ((far * c + h * s) * t) };
        };
        let lo = 0.05;
        let hi = 1.3;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (solve(mid).y < yFar) lo = mid;
          else hi = mid;
        }
        const pitch = (lo + hi) / 2;
        const { back, h } = solve(pitch);
        const ahead = h / Math.tan(pitch);
        return controls.poseLookingAt({ x: w + back - ahead, y: 0, z: across / 2 }, { distance: h / Math.sin(pitch), yaw: 90, pitch: (-pitch * 180) / Math.PI });
      }
      const target = { x: w * 0.64, y: 0, z: worldZ(grid.rows) * 0.5 };
      const fit = Math.max(1, 16 / 9 / Math.max(0.2, aspect)) * (Math.tan((25 * Math.PI) / 180) / Math.tan(vfov / 2));
      const distance = Math.max(40, w * 0.69 * fit);
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
      if (controls.mode !== 'map') controls.setMode('map');
      if (p.kind === 'era') {
        const f = focus();
        const target = { x: worldX(p.block) - 9, y: 0, z: clamp(f.z, worldZ(300), worldZ(1900)) };
        target.y = ground(target.x, target.z);
        const pose = controls.poseLookingAt(target, { distance: 75, yaw: 28, pitch: -30 });
        notice(p.title + ' \u00b7 block ' + fmtInt(p.block), 'info', 'place');
        await Promise.all([seekPlacingCamera(p.block), controls.flyTo(pose)]);
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
      const opened = inspector.open(hit);
      if (touchOnly) keepClearOfSheet(hit, x, y);
      return opened;
    }

    // On phones the inspector is a sheet over the bottom (portrait) or the right (landscape) of
    // the view. When it covers the tapped cell, slide the view so the cell shows beside it.
    function keepClearOfSheet(hit, x, y) {
      const sheet = $('inspector');
      if (!sheet || sheet.hidden) return;
      const s = sheet.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      const m = 24;
      if (x < s.left - m || x > s.right + m || y < s.top - m || y > s.bottom + m) return;
      if (s.width >= 0.9 * c.width) {
        const top = Math.max(c.top, $('hud').getBoundingClientRect().bottom);
        controls.panPointTo(hit, x, (top + s.top) / 2);
      } else {
        controls.panPointTo(hit, (c.left + s.left) / 2, y);
      }
    }

    // ---- URL hash ---------------------------------------------------------------------
    // Plane mode is not shared: a link made while flying opens in map mode at the camera.
    const shareMode = () => (controls.mode === 'plane' ? 'map' : controls.mode);
    const currentHash = () => encodeHash({ block: replay.block, mode: shareMode(), cam: controls.getPose(), follow: follow.active }, store.toURL());
    const viewState = () => ({ b: replay.block, cam: controls.getPose(), mode: shareMode(), follow: follow.active });
    function restoreView(v) {
      if (!v) return;
      if (v.cam) controls.setPose(v.cam);
      if (v.mode === 'flight' || v.mode === 'map') controls.setMode(v.mode);
      if (typeof v.follow === 'boolean') setFollow(v.follow, { quiet: true });
      if (Number.isInteger(v.b)) seekPlacingCamera(clamp(v.b, 0, tip));
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
      setFollow(h.follow, { quiet: true });
      if (h.block != null && h.block !== replay.block) seekPlacingCamera(clamp(h.block, 0, tip));
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
          // In plane mode, inspect where the nose points (its circle), else as the controls say.
          const p = (controls.mode === 'plane' && planeHud.noseClient()) || controls.inspectPoint();
          if (p) inspectAt(p.x, p.y);
          break;
        }
        case 'KeyF':
          controls.toggleFlight();
          break;
        case 'KeyT':
          if (!touchOnly) {
            funMenu.close();
            controls.togglePlane();
          }
          break;
        case 'KeyC':
          if (!touchOnly) cycleCraft();
          break;
        case 'Enter':
        case 'NumpadEnter':
          // A focused button (the end card's Again, a menu item) handles Enter itself.
          if (e.target && e.target.closest && e.target.closest('button')) break;
          if (!touchOnly && controls.mode === 'plane') {
            e.preventDefault();
            startRun();
          }
          break;
        case 'KeyN':
          setFollow(!follow.active);
          break;
        case 'KeyM':
          notice(planeSound.toggleMuted() ? 'Plane sound off' : 'Plane sound on', 'info', 'sound');
          break;
        case 'KeyG':
          // Panels need the cursor: leave plane mode (and its pointer lock) first.
          if (controls.mode === 'plane') controls.setMode('map');
          funMenu.close();
          togglePanel();
          break;
        case 'KeyP':
          if (controls.mode === 'plane') controls.setMode('map');
          funMenu.close();
          placesMenu.toggle();
          break;
        case 'KeyH':
          if (controls.mode === 'plane') controls.setMode('map');
          funMenu.close();
          help.toggle();
          break;
        case 'Slash':
          if (e.shiftKey) {
            if (controls.mode === 'plane') controls.setMode('map');
            funMenu.close();
            help.toggle();
          }
          break;
        case 'Escape':
          if (controls.mode !== 'map') controls.setMode('map');
          else if (help.open) help.close();
          else if (funMenu.open) funMenu.close();
          else if (placesMenu.open) placesMenu.close();
          else if (inspector.isOpen) inspector.close();
          else if (panelOpen()) togglePanel(false);
          break;
        default:
      }
    });
    // Browsers may keep the sound suspended until a gesture; any key press or click retries.
    window.addEventListener('keydown', () => planeSound.unlock(), true);
    window.addEventListener('pointerdown', () => planeSound.unlock(), true);
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
    // Flight mode needs a keyboard to steer and to leave; touch-only devices open the link in map mode.
    if (initial.mode === 'flight' && !deviceTraits().coarseOnly) controls.setMode('flight');
    if (initial.follow) setFollow(true, { quiet: true });
    controls.update(0);
    const first = view.update(0);
    if (first && first.desiredTiles) replay.setTiles(first.desiredTiles);
    // A link with a block opens there; otherwise about a week before the tip, so Play plays.
    const startBlock = initial.block != null ? clamp(initial.block, 0, tip)
      : defaultStartBlock(tip, replay.snapshotBlocks || []);
    stage = 'seek';
    loading.set('Replaying to block ' + fmtInt(startBlock));
    seekPlacingCamera(startBlock).catch((err) => {
      hook.error = String(err && err.message ? err.message : err);
      notice('Seek failed: ' + hook.error, 'error');
    });

    Object.assign(hook, {
      settings: store, replay, view, controls, playback, panel, manifest, grid,
      ui: { hud, timeline, legend, minimap, inspector, hover, placesMenu, help, toast, funMenu, funCard },
      seek: (b) => playback.seek(b),
      flyTo: (place) => flyToPlace(place),
      inspect: (x, y) => inspectAt(x, y),
      hash: () => currentHash(),
      follow: {
        get active() {
          return follow.active;
        },
        /** Blocks the camera still has to glide behind the tip. */
        get lag() {
          return follow.lag;
        },
        toggle: () => setFollow(!follow.active),
        set: (on) => setFollow(on),
      },
      plane: {
        get active() {
          return controls.mode === 'plane';
        },
        get takingOff() {
          return controls.takingOff;
        },
        /** Live flight state (ui/plane.js; angles in radians). Checks may move it. */
        get state() {
          return controls.plane;
        },
        get pose() {
          const p = controls.plane;
          return p ? { x: p.x, y: p.y, z: p.z, yaw: (p.yaw * 180) / Math.PI, pitch: (p.pitch * 180) / Math.PI, bank: (p.bank * 180) / Math.PI, speed: p.speed, throttle: p.throttle, bumps: p.bumps } : null;
        },
        get model() {
          return planeModel ? planeModel.object3d : null;
        },
        /** The craft plane mode flies; setCraft(id) chooses it (refused during a run). */
        get craft() {
          return controls.craft;
        },
        crafts: CRAFT_ORDER,
        setCraft: (id) => setCraft(id, { quiet: true }),
        get coins() {
          return coinModels ? coinModels.object3d : null;
        },
        game: {
          get active() {
            return game.running;
          },
          /** Live ui/stack-sats.js state. Checks may move its coins. */
          get state() {
            return game;
          },
          start: () => startRun(),
          /** End the run now as if the minute were up: records the best and opens the end card. */
          stop: () => {
            if (!game.running) return;
            stopStackSats(game, { finished: true });
            finishRun();
          },
        },
        sound: planeSound,
        takeoff: () => controls.setMode('plane'),
        land: () => controls.setMode('map'),
      },
      fun: {
        get open() {
          return funMenu.open;
        },
        toggle: () => funMenu.toggle(),
        get card() {
          return funCard.open;
        },
      },
      state: () => ({
        ready: hook.ready, block: replay.block, busy: replay.busy, playback: playback.state,
        mode: controls.mode, follow: follow.active, pose: controls.getPose(), backend: view.backend, preset: store.preset,
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
        // Follow tip before the controls, so their update draws the shifted camera. Plane mode
        // holds it, so following resumes from wherever the camera lands.
        if (controls.mode === 'plane') follow.hold(replay.block);
        else {
          const dx = follow.step(dt);
          if (dx !== 0) controls.shiftX(dx);
        }
        controls.update(dt);
        // Stack sats steps once the craft has taken off; otherwise only the coin fades advance.
        const flying = controls.mode === 'plane' && !controls.takingOff ? controls.plane : null;
        const ev = stepStackSats(game, game.running ? flying : null, dt, { ground, extent: groundExtent });
        for (const c of ev.collected) {
          planeHud.pop('+' + fmtAmount(c.value));
          planeSound.coin();
        }
        if (ev.ended) finishRun();
        if (coinModels) coinModels.update(game);
        if (planeModel) planeModel.update(controls.plane, dt);
        planeHud.update(controls.plane, replay.block, game);
        planeSound.update(controls.plane);
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
          if (touchOnly) toast.show('Drag to pan \u00b7 pinch to zoom \u00b7 twist to turn \u00b7 two fingers up or down to tilt \u00b7 tap to inspect', 'info', 'touch-hint', 6500);
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
        hover.update(now);
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
