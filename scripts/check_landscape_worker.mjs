// Checks the landscape Worker (cloudflare/utxo-landscape-worker) against mock R2, Cache API and
// static assets: dataset allowlist and byte ranges, conditional requests, edge caching, the
// cell API's validation and empty rows, the row table, and the headers on every response.
//   node scripts/check_landscape_worker.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import worker, { parseRange, rowRange, contentSecurityPolicy, ROWS } from '../cloudflare/utxo-landscape-worker/src/index.js';
import { RELEASE } from '../cloudflare/utxo-landscape-worker/src/release.js';
import { rowSatoshiRange } from '../cloudflare/utxo-video-worker/src/mapping.js';

const ID = RELEASE.dataset.id;
const P = 'landscape/' + ID + '/';
const enc = new TextEncoder();
const rowsCandidates = ['/Volumes/4T Data/buv_render/landscape_966827/rows.bin', '/tmp/landscape_dev/rows.bin'];
const rowsPath = rowsCandidates.find((p) => existsSync(p));
let rowsBytes;
if (rowsPath) rowsBytes = new Uint8Array(readFileSync(rowsPath));
else {
  // Synthetic non-increasing table with some empty rows.
  const t = new Float64Array(ROWS);
  for (let r = 0; r < ROWS; r++) t[r] = Math.max(1, Math.floor(1e13 / Math.pow(1.0155, r)) - (r % 97 === 5 ? 0 : 0));
  for (let r = 2000; r < ROWS; r++) t[r] = Math.max(1, ROWS - r);
  t[2001] = t[2000];
  rowsBytes = new Uint8Array(t.buffer);
}
const chunk = new Uint8Array(64).map((_, i) => i);
const objects = new Map([
  [P + 'manifest.json', enc.encode('{"format":"utxo-landscape-1"}')],
  [P + 'rows.bin', rowsBytes],
  [P + 'chunks/00001.bin', chunk],
  [P + 'snapshots/0000000.bin', new Uint8Array(100)],
  ['explorer/v5/site/explorer.html', enc.encode('private')],
]);
const r2 = { heads: 0, gets: 0 };
const etagOf = (key) => '"etag-' + key.length + '"';
const VIDEO_BUCKET = {
  async head(key) {
    r2.heads++;
    const b = objects.get(key);
    return b ? { size: b.byteLength, httpEtag: etagOf(key) } : null;
  },
  async get(key, opts) {
    r2.gets++;
    const b = objects.get(key);
    if (!b) return null;
    const part = opts && opts.range ? b.slice(opts.range.offset, opts.range.offset + opts.range.length) : b;
    return { size: b.byteLength, httpEtag: etagOf(key), body: new Blob([part]).stream(), arrayBuffer: async () => part.slice().buffer };
  },
};
const cacheStore = new Map();
globalThis.caches = { default: {
  async match(req) {
    const e = cacheStore.get(req.url);
    return e ? new Response(e.body.slice(0), { status: e.status, headers: e.headers }) : undefined;
  },
  async put(req, res) {
    assert.equal(res.status, 200, 'only 200 responses are cached');
    cacheStore.set(req.url, { status: res.status, headers: [...res.headers], body: await res.arrayBuffer() });
  },
} };
const ASSET_FILES = {
  '/': ['text/html; charset=utf-8', '<!doctype html>'],
  '/main.js': ['text/javascript; charset=utf-8', 'export {};'],
  '/og.jpg': ['image/jpeg', 'jpg'],
  '/favicon.svg': ['image/svg+xml', '<svg/>'],
};
const ASSETS = { async fetch(request) {
  const path = new URL(request.url).pathname;
  const f = ASSET_FILES[path];
  if (!f) return new Response('Not Found', { status: 404 });
  const etag = '"a' + path.length + '"';
  const base = { ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate' };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: base });
  return new Response(request.method === 'HEAD' ? null : f[1], { headers: { ...base, 'Content-Type': f[0] } });
} };
const env = { VIDEO_BUCKET, ASSETS };
let pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
async function req(path, init = {}) {
  const res = await worker.fetch(new Request('https://3d.bitcointimelapse.com' + path, init), env, ctx);
  await Promise.all(pending);
  pending = [];
  return res;
}
const bytes = async (res) => new Uint8Array(await res.arrayBuffer());
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
function securityHeadersOk(res, what) {
  const h = res.headers;
  assert.equal(h.get('Content-Security-Policy'), contentSecurityPolicy(), what + ' CSP');
  assert.ok(h.get('Content-Security-Policy').includes("'" + RELEASE.importMapHash + "'"), what + ' import map hash');
  assert.ok(!h.get('Content-Security-Policy').includes('unsafe-inline') || /style-src 'self' 'unsafe-inline'/.test(h.get('Content-Security-Policy')), what + ' no inline scripts');
  assert.equal(h.get('Cross-Origin-Opener-Policy'), 'same-origin', what);
  assert.equal(h.get('Cross-Origin-Embedder-Policy'), 'require-corp', what);
  assert.equal(h.get('X-Frame-Options'), 'DENY', what);
  assert.equal(h.get('X-Content-Type-Options'), 'nosniff', what);
  assert.equal(h.get('X-Worker-Version'), RELEASE.version, what);
}

await check('health, robots and the dataset index', async () => {
  const h = await req('/health');
  assert.equal(h.status, 200);
  assert.equal(await h.text(), 'ok\n');
  securityHeadersOk(h, '/health');
  const robots = await (await req('/robots.txt')).text();
  assert.match(robots, /Disallow: \/dataset\//);
  assert.match(robots, /Disallow: \/api\//);
  const ix = await req('/dataset/index.json');
  assert.equal(ix.headers.get('Cache-Control'), 'no-store');
  const body = await ix.json();
  assert.deepEqual(body.current, { id: ID, url: '/dataset/' + ID + '/', tip: RELEASE.dataset.tip });
});

await check('dataset objects: immutable, CORS, ETag, whole and HEAD', async () => {
  const m = await req('/dataset/' + ID + '/manifest.json');
  assert.equal(m.status, 200);
  assert.equal(m.headers.get('Content-Type'), 'application/json');
  assert.equal(m.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(m.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(m.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal(m.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(m.headers.get('ETag'), etagOf(P + 'manifest.json'));
  assert.equal(m.headers.get('X-Object-Size'), null);
  assert.equal(await m.text(), '{"format":"utxo-landscape-1"}');
  securityHeadersOk(m, 'manifest');
  const head = await req('/dataset/' + ID + '/chunks/00001.bin', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '64');
  assert.equal(head.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal((await bytes(head)).length, 0);
});

await check('byte ranges: closed, suffix, open, unsatisfiable, multiple', async () => {
  const url = '/dataset/' + ID + '/chunks/00001.bin';
  const a = await req(url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(a.status, 206);
  assert.equal(a.headers.get('Content-Range'), 'bytes 10-19/64');
  assert.equal(a.headers.get('Content-Length'), '10');
  assert.deepEqual([...await bytes(a)], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const s = await req(url, { headers: { Range: 'bytes=-8' } });
  assert.equal(s.headers.get('Content-Range'), 'bytes 56-63/64');
  assert.deepEqual([...await bytes(s)], [56, 57, 58, 59, 60, 61, 62, 63]);
  const o = await req(url, { headers: { Range: 'bytes=60-' } });
  assert.equal(o.headers.get('Content-Range'), 'bytes 60-63/64');
  const c = await req(url, { headers: { Range: 'bytes=62-99' } });
  assert.equal(c.headers.get('Content-Range'), 'bytes 62-63/64');
  const bad = await req(url, { headers: { Range: 'bytes=64-70' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('Content-Range'), 'bytes */64');
  const multi = await req(url, { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(multi.status, 200, 'multiple ranges are ignored (RFC 9110 allows it)');
  assert.equal((await bytes(multi)).length, 64);
  assert.deepEqual(parseRange('bytes=0-0', 1), { offset: 0, length: 1 });
  assert.equal(parseRange('bytes=-0', 10), undefined);
  assert.equal(parseRange('items=0-1', 10), null);
});

await check('conditional requests and the edge cache', async () => {
  const url = '/dataset/' + ID + '/snapshots/0000000.bin';
  const etag = etagOf(P + 'snapshots/0000000.bin');
  const nm = await req(url, { headers: { 'If-None-Match': etag } });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get('ETag'), etag);
  const first = await req(url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  const before = { ...r2 };
  const again = await req(url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(again.status, 206);
  assert.equal(again.headers.get('Content-Range'), 'bytes 0-9/100');
  assert.equal((await bytes(again)).length, 10);
  assert.deepEqual(r2, before, 'a cached range needs no R2 call');
  const cachedNm = await req(url, { headers: { Range: 'bytes=0-9', 'If-None-Match': etag } });
  assert.equal(cachedNm.status, 304);
  assert.deepEqual(r2, before);
  const whole = await req(url);
  await whole.arrayBuffer();
  const before2 = { ...r2 };
  const whole2 = await req(url);
  assert.equal(whole2.status, 200);
  assert.equal(whole2.headers.get('Content-Length'), '100');
  assert.equal((await bytes(whole2)).length, 100);
  assert.deepEqual(r2, before2, 'a cached whole object needs no R2 call');
});

await check('dataset allowlist: unknown ids, files and traversal never reach R2', async () => {
  const before = { ...r2 };
  for (const path of [
    '/dataset/d1-20260101/manifest.json', '/dataset/' + ID + '/secret.bin', '/dataset/' + ID + '/snapshots/123.bin',
    '/dataset/' + ID + '/chunks/00001.bin.bak', '/dataset/' + ID + '/%2e%2e/explorer/v5/site/explorer.html',
    '/dataset/' + ID + '/../explorer/v5/site/explorer.html', '/dataset/', '/dataset/' + ID + '/', '/dataset/../landscape/' + ID + '/rows.bin',
  ]) {
    const res = await req(path);
    assert.equal(res.status, 404, path);
    securityHeadersOk(res, path);
  }
  assert.deepEqual(r2, before);
  const opt = await req('/dataset/' + ID + '/rows.bin', { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(opt.headers.get('Access-Control-Allow-Headers'), /Range/);
  assert.equal((await req('/', { method: 'POST' })).status, 405);
  assert.equal((await req('/api/pixel?block=1&x=1&y=10')).status, 404, 'only the landscape cell API is served here');
});

await check('row table: the native explorer\'s ranges', async () => {
  const minAmt = new Float64Array(rowsBytes.buffer.slice(rowsBytes.byteOffset, rowsBytes.byteOffset + rowsBytes.byteLength));
  let occupied = 0;
  let prevMin = null;
  for (let r = 0; r < ROWS; r++) {
    const range = rowRange(minAmt, r);
    if (!range) continue;
    occupied++;
    assert.ok(range[0] <= range[1], 'row ' + r);
    if (prevMin !== null) assert.equal(range[1] + 1, prevMin, 'rows ' + r + ' and the next larger row are contiguous');
    prevMin = range[0];
  }
  assert.equal(rowRange(minAmt, 0)[1], 9223372036854776000);
  assert.equal(rowRange(minAmt, ROWS - 1)[0], 1, 'the smallest row starts at 1 sat');
  if (rowsPath) {
    assert.equal(occupied, 2022, 'occupied rows of the film axis');
    // The compiled (fast-math) mapper puts 779,521,282,186 sat in row 49, as the native explorer
    // and the landscape replay do; the IEEE port in mapping.js puts it in row 50.
    assert.equal(rowRange(minAmt, 49)[0], 779521282186);
    assert.equal(rowSatoshiRange(49 + 10)[0], 779521282187);
    let differ = 0;
    for (let r = 0; r < ROWS; r++) {
      const a = rowRange(minAmt, r);
      const b = rowSatoshiRange(r + 10);
      if (JSON.stringify(a) !== JSON.stringify(b)) differ++;
    }
    assert.equal(differ, 2, 'rows 49 and 50 are the only difference from mapping.js');
  }
});

await check('cell API: validation, empty rows, rate limit', async () => {
  for (const q of ['', '?block=1&col=1', '?block=x&col=1&row=1', '?block=1&col=-1&row=1', '?block=1&col=1.5&row=1']) {
    const res = await req('/api/landscape/cell' + q);
    assert.equal(res.status, 400, q);
    assert.match((await res.json()).error, /non-negative integers/);
  }
  const col = await req('/api/landscape/cell?block=1&col=15107&row=1');
  assert.equal(col.status, 400);
  assert.equal((await col.json()).error, 'col outside the landscape');
  const row = await req('/api/landscape/cell?block=1&col=1&row=2072');
  assert.equal((await row.json()).error, 'row outside the landscape');
  const minAmt = new Float64Array(rowsBytes.buffer.slice(rowsBytes.byteOffset, rowsBytes.byteOffset + rowsBytes.byteLength));
  let empty = -1;
  for (let r = 1; r < ROWS && empty < 0; r++) if (!rowRange(minAmt, r)) empty = r;
  assert.ok(empty > 0, 'an empty row exists');
  const e = await req('/api/landscape/cell?block=999999999&col=3&row=' + empty);
  assert.equal(e.status, 200);
  assert.equal(await e.text(), JSON.stringify({ col: 3, row: empty, blockRange: null, satRange: null, count: 0, utxos: [] }));
  assert.equal(e.headers.get('Cache-Control'), 'public, max-age=86400, s-maxage=86400');
  securityHeadersOk(e, 'cell');
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const res = await req('/api/landscape/cell?block=1&col=3&row=' + empty, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    if (res.status === 429) { limited++; assert.equal(res.headers.get('Retry-After'), '1'); }
  }
  assert.ok(limited >= 9 && limited <= 11, 'burst of 20 then limited: ' + limited);
});

await check('static app: headers, cache policy, 404 and 304 pass through', async () => {
  const html = await req('/');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('Cache-Control'), 'no-cache');
  securityHeadersOk(html, '/');
  assert.equal(html.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  const js = await req('/main.js');
  assert.equal(js.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal((await req('/og.jpg')).headers.get('Cache-Control'), 'public, max-age=86400');
  assert.equal((await req('/favicon.svg')).headers.get('Cache-Control'), 'public, max-age=86400');
  const missing = await req('/dev/js_replay-client.html');
  assert.equal(missing.status, 404);
  securityHeadersOk(missing, '404');
  const nm = await req('/main.js', { headers: { 'If-None-Match': '"a8"' } });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
});

console.log(passed + ' checks passed');
