// Tests for landscape/tools/serve.mjs (owner: js_replay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createLandscapeServer, parseRange } from '../tools/serve.mjs';

const base = mkdtempSync(join(tmpdir(), 'landscape-serve-test-'));
const web = join(base, 'web');
const data = join(base, 'data');
mkdirSync(join(web, 'sub'), { recursive: true });
mkdirSync(join(web, 'data'), { recursive: true });
writeFileSync(join(web, 'data', 'grid.js'), 'export const TILE = 256;');
mkdirSync(join(data, 'snapshots'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>x</title>');
writeFileSync(join(web, 'app.mjs'), 'export const a = 1;');
writeFileSync(join(web, 'sub', 'style.css'), 'body{}');
writeFileSync(join(web, 'font.woff2'), 'w');
writeFileSync(join(web, 'lut.cube'), 'LUT_3D_SIZE 2');
writeFileSync(join(base, 'secret.txt'), 'secret');
symlinkSync(join(base, 'secret.txt'), join(web, 'link.txt'));
const blob = Buffer.alloc(1000);
for (let i = 0; i < blob.length; i++) blob[i] = i & 255;
writeFileSync(join(data, 'snapshots', '0000000.bin'), blob);
writeFileSync(join(data, 'manifest.json'), '{"format":"utxo-landscape-1"}');
writeFileSync(join(data, 'empty.bin'), '');

const server = createLandscapeServer({ web, data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
test.after(() => { server.close(); rmSync(base, { recursive: true, force: true }); });

function raw(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('parseRange variants', () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=-40', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange('bytes=5-2', 10), null);
});

test('app files: index, MIME, no-cache, isolation headers', async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(r.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.match((await raw('/app.mjs')).headers['content-type'], /text\/javascript/);
  assert.match((await raw('/sub/style.css')).headers['content-type'], /text\/css/);
  assert.equal((await raw('/font.woff2')).headers['content-type'], 'font/woff2');
  assert.match((await raw('/lut.cube')).headers['content-type'], /text\/plain/);
  const redirect = await raw('/sub');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/sub/');
  assert.equal((await raw('/missing.js')).status, 404);
  assert.equal((await raw('/app.mjs', { method: 'POST' })).status, 405);
  // /data/ is an ordinary app path (shared JS modules), never the dataset.
  const mod = await raw('/data/grid.js');
  assert.equal(mod.status, 200);
  assert.match(mod.headers['content-type'], /text\/javascript/);
  assert.equal(mod.headers['cache-control'], 'no-cache');
  assert.equal((await raw('/data/manifest.json')).status, 404);
});

test('data files: ranges, HEAD, caching', async () => {
  const full = await raw('/dataset/snapshots/0000000.bin');
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'application/octet-stream');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.match(full.headers['cache-control'], /immutable/);
  assert.equal(full.body.length, 1000);
  const part = await raw('/dataset/snapshots/0000000.bin', { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
  assert.equal(part.headers['content-length'], '100');
  assert.deepEqual([...part.body], [...blob.subarray(100, 200)]);
  const open = await raw('/dataset/snapshots/0000000.bin', { headers: { Range: 'bytes=990-' } });
  assert.equal(open.status, 206);
  assert.deepEqual([...open.body], [...blob.subarray(990)]);
  const suffix = await raw('/dataset/snapshots/0000000.bin', { headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.headers['content-range'], 'bytes 995-999/1000');
  assert.equal(suffix.body.length, 5);
  const bad = await raw('/dataset/snapshots/0000000.bin', { headers: { Range: 'bytes=1000-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */1000');
  const multi = await raw('/dataset/snapshots/0000000.bin', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(multi.status, 200);
  assert.equal(multi.body.length, 1000);
  const head = await raw('/dataset/snapshots/0000000.bin', { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-length'], '10');
  assert.equal(head.body.length, 0);
  const manifest = await raw('/dataset/manifest.json');
  assert.match(manifest.headers['content-type'], /application\/json/);
  assert.equal(manifest.headers['cache-control'], 'no-cache');
  const empty = await raw('/dataset/empty.bin');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.length, 0);
  const cond = await raw('/dataset/snapshots/0000000.bin', { headers: { 'If-None-Match': full.headers.etag } });
  assert.equal(cond.status, 304);
  assert.equal((await raw('/dataset/')).status, 404);
  assert.equal((await raw('/dataset/missing.bin')).status, 404);
});

test('path traversal and symlink escapes are refused', async () => {
  for (const p of ['/../secret.txt', '/dataset/../../secret.txt', '/dataset/..%2F..%2Fsecret.txt', '/%2e%2e/secret.txt',
    '/sub/..%2f..%2fsecret.txt', '/dataset/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt']) {
    const r = await raw(p);
    assert.ok([400, 403, 404].includes(r.status), p + ' -> ' + r.status);
    assert.ok(!r.body.toString().includes('secret') || r.status !== 200, p);
  }
  assert.equal((await raw('/link.txt')).status, 403);
  assert.equal((await raw('/a%00b')).status, 400);
});

test('server without --data returns 404 under /dataset/', async () => {
  const s = createLandscapeServer({ web });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  const r = await new Promise((resolve) => request({ host: '127.0.0.1', port: p, path: '/dataset/manifest.json' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).end());
  assert.equal(r, 404);
  s.close();
});
