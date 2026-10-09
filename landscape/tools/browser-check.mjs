#!/usr/bin/env node
// Headless Chrome checker for landscape pages (root-owned tool).
// Requires Node >= 22 (global WebSocket), e.g. ~/.nvm/versions/node/v22.23.2/bin/node.
//
//   node22 landscape/tools/browser-check.mjs --url http://127.0.0.1:12990/ \
//     [--wait-for 'window.__landscape?.ready'] [--timeout 60000] [--settle 1000] \
//     [--eval 'expr']... [--script file.js] [--screenshot /tmp/x.png] \
//     [--width 1920 --height 1080 --dpr 1] [--browser chrome|canary|brave] [--headed] \
//     [--flag --some-chrome-flag]... [--fail-on-error] [--console-limit 200]
//     [--fullscreen] [--no-emulation] [--net] [--mobile]
//
// --fullscreen switches the (headed) window to native fullscreen on the display it opened on
// (place it with --flag --window-position=X,Y); --no-emulation keeps the real viewport and
// device pixel ratio instead of overriding them with --width/--height/--dpr.
// --net also attaches to the page's workers: their console messages, exceptions and failed
// requests join the summary, and summary.net counts the encoded bytes and requests of the page
// and its workers until --wait-for succeeded (atReady) and in total.
// --mobile emulates a phone: a mobile viewport (use --width 390 --height 844 --dpr 3), touch
// input with five touch points and an Android Chrome user agent. Page scripts can then send
// real multi-touch input through Chrome: window.__cdpTouch(JSON.stringify({id, steps})), where
// each step is {type: 'touchStart'|'touchMove'|'touchEnd', points: [{x, y, id}], wait: ms}
// (CSS pixels). touchStart and touchMove list the fingers that are down; touchEnd lists the
// fingers that lift (an empty list lifts all of them). When the steps are done the checker
// calls window.__cdpTouchDone(id, error).
//
// Prints a JSON summary: console messages, page exceptions, failed requests, eval
// results, timings and the screenshot path. --script evaluates the file body as an
// async function in the page and records its return value.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

if (typeof WebSocket === 'undefined') {
  console.error('browser-check needs Node >= 22 (global WebSocket). Try ~/.nvm/versions/node/v22.23.2/bin/node');
  process.exit(2);
}

const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  canary: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

function parseArgs(argv) {
  const o = { evals: [], flags: [], timeout: 60000, settle: 0, width: 1600, height: 900, dpr: 1,
    browser: 'chrome', headed: false, failOnError: false, consoleLimit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': o.url = next(); break;
      case '--wait-for': o.waitFor = next(); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--settle': o.settle = Number(next()); break;
      case '--eval': o.evals.push(next()); break;
      case '--script': o.script = next(); break;
      case '--screenshot': o.screenshot = next(); break;
      case '--width': o.width = Number(next()); break;
      case '--height': o.height = Number(next()); break;
      case '--dpr': o.dpr = Number(next()); break;
      case '--browser': o.browser = next(); break;
      case '--headed': o.headed = true; break;
      case '--flag': o.flags.push(next()); break;
      case '--fail-on-error': o.failOnError = true; break;
      case '--console-limit': o.consoleLimit = Number(next()); break;
      case '--fullscreen': o.fullscreen = true; break;
      case '--no-emulation': o.noEmulation = true; break;
      case '--net': o.net = true; break;
      case '--mobile': o.mobile = true; break;
      default: throw new Error('unknown argument ' + a);
    }
  }
  if (!o.url) throw new Error('--url is required');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const exe = BROWSERS[opts.browser] || opts.browser;
const profile = mkdtempSync(join(tmpdir(), 'landscape-check-'));
const args = [
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=' + opts.width + ',' + opts.height,
  ...(opts.headed ? [] : ['--headless=new']),
  ...opts.flags, 'about:blank',
];
const t0 = Date.now();
const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderrTail = '';
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('browser did not start: ' + stderrTail.slice(-2000))), 20000);
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-8000);
    const m = stderrTail.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  proc.on('exit', (code) => reject(new Error('browser exited ' + code + ': ' + stderrTail.slice(-2000))));
});

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message + (msg.error.data ? ': ' + msg.error.data : '')));
    else resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const summary = { url: opts.url, browser: opts.browser, headless: !opts.headed,
  viewport: [opts.width, opts.height, opts.dpr], console: [], exceptions: [], failedRequests: [],
  evals: [], timings: {} };
