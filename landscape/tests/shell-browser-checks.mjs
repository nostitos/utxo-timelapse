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
      return { ready: L.ready, backend: L.view.backend, block: L.replay.block, tip, preset: L.settings.preset, frameError: L.frameError || null,
        hud: document.querySelector('[data-k="block"]').textContent, fps: L.view.stats.fps };`,
    expect: (v) => [
      ['ready after the first real frame', v.ready === true],
      ['starts at the dataset tip', v.block === v.tip],
      ['HUD shows the block', v.hud === v.tip.toLocaleString('en-US')],
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
  const cli = [checker, '--url', url, '--wait-for', 'window.__landscape && window.__landscape.ready', '--timeout', String(check.timeout || 60000),
    '--settle', '300', '--script', file, '--width', width, '--height', height, '--dpr', dpr, '--browser', browser];
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
