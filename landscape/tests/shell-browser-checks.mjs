#!/usr/bin/env node
// Browser checks for the app shell (landscape/SPEC.md §8) against a running app and dataset.
// Not part of node --test: it needs the server, a dataset and optionally the native explorer.
//
//   ~/.nvm/versions/node/v22.23.2/bin/node landscape/tests/shell-browser-checks.mjs \
//     --url http://127.0.0.1:12990/ [--explorer http://127.0.0.1:12989] [--shots DIR] \
//     [--browser chrome|canary|brave] [--width 1600 --height 900 --dpr 1] [--only name,name] \
//     [--query startup=high]
//
// Each check runs landscape/tools/browser-check.mjs with a page script, then judges the
// returned values. Prints one PASS/FAIL line per expectation and exits 1 on any failure.
// Against the online site, --explorer can stay unset: the date check then only requires a
// positive block. --query adds parameters to every page URL (for example startup=high).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

const CHECKS = [
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
        L.playback.pause(); await idle();
        return { from: b0, blocks: b1 - b0, seconds: (t1 - t0) / 1000, rate: (b1 - b0) / ((t1 - t0) / 1000), limited: st.limited, achieved: st.achieved, windowRate, seeks };
      }
      const busy = inData(300000);
      out.x1 = await run('1', 10, busy);
      out.x10 = await run('10', 5, busy);
      out.x100 = await run('100', 4, inData(200000));
      out.max = await run('max', 4, busy);
      out.memoryMB = L.replay.status && Math.round(L.replay.status.memoryBytes / 1048576);
      return out;`,
    expect: (v) => [
      ['1x: about 600 blocks in 10 s, exact (' + v.x1.blocks + ')', v.x1.blocks >= 590 && v.x1.blocks <= 610 && v.x1.seeks === 0],
      ['10x: exact (no snapshot seeks)', v.x10.seeks === 0],
      ['10x: 600 blocks/s, or the HUD shows the achieved rate (measured ' + Math.round(v.x10.rate) + '/s, last 1.5 s ' + Math.round(v.x10.windowRate) +
        '/s, HUD ' + Math.round(v.x10.achieved) + '/s)', v.x10.rate >= 570 || Math.abs(v.x10.achieved - v.x10.windowRate) <= 0.1 * v.x10.windowRate],
      ['100x: no faster than 6,000 blocks/s (' + Math.round(v.x100.rate) + '/s)', v.x100.rate <= 6000 * 1.05 && v.x100.blocks > 0],
      ['Max: exact advance only (' + Math.round(v.max.rate) + '/s)', v.max.seeks === 0 && v.max.blocks > 0],
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
      ['2 selects 10x', v.keys.speed === '10'],
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
    name: 'hash-export-import',
    hash: '#b=BLOCK&mode=map&cam=290.000,30.000,180.000,20.00,-25.00&preset=Film',
    script: `await idle();
      const want = Number(new URLSearchParams(location.hash.slice(1)).get('b'));
      const p = L.controls.getPose();
      const out = { block: L.replay.block, want, preset: L.settings.preset, pose: p };
      const json = await L.panel.exportJSON({ download: false }); out.exportView = json && json.view;
      await L.seek(inData(150000)); await idle(); L.controls.setPose({ x: 50, y: 80, z: 300, yaw: 0, pitch: -40 }); L.settings.applyPreset('High'); await sleep(200);
      await L.panel.importJSON(json, 'check.json'); await sleep(300); await idle();
      const q = L.controls.getPose(); out.after = { block: L.replay.block, preset: L.settings.preset, x: q.x, z: q.z };
      L.settings.set('display.hud', false); L.settings.set('amp.measure', 'count'); await sleep(200);
      out.hudHidden = document.getElementById('hud').hidden; out.measures = L.replay.measures; L.settings.set('display.hud', true);
      return out;`,
    expect: (v) => [
      ['link restores the block', v.block === v.want],
      ['link restores the preset', v.preset === 'Film'],
      ['link restores the camera', Math.abs(v.pose.x - 290) < 1e-3 && Math.abs(v.pose.yaw - 20) < 1e-3],
      ['export carries the view', !!(v.exportView && v.exportView.b === v.want)],
      ['import restores block, preset and camera', v.after.block === v.want && v.after.preset === 'Film' && Math.abs(v.after.x - 290) < 1e-3],
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
      ['no frame errors', v.frameError === null],
    ],
  },
  {
    name: 'webgl2-fallback',
    query: '?webgl=1',
    shot: 'webgl2.png',
    script: `await idle(); await sleep(800); L.settings.applyPreset('Extreme'); await sleep(400);
      return { backend: L.view.backend, preset: L.settings.preset, ready: L.ready, frameError: L.frameError || null };`,
    expect: (v) => [
      ['?webgl=1 uses WebGL2', v.backend === 'webgl2'],
      ['presets capped at High', v.preset === 'High'],
      ['renders (ready, no frame errors)', v.ready && !v.frameError],
    ],
  },
];

let failures = 0;
const results = {};
for (const check of CHECKS) {
  if (only && !only.split(',').includes(check.name)) continue;
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
console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
