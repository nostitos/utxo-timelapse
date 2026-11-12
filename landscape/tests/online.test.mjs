// Online behaviour of the app shell (ui/online.js) and the CSP hash the Worker allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveEndpoints, resolveDataUrl, ownersUrl, startupMode, chooseStartup, deviceTraits, isLocalHost,
  ADAPTIVE_DISPLAY, LOW_END_NOTICE, LOCAL_EXPLORER, isLowEnd,
} from '../web/ui/online.js';
import { SCHEMA, PRESETS } from '../web/settings.schema.js';
import { createSettingsStore } from '../web/settings.js';
import { importMapHash, INDEX_HTML } from '../tools/csp-hash.mjs';
import { RELEASE } from '../../cloudflare/utxo-landscape-worker/src/release.js';

const q = (s = '') => new URLSearchParams(s);

test('local hosts keep the native explorer for the cell API and the 2D link', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLocalHost(h), true, h);
  assert.equal(isLocalHost('3d.bitcointimelapse.com'), false);
  const e = resolveEndpoints({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:12990', query: q() });
  assert.equal(e.local, true);
  assert.equal(e.apiBase, LOCAL_EXPLORER);
  assert.equal(e.link2d(314000, 3000, 1525), 'http://127.0.0.1:12989/?block=314000&x=3000&y=1525');
});

test('online, the site answers the cell API and the 2D link opens the public explorer', () => {
  const e = resolveEndpoints({ hostname: '3d.bitcointimelapse.com', origin: 'https://3d.bitcointimelapse.com', query: q() });
  assert.equal(e.local, false);
  assert.equal(e.apiBase, 'https://3d.bitcointimelapse.com');
  assert.equal(e.link2d(314000, 3000, 1525), 'https://bitcointimelapse.com/explorer?block=314000&x=3000&y=1525');
  const o = resolveEndpoints({ hostname: '3d.bitcointimelapse.com', origin: 'https://3d.bitcointimelapse.com',
    query: q('explorer=http://127.0.0.1:12989/&explorer2d=https://example.test/explorer') });
  assert.equal(o.apiBase, 'http://127.0.0.1:12989');
  assert.equal(o.link2d(1, 2, 3), 'https://example.test/explorer?block=1&x=2&y=3');
});

test('dataset URL: ?data wins, then /dataset/index.json, then /dataset/', async () => {
  const href = 'https://3d.bitcointimelapse.com/#b=1';
  let calls = 0;
  const never = async () => { calls++; throw new Error('must not fetch'); };
  assert.equal(await resolveDataUrl({ query: q('data=/other/'), href, fetchImpl: never }), 'https://3d.bitcointimelapse.com/other/');
  assert.equal(calls, 0);
  const seen = [];
  const withIndex = async (url, opts) => {
    seen.push([url, opts.cache]);
    return { ok: true, json: async () => ({ current: { id: 'd966827-20261008', url: '/dataset/d966827-20261008/', tip: 966827 } }) };
  };
  assert.equal(await resolveDataUrl({ href, fetchImpl: withIndex }), 'https://3d.bitcointimelapse.com/dataset/d966827-20261008/');
  assert.deepEqual(seen, [['https://3d.bitcointimelapse.com/dataset/index.json', 'no-store']]);
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await resolveDataUrl({ href: 'http://127.0.0.1:12990/', fetchImpl: missing }), 'http://127.0.0.1:12990/dataset/');
  const broken = async () => { throw new TypeError('network'); };
  assert.equal(await resolveDataUrl({ href, fetchImpl: broken }), 'https://3d.bitcointimelapse.com/dataset/');
  const junk = async () => ({ ok: true, json: async () => ({ current: null }) });
  assert.equal(await resolveDataUrl({ href, fetchImpl: junk }), 'https://3d.bitcointimelapse.com/dataset/');
});

test('owner data URL: /owners/index.json names it; anything else hides the Owners view', async () => {
  const href = 'https://bitcoinlandscape.com/#b=1&own=binance';
  const seen = [];
  const index = async (url, opts) => {
    seen.push([url, opts.cache]);
    return { ok: true, json: async () => ({ id: 'o974310-20261102', url: '/owners/o974310-20261102/', tip: 974310 }) };
  };
  assert.equal(await ownersUrl(href, index), 'https://bitcoinlandscape.com/owners/o974310-20261102/');
  assert.deepEqual(seen, [['https://bitcoinlandscape.com/owners/index.json', 'no-store']]);
  assert.equal(await ownersUrl('http://127.0.0.1:12990/', index), 'http://127.0.0.1:12990/owners/o974310-20261102/');
  const answers = [
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => { throw new TypeError('network'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } }),
    async () => ({ ok: true, json: async () => null }),
    async () => ({ ok: true, json: async () => ({ url: 42 }) }),
    async () => ({ ok: true, json: async () => ({ url: '/dataset/d974310-20261102/' }) }),
    async () => ({ ok: true, json: async () => ({ url: 'https://example.test/owners/o1-20260101/' }) }),
    async () => ({ ok: true, json: async () => ({ url: '//example.test/owners/o1-20260101/' }) }),
  ];
  for (const [i, fetchImpl] of answers.entries()) assert.equal(await ownersUrl(href, fetchImpl), null, 'answer ' + i);
  assert.equal(await ownersUrl(undefined, index), null, 'no page URL (outside a browser)');
});