let consoleCount = 0;
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
let loaded = false;
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleCount++;
    if (summary.console.length < opts.consoleLimit) {
      const text = m.params.args.map((x) => x.value !== undefined ? (typeof x.value === 'string' ? x.value : JSON.stringify(x.value)) : (x.description || x.type)).join(' ');
      summary.console.push({ type: m.params.type, text: text.slice(0, 2000) });
    }
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    summary.exceptions.push(((d.exception && d.exception.description) || d.text || 'exception').slice(0, 3000));
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') {
      if (summary.console.length < opts.consoleLimit) summary.console.push({ type: 'log.' + e.level, text: (e.text + (e.url ? ' ' + e.url : '')).slice(0, 2000) });
    }
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (r.status >= 400) summary.failedRequests.push({ url: r.url, status: r.status });
  } else if (m.method === 'Network.loadingFailed') {
    if (!m.params.canceled) summary.failedRequests.push({ requestId: m.params.requestId, error: m.params.errorText });
  } else if (m.method === 'Page.loadEventFired') {
    loaded = true;
  }
});
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
// --net: worker sessions (flattened auto-attach) and byte accounting, deduplicated by request id.
const net = { bytes: 0, requests: 0, workerBytes: 0, workers: 0 };
if (opts.net) {
  const workerSessions = new Set();
  const seen = new Set();
  listeners.push((m) => {
    if (m.method === 'Target.attachedToTarget' && m.sessionId === sessionId) {
      const child = m.params.sessionId;
      workerSessions.add(child);
      net.workers++;
      for (const domain of ['Runtime', 'Log', 'Network']) send(domain + '.enable', {}, child).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
      return;
    }
    const fromWorker = workerSessions.has(m.sessionId);
    if (m.method === 'Network.loadingFinished' && (fromWorker || m.sessionId === sessionId)) {
      if (seen.has(m.params.requestId)) return;
      seen.add(m.params.requestId);
      net.bytes += m.params.encodedDataLength;
      net.requests++;
      if (fromWorker) net.workerBytes += m.params.encodedDataLength;
      return;
    }
    if (!fromWorker) return;
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleCount++;
      if (summary.console.length < opts.consoleLimit) {
        const text = m.params.args.map((x) => x.value !== undefined ? (typeof x.value === 'string' ? x.value : JSON.stringify(x.value)) : (x.description || x.type)).join(' ');
        summary.console.push({ type: 'worker.' + m.params.type, text: text.slice(0, 2000) });
      }
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      summary.exceptions.push(('worker: ' + ((d.exception && d.exception.description) || d.text || 'exception')).slice(0, 3000));
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if ((e.level === 'error' || e.level === 'warning') && summary.console.length < opts.consoleLimit) {
        summary.console.push({ type: 'worker.log.' + e.level, text: (e.text + (e.url ? ' ' + e.url : '')).slice(0, 2000) });
      }
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) summary.failedRequests.push({ url: r.url, status: r.status, worker: true });
    } else if (m.method === 'Network.loadingFailed') {
      if (!m.params.canceled) summary.failedRequests.push({ requestId: m.params.requestId, error: m.params.errorText, worker: true });
    }
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (opts.fullscreen) {
  const { windowId } = await send('Browser.getWindowForTarget', { targetId });
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  await sleep(2000);
}
if (!opts.noEmulation) {
  await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr, mobile: !!opts.mobile }, sessionId);
}
if (opts.mobile) {
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Linux armv8l' }, sessionId);
  await send('Runtime.addBinding', { name: '__cdpTouch' }, sessionId);
  const runTouch = async ({ id, steps }) => {
    let error = null;
    try {
      for (const s of steps || []) {
        const touchPoints = (s.points || []).map((p) => ({ x: p.x, y: p.y, id: p.id || 0, radiusX: 6, radiusY: 6, force: 1 }));
        await send('Input.dispatchTouchEvent', { type: s.type, touchPoints }, sessionId);
        if (s.wait) await sleep(s.wait);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    await send('Runtime.evaluate', { expression: 'window.__cdpTouchDone && window.__cdpTouchDone(' + JSON.stringify(id) + ', ' + JSON.stringify(error) + ')' }, sessionId);
  };
  listeners.push((m) => {
    if (m.sessionId !== sessionId || m.method !== 'Runtime.bindingCalled' || m.params.name !== '__cdpTouch') return;
    let payload = null;
    try {
      payload = JSON.parse(m.params.payload);
    } catch {
      return;
    }
    runTouch(payload).catch(() => {});
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return { error: ((d.exception && d.exception.description) || d.text || 'error').slice(0, 3000) };
  }
  return { value: r.result.value === undefined ? (r.result.description ?? null) : r.result.value };
}
let exitCode = 0;
try {
  const tNav = Date.now();
  await send('Page.navigate', { url: opts.url }, sessionId);
  while (!loaded && Date.now() - tNav < opts.timeout) await sleep(50);
  summary.timings.loadMs = Date.now() - tNav;
  if (opts.waitFor) {
    const tw = Date.now();
    let ok = false, last;
    while (Date.now() - tw < opts.timeout) {
      last = await evaluate('(async () => !!(' + opts.waitFor + '))()');
      if (last.value === true) { ok = true; break; }
      await sleep(250);
    }
    summary.waitFor = { expression: opts.waitFor, ok, ms: Date.now() - tw, ...(ok ? {} : { last }) };
    if (opts.net) summary.net = { atReady: { ...net, ms: Date.now() - tNav } };
    if (!ok) exitCode = 3;
  }
  if (opts.settle) await sleep(opts.settle);
  for (const e of opts.evals) summary.evals.push({ expression: e, ...(await evaluate('(async () => (' + e + '))()')) });
  if (opts.script) {
    const body = readFileSync(opts.script, 'utf8');
    summary.script = { file: opts.script, ...(await evaluate('(async () => {\n' + body + '\n})()')) };
  }
  if (opts.screenshot) {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    mkdirSync(dirname(opts.screenshot), { recursive: true });
    writeFileSync(opts.screenshot, Buffer.from(shot.data, 'base64'));
    summary.screenshot = opts.screenshot;
  }
} catch (err) {
  summary.fatal = String(err && err.stack || err);
  exitCode = 4;
} finally {
  summary.consoleTotal = consoleCount;
  if (opts.net) summary.net = { ...(summary.net || {}), total: { ...net } };
  summary.timings.totalMs = Date.now() - t0;
  try { await send('Browser.close'); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  try { ws.close(); } catch {}
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
if (opts.failOnError && (summary.exceptions.length || summary.console.some((c) => c.type === 'error'))) exitCode = exitCode || 5;
console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
