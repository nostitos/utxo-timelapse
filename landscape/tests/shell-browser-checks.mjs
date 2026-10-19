#!/usr/bin/env node
// Browser checks for the app shell (landscape/SPEC.md §8) against a running app and dataset.
// Not part of node --test: it needs the server, a dataset and optionally the native explorer.
//
//   ~/.nvm/versions/node/v22.23.2/bin/node landscape/tests/shell-browser-checks.mjs \
//     --url http://127.0.0.1:12990/ [--explorer http://127.0.0.1:12989] [--shots DIR] \
//     [--browser chrome|canary|brave] [--width 1600 --height 900 --dpr 1] [--only name,name] \
//     [--query startup=high] [--audit] [--games]
//
// Each check runs landscape/tools/browser-check.mjs with a page script, then judges the
// returned values. Prints one PASS/FAIL line per expectation and exits 1 on any failure.
// Against the online site, --explorer can stay unset: the date check then only requires a
// positive block. --query adds parameters to every page URL (for example startup=high).
// --audit (or --only settings-audit) also runs the settings audit, about 30 minutes: every
// preset-governed setting moved across its range, with the image compared, and every 'needs'
// condition broken to confirm the setting then has no effect. It writes settings-audit.json
// to --shots (or the working directory). With --query auditlog=1 the page requests
// /__audit?i=N&id=ID before each setting, so a server log shows its progress.
// --games (or --only plane,fun) also runs the plane and Stack sats checks, which a normal run
// skips. The browser is always muted (browser-check.mjs), so no check makes a sound.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, '..', 'tools', 'browser-check.mjs');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = opt('url', 'http://127.0.0.1:12990/');
const explorer = opt('explorer', 'http://127.0.0.1:12989').replace(/\/+$/, '');
const shots = opt('shots', null);
const browser = opt('browser', 'chrome');
const width = opt('width', '1600');
const height = opt('height', '900');
const dpr = opt('dpr', '1');
const only = opt('only', null);
const extraQuery = new URLSearchParams(opt('query', ''));
const audit = args.includes('--audit');
const optIns = { audit, games: args.includes('--games') };
if (shots) mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'shell-checks-'));
// The online Worker names the current dataset in /dataset/index.json; serve.mjs has no index.
async function loadManifest(root) {
  try {
    const r = await fetch(new URL('/dataset/index.json', root));
    if (r.ok) {
      const index = await r.json();
      const url = index && index.current && index.current.url;
      if (url) return (await fetch(new URL('manifest.json', new URL(url.endsWith('/') ? url : url + '/', root)))).json();
    }
  } catch { /* fall back to the local layout */ }
  return (await fetch(new URL('dataset/manifest.json', root))).json();
}
const manifest = await loadManifest(base.replace(/[?#].*$/, ''));
const hashBlock = Math.min(314000, manifest.tip - 2000);

// Shared page helpers, prepended to every script.
const PRELUDE = String.raw`
const L = window.__landscape;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const idle = async (ms = 15000) => { const t = performance.now(); while (!L.idle() && performance.now() - t < ms) await sleep(50); };
const tip = L.manifest.tip;
const inData = (b) => Math.min(b, tip - 2000);
const canvas = document.getElementById('view');
const pt = (h) => (h ? { x: h.x, y: h.y, z: h.z } : null);
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null);
const key = (code, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...o }));
const ptr = (type, x, y, o = {}) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', bubbles: true, cancelable: true, button: 0, buttons: 1, ...o }));
// Settings checks: camera poses, the next frame's pixels (read in the frame that drew them,
// while the WebGPU canvas still holds them) and a mean absolute RGB difference.
// back looks at the large-amount rows from behind the landscape (yaw 180 faces +z).
// map looks straight down on the most recent 370,000 blocks, so the landscape fills the frame.
const POSES = { close: { x: 845, y: 9, z: 214, yaw: -25, pitch: -16 }, low: { x: 700, y: 40, z: 260, yaw: -40, pitch: -8 },
  back: { x: 640, y: 30, z: -45, yaw: 180, pitch: -20 }, map: { x: 780, y: 225, z: 104, yaw: 0, pitch: -89 } };
const frameImage = (w, h) => new Promise((resolve) => requestAnimationFrame(() => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h); resolve(c);
}));
async function grid() {
  const d = (await frameImage(48, 27)).getContext('2d').getImageData(0, 0, 48, 27).data;
  const out = new Uint8Array(48 * 27 * 3);
  for (let i = 0, j = 0; i < d.length; i += 4) { out[j++] = d[i]; out[j++] = d[i + 1]; out[j++] = d[i + 2]; }
  return out;
}
const gridDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const jpeg = async (w = 640, h = 360) => (await frameImage(w, h)).toDataURL('image/jpeg', 0.85);
// Waits until the image stops changing: shader rebuilds, tile loads, TRAA and exposure settle.
async function settled(minMs = 400, maxMs = 5000) {
  await sleep(minMs); await idle();
  const t0 = performance.now(); let prev = await grid();
  while (performance.now() - t0 < maxMs) { await sleep(250); const next = await grid(); if (gridDiff(prev, next) < 0.3) return next; prev = next; }
  return prev;
}
const openPanel = async () => { if (!L.panel.isOpen()) document.querySelector('#timeline [data-act="settings"]').click(); await sleep(250); };
const quickButton = (cid, oid) => document.querySelector('#panel [data-quick="' + cid + '"] [data-option="' + oid + '"]');
const settingRow = (id) => document.querySelector('#panel [data-setting-id="' + id + '"]');
async function findCell() {
  for (let y = 360; y <= 680; y += 40) for (let x = 420; x <= 1180; x += 60) {
    const hit = L.view.pick(x, y);
    if (!hit) continue;
    const r = await L.inspect(x, y);
    if (r && r.cell && r.cell.countSmall + r.cell.countLarge > 0 && r.api && !r.api.offline && !r.api.error) return { x, y, r };
  }
  return null;
}
`;

// Injected into the page, so the same check works online where /dev/ is excluded.
const COLUMN_COUNT_HELPERS = readFileSync(join(here, 'column-count-browser.mjs'), 'utf8');

const CHECKS = [
  {
    name: 'column-counts',
    timeout: 120000,
    shot: 'counted-columns.png',
    script: `${COLUMN_COUNT_HELPERS}
      L.playback.pause(); L.follow.set(false);
      L.settings.set('amp.exaggeration', 1);
      L.controls.setPose({ x: Math.min(819.65, tip / 1000 - 20), y: 0.7, z: 103.1, yaw: -15, pitch: -20 });
      await sleep(1200); await idle(45000); await sleep(500);
      const layers = await columnLayerPixels(L.view.renderer);
      const states = [await countAtlasCheck(L)];
      const start = L.replay.block;
      let deltaCells = 0;
      const off = L.replay.onFrame(f => { deltaCells += f.deltas?.counts?.length || 0; });
      await L.replay.advance(start + 3, { budgetMs: 1000 }); await idle(); await sleep(300);
      states.push(await countAtlasCheck(L));
      await L.replay.advance(start, { budgetMs: 1000 }); await idle(); await sleep(300);
      states.push(await countAtlasCheck(L)); off();
      L.settings.set('amp.measure', 'value'); await sleep(300); await idle(); await sleep(300);
      states.push(await countAtlasCheck(L));
      L.settings.set('amp.measure', 'density'); await sleep(300); await idle(); await sleep(300);
      return { layers, states, deltaCells, columns: L.view.stats.columns, frameError: L.frameError || null };`,
    expect: (v) => [
      ['1, 2, 5 and 10 UTXOs draw 0, 1, 4 and 9 internal lines; subpixel layers fade in all column shapes/styles',
        v.layers.length === 15 && v.layers.every(r => r.boundaries.every(b => b.peak > 0 && b.runs === (b.n === 1000 ? 0 : b.n - 1)))],
      ['GPU counts match the CPU atlas after full loads, playback, rewind and measure changes',
        v.states.length === 4 && v.states.every(s => s.gpuChecked > 0 && s.gpuMismatches === 0)],
      ['counts match the exact replay ledger at every resident level',
        v.states.every(s => s.exactChecked > 0 && s.exactMismatches === 0)],
      ['playback delivered count deltas', v.deltaCells > 0],
      ['real columns render without frame errors', v.columns > 0 && v.frameError === null],
    ],
  },
  {
    name: 'startup',
    shot: 'first-view.png',
    script: `await idle(); await sleep(1500);
      const out = { ready: L.ready, backend: L.view.backend, block: L.replay.block, tip, preset: L.settings.preset, frameError: L.frameError || null,
        hud: document.querySelector('[data-k="block"]').textContent, fps: L.view.stats.fps,
        onSnapshot: (L.replay.snapshotBlocks || []).includes(L.replay.block) };
      L.playback.play(); await sleep(2000); L.playback.pause(); await idle();
      out.played = L.replay.block - out.block;
      return out;`,
    expect: (v) => [
      ['ready after the first real frame', v.ready === true],
      ['starts at a snapshot at least a week before the tip (' + (v.tip - v.block) + ' blocks)',
        v.onSnapshot && v.tip - v.block >= 1008 && v.tip - v.block < 3000],
      ['HUD shows the block', v.hud === v.block.toLocaleString('en-US')],
      ['Play advances at 1x (' + v.played + ' blocks in 2 s)', v.played >= 60 && v.played <= 180],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'inspector',
    shot: 'inspector.png',
    script: `await L.flyTo(inData(314000)); await idle(); await sleep(1200);
      const f = await findCell(); await sleep(300);
      const c = L.ui.inspector.current;
      return { found: !!f, block: L.replay.block, col: c && c.col, row: c && c.row, cell: c && c.cell, api: c && c.api && { count: c.api.count, liveSat: c.api.liveSat, offline: !!c.api.offline }, match: c && c.match,
        marker: !document.getElementById('marker').hidden, link: (document.querySelector('.in-links a') || {}).href || null };`,
    expect: (v) => [
      ['found a cell with outputs and an explorer answer', v.found],
      ['replay and history index agree (count and sats)', !!(v.match && v.match.ok)],
      ['selection marker visible', v.marker],
      ['2D explorer link present', !!v.link],
    ],
  },
  {
    // ui/hover.js: the card docked under the HUD names the picked cell from local data only.
    name: 'hover',
    shot: 'hover.png',
    script: `await L.flyTo(inData(314000)); await idle(); await sleep(1200);
      const card = document.getElementById('hover');
      const move = (x, y, type = 'pointermove') => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 9, pointerType: 'mouse', bubbles: true, cancelable: true }));
      const settle = async () => { for (let i = 0; i < 4; i++) await frame(); await sleep(120); await frame(); };
      let fetches = 0; const realFetch = window.fetch; window.fetch = (...a) => { fetches++; return realFetch(...a); };
      const cell = L.replay.cell.bind(L.replay); const loads = []; L.replay.cell = (l, c, r, o) => { loads.push(o && o.load); return cell(l, c, r, o); };
      let at = null;
      find: for (let y = 360; y <= 680; y += 24) for (let x = 420; x <= 1180; x += 30) {
        const h = L.view.pick(x, y); if (!h) continue;
        const c = await cell(h.level || 0, h.col, h.row, { load: false });
        if (c && c.countSmall + c.countLarge > 0) { at = { x, y, h }; break find; }
      }
      const out = { found: !!at };
      if (at) {
        move(at.x, at.y); await settle();
        const cur = L.ui.hover.current; const r = card.getBoundingClientRect(); const hud = document.getElementById('hud').getBoundingClientRect();
        const direct = await cell(cur.level, cur.col, cur.row, { load: false });
        out.sameCell = cur.level === (at.h.level || 0) && cur.col === at.h.col && cur.row === at.h.row;
        out.counts = !!(cur.cell && direct && ['countSmall', 'countLarge', 'satsSmall', 'satsLarge'].every((k) => cur.cell[k] === direct[k]));
        out.text = cur.text;
        out.docked = Math.abs(r.left - hud.left) < 1 && Math.abs(r.width - hud.width) < 1 && r.top > hud.bottom && r.top - hud.bottom <= 16;
        move(at.x + 40, at.y + 20); await settle(); const r2 = card.getBoundingClientRect(); out.staysPut = r2.left === r.left && r2.top === r.top;
        // Off the canvas the card lingers, dimmed, stays while the pointer is over it, then hides.
        const onCard = (type) => card.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'mouse' }));
        move(5, 5, 'pointerleave'); await frame(); await frame(); out.lingers = !card.hidden && card.classList.contains('linger');
        onCard('pointerenter'); await sleep(1900); await frame(); out.staysOverCard = !card.hidden;
        onCard('pointerleave'); await sleep(1900); await frame(); await frame(); out.hidesOffCanvas = card.hidden;
        move(at.x, at.y); await settle(); canvas.classList.add('dragging'); await frame(); await frame();
        out.hidesWhileDragging = card.hidden; canvas.classList.remove('dragging');
        move(at.x, at.y); await settle();
        // Its × hides it until reload: moving over cells, out and back in does not bring it back.
        out.shownBeforeClose = !card.hidden;
        card.querySelector('.box-close').click(); await frame();
        out.closeHides = card.hidden;
        for (const [dx, dy] of [[0, 0], [40, 20], [-30, -12], [0, 0]]) { move(at.x + dx, at.y + dy); await settle(); }
        move(5, 5, 'pointerleave'); await frame(); move(at.x, at.y); await settle();
        out.staysClosed = card.hidden && L.ui.hover.current === null && L.ui.hover.dismissed;
      }
      out.fetches = fetches; out.queries = loads.length; out.local = loads.length > 0 && loads.every((v) => v === false);
      window.fetch = realFetch; L.replay.cell = cell;
      return out;`,
    expect: (v) => [
      ['found a cell with outputs to hover', v.found],
      ['the card names the cell the pointer picks', !!v.sameCell],
      ['size, blocks, dates, unspent and value shown as ranges with "to" (' + (v.text || '').replace(/\s+/g, ' ') + ')',
        /UNDER THE CURSOR\s+SIZE\s+[\d,.]+ to [\d,.]+ (BTC|sat)\s+BLOCKS\s+[\d,]+ to [\d,]+\s+MINED\s+\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?\s+UNSPENT OUTPUTS\s+[\d,]+\s+VALUE\s+[\d,.]+ (BTC|sat)/i.test(v.text || '')],
      ['unspent count and value equal the replay worker', !!v.counts],
      ['card docked under the HUD, same edge and width', !!v.docked],
      ['card stays put while the pointer moves', !!v.staysPut],
      ['off the canvas it lingers dimmed, stays while pointed at, then hides', !!(v.lingers && v.staysOverCard && v.hidesOffCanvas)],
      ['hidden while dragging', !!v.hidesWhileDragging],
      ['the \u00d7 hides it, and moving over cells, out and back in keeps it hidden', !!(v.shownBeforeClose && v.closeHides && v.staysClosed)],
      ['no requests: ' + v.fetches + ' fetches, ' + v.queries + ' worker queries all load: false', v.fetches === 0 && !!v.local],
    ],
  },
  {
    name: 'playback',
    timeout: 120000,
    script: `const out = {};
      async function run(speed, seconds, from) {
        await L.seek(from); await idle(); await sleep(300);
        L.playback.setSpeed(speed);
        const b0 = L.replay.block; const t0 = performance.now(); let seeks = 0; let last = L.playback.lastOperation; const samples = [];
        L.playback.play();
        while (performance.now() < t0 + seconds * 1000) { await sleep(50); const op = L.playback.lastOperation; if (op && op !== last && op.kind === 'seek') seeks++; last = op; samples.push([performance.now(), L.replay.block]); }
        const b1 = L.replay.block; const t1 = performance.now(); const st = L.playback.state;
        // Rate over the HUD's own window (last 1.5 s), to compare with what the HUD shows.
        const w0 = samples.find((s) => s[0] >= t1 - 1500) || samples[0];
        const windowRate = (b1 - w0[1]) / ((t1 - w0[0]) / 1000);
        // Longest stretch without visible progress after the first 1.5 s (50 ms samples).
        let still = 0, longestStill = 0;
        for (let i = 1; i < samples.length; i++) {
          if (samples[i][0] < t0 + 1500) continue;
          if (samples[i][1] === samples[i - 1][1]) still += samples[i][0] - samples[i - 1][0];
          else { longestStill = Math.max(longestStill, still); still = 0; }
        }
        longestStill = Math.max(longestStill, still);
        L.playback.pause(); await idle();
        return { from: b0, blocks: b1 - b0, seconds: (t1 - t0) / 1000, rate: (b1 - b0) / ((t1 - t0) / 1000), limited: st.limited, achieved: st.achieved, windowRate, seeks, longestStill, paced: st.paced };
      }
      const busy = inData(300000);
      out.x1 = await run('1', 10, busy);
      out.x2 = await run('2', 5, busy);
      out.x5 = await run('5', 5, busy);
      // Near the tip a chunk holds about 115 blocks, so online Max is paced to the download.
      out.max = await run('max', 6, inData(840000));
      out.memoryMB = L.replay.status && Math.round(L.replay.status.memoryBytes / 1048576);
      return out;`,
    expect: (v) => [
      ['1x: about 600 blocks in 10 s, exact (' + v.x1.blocks + ')', v.x1.blocks >= 590 && v.x1.blocks <= 610 && v.x1.seeks === 0],
      ['2x: exact (no snapshot seeks)', v.x2.seeks === 0],
      ['2x: 120 blocks/s, or the HUD shows the achieved rate (measured ' + Math.round(v.x2.rate) + '/s, last 1.5 s ' + Math.round(v.x2.windowRate) +
        '/s, HUD ' + Math.round(v.x2.achieved) + '/s)', (v.x2.rate >= 114 && v.x2.rate <= 126) || Math.abs(v.x2.achieved - v.x2.windowRate) <= 0.1 * v.x2.windowRate],
      ['5x: exact (no snapshot seeks)', v.x5.seeks === 0],
      ['5x: 300 blocks/s, or the HUD shows the achieved rate (measured ' + Math.round(v.x5.rate) + '/s, last 1.5 s ' + Math.round(v.x5.windowRate) +
        '/s, HUD ' + Math.round(v.x5.achieved) + '/s)', (v.x5.rate >= 285 && v.x5.rate <= 315) || Math.abs(v.x5.achieved - v.x5.windowRate) <= 0.1 * v.x5.windowRate],
      ['Max: exact advance only (' + Math.round(v.max.rate) + '/s)', v.max.seeks === 0 && v.max.blocks > 0],
      ['Max: moves steadily, never still for 300 ms (longest ' + Math.round(v.max.longestStill) + ' ms' + (v.max.paced ? ', paced to the download' : '') + ')', v.max.longestStill < 300],
      ['worker memory <= 1.5 GB (' + v.memoryMB + ' MB)', v.memoryMB <= 1536],
    ],
  },
  {
    name: 'navigation',
    script: `await L.flyTo(inData(314000)); await idle(); await sleep(1000);
      const { Vector3 } = await import('three');
      const proj = (p) => { const v = new Vector3(p.x, p.y, p.z).project(L.view.camera); const r = canvas.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
      const out = {};
      { const g = L.view.pick(700, 450); ptr('pointerdown', 700, 450); for (let i = 1; i <= 6; i++) { ptr('pointermove', 700 + i * 20, 450 + i * 12); await frame(); } ptr('pointerup', 820, 522, { buttons: 0 }); await frame();
        const s = proj(g); out.panPx = Math.hypot(s[0] - 820, s[1] - 522); }
      { const p = L.view.pick(800, 430); ptr('pointerdown', 800, 430, { button: 2, buttons: 2 }); for (let i = 1; i <= 6; i++) { ptr('pointermove', 800 + i * 15, 430 - i * 6, { button: 2, buttons: 2 }); await frame(); } ptr('pointerup', 890, 394, { button: 2, buttons: 0 }); await frame();
        const s = proj(p); out.orbitPx = Math.hypot(s[0] - 800, s[1] - 430); }
      { const p = L.view.pick(900, 480); const c0 = L.controls.getPose(); canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 900, clientY: 480, deltaY: -300, bubbles: true, cancelable: true })); await sleep(1200);
        const s = proj(p); const c1 = L.controls.getPose(); out.zoomPx = Math.hypot(s[0] - 900, s[1] - 480); out.zoomCloser = dist(c1, p) < dist(c0, p); }
      { const p = L.view.pick(650, 520); canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: 650, clientY: 520, bubbles: true })); await sleep(2300);
        const r = canvas.getBoundingClientRect(); const s = proj(p); out.dblclickPx = Math.hypot(s[0] - (r.left + r.width / 2), s[1] - (r.top + r.height / 2)); }
      return out;`,
    expect: (v) => [
      ['pan keeps the grabbed point under the cursor (' + v.panPx.toFixed(3) + ' px)', v.panPx < 0.5],
      ['orbit keeps the pivot at its pixel (' + v.orbitPx.toFixed(3) + ' px)', v.orbitPx < 0.5],
      ['wheel zooms toward the cursor point (' + v.zoomPx.toFixed(3) + ' px)', v.zoomPx < 0.5 && v.zoomCloser],
      ['double-click brings the point to the centre (' + v.dblclickPx.toFixed(3) + ' px)', v.dblclickPx < 0.5],
    ],
  },
  {
    name: 'keys-inputs-scrub',
    script: `const out = {};
      await L.seek(inData(250000)); await idle();
      const b0 = L.replay.block;
      key('BracketRight', { key: ']' }); await sleep(400); const b1 = L.replay.block;
      key('BracketRight', { key: '}', shiftKey: true }); await sleep(800); await idle(); const b2 = L.replay.block;
      key('BracketLeft', { key: '[' }); await sleep(400); const b3 = L.replay.block;
      key('Digit2', { key: '2' }); const speed = L.playback.state.speed; key('Digit1', { key: '1' });
      key('Space', { key: ' ' }); await sleep(1000); const playing = L.playback.state.playing; const b4 = L.replay.block; key('Space', { key: ' ' }); await sleep(300);
      out.keys = { b0, b1, b2, b3, speed, playing, oneSecond: b4 - b3, paused: !L.playback.state.playing };
      const bi = document.querySelector('.tl-block'); bi.focus(); bi.value = String(inData(200000)); bi.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); await idle();
      out.blockInput = { want: inData(200000), got: L.replay.block };
      const di = document.querySelector('.tl-date'); di.focus(); di.value = '2013-01-01'; di.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); await idle();
      out.dateInput = L.replay.block;
      const s = document.querySelector('.tl-scrub'); const snaps = L.replay.snapshotBlocks; const ops = [];
      const marks = [0.55, 0.6, 0.7].map((f) => Math.round(f * tip));
      for (const m of marks) { s.value = String(m); s.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250); ops.push(L.playback.lastOperation && L.playback.lastOperation.block); }
      const finalWant = marks[2] + 123; s.value = String(finalWant); s.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300); await idle();
      out.scrub = { ops, expected: marks.map((m) => snaps.filter((b) => b <= m).at(-1)), final: L.replay.block, finalWant };
      return out;`,
    node: async (v) => {
      try {
        const r = await fetch(explorer + '/api/date?d=2013-01-01');
        v.explorerDate = (await r.json()).block;
      } catch {
        v.explorerDate = null;
      }
    },
    expect: (v) => [
      [']: +1 block exact', v.keys.b1 === v.keys.b0 + 1],
      ['Shift+]: +1,008 blocks', v.keys.b2 === v.keys.b1 + 1008],
      ['[: -1 block', v.keys.b3 === v.keys.b2 - 1],
      ['2 selects 2x', v.keys.speed === '2'],
      ['Space plays about 60 blocks/s and pauses (' + v.keys.oneSecond + ')', v.keys.playing && v.keys.paused && v.keys.oneSecond >= 50 && v.keys.oneSecond <= 70],
      ['block input seeks exactly', v.blockInput.got === v.blockInput.want],
      ['UTC date matches the explorer /api/date (' + v.dateInput + ' vs ' + v.explorerDate + ')', v.explorerDate == null ? v.dateInput > 0 : v.dateInput === v.explorerDate],
      ['scrub seeks the snapshot at/below while dragging', JSON.stringify(v.scrub.ops) === JSON.stringify(v.scrub.expected)],
      ['scrub release seeks exactly', v.scrub.final === v.scrub.finalWant],
    ],
  },
  {
    name: 'places-flight-help',
    shot: 'flight.png',
    script: `const out = {};
      document.querySelector('[data-act="places"]').click(); await sleep(200);
      out.placesOpen = L.ui.placesMenu.open;
      out.disabledBeyondTip = [...document.querySelectorAll('#places .pl-item')].filter((b) => b.disabled).length;
      L.ui.placesMenu.close();
      const p = await L.flyTo('btc1'); out.band = p && p.rowMin;
      key('KeyH', { key: 'h' }); await sleep(200); out.helpOpen = L.ui.help.open; key('Escape', { key: 'Escape' }); L.ui.help.close();
      await L.seek(inData(314000)); await idle();
      L.controls.setMode('flight');
      const g = L.view.heightAt(150, 120); L.controls.setPose({ x: 150, y: g - 1, z: 120, yaw: 0, pitch: 0 }); await sleep(150);
      const pc = L.controls.getPose(); out.clearance = pc.y - L.view.heightAt(pc.x, pc.z);
      L.controls.setPose({ x: Math.min(205, tip / 1000 - 60), y: 15, z: 175, yaw: -62, pitch: -13 }); await sleep(200);
      const p0 = L.controls.getPose(); key('KeyW', { key: 'w' }); await sleep(800); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })); await sleep(700);
      const p1 = L.controls.getPose(); out.flew = Math.hypot(p1.x - p0.x, p1.z - p0.z); out.crosshair = !document.getElementById('crosshair').hidden; out.mode = L.controls.mode;
      return out;`,
    expect: (v) => [
      ['places popover opens', v.placesOpen],
      ['1 BTC band resolves to a row', Number.isInteger(v.band)],
      ['help opens with H', v.helpOpen],
      ['flight: W moves the camera (' + v.flew.toFixed(2) + ')', v.flew > 1],
      ['flight: crosshair shown', v.crosshair && v.mode === 'flight'],
      ['flight: collision keeps the camera above the surface (' + v.clearance.toFixed(3) + ')', v.clearance >= 0.079],
    ],
  },
  {
    name: 'plane',
    optIn: 'games',
    shot: 'plane.png',
    timeout: 90000,
    script: `const up = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
      const takeoffDone = async () => { const t = performance.now(); while (L.plane.takingOff && performance.now() - t < 4000) await sleep(30); };
      await L.seek(inData(314000)); await idle();
      L.controls.setPose({ x: Math.min(150, tip / 1000 - 40), y: 14, z: 120, yaw: -70, pitch: -14 }); await sleep(400); await idle();
      L.plane.setCraft('plane');
      L.sound.set(false);
      const out = { funButton: !!document.querySelector('#timeline [data-act="fun"]') };
      key('KeyT', { key: 't' }); await sleep(50);
      out.modeAfterT = L.controls.mode;
      await takeoffDone();
      out.tookOff = !L.plane.takingOff && !!L.plane.state;
      const keysEl = document.getElementById('planekeys');
      // Sound is off by default: takeoff builds no engine; turning it on in flight starts it.
      out.silent = { state: L.plane.sound.state, keys: keysEl.textContent.includes('Sound off') };
      L.sound.set(true); await sleep(100);
      out.keys = keysEl.hidden ? null : keysEl.textContent;
      out.sound0 = L.plane.sound.state;
      // Bank to turn: a quarter second of D banks the plane while the heading has barely moved.
      const b0 = L.plane.pose;
      key('KeyD', { key: 'd' }); await sleep(250);
      const b1 = L.plane.pose; up('KeyD');
      out.bankFirst = { bank: b1.bank - b0.bank, heading: wrapDeg(b1.yaw - b0.yaw) };
      // Level the wings again before the long turn.
      await sleep(300); L.plane.state.bank = 0;
      // The up arrow raises the nose (Invert Y off).
      { const st = L.plane.state; st.pitch = 0; st.camPitch = 0; const p0 = L.plane.pose.pitch;
        key('ArrowUp', { key: 'ArrowUp' }); await sleep(400); up('ArrowUp');
        out.arrowUp = L.plane.pose.pitch - p0; await sleep(300); st.pitch = 0; st.camPitch = 0; }
      // The mouse is a stick that springs back: moving it right deflects the stick and banks right;
      // once it stops the stick centres and the bank stays. With pointer lock the movement comes
      // as mousemove deltas, otherwise as a drag on the canvas.
      const cr = canvas.getBoundingClientRect(); const mx = cr.left + cr.width / 2, my = cr.top + cr.height / 2;
      const locked = document.pointerLockElement === canvas;
      if (!locked) ptr('pointerdown', mx, my);
      for (let i = 1; i <= 6; i++) {
        if (locked) document.dispatchEvent(new MouseEvent('mousemove', { movementX: 12, movementY: 0, bubbles: true }));
        else ptr('pointermove', mx + i * 12, my);
        await frame();
      }
      out.stick = { roll: L.plane.state.roll, mouseX: L.plane.state.mouseX, locked };
      if (!locked) ptr('pointerup', mx + 72, my, { buttons: 0 });
      await sleep(1500);
      out.stickAfter = { mouseX: L.plane.state.mouseX, bank: L.plane.pose.bank };
      L.plane.state.bank = 0;
      const s0 = L.plane.pose;
      key('KeyW', { key: 'w' }); key('KeyD', { key: 'd' }); await sleep(1500); up('KeyW'); up('KeyD');
      const s1 = L.plane.pose;
      out.sound1 = L.plane.sound.state;
      out.detailAhead = L.view.stats.columnAhead;
      key('KeyM', { key: 'm' }); await sleep(50);
      out.muted = { state: L.plane.sound.state, keys: keysEl.textContent.includes('Sound off') };
      key('KeyM', { key: 'm' }); await sleep(50);
      out.moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
      out.turned = wrapDeg(s1.yaw - s0.yaw);
      out.throttle = [s0.throttle, s1.throttle];
      const st = L.plane.state;
      out.clearance = st.y - L.view.heightAt(st.x, st.z);
      out.model = !!(L.plane.model && L.plane.model.visible);
      out.readout = document.getElementById('planehud').hidden ? null : document.querySelector('#planehud .ph-ground').textContent;
      out.crosshair = !document.getElementById('crosshair').hidden;
      out.nose = !document.getElementById('plane-nose').hidden;
      out.hashMode = new URLSearchParams(L.hash().slice(1)).get('mode');
      await idle(); await sleep(600);
      // Bump: put the plane low in front of a wall. Walk the path with the flight model's rule
      // (0.05-unit samples, rises up to 0.35 are ridden over, taller ones bump) and take a spot
      // only where the first bump is clear (a rise over 0.6) and every step before it is clearly
      // rideable (under 0.2); heightAt blends between rows, so most columns rise over a ramp.
      let spot = null;
      for (let dz = 0; dz < 40 && !spot; dz += 0.5) for (let dx = -10; dx <= 10 && !spot; dx += 0.7) {
        const x = st.x + dx, z = st.z - dz, g0 = L.view.heightAt(x, z);
        let cy = g0 + 0.15;
        for (let d = 0.05; d < 2.5; d += 0.05) {
          const rise = L.view.heightAt(x, z - d) + 0.15 - cy;
          if (rise > 0.6) { if (d >= 0.2) spot = { x, z, g0, d }; break; }
          if (rise > 0.2) break;
          cy = Math.max(cy, cy + rise);
        }
      }
      out.spot = spot;
      if (spot) {
        // Throttle 0.75 is 5.7 units/s on the logarithmic throttle, so the column 2.5 units ahead is reached well within the wait.
        Object.assign(st, { x: spot.x, z: spot.z, y: spot.g0 + 0.15, yaw: 0, camYaw: 0, pitch: 0, camPitch: 0, bank: 0, mouseX: 0, mouseY: 0, speed: 8.6, throttle: 0.75, cooldown: 0 });
        const b0 = st.bumps; const t = performance.now();
        while (st.bumps === b0 && performance.now() - t < 2000) await sleep(16);
        out.bumped = st.bumps > b0;
        out.stoppedBefore = st.z > spot.z - spot.d;
      }
      out.frameError = L.frameError || null;
      out.backend = L.view.backend;
      key('Escape', { key: 'Escape' }); await sleep(100);
      out.afterEsc = { mode: L.controls.mode, model: !!(L.plane.model && L.plane.model.visible), readout: !document.getElementById('planehud').hidden,
        crosshair: !document.getElementById('crosshair').hidden, keys: !keysEl.hidden, sound: L.plane.sound.state.active };
      await sleep(300); out.detailAfter = L.view.stats.columnAhead;
      L.plane.takeoff(); await takeoffDone(); out.again = L.controls.mode;
      L.plane.land(); await sleep(100);
      out.afterLand = { mode: L.controls.mode, model: !!(L.plane.model && L.plane.model.visible), state: L.plane.state };
      return out;`,
    expect: (v) => [
      ['Fun button in the timeline', v.funButton],
      ['T takes off (' + v.modeAfterT + ')', v.modeAfterT === 'plane' && v.tookOff],
      ['D banks before it turns: after 0.25 s, ' + v.bankFirst.bank.toFixed(1) + ' degrees of bank and ' + v.bankFirst.heading.toFixed(2) + ' of heading',
        v.bankFirst.bank > 5 && Math.abs(v.bankFirst.heading) < 1],
      ['the up arrow raises the nose (' + v.arrowUp.toFixed(1) + ' degrees in 0.4 s)', v.arrowUp > 3],
      ['the mouse is a stick (' + (v.stick.locked ? 'pointer lock' : 'drag') + '): moving it right banks right (stick ' + v.stick.roll.toFixed(2) + '), then springs back (' + v.stickAfter.mouseX.toFixed(3) + ') while the bank stays (' + v.stickAfter.bank.toFixed(1) + ' degrees)',
        v.stick.roll > 0.2 && Math.abs(v.stickAfter.mouseX) < 0.02 && v.stickAfter.bank > 5],
      ['W and D for 1.5 s: moves (' + v.moved.toFixed(1) + ' units) and the bank turns it right (' + v.turned.toFixed(1) + ' degrees)', v.moved > 5 && v.turned < -20],
      ['W raises the throttle (' + v.throttle.map((t) => t.toFixed(2)).join(' -> ') + ')', v.throttle[1] > v.throttle[0] + 0.4],
      ['the controls card stays visible: the craft, bank to turn, up raises the nose, next craft, Stack sats, sound, land',
        !!v.keys && /^Plane/.test(v.keys) && /banking turns/.test(v.keys) && /up raises the nose/.test(v.keys) && /Next craft: Bird/.test(v.keys) &&
        /Stack sats: 60 s/.test(v.keys) && /Sound on/.test(v.keys) && /Land in map mode/.test(v.keys)],
      ['with Sound off, takeoff builds no engine and the card says Sound off; Sound on in flight starts it',
        !v.silent.state.created && v.silent.state.muted && v.silent.keys && v.sound0.created],
      ['engine sound: built on takeoff, pitch rises with the throttle (' + (v.sound0.target ? v.sound0.target.freq.toFixed(0) : '?') + ' -> ' + (v.sound1.target ? v.sound1.target.freq.toFixed(0) : '?') + ' Hz, context ' + v.sound1.context + ')',
        v.sound0.created && v.sound0.active && v.sound1.target.freq > v.sound0.target.freq + 10],
      ['M mutes the engine and the card says so', v.muted.state.muted && v.muted.state.target.gain === 0 && v.muted.keys],
      // Cylinder columns are WebGPU-only; WebGL2 has no column disc to move.
      ['cylinder detail moves ahead of the camera while flying (' + (v.detailAhead || 0).toFixed(1) + ' units), back to centred after landing (' + (v.detailAfter || 0).toFixed(1) + ')',
        (v.backend !== 'webgpu' || v.detailAhead > 1) && v.detailAfter === 0],
      ['the plane model and the readout are visible (' + v.readout + ')', v.model && /^Blocks [\d,]+\u2013[\d,]+/.test(v.readout || '')],
      ['the nose circle marks where the plane points; no centre crosshair', v.nose && !v.crosshair],
      ['collision keeps the plane 0.15 above the surface (' + v.clearance.toFixed(3) + ')', v.clearance >= 0.149],
      ['links made while flying open in map mode (mode=' + v.hashMode + ')', v.hashMode === 'map'],
      ['flying into a tall column bumps and stops in front of it' + (v.spot ? '' : ' (no column found)'), !!v.spot && v.bumped && v.stoppedBefore],
      ['Esc returns to map mode with the plane, readout, crosshair and controls card hidden and the engine stopped',
        v.afterEsc.mode === 'map' && !v.afterEsc.model && !v.afterEsc.readout && !v.afterEsc.crosshair && !v.afterEsc.keys && !v.afterEsc.sound],
      ['land() returns to map mode', v.again === 'plane' && v.afterLand.mode === 'map' && !v.afterLand.model && v.afterLand.state === null],
      ['no frame errors (' + v.backend + ')', v.frameError === null],
    ],
  },
  {
    name: 'fly-button',
    shot: 'fly-button.png',
    script: `const btn = document.querySelector('#timeline [data-act="fly"]');
      const fun = document.querySelector('#timeline [data-act="fun"]');
      const out = { title: btn && btn.title, pressed0: btn && btn.getAttribute('aria-pressed'), fun: fun && { title: fun.title, popup: fun.getAttribute('aria-haspopup') } };
      key('KeyH', { key: 'h' }); await sleep(150);
      out.help = [...document.querySelectorAll('#help h3')].map((h) => h.textContent);
      L.ui.help.close(); await sleep(100);
      btn.click(); await sleep(150);
      out.on = { mode: L.controls.mode, pressed: btn.getAttribute('aria-pressed'), crosshair: !document.getElementById('crosshair').hidden };
      out.hashMode = new URLSearchParams(L.hash().slice(1)).get('mode');
      key('Escape', { key: 'Escape' }); await sleep(150);
      out.esc = { mode: L.controls.mode, pressed: btn.getAttribute('aria-pressed') };
      key('KeyF', { key: 'f' }); await sleep(150);
      out.f = { mode: L.controls.mode, pressed: btn.getAttribute('aria-pressed') };
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['the Fly button says what it does (' + v.title + ')', /^Fly: mouse to look, W A S D to move \(F\)$/.test(v.title || '') && v.pressed0 === 'false'],
      ['clicking Fly enters flight mode, shown pressed, with the crosshair', v.on.mode === 'flight' && v.on.pressed === 'true' && v.on.crosshair],
      ['links made in flight mode keep it (mode=' + v.hashMode + ')', v.hashMode === 'flight'],
      ['Esc returns to map mode and releases the button', v.esc.mode === 'map' && v.esc.pressed === 'false'],
      ['F enters the same mode and presses the button', v.f.mode === 'flight' && v.f.pressed === 'true'],
      ['a Fun button opens a menu (' + (v.fun && v.fun.title) + ')', !!v.fun && /^Fun: fly a plane, bird or jet/.test(v.fun.title) && v.fun.popup === 'true'],
      ['help has Fly and Fun sections (' + v.help.join(', ') + ')', v.help.includes('Fly') && v.help.includes('Fun') && !v.help.includes('Plane')],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    // ui/sound.js and ui/flash-sound.js: the Sound button, M, and a click per spend flash on screen.
    name: 'flash-sound',
    shot: 'sound-on.png',
    timeout: 120000,
    script: `const btn = document.querySelector('#timeline [data-act="sound"]');
      const S = () => L.flashSound.state;
      const spawned = () => L.view.terrain.flashes.stats.spawned;
      const out = { title: btn && btn.title, pressed0: btn && btn.getAttribute('aria-pressed'), on0: L.sound.on, ctx0: L.sound.state.context,
        stored0: localStorage.getItem('utxo-landscape-sound') };
      L.follow.set(false);
      await L.seek(inData(tip)); await idle();
      L.controls.setPose(POSES.map); await sleep(600); await idle();
      L.playback.setSpeed('1');
      // Off: the flashes play, silently, and no audio context exists.
      { const f0 = spawned(); L.playback.play(); await sleep(1000); L.playback.pause(); await idle();
        out.off = { flashes: spawned() - f0, voices: S().totals.voices, created: S().created, context: L.sound.state.context }; }
      btn.click(); await sleep(150);
      out.on = { pressed: btn.getAttribute('aria-pressed'), on: L.sound.on, context: L.sound.state.context,
        stored: localStorage.getItem('utxo-landscape-sound'), toast: document.getElementById('toast').textContent };
      // 1x from above the most recent blocks.
      { const v0 = S().totals.voices, fr0 = S().totals.frames; let maxLevel = 0, onScreen = 0, voiced = 0, minLead = Infinity;
        L.playback.play();
        for (let i = 0; i < 40; i++) { await sleep(50); const lf = S().lastFrame; if (lf) { maxLevel = Math.max(maxLevel, lf.maxLevel); onScreen = Math.max(onScreen, lf.onScreen); voiced = Math.max(voiced, lf.voiced); minLead = Math.min(minLead, lf.lead); } }
        L.playback.pause(); await idle();
        out.play = { voices: S().totals.voices - v0, frames: S().totals.frames - fr0, maxLevel, onScreen, voiced, minLead, dRef: S().dRef, created: S().created }; }
      // Max: dense frames mix hundreds of ticks into one buffer each.
      { let voiced = 0, gain = 0; const t0 = S().totals; L.playback.setSpeed('max'); L.playback.play();
        for (let i = 0; i < 30; i++) { await sleep(50); const lf = S().lastFrame; if (lf) { voiced = Math.max(voiced, lf.voiced); gain = Math.max(gain, lf.gain); } }
        L.playback.pause(); L.playback.setSpeed('1'); await idle(); const t1 = S().totals;
        out.dense = { voiced, gain, mixMs: (t1.mixMs - t0.mixMs) / Math.max(1, t1.frames - t0.frames), perSecond: (t1.voices - t0.voices) / 1.5 }; }
      // Close to the ground the reference distance shrinks with the view (Max may have reached the tip).
      await L.seek(inData(tip - 10000)); await idle();
      L.controls.setPose(POSES.close); await sleep(600); await idle();
      L.playback.play(); await sleep(1500); L.playback.pause(); await idle();
      out.closeRef = S().dRef;
      // M turns it off: no clicks, and the context is suspended once the sound has faded.
      key('KeyM', { key: 'm' }); await sleep(100);
      out.m = { on: L.sound.on, pressed: btn.getAttribute('aria-pressed'), stored: localStorage.getItem('utxo-landscape-sound') };
      { const v1 = S().totals.voices, f1 = spawned(); L.playback.play(); await sleep(1000); L.playback.pause(); await idle(); await sleep(400);
        out.m.voices = S().totals.voices - v1; out.m.flashes = spawned() - f1; out.m.context = L.sound.state.context; }
      // Seeking and scrubbing stay silent with the sound on.
      key('KeyM', { key: 'm' }); await sleep(100);
      { const v2 = S().totals.voices;
        await L.seek(inData(tip - 30000)); await idle();
        for (const b of [600000, 650000, 700000]) { L.playback.scrubTo(inData(b)); await sleep(200); }
        L.playback.scrubEnd(inData(700000)); await sleep(300); await idle();
        out.seek = { voices: S().totals.voices - v2, on: L.sound.on }; }
      key('KeyH', { key: 'h' }); await sleep(150);
      out.help = [...document.querySelectorAll('#help dl div')].map((d) => d.textContent).find((t) => /Sound on or off/.test(t)) || null;
      L.ui.help.close(); await sleep(100);
      L.controls.setPose(POSES.map); await sleep(300); await idle();
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['a Sound button in the timeline, off by default (' + v.title + ')',
        /^Sound: ticks for the spend flashes on screen/.test(v.title || '') && v.pressed0 === 'false' && !v.on0 && v.ctx0 === null && v.stored0 === null],
      ['off: ' + v.off.flashes + ' flashes played silently, no audio context', v.off.flashes > 0 && v.off.voices === 0 && !v.off.created && v.off.context === null],
      ['the button turns sound on: pressed, remembered, context ' + v.on.context + ', notice "' + v.on.toast + '"',
        v.on.pressed === 'true' && v.on.on && v.on.context === 'running' && v.on.stored === 'on' && /Sound on/.test(v.on.toast)],
      ['1x from above: ' + v.play.voices + ' ticks over ' + v.play.frames + ' frames (up to 4,000 a second), up to ' + v.play.onScreen + ' flashes on screen and ' + v.play.voiced + ' ticks in a frame, loudest ' + v.play.maxLevel.toFixed(2),
        v.play.voices >= 3000 && v.play.voices <= 8800 && v.play.onScreen > 0 && v.play.voiced <= 400 && v.play.maxLevel > 0 && v.play.maxLevel <= 1],
      ['every frame of ticks is queued well ahead of the audio clock (closest ' + (v.play.minLead * 1000).toFixed(1) + ' ms; the schedule aims for 60)', v.play.minLead >= 0.05],
      ['the reference distance follows the view: ' + (v.play.dRef || 0).toFixed(1) + ' from above, ' + (v.closeRef || 0).toFixed(1) + ' near the ground',
        v.play.dRef >= 1 && v.play.dRef <= 1000 && v.closeRef > 0 && v.closeRef < v.play.dRef * 0.75],
      ['Max: ' + Math.round(v.dense.perSecond) + ' ticks a second, up to ' + v.dense.voiced + ' in a frame, mixed in ' + v.dense.mixMs.toFixed(2) + ' ms a frame on average (density gain up to ' + v.dense.gain.toFixed(2) + ')',
        v.dense.voiced >= 30 && v.dense.perSecond > 1000 && v.dense.mixMs < 2 && v.dense.gain > 0 && v.dense.gain <= 2],
      ['M turns it off: released, remembered, no clicks for ' + v.m.flashes + ' flashes, context ' + v.m.context,
        !v.m.on && v.m.pressed === 'false' && v.m.stored === 'off' && v.m.flashes > 0 && v.m.voices === 0 && v.m.context === 'suspended'],
      ['seeking and scrubbing stay silent (' + v.seek.voices + ' clicks)', v.seek.on && v.seek.voices === 0],
      ['help lists M and the Sound button', !!v.help && /M/.test(v.help) && /Sound button/.test(v.help)],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'fun',
    optIn: 'games',
    shot: 'fun.png',
    timeout: 120000,
    script: `const takeoffDone = async () => { const t = performance.now(); while (L.plane.takingOff && performance.now() - t < 4000) await sleep(30); };
      const stored = () => JSON.parse(localStorage.getItem('utxo-landscape-fun') || '{}');
      const live = () => L.plane.game.state.coins.filter((c) => c.gone == null);
      localStorage.removeItem('utxo-landscape-fun');
      await L.seek(inData(314000)); await idle();
      L.controls.setPose({ x: Math.min(150, tip / 1000 - 40), y: 14, z: 120, yaw: -70, pitch: -14 }); await sleep(400); await idle();
      const out = {};
      document.querySelector('#timeline [data-act="fun"]').click(); await sleep(150);
      out.menu = { open: L.fun.open, crafts: [...document.querySelectorAll('#fun [data-craft]')].map((b) => b.dataset.craft + '=' + b.getAttribute('aria-pressed')),
        best: document.querySelector('#fun [data-play="stack-sats"] .pl-meta').textContent };
      document.querySelector('#fun [data-craft="bird"]').click(); await sleep(100);
      out.chose = { open: L.fun.open, craft: L.plane.craft, pressed: document.querySelector('#fun [data-craft="bird"]').getAttribute('aria-pressed'), stored: stored().craft };
      document.querySelector('#fun [data-play="free"]').click(); await sleep(50);
      out.free = { open: L.fun.open, mode: L.controls.mode };
      await takeoffDone(); await sleep(400);
      const pivots = L.plane.model.getObjectByName('bird').children.filter((o) => o.type === 'Group');
      const z0 = pivots.length ? pivots[1].rotation.z : NaN; await sleep(90); const z1 = pivots.length ? pivots[1].rotation.z : NaN;
      out.bird = { craft: L.plane.state.craft, shown: L.plane.model.getObjectByName('bird').visible && !L.plane.model.getObjectByName('plane').visible,
        speed: L.plane.state.speed, head: document.querySelector('#planekeys .eyebrow').textContent, flapping: Math.abs(z1 - z0) > 0.01,
        clearance: L.plane.state.y - L.view.heightAt(L.plane.state.x, L.plane.state.z) };
      // Down to the ground: the bird skims at its 0.06 clearance.
      { const st = L.plane.state; st.y = L.view.heightAt(st.x, st.z) + 0.4; st.pitch = -1.2; st.camPitch = -1.2;
        const t = performance.now(); while (st.y - L.view.heightAt(st.x, st.z) > 0.1 && performance.now() - t < 4000) await sleep(30);
        out.bird.low = st.y - L.view.heightAt(st.x, st.z);
        // Climb clear of the columns before the jet takes over (it bumps on rises over 0.2).
        Object.assign(st, { y: st.y + 8, pitch: 0, camPitch: 0, bank: 0 }); }
      key('KeyC', { key: 'c' }); await sleep(100);
      out.jet = { craft: L.plane.state.craft, shown: L.plane.model.getObjectByName('jet').visible && !L.plane.model.getObjectByName('bird').visible, stored: stored().craft,
        head: document.querySelector('#planekeys .eyebrow').textContent, sound: L.plane.sound.state.target };
      await sleep(2500); out.jet.speed = L.plane.state.speed;
      key('Enter', { key: 'Enter' }); await sleep(50);
      out.started = L.plane.game.active;
      const t0 = performance.now();
      while (live().length < 10 && performance.now() - t0 < 3000) await sleep(30);
      out.coins = { ms: Math.round(performance.now() - t0), n: live().length, meshes: L.plane.coins ? L.plane.coins.children.filter((m) => m.visible).length : 0,
        hud: document.querySelector('#planehud .ph-game').textContent };
      key('KeyC', { key: 'c' }); await sleep(50); out.craftDuringRun = L.plane.state.craft;
      // Fly at a coin: just in front of it at its height, heading for it (collision off for this pass).
      const coin = live()[0]; const st = L.plane.state;
      L.settings.set('camera.collision', false);
      Object.assign(st, { x: coin.x, z: coin.z + 2, y: coin.y, yaw: 0, camYaw: 0, pitch: 0, camPitch: 0, bank: 0, mouseX: 0, mouseY: 0 });
      const t1 = performance.now();
      while (L.plane.game.state.collected === 0 && performance.now() - t1 < 2000) await sleep(16);
      L.settings.set('camera.collision', true);
      out.hit = { collected: L.plane.game.state.collected, score: L.plane.game.state.score, value: coin.value, pops: [...document.querySelectorAll('#funpops .ph-pop')].map((e) => e.textContent),
        hud: document.querySelector('#planehud .ph-game').textContent };
      // Follow the trail like a player: aim at the nearest coin ahead every frame for 6 s.
      { const c0 = L.plane.game.state.collected; const t2 = performance.now(); let most = 0;
        while (performance.now() - t2 < 6000 && L.plane.game.active) {
          const lv = live(); most = Math.max(most, lv.length);
          const target = lv.filter((k) => (k.x - st.x) * -Math.sin(st.yaw) + (k.z - st.z) * -Math.cos(st.yaw) > -0.3)
            .sort((u, w) => Math.hypot(u.x - st.x, u.z - st.z) - Math.hypot(w.x - st.x, w.z - st.z))[0];
          if (target) {
            const dx = target.x - st.x, dz = target.z - st.z, d = Math.hypot(dx, dz);
            Object.assign(st, { yaw: Math.atan2(-dx, -dz), pitch: Math.max(-1, Math.min(1, Math.atan2(target.y - st.y, Math.max(d, 0.5)))), bank: 0, mouseX: 0, mouseY: 0 });
          }
          await frame();
        }
        out.follow = { coins: L.plane.game.state.collected - c0, most, bumps: st.bumps }; }
      L.plane.game.stop(); await sleep(150);
      const p0 = { x: st.x, z: st.z }; await sleep(300);
      out.card = { open: L.fun.card, text: document.getElementById('funcard').textContent, mode: L.controls.mode, active: L.plane.game.active,
        flying: Math.hypot(st.x - p0.x, st.z - p0.z) > 0.5, best: stored().best && stored().best['stack-sats'] && stored().best['stack-sats'].jet };
      document.querySelector('#fun').hidden = true;
      document.querySelector('#funcard [data-card="again"]').click(); await sleep(150);
      out.again = { active: L.plane.game.active, score: L.plane.game.state.score, card: L.fun.card, mode: L.controls.mode };
      document.querySelector('#timeline [data-act="fun"]').click(); await sleep(150);
      out.menuInFlight = { open: L.fun.open, mode: L.controls.mode, active: L.plane.game.active,
        best: document.querySelector('#fun [data-play="stack-sats"] .pl-meta').textContent };
      L.fun.toggle();
      key('Enter', { key: 'Enter' }); await sleep(50);
      out.enterInMap = L.controls.mode;
      L.plane.takeoff(); await takeoffDone(); key('Enter', { key: 'Enter' }); await sleep(100); L.plane.game.stop(); await sleep(100);
      document.querySelector('#funcard [data-card="land"]').click(); await sleep(400);
      out.land = { mode: L.controls.mode, card: L.fun.card, coins: live().length, model: L.plane.model.visible };
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['the Fun menu opens with three crafts, the plane chosen, no stack yet (' + v.menu.crafts.join(' ') + ')',
        v.menu.open && v.menu.crafts.join(' ') === 'plane=true bird=false jet=false' && v.menu.best === 'No stack yet'],
      ['choosing the bird keeps the menu open and remembers it', v.chose.open && v.chose.craft === 'bird' && v.chose.pressed === 'true' && v.chose.stored === 'bird'],
      ['Free flight closes the menu and takes off', !v.free.open && v.free.mode === 'plane'],
      ['the bird flies: its model shown, flapping, at most 4 units/s (' + v.bird.speed.toFixed(2) + ')',
        v.bird.craft === 'bird' && v.bird.shown && v.bird.flapping && v.bird.speed <= 4 && v.bird.head === 'Bird'],
      ['the bird dives to skim the ground (' + v.bird.low.toFixed(3) + ' above it, from ' + v.bird.clearance.toFixed(2) + ')', v.bird.low >= 0.059 && v.bird.low < 0.2],
      ['C switches to the jet in flight and remembers it', v.jet.craft === 'jet' && v.jet.shown && v.jet.stored === 'jet' && v.jet.head === 'Jet'],
      ['the jet speeds up past the bird (' + v.jet.speed.toFixed(1) + ' units/s)', v.jet.speed > 4],
      ['Enter starts Stack sats and a coin trail appears at once (' + v.coins.n + ' coins, ' + v.coins.meshes + ' drawn, after ' + v.coins.ms + ' ms)',
        v.started && v.coins.n >= 10 && v.coins.ms < 1000 && v.coins.meshes >= v.coins.n],
      ['the HUD shows the run (' + v.coins.hud + ')', /^Stack sats \u00b7 [01]:\d\d \u00b7 0 BTC \u00b7 0 coins$/.test(v.coins.hud)],
      ['C does not change the craft during a run', v.craftDuringRun === 'jet'],
      ['flying through a coin stacks its row amount and pops it (' + v.hit.pops.join(' ') + '; ' + v.hit.hud + ')',
        v.hit.collected >= 1 && v.hit.score >= v.hit.value && v.hit.value > 0 && v.hit.pops.length >= 1 && /^\+/.test(v.hit.pops[0]) && / [1-8] coins?$/.test(v.hit.hud)],
      ['following the trails for 6 s collects many coins (' + v.follow.coins + ', up to ' + v.follow.most + ' out at once, ' + v.follow.bumps + ' bumps)', v.follow.coins >= 8 && v.follow.most >= 12],
      ['the end card shows the stack and the new best, the craft flies on (' + v.card.text + ')',
        v.card.open && !v.card.active && v.card.mode === 'plane' && v.card.flying && /^Stack sats \u00b7 JetStacked /.test(v.card.text) && /New best with the Jet/.test(v.card.text) && !!v.card.best && v.card.best.sats > 0],
      ['Again restarts from zero', v.again.active && v.again.score === 0 && !v.again.card && v.again.mode === 'plane'],
      ['the Fun button lands first and the menu shows the best', v.menuInFlight.open && v.menuInFlight.mode === 'map' && !v.menuInFlight.active && /^Best /.test(v.menuInFlight.best)],
      ['Enter does nothing in map mode', v.enterInMap === 'map'],
      ['Land returns to map mode, card closed, coins gone', v.land.mode === 'map' && !v.land.card && v.land.coins === 0 && !v.land.model],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'follow',
    shot: 'follow.png',
    timeout: 120000,
    script: `const out = {};
      const btn = document.querySelector('#timeline [data-act="follow"]');
      out.button = !!btn;
      // Pose change of everything but x (y, z, yaw, pitch).
      const offAxis = (a, b) => Math.max(Math.abs(a.y - b.y), Math.abs(a.z - b.z), Math.abs(a.yaw - b.yaw), Math.abs(a.pitch - b.pitch));
      const settle = async () => { await idle(); await sleep(1500); };
      // Play at 1x for ms; returns the camera's x shift against the tip's after the glide settles.
      async function playFor(ms, track = null) {
        const b0 = L.replay.block; const c0 = L.controls.getPose();
        L.playback.setSpeed('1'); L.playback.play();
        if (track) {
          const t0 = performance.now(); let lastX = c0.x; let still = 0;
          while (performance.now() - t0 < ms) {
            await frame();
            const t = performance.now(); const x = L.controls.getPose().x;
            if (t - t0 > 1000) { if (x === lastX) still++; track.frames++; track.samples.push([t, x, L.replay.block]); }
            lastX = x;
          }
          track.still = still;
        } else await sleep(ms);
        L.playback.pause(); await settle();
        const c1 = L.controls.getPose();
        return { blocks: L.replay.block - b0, dx: c1.x - c0.x, off: offAxis(c0, c1) };
      }
      await L.seek(inData(400000)); await idle();
      const tx = L.replay.block / 1000;
      const place = (x, z, up, yaw, pitch) => L.controls.setPose({ x, y: L.view.heightAt(x, z) + up, z, yaw, pitch });
      place(tx - 5, 185, 8, -50, -28); await sleep(300); await idle();
      // N turns following on without moving the camera.
      const p0 = L.controls.getPose();
      key('KeyN', { key: 'n' }); await frame(); await frame();
      const p1 = L.controls.getPose();
      out.on = { active: L.follow.active, pressed: btn && btn.getAttribute('aria-pressed'), moved: Math.max(Math.abs(p1.x - p0.x), offAxis(p0, p1)),
        hash: L.hash().includes('follow=1') };
      // 1x for 5 s: the camera moves on every frame and travels as far as the tip.
      const track = { frames: 0, samples: [] };
      out.play = await playFor(5000, track);
      const s = track.samples; const a = s[0]; const z = s[s.length - 1];
      out.play.still = track.still; out.play.frames = track.frames;
      out.play.window = { cam: z[1] - a[1], tip: (z[2] - a[2]) / 1000 };
      // A paused step of one block moves the camera one block's width.
      const q0 = L.controls.getPose(); key('BracketRight', { key: ']' }); await settle();
      out.step = L.controls.getPose().x - q0.x;
      // A seek moves the camera as far as the tip went (y only rises for ground clearance).
      const across = (a, b) => Math.max(Math.abs(a.z - b.z), Math.abs(a.yaw - b.yaw), Math.abs(a.pitch - b.pitch));
      { const c0 = L.controls.getPose(); const b0 = L.replay.block; await L.seek(b0 + 5000); await settle(); await sleep(2000);
        const c1 = L.controls.getPose(); out.seek = { blocks: L.replay.block - b0, dx: c1.x - c0.x, off: across(c0, c1), dy: c1.y - c0.y }; }
      // Dragging the scrubber: the camera moves with each seek while dragging and ends as far
      // as the tip went after the release.
      { const s = document.querySelector('.tl-scrub'); const c0 = L.controls.getPose(); const b0 = L.replay.block;
        const marks = [b0 + 8000, b0 + 16000, b0 + 24000]; let mid = null; let midScrubbing = null;
        for (const m of marks) {
          s.value = String(m); s.dispatchEvent(new Event('input', { bubbles: true }));
          if (mid === null) {
            // Still dragging: wait for the first scrub seek to land, then see the camera follow.
            const t = performance.now(); while (L.replay.block === b0 && performance.now() - t < 6000) await sleep(50);
            await sleep(800); mid = L.controls.getPose().x - c0.x; midScrubbing = L.playback.state.scrubbing;
          } else await sleep(700);
        }
        const want = b0 + 24123; s.value = String(want); s.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300); await settle(); await sleep(2500);
        const c1 = L.controls.getPose(); out.scrub = { want, block: L.replay.block, blocks: L.replay.block - b0, dx: c1.x - c0.x, mid, midScrubbing, off: across(c0, c1) }; }
      // The block field moves it too.
      { const bi = document.querySelector('.tl-block'); const c0 = L.controls.getPose(); const b0 = L.replay.block;
        bi.focus(); bi.value = String(b0 - 1500); bi.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); await settle(); await sleep(1000);
        const c1 = L.controls.getPose(); out.blockInput = { blocks: L.replay.block - b0, dx: c1.x - c0.x }; }
      // Places sets the camera itself: following starts again from the place's pose.
      { const p = await L.flyTo(inData(314000)); await settle();
        const want = p.block / 1000 - 9 + 75 * Math.sin(28 * Math.PI / 180) * Math.cos(30 * Math.PI / 180);
        out.place = { block: L.replay.block, placeBlock: p.block, x: L.controls.getPose().x, want, lag: L.follow.lag, active: L.follow.active }; }
      // Flight mode follows the same way.
      L.controls.setMode('flight'); await sleep(200);
      out.flight = await playFor(2500); out.flight.mode = L.controls.mode;
      L.controls.setMode('map'); await sleep(200);
      // Plane mode holds following; landing does not jump, and following resumes after it.
      L.controls.setMode('plane');
      { const t = performance.now(); while (L.plane.takingOff && performance.now() - t < 4000) await sleep(30); }
      L.playback.play(); await sleep(1500); L.playback.pause(); await idle();
      out.plane = { active: L.follow.active, mode: L.controls.mode };
      const g0 = L.controls.getPose(); L.plane.land(); await frame(); await frame(); await frame(); await sleep(500);
      const g1 = L.controls.getPose(); out.plane.landing = Math.max(Math.abs(g1.x - g0.x), Math.abs(g1.y - g0.y), Math.abs(g1.z - g0.z));
      out.plane.after = await playFor(2500);
      // Export carries following; the button turns it off; a link with follow=1 turns it on.
      const json = await L.panel.exportJSON({ download: false }); out.exported = json && json.view && json.view.follow;
      btn.click(); await frame();
      out.off = { active: L.follow.active, pressed: btn.getAttribute('aria-pressed') };
      await sleep(500); out.off.hash = L.hash().includes('follow=1');
      location.hash = '#b=' + L.replay.block + '&follow=1'; await sleep(300);
      out.link = { active: L.follow.active, pressed: btn.getAttribute('aria-pressed') };
      // Screenshot: following on (turned on with the button) above the tip in map mode.
      L.follow.set(false); btn.click(); await frame();
      out.clicked = { active: L.follow.active, pressed: btn.getAttribute('aria-pressed') };
      place(L.replay.block / 1000 - 16, 200, 20, -55, -30); await sleep(300); await idle(); await sleep(800);
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['Follow button in the timeline', v.button],
      ['N turns following on without moving the camera (' + v.on.moved + ')', v.on.active && v.on.pressed === 'true' && v.on.moved === 0],
      ['the link records follow=1', v.on.hash],
      ['1x: the camera travels as far as the tip (' + v.play.dx.toFixed(4) + ' for ' + v.play.blocks + ' blocks)',
        v.play.blocks > 100 && Math.abs(v.play.dx - v.play.blocks / 1000) < 0.002],
      ['1x: only x changes (' + v.play.off + ')', v.play.off < 1e-6],
      ['1x: the camera keeps pace with the tip (camera ' + v.play.window.cam.toFixed(4) + ', tip ' + v.play.window.tip.toFixed(4) + ' over the last 4 s)',
        Math.abs(v.play.window.cam - v.play.window.tip) < 0.02],
      ['1x: the camera moves on every frame (' + v.play.still + ' still of ' + v.play.frames + ')', v.play.frames > 30 && v.play.still <= 2],
      ['a paused 1-block step moves the camera one block (' + v.step.toFixed(6) + ')', Math.abs(v.step - 0.001) < 1e-4],
      ['a seek moves the camera as far as the tip (' + v.seek.dx.toFixed(4) + ' for ' + v.seek.blocks + ' blocks)',
        v.seek.blocks === 5000 && Math.abs(v.seek.dx - 5) < 0.002 && v.seek.off < 1e-6 && v.seek.dy >= 0],
      ['the scrubber moves the camera while dragging (' + v.scrub.mid.toFixed(3) + ') and as far as the tip after the release (' +
        v.scrub.dx.toFixed(4) + ' for ' + v.scrub.blocks + ' blocks)',
        v.scrub.block === v.scrub.want && v.scrub.midScrubbing === true && v.scrub.mid > 1 && Math.abs(v.scrub.dx - v.scrub.blocks / 1000) < 0.002 && v.scrub.off < 1e-6],
      ['the block field moves the camera as far as the tip (' + v.blockInput.dx.toFixed(4) + ' for ' + v.blockInput.blocks + ' blocks)',
        v.blockInput.blocks === -1500 && Math.abs(v.blockInput.dx + 1.5) < 0.002],
      ['Places puts the camera at the place, not shifted by the seek (x ' + v.place.x.toFixed(3) + ', place pose ' + v.place.want.toFixed(3) + ')',
        v.place.active && v.place.block === v.place.placeBlock && Math.abs(v.place.x - v.place.want) < 1e-3 && v.place.lag === 0],
      ['flight mode follows the tip (' + v.flight.dx.toFixed(4) + ' for ' + v.flight.blocks + ' blocks)',
        v.flight.mode === 'flight' && v.flight.blocks > 50 && Math.abs(v.flight.dx - v.flight.blocks / 1000) < 0.002],
      ['plane mode keeps following on; landing does not jump (' + v.plane.landing + ')', v.plane.active && v.plane.mode === 'plane' && v.plane.landing < 1e-9],
      ['following resumes after landing (' + v.plane.after.dx.toFixed(4) + ' for ' + v.plane.after.blocks + ' blocks)',
        v.plane.after.blocks > 50 && Math.abs(v.plane.after.dx - v.plane.after.blocks / 1000) < 0.002],
      ['export carries following', v.exported === true],
      ['the button turns following off', !v.off.active && v.off.pressed === 'false' && !v.off.hash],
      ['a link with follow=1 turns it on', v.link.active && v.link.pressed === 'true'],
      ['the button turns following on', v.clicked.active && v.clicked.pressed === 'true'],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'hash-export-import',
    hash: '#b=BLOCK&mode=map&cam=290.000,30.000,180.000,20.00,-25.00&preset=Film',
    script: `await idle();
      const want = Number(new URLSearchParams(location.hash.slice(1)).get('b'));
      const p = L.controls.getPose();
      const out = { block: L.replay.block, want, look: L.settings.look, quality: L.settings.quality, pose: p };
      const json = await L.panel.exportJSON({ download: false }); out.exportView = json && json.view;
      await L.seek(inData(150000)); await idle(); L.controls.setPose({ x: 50, y: 80, z: 300, yaw: 0, pitch: -40 }); L.settings.setLook('Landscape'); L.settings.setQuality('Balanced'); await sleep(200);
      await L.panel.importJSON(json, 'check.json'); await sleep(300); await idle();
      const q = L.controls.getPose(); out.after = { block: L.replay.block, look: L.settings.look, quality: L.settings.quality, x: q.x, z: q.z };
      L.settings.set('display.hud', false); L.settings.set('amp.measure', 'count'); await sleep(200);
      out.hudHidden = document.getElementById('hud').hidden; out.measures = L.replay.measures; L.settings.set('display.hud', true);
      out.hash = L.hash();
      return out;`,
    expect: (v) => [
      ['link restores the block', v.block === v.want],
      ['a link from before looks (preset=Film) opens BitcoinTimelapse.com at High', v.look === 'BitcoinTimelapse.com' && v.quality === 'High'],
      ['link restores the camera', Math.abs(v.pose.x - 290) < 1e-3 && Math.abs(v.pose.yaw - 20) < 1e-3],
      ['export carries the view', !!(v.exportView && v.exportView.b === v.want)],
      ['import restores block, look, quality and camera', v.after.block === v.want && v.after.look === 'BitcoinTimelapse.com' && v.after.quality === 'High' && Math.abs(v.after.x - 290) < 1e-3],
      ['the share link names the look by its current name', /(^|&|#)look=BitcoinTimelapse\.com(&|$)/.test(v.hash) && /(^|&|#)preset=High(&|$)/.test(v.hash)],
      ['display.hud hides the HUD', v.hudHidden],
      ['amp.measure reaches the worker', v.measures && v.measures.height === 'count'],
    ],
  },
  {
    name: 'touch',
    mobile: { width: 390, height: 844, dpr: 3 },
    shot: 'touch-phone.png',
    timeout: 120000,
    script: `const { Vector3 } = await import('three');
      const proj = (p) => { const v = new Vector3(p.x, p.y, p.z).project(L.view.camera); const r = canvas.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
      const off = (p, x, y) => { const s = proj(p); return Math.hypot(s[0] - x, s[1] - y); };
      const touch = (steps) => new Promise((resolve) => { const id = String(Math.random()); window.__cdpTouchDone = (i, err) => { if (i === id) resolve(err); }; window.__cdpTouch(JSON.stringify({ id, steps })); });
      const pts = (list) => list.map(([x, y], i) => ({ x, y, id: i + 1 }));
      // Fingers from 'from' to 'to' ([[x, y], ...]) in n moves, one frame apart.
      const path = (from, to, n = 14) => { const s = []; for (let i = 1; i <= n; i++) s.push({ type: 'touchMove', points: pts(from.map(([x, y], k) => [x + (to[k][0] - x) * i / n, y + (to[k][1] - y) * i / n])), wait: 16 }); return s; };
      const gesture = async (from, to, n) => touch([{ type: 'touchStart', points: pts(from), wait: 30 }, ...path(from, to, n), { type: 'touchEnd', points: [], wait: 60 }]);
      const tapAt = (x, y) => [{ type: 'touchStart', points: pts([[x, y]]), wait: 40 }, { type: 'touchEnd', points: [], wait: 0 }];
      const pose = () => L.controls.getPose();
      const camPos = () => L.view.camera.position.clone();
      const home = async () => { await L.flyTo(inData(314000)); await idle(); await sleep(800); };
      const out = { errors: [] };
      const run = async (f) => { const e = await f(); if (e) out.errors.push(e); };
      await home();
      { const p = L.view.pick(195, 500); await run(() => gesture([[195, 500]], [[235, 560]])); await sleep(100); out.panPx = p ? off(p, 235, 560) : null; }
      await home();
      { const p = L.view.pick(195, 480); const d0 = camPos().distanceTo(p); await run(() => gesture([[155, 480], [235, 480]], [[115, 480], [275, 480]])); await sleep(100);
        out.pinch = { px: off(p, 195, 480), ratio: d0 / camPos().distanceTo(p) }; }
      await home();
      { const p = L.view.pick(195, 480); const pa = L.view.pick(135, 480); const y0 = pose().yaw; const r = 60, t = 30 * Math.PI / 180;
        await run(() => gesture([[195 - r, 480], [195 + r, 480]], [[195 - r * Math.cos(t), 480 - r * Math.sin(t)], [195 + r * Math.cos(t), 480 + r * Math.sin(t)]], 18)); await sleep(100);
        // The ground under the left finger turns the same way as the finger (clockwise on screen).
        const s = proj(pa); const turn = Math.atan2(s[1] - 480, s[0] - 195) - Math.atan2(0, -60);
        const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn));
        out.twist = { px: off(p, 195, 480), dYaw: pose().yaw - y0, contentTurn: wrapped * 180 / Math.PI }; }
      await home();
      { const p = L.view.pick(195, 520); const q0 = pose(); const d0 = p && camPos().distanceTo(p);
        await run(() => gesture([[135, 520], [255, 520]], [[135, 460], [255, 460]])); await sleep(100);
        const q1 = pose(); out.tilt = { dPitch: q1.pitch - q0.pitch, dYaw: q1.yaw - q0.yaw, distRatio: p ? camPos().distanceTo(p) / d0 : null }; }
      await home();
      { // Pinch, lift one finger, keep panning with the other: the ground under it must not jump.
        const a0 = [[155, 480], [235, 480]], a1 = [[145, 480], [245, 480]];
        await run(() => touch([{ type: 'touchStart', points: pts(a0), wait: 30 }, ...path(a0, a1, 8), { type: 'touchEnd', points: [{ x: 245, y: 480, id: 2 }], wait: 60 }]));
        const g = L.view.pick(145, 480);
        await run(() => touch([...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ type: 'touchMove', points: [{ x: 145 + i * 5, y: 480 + i * 6, id: 1 }], wait: 16 })), { type: 'touchEnd', points: [], wait: 60 }]));
        out.liftPx = g ? off(g, 185, 528) : null; }
      await home();
      { const p = L.view.pick(195, 470); const d0 = camPos().distanceTo(p); await run(() => touch([...tapAt(195, 470).map((s, i) => (i === 1 ? { ...s, wait: 90 } : s)), ...tapAt(195, 470)])); await sleep(2200);
        const r = canvas.getBoundingClientRect(); out.doubleTap = { centrePx: off(p, r.left + r.width / 2, r.top + r.height / 2), ratio: camPos().distanceTo(p) / d0 }; }
      await home();
      { const p = L.view.pick(195, 470); const d0 = camPos().distanceTo(p); await run(() => touch([{ type: 'touchStart', points: pts([[155, 470], [235, 470]]), wait: 70 }, { type: 'touchEnd', points: [], wait: 0 }])); await sleep(900);
        out.twoTap = { ratio: camPos().distanceTo(p) / d0 }; }
      await home();
      { const p = L.view.pick(195, 470); const d0 = camPos().distanceTo(p);
        await run(() => touch([...tapAt(195, 470).map((s, i) => (i === 1 ? { ...s, wait: 90 } : s)), { type: 'touchStart', points: pts([[195, 470]]), wait: 30 }, ...path([[195, 470]], [[195, 550]], 10), { type: 'touchEnd', points: [], wait: 60 }])); await sleep(500);
        out.tapDrag = { ratio: camPos().distanceTo(p) / d0, inspectorOpen: !document.getElementById('inspector').hidden }; }
      await home();
      { L.ui.inspector.close && L.ui.inspector.close(); const p = L.view.pick(195, 470); await run(() => touch(tapAt(195, 470))); await sleep(150); const early = !!(L.ui.inspector.current); await sleep(900);
        const c = L.ui.inspector.current; out.tap = { early, opened: !!c && !document.getElementById('inspector').hidden, hasCell: !!(c && Number.isInteger(c.col)) }; }
      { // The tapped cell stays visible beside the inspector sheet.
        const mk = document.getElementById('marker'); const sh = document.getElementById('inspector').getBoundingClientRect(); const m = mk.getBoundingClientRect();
        out.tap.marker = { hidden: mk.hidden, x: m.left, y: m.top, sheet: [sh.left, sh.top, sh.width] }; }
      L.ui.inspector.close(); await sleep(300);
      { // Pinch over the empty ground beyond the landscape, just below the horizon: the camera
        // must not be flung toward the far ground point (the old behaviour moved ~6x farther).
        L.controls.setPose({ x: 1150, y: 40, z: 100, yaw: -90, pitch: -2 }); await sleep(300);
        const onCanvas = (y) => document.elementFromPoint(155, y) === canvas && document.elementFromPoint(235, y) === canvas;
        const r = canvas.getBoundingClientRect(); let y = Math.round(r.top + r.height / 2) + 30;
        while (y < r.bottom - 120 && (L.view.pick(195, y) || !onCanvas(y))) y += 10;
        const sky = !L.view.pick(195, y) && onCanvas(y); const c0 = camPos();
        const edge = new Vector3((L.manifest.tip + 1) / 1000, 0, c0.z);
        await run(() => gesture([[155, y], [235, y]], [[115, y], [275, y]])); await sleep(100);
        out.background = { sky, y, moved: camPos().distanceTo(c0), edgeDist: c0.distanceTo(edge) }; }
      // Pinch with both fingers on the HUD card, then on the timeline: the page must not zoom.
      for (const id of ['hud', 'timeline']) {
        const h = document.getElementById(id).getBoundingClientRect(); const hy = h.top + Math.min(24, h.height / 2);
        const at = (f) => h.left + f * h.width;
        await run(() => gesture([[at(0.3), hy], [at(0.7), hy]], [[at(0.03), hy], [at(0.97), hy]])); await sleep(300);
      }
      out.pageScale = window.visualViewport ? visualViewport.scale : 1;
      out.fly = { button: !!document.querySelector('#timeline [data-act="fly"]'), fun: !!document.querySelector('#timeline [data-act="fun"]') };
      { const sb = document.querySelector('#timeline [data-act="sound"]'); const hb = document.querySelector('#timeline [data-act="help"]').getBoundingClientRect();
        out.sound = { button: !!sb, right: Math.round(hb.right), width: innerWidth }; }
      key('KeyT', { key: 't' }); await sleep(100); out.fly.mode = L.controls.mode;
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['touch input delivered', v.errors.length === 0],
      ['one finger: the ground stays under the finger (' + (v.panPx ?? NaN).toFixed(2) + ' px)', v.panPx !== null && v.panPx < 1],
      ['pinch: the point between the fingers stays put (' + v.pinch.px.toFixed(2) + ' px) and zooms 2x (' + v.pinch.ratio.toFixed(2) + ')', v.pinch.px < 1.5 && Math.abs(v.pinch.ratio - 2) < 0.15],
      ['twist: clockwise 30 degrees turns the view 30 degrees (' + v.twist.dYaw.toFixed(1) + ') about the point between the fingers (' + v.twist.px.toFixed(2) + ' px)', Math.abs(v.twist.dYaw - 30) < 1.5 && v.twist.px < 1.5],
      ['twist: the ground turns with the fingers (' + v.twist.contentTurn.toFixed(1) + ' degrees clockwise)', v.twist.contentTurn > 10],
      ['two fingers up: tilts toward the horizon (' + v.tilt.dPitch.toFixed(1) + ' degrees) without turning or zooming', v.tilt.dPitch > 10 && Math.abs(v.tilt.dYaw) < 0.5 && v.tilt.distRatio !== null && Math.abs(v.tilt.distRatio - 1) < 0.02],
      ['lifting one finger keeps panning without a jump (' + (v.liftPx ?? NaN).toFixed(2) + ' px)', v.liftPx !== null && v.liftPx < 1.5],
      ['double tap: flies closer (' + v.doubleTap.ratio.toFixed(2) + ' of the distance) and centres the point (' + v.doubleTap.centrePx.toFixed(1) + ' px)', Math.abs(v.doubleTap.ratio - 0.35) < 0.05 && v.doubleTap.centrePx < 3],
      ['two-finger tap: zooms out 2x (' + v.twoTap.ratio.toFixed(2) + ')', Math.abs(v.twoTap.ratio - 2) < 0.15],
      ['double tap and drag down: zooms in (' + v.tapDrag.ratio.toFixed(2) + ') without inspecting', v.tapDrag.ratio < 0.65 && v.tapDrag.ratio > 0.4 && !v.tapDrag.inspectorOpen],
      ['tap: inspects after the double-tap window', !v.tap.early && v.tap.opened && v.tap.hasCell],
      ['tap: the inspected cell stays visible above the sheet (marker at ' + Math.round(v.tap.marker.y) + ' px, sheet from ' + Math.round(v.tap.marker.sheet[1]) + ' px)',
        !v.tap.marker.hidden && v.tap.marker.y > 0 && (v.tap.marker.y < v.tap.marker.sheet[1] - 8 || v.tap.marker.x < v.tap.marker.sheet[0] - 8)],
      ['pinch over empty ground: no fling (' + v.background.moved.toFixed(0) + ' units, landscape edge ' + v.background.edgeDist.toFixed(0) + ' away)', v.background.sky && v.background.moved > 1 && v.background.moved < 0.6 * v.background.edgeDist],
      ['the page itself never zooms', v.pageScale === 1],
      ['touch-only: no Fly or Fun button and T does not take off', !v.fly.button && !v.fly.fun && v.fly.mode === 'map'],
      ['a Sound button on touch devices too, and the button row fits (help ends at ' + v.sound.right + ' of ' + v.sound.width + ' px)',
        v.sound.button && v.sound.right <= v.sound.width],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'webgl2-fallback',
    query: '?webgl=1',
    shot: 'webgl2.png',
    script: `await idle(); await sleep(800); L.settings.applyPreset('Extreme'); await sleep(400);
      const out = { backend: L.view.backend, quality: L.settings.quality, ready: L.ready, frameError: L.frameError || null };
      await openPanel();
      out.ultraOff = quickButton('quality', 'Ultra').disabled && quickButton('quality', 'Extreme').disabled;
      out.boxesOff = quickButton('cellShape', 'boxes').disabled && quickButton('cellShape', 'columns').disabled;
      L.settings.setLook('Outputs'); await sleep(600);
      out.boxes = { columns: L.settings.get('geo.columns'), stepped: L.settings.get('geo.stepped'), frameError: L.frameError || null };
      return out;`,
    expect: (v) => [
      ['?webgl=1 uses WebGL2', v.backend === 'webgl2'],
      ['quality capped at High', v.quality === 'High'],
      ['the panel disables Ultra, Extreme, Columns and Boxes', v.ultraOff && v.boxesOff],
      ['Outputs (boxes) falls back to stepped cells without errors', v.boxes.columns === false && v.boxes.stepped === true && !v.boxes.frameError],
      ['renders (ready, no frame errors)', v.ready && !v.frameError],
    ],
  },
  {
    name: 'height-scale',
    shot: 'height-scale-settings.png',
    script: `await idle(); await sleep(500); L.playback.pause();
      const S = L.settings; await openPanel();
      const out = { sections: Array.from(document.querySelectorAll('#panel .lsq-sec')).map(s => s.dataset.section) };
      const row = L.panel.quick.row('heightCurve');
      const note = () => row.querySelector('.lsq-note').textContent;
      out.start = { curve: S.get('amp.curve'), pressed: row.querySelector('[aria-pressed=true]').dataset.option, note: note() };
      const panelRect = document.querySelector('#panel').getBoundingClientRect();
      out.nearTop = row.getBoundingClientRect().top < panelRect.top + 400;
      // Direct legend link opens the main controls, with the active option focused.
      L.panel.close(); await sleep(150); document.querySelector('#legend .lg-edit-height').click(); await sleep(200);
      out.link = L.panel.isOpen() && row.contains(document.activeElement) && !L.panel.quick.domElement.hidden;
      quickButton('heightCurve', 'linear').click(); await sleep(100);
      out.linear = { curve: S.get('amp.curve'), note: note(), legend: document.querySelector('#legend').textContent,
        logHidden: L.panel.quick.row('heightExposure').hidden, powerHidden: L.panel.quick.row('heightExponent').hidden };
      const enterNumber = (id, value) => { const input = L.panel.quick.row(id).querySelector('input'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); };
      enterNumber('heightReference', 1000); enterNumber('minimumHeight', 0);
      const height = L.panel.quick.row('height').querySelector('input'); height.value = '20'; height.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
      const { heightOfCpu } = await import('/render/terrain/curve.js');
      const p = L.view.terrain.shading.heightParams();
      out.proportional = { reference: S.get('amp.reference'), height: S.get('amp.exaggeration'), floor: S.get('amp.floor'),
        ratio: heightOfCpu(20, 1500, p) / heightOfCpu(10, 1500, p), note: note() };
      quickButton('heightCurve', 'power').click(); enterNumber('heightExponent', 0.8); await sleep(100);
      out.power = { curve: S.get('amp.curve'), exponent: S.get('amp.exponent'), visible: !L.panel.quick.row('heightExponent').hidden, note: note() };
      quickButton('heightCurve', 'log').click(); enterNumber('heightExposure', 2); await sleep(100);
      out.log = { curve: S.get('amp.curve'), exposure: S.get('amp.exposure'), visible: !L.panel.quick.row('heightExposure').hidden, note: note() };
      // Persistence and share links reproduce these values without changing the look.
      const { createSettingsStore } = await import('/settings.js'); const { SCHEMA, PRESETS } = await import('/settings.schema.js');
      S.flush(); await sleep(350);
      const fresh = createSettingsStore(SCHEMA, PRESETS, { storage: localStorage, autosave: false });
      fresh.load();
      const shared = createSettingsStore(SCHEMA, PRESETS, { storage: null }); shared.fromURL(S.toURL());
      const ids = ['amp.curve', 'amp.reference', 'amp.exaggeration', 'amp.floor', 'amp.exposure', 'amp.exponent'];
      out.persisted = ids.every(id => fresh.get(id) === S.get(id));
      out.shared = ids.every(id => shared.get(id) === S.get(id));
      fresh.dispose(); shared.dispose();
      S.setLook('Landscape'); await sleep(300);
      L.panel.quick.row('measure').scrollIntoView({ block: 'start' });
      out.frameError = L.frameError || null; return out;`,
    expect: (v) => [
      ['Data appears immediately after Look and the scale controls are near the top', v.sections[0] === 'Look' && v.sections[1] === 'Data' && v.nearTop],
      ['the active logarithmic setting and its compression are visible', v.start.curve === 'log' && v.start.pressed === 'log' && v.start.note.includes('not proportional')],
      ['Edit height scale opens and focuses the main controls', v.link],
      ['Linear changes the curve and legend, and hides irrelevant parameters', v.linear.curve === 'linear' && v.linear.legend.includes('Linear (proportional)') && v.linear.logHidden && v.linear.powerHidden],
      ['reference, drawing height and minimum height are editable; doubling the count doubles linear height', v.proportional.reference === 1000 && v.proportional.height === 20 && v.proportional.floor === 0 && Math.abs(v.proportional.ratio - 2) < 1e-9],
      ['Power and Logarithmic expose their own editable parameters', v.power.visible && v.power.exponent === 0.8 && v.log.visible && v.log.exposure === 2],
      ['scale settings survive storage reload and share links', v.persisted && v.shared],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'quick-settings',
    shot: 'quick-settings.png',
    timeout: 300000,
    script: `await idle(); await sleep(800);
      const { QUICK, quickOption } = await import('/settings.quick.js');
      const S = L.settings; const start = L.controls.getPose();
      await openPanel();
      const out = { clicks: [], bad: [], effects: {}, ui: {} };
      const select = document.querySelector('#panel [data-quick="look"] select');
      out.ui.looks = Array.from(select.options).map((o) => o.value);
      out.ui.qualities = Array.from(document.querySelectorAll('#panel [data-quick="quality"] [data-option]')).map((b) => b.dataset.option);
      // The startup quality: High locally, Balanced or Performance on a first visit online.
      out.ui.quality = S.quality;
      out.ui.status = document.querySelector('#panel .lsp-status').textContent;
      out.ui.advancedClosed = L.panel.advanced._closed;
      // Every option of every choice and toggle, clicked in the panel, selects itself.
      for (const c of QUICK.filter((q) => q.type === 'choice' || q.type === 'toggle' || q.type === 'blend')) {
        for (const o of c.options) {
          const b = quickButton(c.id, o.id);
          if (!b) { out.bad.push(c.id + '.' + o.id + ' missing'); continue; }
          b.click(); await sleep(30);
          const ok = quickOption(c, S.get) === o.id && b.getAttribute('aria-pressed') === 'true';
          out.clicks.push(c.id + '.' + o.id);
          if (!ok) out.bad.push(c.id + '.' + o.id);
        }
        S.setLook('Landscape'); await sleep(30);
      }
      // The look select and the quality buttons drive the store.
      select.value = 'Golden hour'; select.dispatchEvent(new Event('change')); await sleep(50);
      out.ui.lookAfterSelect = S.look;
      quickButton('quality', 'Balanced').click(); await sleep(50);
      out.ui.qualityAfterClick = S.quality;
      out.ui.statusAfter = document.querySelector('#panel .lsp-status').textContent;
      // Picking a quality turns auto scale off (it cut Extreme to half the pixels); Undo restores it.
      S.set('display.autoScale', true); await sleep(50);
      quickButton('quality', 'High').click(); await sleep(50);
      const box = document.querySelector('#panel .lsp-message');
      out.ui.autoScale = { afterClick: S.get('display.autoScale'), message: box.hidden ? '' : box.textContent };
      const undo = box.querySelector('button'); if (undo) undo.click(); await sleep(50);
      out.ui.autoScale.afterUndo = S.get('display.autoScale');
      S.set('display.autoScale', false);
      S.setLook('Landscape'); S.setQuality('High'); await sleep(50);
      // Each main control changes the picture: the largest of the differences between its two
      // ends at four cameras (each shows best somewhere else: the sky low, big coins from behind).
      const poses = { overview: start, close: POSES.close, low: POSES.low, back: POSES.back };
      async function effect(set0, set1) {
        const best = { diff: 0, pose: null };
        for (const [name, pose] of Object.entries(poses)) {
          L.controls.setPose(pose);
          S.setLook('Landscape'); S.setMany(set0); const a = await settled(700);
          S.setMany(set1); const b = await settled(700);
          const d = gridDiff(a, b);
          if (d > best.diff) { best.diff = Math.round(d * 100) / 100; best.pose = name; }
        }
        return best;
      }
      const P = (cid, oid) => QUICK.find((q) => q.id === cid).options.find((o) => o.id === oid).set;
      out.effects.timeOfDay = await effect(P('timeOfDay', 'night'), P('timeOfDay', 'day'));
      out.effects.sky = await effect(P('sky', 'on'), P('sky', 'off'));
      out.effects.glow = await effect(P('glow', 'off'), P('glow', 'strong'));
      out.effects.haze = await effect(P('haze', 'none'), P('haze', 'thick'));
      out.effects.cellShape = await effect(P('cellShape', 'smooth'), P('cellShape', 'boxes'));
      out.effects.height = await effect({ 'amp.exaggeration': 2 }, { 'amp.exaggeration': 30 });
      out.effects.colours = await effect({ 'color.palette': 'film' }, { 'color.palette': 'grey' });
      out.effects.bigCoins = await effect(P('bigCoins', 'normal'), P('bigCoins', 'towering'));
      S.setLook('Landscape'); L.controls.setPose(POSES.close); await settled(500);
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['the look select lists the eleven looks (' + v.ui.looks.length + ')', v.ui.looks.join() === 'Landscape,BitcoinTimelapse.com,Daylight,Golden hour,Earth,Whales,Pulse,Outputs,Money map,Linear,Paper'],
      ['five quality buttons', v.ui.qualities.join() === 'Performance,Balanced,High,Ultra,Extreme'],
      ['status reads the look and quality; Advanced starts closed (' + v.ui.status + ')', v.ui.status === 'Landscape \u00b7 ' + v.ui.quality && v.ui.advancedClosed === true],
      ['every option of every quick control selects itself (' + v.clicks.length + ' options' + (v.bad.length ? '; failed ' + v.bad.join(', ') : '') + ')', v.clicks.length >= 30 && v.bad.length === 0],
      ['the look select and quality buttons drive the store (' + v.ui.statusAfter + ')', v.ui.lookAfterSelect === 'Golden hour' && v.ui.qualityAfterClick === 'Balanced' && v.ui.statusAfter === 'Golden hour \u00b7 Balanced'],
      ['a quality button turns auto scale off and Undo turns it back on (' + v.ui.autoScale.message + ')', v.ui.autoScale.afterClick === false
        && /^Auto scale off: High renders at 100% resolution/.test(v.ui.autoScale.message) && v.ui.autoScale.afterUndo === true],
      ...Object.entries(v.effects).map(([k, e]) => [k + ' changes the picture (mean RGB difference ' + e.diff + ' at the ' + e.pose + ' camera)', e.diff >= 10]),
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'looks',
    timeout: 480000,
    script: `await idle(); await sleep(800);
      const S = L.settings; const start = L.controls.getPose();
      const out = { cameras: {}, shots: [], count: S.looks.length };
      for (const [cam, pose] of [['overview', start], ['map', POSES.map], ['close', POSES.close]]) {
        L.controls.setPose(pose);
        const grids = {};
        for (const look of S.looks) {
          S.setLook(look);
          grids[look] = await settled(1200);
          out.shots.push([cam + '-' + look, await jpeg(640, 360)]);
        }
        const pairs = [];
        const names = Object.keys(grids);
        for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
          pairs.push([names[i] + ' / ' + names[j], Math.round(gridDiff(grids[names[i]], grids[names[j]]) * 100) / 100]);
        }
        pairs.sort((a, b) => a[1] - b[1]);
        out.cameras[cam] = { min: pairs[0], closest: pairs.slice(0, 3) };
      }
      S.setLook('Landscape');
      out.frameError = L.frameError || null;
      const ink = () => document.getElementById('labels').classList.contains('lbl-on-light');
      await sleep(100); out.labelInk = { landscape: ink() };
      S.setLook('Paper'); await sleep(100); out.labelInk.paper = ink();
      S.setLook('Landscape'); await sleep(100); out.labelInk.back = ink();
      // Earth's sea reaches the horizon: looking out past the front edge (z 207) shows water where
      // other looks show the sky's ground colour, the floor moves with the camera, and picking
      // there still finds no cell. Back on Landscape the floor covers the landscape only.
      const floor = L.view.terrain.meshes.floor;
      const seaward = { x: 600, y: 30, z: 260, yaw: 180, pitch: -25 };
      const lowerHalf = async () => {
        const d = (await frameImage(48, 27)).getContext('2d').getImageData(0, 14, 48, 13).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      };
      S.setLook('Earth'); L.controls.setPose(seaward); await settled(800);
      out.sea = { look: S.get('geo.groundHorizon'), size: floor.scale.x, offset: Math.abs(floor.position.x - L.view.camera.position.x),
        colour: await lowerHalf(), pick: L.view.pick(innerWidth / 2, innerHeight * 0.75) };
      L.controls.setPose({ ...seaward, x: 300 }); await settled(500);
      out.sea.follows = Math.abs(floor.position.x - 300) < 1e-6;
      S.setLook('Landscape'); await settled(800);
      out.noSea = { size: floor.scale.x, colour: await lowerHalf() };
      L.controls.setPose(start);
      return out;`,
    node: (v) => {
      if (shots) for (const [name, url] of v.shots) writeFileSync(join(shots, 'look-' + name.replace(/ /g, '-').toLowerCase() + '.jpg'), Buffer.from(url.split(',')[1], 'base64'));
      v.shots = v.shots.map(([name]) => name);
    },
    // From the overview the landscape is a strip over about a quarter of the frame, and the data
    // looks (Outputs, Money map, Linear) share one background, so the frame means of two of them
    // differ by about 5 even where their strips look nothing alike: there a look only has to
    // change the frame visibly (3; a look that failed to apply scores about 0). The map and close
    // cameras, where the landscape fills the frame, need 10.
    expect: (v) => [
      ...Object.entries(v.cameras).map(([cam, c]) => {
        const need = cam === 'overview' ? 3 : 10;
        return ['all ' + v.count + ' looks differ by ' + need + ' or more at the ' + cam + ' camera (closest pair ' + c.min[0] + ': ' + c.min[1] + ')', c.min[1] >= need];
      }),
      ['axis labels turn to dark ink on Paper\'s white ground and back', !v.labelInk.landscape && v.labelInk.paper && !v.labelInk.back],
      ['Earth\'s sea reaches the horizon and follows the camera (floor ' + Math.round(v.sea.size) + ' units, lower half rgb ' + v.sea.colour.join(',') + ')',
        v.sea.look === true && v.sea.size > 10000 && v.sea.offset < 1e-6 && v.sea.follows && v.sea.colour[2] > v.sea.colour[0] + 40],
      ['the sea holds no data: picking past the landscape finds nothing', v.sea.pick === null],
      ['other looks keep the floor to the landscape (' + Math.round(v.noSea.size) + ' units, lower half rgb ' + v.noSea.colour.join(',') + ')',
        v.noSea.size < 1100 && Math.abs(v.noSea.colour[2] - v.noSea.colour[0]) < 40],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'user-presets',
    timeout: 120000,
    script: `await idle(); await sleep(500);
      const S = L.settings; const out = {};
      out.quality = S.quality; // saved looks keep the quality they were saved at
      localStorage.removeItem('utxo-landscape-presets-v1');
      await openPanel();
      const row = document.querySelector('#panel [data-quick="look"]');
      const select = row.querySelector('select');
      select.value = 'Daylight'; select.dispatchEvent(new Event('change')); await sleep(50);
      quickButton('haze', 'thick').click(); quickButton('glow', 'strong').click(); await sleep(50);
      out.before = { look: S.look, modified: S.modified, status: document.querySelector('#panel .lsp-status').textContent };
      row.querySelector('[data-act="save"]').click(); await sleep(50);
      const input = row.querySelector('input.lsq-name');
      out.formOpen = !row.querySelector('.lsq-saveform').hidden && document.activeElement === input;
      input.value = 'Check hazy noon';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(100);
      out.saved = { look: S.look, modified: S.modified, status: document.querySelector('#panel .lsp-status').textContent,
        listed: Array.from(select.querySelectorAll('optgroup[label="Saved"] option')).map((o) => o.value),
        message: document.querySelector('#panel .lsp-message').textContent };
      const stored = JSON.parse(localStorage.getItem('utxo-landscape-presets-v1') || 'null');
      out.stored = stored && stored.presets.map((p) => [p.name, p.look, p.quality, Object.keys(p.overrides).sort().join(',')]);
      // A fresh store on the same storage (as after a reload) lists it and reproduces the values.
      const { createSettingsStore } = await import('/settings.js');
      const { SCHEMA, PRESETS } = await import('/settings.schema.js');
      const fresh = createSettingsStore(SCHEMA, PRESETS, { storage: localStorage, autosave: false });
      fresh.setLook('Check hazy noon');
      out.freshMatches = SCHEMA.filter((e) => e.preset !== false).every((e) => JSON.stringify(fresh.get(e.id)) === JSON.stringify(S.get(e.id)));
      // Switch away and back through the select.
      select.value = 'Landscape'; select.dispatchEvent(new Event('change')); await sleep(50);
      out.away = { look: S.look, fog: S.get('light.fogDensity') };
      select.value = 'Check hazy noon'; select.dispatchEvent(new Event('change')); await sleep(50);
      out.back = { look: S.look, fog: S.get('light.fogDensity'), modified: S.modified };
      // Delete, then undo from the message.
      row.querySelector('[data-act="delete"]').click(); await sleep(100);
      out.deleted = { look: S.look, listed: Array.from(select.querySelectorAll('optgroup[label="Saved"] option')).length,
        stored: JSON.parse(localStorage.getItem('utxo-landscape-presets-v1')).presets.length };
      document.querySelector('#panel .lsp-message button.lsp-link').click(); await sleep(100);
      out.undone = { look: S.look, stored: JSON.parse(localStorage.getItem('utxo-landscape-presets-v1')).presets.length };
      // A built-in name is refused with a message.
      row.querySelector('[data-act="save"]').click(); await sleep(50);
      input.value = 'High'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(50);
      out.refused = { message: document.querySelector('#panel .lsp-message').textContent, formOpen: !row.querySelector('.lsq-saveform').hidden };
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      localStorage.removeItem('utxo-landscape-presets-v1');
      return out;`,
    expect: (v) => [
      ['changing quick settings marks the look changed (' + v.before.status + ')', v.before.look === 'Daylight' && v.before.modified && v.before.status === 'Daylight \u00b7 ' + v.quality + ' \u00b7 6 changed'],
      ['Save\u2026 opens a focused name field', v.formOpen],
      ['Enter saves it as the active look (' + v.saved.status + ')', v.saved.look === 'Check hazy noon' && !v.saved.modified && v.saved.listed.join() === 'Check hazy noon' && v.saved.status === 'Check hazy noon (saved) \u00b7 ' + v.quality],
      ['stored in this browser: base look, quality and the changed settings', JSON.stringify(v.stored) === JSON.stringify([['Check hazy noon', 'Daylight', v.quality, 'fx.bloom,fx.bloomRadius,fx.bloomStrength,fx.bloomThreshold,light.fogDensity,light.fogHeightFalloff']])],
      ['a fresh store on the same storage reproduces it', v.freshMatches],
      ['choosing it again restores its values', v.away.look === 'Landscape' && v.back.look === 'Check hazy noon' && v.back.fog === 0.008 && !v.back.modified],
      ['Delete removes it and keeps the values on Daylight; Undo brings it back', v.deleted.look === 'Daylight' && v.deleted.listed === 0 && v.deleted.stored === 0 && v.undone.look === 'Check hazy noon' && v.undone.stored === 1],
      ['a built-in name is refused with a message (' + v.refused.message + ')', /built-in name/.test(v.refused.message) && v.refused.formOpen],
    ],
  },
  {
    name: 'advanced-needs',
    shot: 'advanced-needs.png',
    script: `await idle(); await sleep(500);
      const S = L.settings; const out = {};
      await openPanel();
      L.panel.reveal('fx.bloomStrength'); await sleep(100);
      out.advancedOpen = !L.panel.advanced._closed;
      const bloomIds = ['fx.bloomStrength', 'fx.bloomThreshold', 'fx.bloomRadius', 'fx.bloomMips'];
      out.bloomOnInert = bloomIds.some((id) => settingRow(id).classList.contains('lsp-inert'));
      S.set('fx.bloom', false); await sleep(100);
      out.bloomOffInert = bloomIds.every((id) => settingRow(id).classList.contains('lsp-inert'));
      out.bloomTitle = settingRow('fx.bloomStrength').querySelector('.name').title.split('\\n').pop();
      S.set('fx.bloom', true); S.set('light.shadows', false); await sleep(100);
      out.cascades = { inert: settingRow('light.cascades').classList.contains('lsp-inert'), title: settingRow('light.cascades').querySelector('.name').title.split('\\n').pop() };
      S.set('light.shadows', true); await sleep(100);
      out.advancedTitle = L.panel.advanced.$title.textContent;
      out.changedList = Array.from(document.querySelectorAll('#panel .lsp-ov-item')).length;
      // Online, a first visit also turns on auto scale (personal preferences): those may be listed.
      out.governedChanged = Object.keys(S.overrides()).filter((id) => S.entry(id).preset !== false).length;
      S.setLook('BitcoinTimelapse.com'); await sleep(100);
      const shadowRow = document.querySelector('#panel [data-quick="shadows"]');
      out.film = { shadowsInert: shadowRow.classList.contains('lsq-inert'), shadowsTitle: shadowRow.querySelector('.lsq-label').title.split('\\n').pop(),
        todInert: document.querySelector('#panel [data-quick="timeOfDay"]').classList.contains('lsq-inert'),
        sunInert: settingRow('light.sunElevation').classList.contains('lsp-inert'), status: document.querySelector('#panel .lsp-status').textContent, quality: S.quality };
      // Haze is a slider: a density between its stops is a point on it, one beyond Thick is set by hand.
      S.setLook('Landscape'); S.set('light.fogDensity', 0.003); await sleep(100);
      out.between = document.querySelector('#panel [data-quick="haze"] .lsq-mixed').hidden;
      S.set('light.fogDensity', 0.03); await sleep(100);
      out.mixed = !document.querySelector('#panel [data-quick="haze"] .lsq-mixed').hidden;
      out.matches = L.panel.filter('bloom');
      out.searching = { quickHidden: L.panel.quick.domElement.hidden, advancedOpen: !L.panel.advanced._closed };
      L.panel.filter('');
      out.afterSearch = { quickHidden: L.panel.quick.domElement.hidden };
      S.setLook('Landscape');
      return out;`,
    expect: (v) => [
      ['reveal opens Advanced', v.advancedOpen],
      ['bloom off dims the bloom settings and says why (' + v.bloomTitle + ')', !v.bloomOnInert && v.bloomOffInert && v.bloomTitle === 'No effect with Bloom off.'],
      ['shadows off dims the cascade setting (' + v.cascades.title + ')', v.cascades.inert && v.cascades.title === 'No effect with Shadows off.'],
      ['Advanced counts the changed settings (' + v.advancedTitle + ', ' + v.changedList + ' listed, ' + v.governedChanged + ' of them look or quality)', v.advancedTitle === (v.changedList ? 'Advanced \u00b7 ' + v.changedList + ' changed' : 'Advanced') && v.governedChanged === 0],
      ['BitcoinTimelapse.com dims Shadows and the sun direction, not Time of day (' + v.film.shadowsTitle + ')', v.film.shadowsInert && v.film.sunInert && !v.film.todInert && v.film.shadowsTitle === 'No effect with Sun intensity 0.' && v.film.status === 'BitcoinTimelapse.com \u00b7 ' + v.film.quality],
      ['a fog density between the Haze stops sits on its slider; one beyond Thick shows Haze as mixed', v.between && v.mixed],
      ['search finds the bloom settings and steps the quick settings aside', v.matches >= 5 && v.searching.quickHidden && v.searching.advancedOpen && !v.afterSearch.quickHidden],
    ],
  },
  {
    name: 'render-layouts',
    timeout: 120000,
    script: `await idle(); await sleep(500);
      // Every scene-pass attachment layout renders: switching effects that add or drop G-buffer
      // attachments must not leave a stale pipeline behind (which failed validation and turned the
      // frame black, render/gbuffer.js).
      const S = L.settings; const errors = [];
      const original = console.error;
      console.error = (...a) => { const t = a.map(String).join(' '); if (/GPUValidationError|Invalid CommandBuffer/.test(t)) errors.push(t.slice(0, 160)); original.apply(console, a); };
      const brightness = async () => { const d = (await frameImage(48, 27)).getContext('2d').getImageData(0, 0, 48, 27).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return Math.round(s / (d.length / 4 * 3)); };
      L.controls.setPose(POSES.close); await settled(1500, 15000);
      const steps = [
        ['High', () => { S.setQuality('High'); S.setLook('Landscape'); }],
        ['Performance (no G-buffer)', () => S.setQuality('Performance')],
        ['Extreme', () => S.setQuality('Extreme')],
        ['Extreme, motion blur on', () => S.set('fx.motionBlur', true)],
        ['Extreme, motion blur off', () => S.set('fx.motionBlur', false)],
        ['SSAA 1', () => S.set('display.ssaa', 1)],
        ['TRAA', () => S.set('display.aa', 'traa')],
        ['SSAA 2 again', () => S.set('display.ssaa', 2)],
        ['GTAO through the denoise blur', () => S.set('fx.ao', 'gtao')],
        ['SSR off', () => S.set('fx.ssr', false)],
        ['AO off', () => S.set('fx.ao', 'off')],
        ['SSR on, AO off', () => S.set('fx.ssr', true)],
        ['SSGI on', () => S.set('fx.ssgi', true)],
        ['motion blur on', () => S.set('fx.motionBlur', true)],
      ];
      const out = [];
      for (const [name, fn] of steps) { fn(); await sleep(1200); await settled(500, 4000); out.push([name, await brightness()]); }
      console.error = original;
      S.setQuality('High'); S.setLook('Landscape');
      return { out, errors: errors.slice(0, 3), errorCount: errors.length, frameError: L.frameError || null };`,
    expect: (v) => [
      ['every attachment layout renders (' + v.out.map(([n, b]) => n + ' ' + b).join(', ') + ')', v.out.every(([, b]) => b > 25)],
      ['no WebGPU validation errors' + (v.errorCount ? ': ' + v.errors.join(' | ') : ''), v.errorCount === 0],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'quality-clarity',
    timeout: 240000,
    script: `await idle(); await sleep(800);
      // October 2026: High and Ultra looked softer than Balanced and shimmered with the camera
      // still (TRAA over spikes thinner than a pixel), and Extreme showed GTAO's noise tile as
      // dark speckles. At the camera where it was reported, every tier from Balanced up must be
      // still, use SMAA and SSAO at full resolution, and its ambient occlusion must be no noisier
      // than Balanced's. AO noise is the fine detail of what AO changes: the frame with AO minus
      // the frame without, less its 7 x 7 local mean. (Scores on the frame alone could not
      // tell: TRAA's shimmer raised a sharpness score, and the dark gaps between spikes swamped
      // a speckle count. Before the change: Balanced 0.82, High 2.8, Ultra 2.84, Extreme 4.67;
      // GTAO through the depth-aware blur still measured 1.9 at High and 2.78 at Extreme.)
      const S = L.settings; const errors = [];
      const original = console.error;
      console.error = (...a) => { const t = a.map(String).join(' '); if (/GPUValidationError|Invalid CommandBuffer/.test(t)) errors.push(t.slice(0, 160)); original.apply(console, a); };
      await L.seek(tip); await idle();
      S.setMany({ 'display.autoScale': false, 'camera.fov': 70, 'amp.exaggeration': 16.1 });
      const POSE = { x: 991.128, y: 34.356, z: 166.546, yaw: 60.08, pitch: -16.77 };
      // A 700 x 400 crop of the landscape (1600 x 900 frame) in the frame that drew it.
      const crop = () => new Promise((resolve) => requestAnimationFrame(() => {
        const k = canvas.width / 1600; const w = Math.round(700 * k); const h = Math.round(400 * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, Math.round(420 * k), Math.round(380 * k), w, h, 0, 0, w, h);
        resolve({ w, h, c, d: ctx.getImageData(0, 0, w, h).data });
      }));
      const gray = ({ w, h, d }) => { const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; };
      const aoNoise = (withAO, withoutAO) => { const { w, h } = withAO; const a = gray(withAO); const b = gray(withoutAO);
        const d = new Float32Array(w * h); for (let i = 0; i < d.length; i++) d[i] = a[i] - b[i];
        const I = new Float64Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[(y + 1) * (w + 1) + x + 1] = d[y * w + x] + I[y * (w + 1) + x + 1] + I[(y + 1) * (w + 1) + x] - I[y * (w + 1) + x];
        let s = 0; let n = 0;
        for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
          const box = I[(y + 4) * (w + 1) + x + 4] - I[(y - 3) * (w + 1) + x + 4] - I[(y + 4) * (w + 1) + x - 3] + I[(y - 3) * (w + 1) + x - 3];
          s += Math.abs(d[y * w + x] - box / 49); n++;
        }
        return Math.round(s / n * 1000) / 1000; };
      const still = async () => { let prev = await crop(); let s = 0;
        for (let i = 0; i < 10; i++) { await sleep(40); const next = await crop(); let t = 0;
          for (let j = 0; j < next.d.length; j++) if (j % 4 !== 3) t += Math.abs(next.d[j] - prev.d[j]);
          s += t / (next.d.length * 0.75); prev = next; }
        return Math.round(s / 10 * 1000) / 1000; };
      const out = { tiers: {}, shots: [] };
      for (const q of ['Balanced', 'High', 'Ultra', 'Extreme']) {
        S.setQuality(q); L.controls.setPose(POSE);
        await settled(1500, 15000); await idle(); await sleep(1500);
        const img = await crop();
        const p = L.view.post.plan;
        const stillness = await still();
        S.set('fx.ao', 'off'); await settled(1200, 8000); await sleep(800);
        const noAO = await crop(); S.reset('fx.ao'); await settled(1200, 8000);
        out.tiers[q] = { still: stillness, aoNoise: aoNoise(img, noAO),
          scale: L.view.stats.scale, aa: p.traa ? 'traa' : p.smaa ? 'smaa' : p.fxaa ? 'fxaa' : 'none', motionBlur: p.motionBlur, ao: p.ao };
        out.shots.push([q, img.c.toDataURL('image/png'), await jpeg(1600, 900)]);
      }
      console.error = original;
      S.reset(['camera.fov', 'amp.exaggeration']); S.setQuality('High');
      return { ...out, errors: errors.slice(0, 3), errorCount: errors.length, frameError: L.frameError || null };`,
    node: (v) => {
      if (shots) for (const [q, crop, frame] of v.shots) {
        writeFileSync(join(shots, 'quality-' + q.toLowerCase() + '-crop.png'), Buffer.from(crop.split(',')[1], 'base64'));
        writeFileSync(join(shots, 'quality-' + q.toLowerCase() + '.jpg'), Buffer.from(frame.split(',')[1], 'base64'));
      }
      v.shots = v.shots.map(([q]) => q);
    },
    expect: (v) => {
      const t = v.tiers; const b = t.Balanced;
      const fmt = (q) => q + ' still ' + t[q].still + ', AO noise ' + t[q].aoNoise + ', ' + t[q].ao + ', ' + t[q].aa + ', scale ' + t[q].scale;
      return [
        ...Object.keys(t).map((q) => [q + ' is still with the camera parked (' + fmt(q) + ')', t[q].still < 0.3]),
        ...['High', 'Ultra', 'Extreme'].map((q) => [q + "'s ambient occlusion is no noisier than Balanced's (" + t[q].aoNoise + ' vs ' + b.aoNoise + ')', t[q].aoNoise <= 1.25 * b.aoNoise + 0.05]),
        ['Balanced to Extreme use SMAA and SSAO at full resolution without motion blur', Object.values(t).every((x) => x.aa === 'smaa' && x.ao === 'ssao' && x.scale === 1 && x.motionBlur === false)],
        ['no WebGPU validation errors' + (v.errorCount ? ': ' + v.errors.join(' | ') : ''), v.errorCount === 0],
        ['no frame errors', v.frameError === null],
      ];
    },
  },
  {
    name: 'god-rays',
    timeout: 120000,
    script: `await idle(); await sleep(500);
      // Facing a low sun, god rays change the picture. Until October 2026 their sky mask took the
      // view ray from the post pass's own camera, never met the sun, and the setting did nothing.
      const S = L.settings; const u = L.view.env.uniforms;
      S.setQuality('High'); S.setLook('Golden hour'); S.set('light.sunElevation', 6); await sleep(600);
      let best = null;
      for (let yaw = -180; yaw < 180; yaw += 5) {
        L.controls.setPose({ x: 600, y: 30, z: 120, yaw, pitch: 0 }); await sleep(40);
        const d = Math.hypot(u.sunScreen.value.x - 0.5, u.sunScreen.value.y - 0.5);
        if (u.sunVisible.value > 0.5 && (!best || d < best.d)) best = { yaw, d };
      }
      L.controls.setPose({ x: 600, y: 30, z: 120, yaw: best.yaw, pitch: 0 });
      S.set('light.godRays', false); const off = await settled(1500);
      S.set('light.godRays', true); const on = await settled(1500);
      const shot = await jpeg(640, 360);
      S.setLook('Landscape'); L.controls.setPose(POSES.close);
      return { yaw: best.yaw, diff: Math.round(gridDiff(off, on) * 100) / 100, shot, frameError: L.frameError || null };`,
    node: (v) => {
      if (shots) writeFileSync(join(shots, 'god-rays.jpg'), Buffer.from(v.shot.split(',')[1], 'base64'));
      v.shot = 'god-rays.jpg';
    },
    expect: (v) => [
      ['god rays change the picture facing a low sun (Golden hour, mean RGB difference ' + v.diff + ')', v.diff >= 5],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'earth-horizon',
    timeout: 180000,
    script: `await idle(); await sleep(500);
      // Earth's sea seen from high up (render/index.js horizonFar, render/env.js volume box).
      const S = L.settings; const start = L.controls.getPose(); const startQuality = S.quality;
      const bands = async () => {
        const d = (await frameImage(48, 27)).getContext('2d').getImageData(0, 0, 48, 27).data;
        const out = [];
        for (let band = 0; band < 9; band++) {
          let r = 0, g = 0, b = 0;
          for (let i = band * 3 * 48 * 4; i < (band + 1) * 3 * 48 * 4; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
          out.push([r, g, b].map((c) => Math.round(c / 144)));
        }
        return out;
      };
      const out = { backend: L.view.backend };
      S.setQuality('High'); S.setLook('Earth');
      // From the height ceiling, 30 degrees down: below the top band of sky every band is sea. The
      // 6,000-unit far plane cut the sea a few degrees below the horizon and left a brown band
      // (the sky beneath the horizon) between the sea and the sky.
      L.controls.setPose({ x: 480, y: 4000, z: 640, yaw: 0, pitch: -30 }); await settled(1200);
      out.top = { far: Math.round(L.view.camera.far), floor: Math.round(L.view.terrain.meshes.floor.scale.x), bands: await bands() };
      // Ultra's volumetric light 1,500 units up: next to no haze lies under the camera, so the frame
      // stays High's. With the camera above the volume box the sky leaked into the volumetric pass
      // and washed the sea out around a dark square under the camera.
      const high = { x: 480, y: 1500, z: 1400, yaw: 0, pitch: -40 };
      L.controls.setPose(high); const gHigh = await settled(1200);
      out.volumetric = { quality: S.setQuality('Ultra') };
      const gUltra = await settled(1500);
      out.volumetric.on = !!L.view.env.volumetricOn;
      out.volumetric.diff = Math.round(gridDiff(gHigh, gUltra) * 100) / 100;
      // Other looks keep the 6,000-unit far plane.
      S.setQuality('High'); S.setLook('Landscape'); await settled(600);
      out.otherFar = L.view.camera.far;
      S.setQuality(startQuality); L.controls.setPose(start);
      out.frameError = L.frameError || null;
      return out;`,
    expect: (v) => [
      ['from 4,000 units up Earth\'s sea reaches the horizon: far plane ' + v.top.far + ', bands below the sky ' + v.top.bands.slice(1).map((c) => c.join(',')).join(' '),
        v.top.far > 100000 && v.top.floor >= 2.2 * v.top.far - 1 && v.top.bands.slice(1).every(([r, , b]) => b > r + 40)],
      ['Ultra\'s volumetric light leaves the sea under a high camera as High shows it (mean RGB difference ' + v.volumetric.diff + ')',
        v.backend !== 'webgpu' || (v.volumetric.on && v.volumetric.diff < 3)],
      ['other looks keep the 6,000-unit far plane (' + v.otherFar + ')', v.otherFar === 6000],
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'settings-audit',
    optIn: 'audit',
    timeout: 3600000,
    script: `await idle(); await sleep(800);
      const { SCHEMA } = await import('/settings.schema.js');
      const S = L.settings;
      const start = L.controls.getPose();
      const startBlock = L.replay.block;
      // Base: Extreme at the Landscape look with every switch on and a custom palette;
      // manual exposure, so brightness changes are not adapted away. (Depth of field keeps
      // SSGI out; settings that need SSGI turn depth of field off through their needs.)
      S.setQuality('Extreme'); S.setLook('Landscape');
      S.setMany({ 'fx.dof': true, 'fx.motionBlur': true, 'fx.ssgi': true, 'fx.ssr': true, 'light.volumetric': true,
        'light.godRays': true, 'color.palette': 'custom', 'display.overlay': false, 'display.autoScale': false });
      const base = S.values();
      const LUT = { name: 'invert.cube', text: 'LUT_3D_SIZE 2\\n1 1 1\\n0 1 1\\n1 0 1\\n0 0 1\\n1 1 0\\n0 1 0\\n1 0 0\\n0 0 0\\n' };
      const ACTIVITY = new Set(['color.heat', 'color.heatGain', 'amp.heatHalfLife', 'amp.heatFloor', 'amp.heatReference', 'amp.heatEdge',
        'amp.heatEdgeBlocks', 'amp.flashSize', 'amp.flashThreshold']);
      const entry = (id) => S.entry(id);
      // Cost settings are tried within safe bounds: their extremes at Extreme quality (a
      // cylinder radius of 8,192 cells, 8 million instances, 4x subdivision) can stall the GPU,
      // and these ranges already show whether a setting changes the picture.
      const SAFE = { 'geo.columnRadius': [16, 2048], 'geo.instanceBudget': [10000, 2000000], 'geo.tileBudget': [32, 320],
        'display.scale': [0.25, 1.5], 'light.volumetricSteps': [8, 128], 'fx.ssgiSamples': [4, 16], 'fx.aoSamples': [4, 32],
        'geo.pixelsPerCell': [1, 32], 'geo.lodBias': [-3, 1], 'geo.columnPixels': [2, 32] };
      const SAFE_OPTIONS = { 'display.ssaa': [1, 2], 'geo.subdivision': [1, 2] };
      const log = new URLSearchParams(location.search).has('auditlog');
      const ping = (i, id) => { if (log) fetch('/__audit?i=' + i + '&id=' + encodeURIComponent(id)).catch(() => {}); };
      const other = (e, v) => {
        if (e.type === 'bool') return !v;
        if (e.type === 'enum') return e.options.find((o) => String(o) !== String(v));
        if (e.type === 'number' || e.type === 'int') return v === e.max ? e.min : e.max;
        if (e.type === 'file') return v ? null : LUT;
        return v;
      };
      // Patches that make a condition hold (with the conditions of the setting it names), or fail.
      function holdPatch(cond, depth = 0) {
        if (cond.any) return holdPatch(cond.any[0], depth);
        const e = entry(cond.id); const v = S.get(cond.id);
        let p = {};
        if ('is' in cond) p = { [cond.id]: cond.is };
        else if ('ne' in cond) p = String(v) === String(cond.ne) ? { [cond.id]: e.type === 'enum' ? other(e, cond.ne) : (cond.ne === 0 ? 0.2 : cond.ne * 2) } : {};
        else if ('gt' in cond) p = v > cond.gt ? {} : { [cond.id]: e.default > cond.gt ? e.default : e.max / 2 };
        else if (cond.notNull) p = { [cond.id]: LUT };
        if (depth < 4 && e.needs) for (const c of e.needs) p = { ...holdPatch(c, depth + 1), ...p };
        return p;
      }
      function failPatch(cond) {
        if (cond.any) return Object.assign({}, ...cond.any.map(failPatch));
        const e = entry(cond.id);
        if ('is' in cond) return { [cond.id]: other(e, cond.is) };
        if ('ne' in cond) return { [cond.id]: cond.ne };
        if ('gt' in cond) return { [cond.id]: Math.max(e.min, Math.min(cond.gt, e.max)) };
        if (cond.notNull) return { [cond.id]: null };
        return {};
      }
      // Numbers at their minimum, default and maximum (a circular range such as hue or azimuth
      // ends where it starts, and a U-shaped one such as focus distance blurs both ends).
      function values(e) {
        if (e.type === 'bool') return [false, true];
        if (e.type === 'enum') return (SAFE_OPTIONS[e.id] || e.options).slice();
        if (e.type === 'number' || e.type === 'int') {
          const [lo, hi] = SAFE[e.id] || [e.min, e.max];
          return [...new Set([lo, Math.min(hi, Math.max(lo, e.default)), hi])];
        }
        if (e.type === 'color') return ['#000000', '#ffffff'];
        if (e.type === 'gradient') return [e.default, [...e.default].reverse().map((s, i, a) => ({ t: a.length > 1 ? i / (a.length - 1) : 0, color: s.color }))];
        return [];
      }
      // Activity settings act on spends: replay blocks after the start block, then look.
      async function capture(e) {
        if (!ACTIVITY.has(e.id)) return settled(500, 4000);
        await L.seek(startBlock); await idle();
        await L.playback.step(30); await idle(); await sleep(120);
        return grid();
      }
      async function spread(e, setup) {
        S.setMany(base); S.setMany(setup);
        const grids = [];
        for (const v of values(e)) { S.set(e.id, v); grids.push(await capture(e)); }
        let d = 0;
        for (let i = 0; i < grids.length; i++) for (let j = i + 1; j < grids.length; j++) d = Math.max(d, gridDiff(grids[i], grids[j]));
        return Math.round(d * 100) / 100;
      }
      const round = (x) => Math.round(x * 100) / 100;
      const cams = { overview: start, close: POSES.close, low: POSES.low };
      const noise = {};
      const rows = new Map();
      let n = 0;
      for (const [cam, pose] of Object.entries(cams)) {
        L.controls.setPose(pose);
        // Noise: the same settings twice, still and with replayed blocks, once the tiles for this
        // camera have loaded.
        S.setMany(base); await settled(2000, 20000);
        const n0 = await settled(800, 4000); const n1 = await settled(800, 4000);
        const g0 = await capture({ id: 'color.heatGain' }); const g1 = await capture({ id: 'color.heatGain' });
        noise[cam] = { still: round(gridDiff(n0, n1)), activity: round(gridDiff(g0, g1)) };
        for (const e of SCHEMA) {
          if (e.preset === false || e.type === 'file') continue;
          ping(n++, cam + ' ' + e.id);
          let setup = {};
          if (e.needs) { S.setMany(base); for (const c of e.needs) setup = { ...setup, ...holdPatch(c) }; }
          const row = rows.get(e.id) || { id: e.id, label: e.label, effect: {}, inertEffect: {} };
          row.effect[cam] = await spread(e, setup);
          if (e.needs) {
            // Break the first condition only (the others hold) and vary the setting again.
            const broken = failPatch(e.needs[0]);
            row.inertEffect[cam] = await spread(e, { ...setup, ...broken });
            row.broken = Object.keys(broken);
          }
          rows.set(e.id, row);
        }
      }
      S.setMany(base); S.setQuality('High'); S.setLook('Landscape'); L.controls.setPose(start);
      return { noise, rows: [...rows.values()], frameError: L.frameError || null };`,
    node: (v) => {
      writeFileSync(join(shots || '.', 'settings-audit.json'), JSON.stringify(v, null, 1));
      const ACTIVITY = ['color.heat', 'color.heatGain', 'amp.heatHalfLife', 'amp.heatFloor', 'amp.heatReference', 'amp.heatEdge', 'amp.heatEdgeBlocks', 'amp.flashSize', 'amp.flashThreshold'];
      const limit = (r, cam) => Math.max(0.5, 3 * (ACTIVITY.includes(r.id) ? v.noise[cam].activity : v.noise[cam].still));
      const best = (r, key) => Object.entries(r[key]).reduce((m, [cam, d]) => (d / limit(r, cam) > m.ratio ? { cam, d, ratio: d / limit(r, cam) } : m), { cam: null, d: 0, ratio: 0 });
      v.noEffect = v.rows.filter((r) => best(r, 'effect').ratio < 1).map((r) => r.id + ' (' + best(r, 'effect').d + ')');
      v.needsWrong = v.rows.filter((r) => r.broken && best(r, 'inertEffect').ratio >= 1).map((r) => { const b = best(r, 'inertEffect'); return r.id + ' with ' + r.broken.join('+') + ' broken (' + b.d + ' at ' + b.cam + ')'; });
    },
    expect: (v) => [
      ['audit ran over ' + v.rows.length + ' settings at ' + Object.keys(v.noise).length + ' cameras (noise ' + JSON.stringify(v.noise) + ')', v.rows.length > 100],
      ['settings without a visible effect in the audit views: ' + (v.noEffect.join(', ') || 'none'), true],
      ['needs that do not hold (the setting still changes the image): ' + (v.needsWrong.join(', ') || 'none'), v.needsWrong.length === 0],
      ['no frame errors', v.frameError === null],
    ],
  },
];

let failures = 0;
const results = {};
const skipped = [];
for (const check of CHECKS) {
  const named = !!only && only.split(',').includes(check.name);
  if (only && !named) continue;
  if (check.optIn && !optIns[check.optIn] && !named) {
    skipped.push(check.name + ' (--' + check.optIn + ')');
    continue;
  }
  const query = new URLSearchParams(check.query || '');
  for (const [k, v] of extraQuery) query.set(k, v);
  let url = base.replace(/[?#].*$/, '') + (String(query) ? '?' + query : '');
  if (check.hash) url += check.hash.replace('BLOCK', String(hashBlock));
  const file = join(tmp, check.name + '.js');
  writeFileSync(file, PRELUDE + '\n' + check.script);
  const m = check.mobile;
  const cli = [checker, '--url', url, '--wait-for', 'window.__landscape && window.__landscape.ready', '--timeout', String(check.timeout || 60000),
    '--settle', '300', '--script', file, '--width', String(m ? m.width : width), '--height', String(m ? m.height : height),
    '--dpr', String(m ? m.dpr : dpr), '--browser', browser];
  if (m) cli.push('--mobile');
  if (shots && check.shot) cli.push('--screenshot', join(shots, check.shot));
  const run = spawnSync(process.execPath, cli, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (check.timeout || 60000) + 60000 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.log('FAIL ' + check.name + ': browser-check output was not JSON: ' + (run.stderr || run.stdout).slice(0, 400));
    failures++;
    continue;
  }
  const value = report.script && report.script.value;
  if (!value) {
    console.log('FAIL ' + check.name + ': ' + JSON.stringify(report.script && report.script.error ? report.script.error : report.waitFor).slice(0, 400));
    failures++;
    continue;
  }
  if (check.node) await check.node(value);
  results[check.name] = value;
  for (const [label, ok] of check.expect(value)) {
    console.log((ok ? 'PASS ' : 'FAIL ') + check.name + ': ' + label);
    if (!ok) failures++;
  }
  if (report.exceptions && report.exceptions.length) {
    console.log('FAIL ' + check.name + ': page exceptions ' + JSON.stringify(report.exceptions).slice(0, 300));
    failures++;
  }
}
if (shots) writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 1));
rmSync(tmp, { recursive: true, force: true });
if (skipped.length) console.log('skipped ' + skipped.join(', '));
console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