test('startup: adaptive first visits online, High locally and for returning visitors', () => {
  assert.equal(startupMode({ query: q(), local: true }), 'high');
  assert.equal(startupMode({ query: q(), local: false }), 'adaptive');
  assert.equal(startupMode({ query: q('startup=adaptive'), local: true }), 'adaptive');
  assert.equal(startupMode({ query: q('startup=high'), local: false }), 'high');
  assert.equal(chooseStartup({ mode: 'high', firstVisit: true, backend: 'webgpu' }), null);
  assert.equal(chooseStartup({ mode: 'adaptive', firstVisit: false, backend: 'webgpu' }), null);
  const desktop = chooseStartup({ mode: 'adaptive', firstVisit: true, backend: 'webgpu', coarseOnly: false, deviceMemory: 8 });
  assert.deepEqual(desktop, { preset: 'Balanced', settings: { ...ADAPTIVE_DISPLAY }, notice: null });
  assert.equal(chooseStartup({ mode: 'adaptive', firstVisit: true, backend: 'webgpu', deviceMemory: NaN }).preset, 'Balanced');
  for (const low of [{ backend: 'webgl2' }, { backend: 'none' }, { backend: 'webgpu', coarseOnly: true }, { backend: 'webgpu', deviceMemory: 4 },
    { backend: 'webgpu', fallback: true }]) {
    const s = chooseStartup({ mode: 'adaptive', firstVisit: true, ...low });
    assert.equal(s.preset, 'Performance', JSON.stringify(low));
    assert.equal(s.notice, LOW_END_NOTICE);
    assert.equal(s.settings['display.autoScale'], true);
    assert.equal(isLowEnd(low), true, JSON.stringify(low));
  }
  assert.equal(isLowEnd({ backend: 'webgpu', deviceMemory: 8 }), false);
});

test('startup: touch-only screens above 2x render at most about 2 device pixels per CSS pixel', () => {
  const phone = (dpr) => chooseStartup({ mode: 'adaptive', firstVisit: true, backend: 'webgpu', coarseOnly: true, dpr }).settings['display.scaleMax'];
  assert.equal(phone(3), 0.65);
  assert.equal(phone(2.625), 0.75);
  assert.equal(phone(4), 0.5);
  assert.equal(phone(2), ADAPTIVE_DISPLAY['display.scaleMax']);
  const laptop = chooseStartup({ mode: 'adaptive', firstVisit: true, backend: 'webgpu', coarseOnly: false, dpr: 3 });
  assert.equal(laptop.settings['display.scaleMax'], ADAPTIVE_DISPLAY['display.scaleMax'], 'a mouse and a 3x screen keep the full resolution');
});

test('device traits: touch-only means a coarse pointer without hover', () => {
  const win = (matches, deviceMemory, devicePixelRatio) => ({ matchMedia: (m) => ({ matches: !!matches[m] }), navigator: { deviceMemory }, devicePixelRatio });
  assert.deepEqual(deviceTraits(win({ '(pointer: coarse)': true }, 2, 3)), { coarseOnly: true, deviceMemory: 2, dpr: 3 });
  assert.equal(deviceTraits(win({ '(pointer: coarse)': true, '(hover: hover)': true }, 8)).coarseOnly, false);
  const t = deviceTraits({ navigator: {} });
  assert.equal(t.coarseOnly, false);
  assert.ok(Number.isNaN(t.deviceMemory));
  assert.equal(t.dpr, 1);
});

test('the adaptive start keeps the preset clean and survives a save/load round trip', () => {
  const caps = { backend: 'webgpu', webgpu: true, compute: true, maxTileBudget: 400, maxInstances: 8000000 };
  const store = createSettingsStore(SCHEMA, PRESETS, { capabilities: caps, storage: null });
  const s = chooseStartup({ mode: 'adaptive', firstVisit: true, backend: 'webgpu', deviceMemory: 16 });
  store.applyPreset(s.preset);
  store.setMany(s.settings);
  assert.equal(store.preset, 'Balanced', 'auto scale is a personal preference, so the preset stays Balanced');
  const preferences = new Set(SCHEMA.filter((e) => e.preset === false).map((e) => e.id));
  assert.ok(Object.keys(store.overrides()).every((id) => preferences.has(id)), 'only preferences differ from Balanced');
  for (const [id, v] of Object.entries(ADAPTIVE_DISPLAY)) assert.equal(store.get(id), v, id);
  const again = createSettingsStore(SCHEMA, PRESETS, { capabilities: caps, storage: null });
  again.fromJSON(store.toJSON());
  assert.equal(again.preset, 'Balanced');
  assert.equal(again.get('display.autoScale'), true);
  assert.equal(again.get('display.scaleMax'), 1);
  // Presets never touch the auto-scale preferences.
  again.applyPreset('Extreme');
  assert.equal(again.get('display.autoScale'), true);
});

test('the Worker allows exactly the import map that index.html carries', () => {
  assert.equal(RELEASE.importMapHash, importMapHash(readFileSync(INDEX_HTML, 'utf8')));
  assert.equal((readFileSync(INDEX_HTML, 'utf8').match(/<script\b(?![^>]*\bsrc=)[^>]*>/g) || []).length, 1,
    'the import map is the only inline script (anything else needs its own CSP hash)');
});
