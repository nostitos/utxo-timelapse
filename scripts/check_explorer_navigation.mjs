import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navigationRoute, explorerCookie, fetchGuide, GUIDE_ORIGIN } from '../cloudflare/utxo-video-worker/src/navigation.js';
import worker from '../cloudflare/utxo-video-worker/src/index.js';
import { RELEASE } from '../cloudflare/utxo-video-worker/src/release.js';

const request = (path, cookie = '', host = 'bitcointimelapse.com') => new Request(`https://${host}${path}`, { headers: { Cookie: cookie } });
// A first visit to the bare public domain opens the explorer behind the welcome choice.
const welcome = { kind: 'explorer', welcome: true };
assert.deepEqual(navigationRoute(request('/')), welcome);
assert.deepEqual(navigationRoute(request('/', '', 'www.bitcointimelapse.com')), welcome);
assert.deepEqual(navigationRoute(request('/?utm_source=friend&fbclid=abc')), welcome, 'campaign tags are not explorer options');
assert.deepEqual(navigationRoute(request('/', 'other=1; btl_explorer=1')), { kind: 'redirect', path: '/explorer' });
assert.deepEqual(navigationRoute(request('/', 'btl_explorer=10')), welcome);
assert.deepEqual(navigationRoute(request('/', 'prefix_btl_explorer=1')), welcome);
for (const host of ['utxo-cdn.hat39.com', 'utxo.aiception.ai']) assert.deepEqual(navigationRoute(request('/', '', host)), { kind: 'explorer' }, host);
for (const path of ['/explorer', '/explorer/', '/explorer.html']) assert.deepEqual(navigationRoute(request(path)), { kind: 'explorer' }, path);
// A link that carries an explorer option opens that view directly, never behind the welcome.
for (const query of ['?block=314000&x=3000&y=1525', '?block=314000', '?x=3000', '?y=1525', '?autoplay=0', '?quality=4k', '?utm_source=friend&autoplay=1']) {
  assert.deepEqual(navigationRoute(request('/' + query)), { kind: 'redirect', path: '/explorer' + query }, query);
}
assert.deepEqual(navigationRoute(request('/guide/', 'btl_explorer=1')), { kind: 'guide', path: '/index.html' });
assert.deepEqual(navigationRoute(request('/guide')), { kind: 'redirect', path: '/guide/' });
for (const path of ['/Guide', '/GUIDE', '/Guide/', '/guide.html', '/Guide.HTM']) {
  assert.deepEqual(navigationRoute(request(path + '?lang=en')), { kind: 'redirect', path: '/guide/?lang=en' }, path);
}
assert.deepEqual(navigationRoute(request('/guide/technical.html')), { kind: 'guide', path: '/technical.html' });
assert.deepEqual(navigationRoute(request('/guide/assets/fonts/fonts.css')), { kind: 'guide', path: '/assets/fonts/fonts.css' });
for (const path of ['/api/info', '/hls/v5/media.m3u8', '/src/index.js', '/assets/.env', '/guide//example.com']) assert.equal(navigationRoute(request(path)), null);
assert.match(explorerCookie(request('/explorer')), /Path=\/;.*HttpOnly; Secure$/);
assert.doesNotMatch(explorerCookie(new Request('http://localhost/explorer')), /Secure/);
// Redirects stay relative so a proxied visitor keeps the hostname they typed, not the
// Worker's own (here utxo-cdn.hat39.com).
for (const [url, target] of [['https://utxo-cdn.hat39.com/GUIDE?lang=en', '/guide/?lang=en'],
  ['https://utxo-cdn.hat39.com/guide', '/guide/'], ['https://bitcointimelapse.com/?block=314000', '/explorer?block=314000']]) {
  const moved = await worker.fetch(new Request(url), {}, { waitUntil() {} });
  assert.equal(moved.status, 302, url);
  assert.equal(moved.headers.get('Location'), target, url);
}

// The welcome page is the release's explorer page with one attribute added, and is never cached.
const page = readFileSync(new URL('../cloudflare/utxo-video-worker/static/explorer.html', import.meta.url), 'utf8');
assert.match(page, /<dialog id="welcome"/);
assert.match(page, /document\.documentElement\.hasAttribute\("data-welcome"\)/);
const pageKey = RELEASE.sitePrefix + '/explorer.html';
const pageBytes = new TextEncoder().encode(page);
const pageObject = () => ({ size: pageBytes.length, httpEtag: '"page"', body: new Response(pageBytes).body, writeHttpMetadata() {}, text: async () => page });
const env = { VIDEO_BUCKET: { head: async (key) => (key === pageKey ? pageObject() : null), get: async (key) => (key === pageKey ? pageObject() : null) } };
const visit = (url, init) => worker.fetch(new Request(url, init), env, { waitUntil() {} });
const first = await visit('https://bitcointimelapse.com/');
assert.equal(first.status, 200);
assert.equal(first.headers.get('Content-Type'), 'text/html; charset=utf-8');
assert.equal(first.headers.get('Cache-Control'), 'no-store');
assert.equal(first.headers.get('Vary'), 'Cookie');
assert.match(first.headers.get('Set-Cookie'), /^btl_explorer=1; Path=\/;.*HttpOnly; Secure$/);
assert.match(first.headers.get('Content-Security-Policy'), /^default-src 'self'/);
const firstPage = await first.text();
assert.match(firstPage, /^<!DOCTYPE html>\n<html data-welcome lang="en">/);
assert.equal(firstPage.replace(' data-welcome', ''), page);
const firstHead = await visit('https://bitcointimelapse.com/', { method: 'HEAD' });
assert.equal(firstHead.status, 200);
assert.equal(firstHead.body, null);
for (const url of ['https://bitcointimelapse.com/explorer', 'https://bitcointimelapse.com/explorer?block=314000', 'https://utxo.aiception.ai/']) {
  const plain = await visit(url);
  assert.equal(plain.status, 200, url);
  assert.match(plain.headers.get('Set-Cookie'), /^btl_explorer=1;/, url);
  assert.equal(await plain.text(), page, url);
}
const returning = await visit('https://bitcointimelapse.com/', { headers: { Cookie: 'btl_explorer=1' } });
assert.equal(returning.status, 302);
assert.equal(returning.headers.get('Location'), '/explorer');

const realFetch = globalThis.fetch;
let observed;
let sourceBody = 'guide';
globalThis.fetch = async (url, init) => {
  observed = { url: String(url), ...init };
  return new Response(init.method === 'HEAD' ? null : sourceBody, { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'origin_cookie=1', 'Cache-Control': 'public, max-age=600' } });
};
try {
  const input = new Request('https://bitcointimelapse.com/guide/', { headers: { Cookie: 'private=1', Authorization: 'private', Range: 'bytes=0-99' } });
  const output = await fetchGuide(input, navigationRoute(input));
  assert.equal(observed.url, GUIDE_ORIGIN + 'index.html');
  assert.equal(observed.redirect, 'manual'); // Workers supports manual/follow, not redirect:error.
  assert.equal(observed.headers.get('Range'), 'bytes=0-99');
  assert.equal(observed.headers.get('Cookie'), null);
  assert.equal(observed.headers.get('Authorization'), null);
  assert.equal(output.headers.get('Set-Cookie'), null);
  assert.equal(output.headers.get('Cache-Control'), 'no-cache');
  assert.equal(output.headers.get('Vary'), null);
  assert.equal(await output.text(), 'guide');
  sourceBody = '<link rel="canonical" href="https://bitcointimelapse.com/"><a class="btn" href="https://bitcointimelapse.com/?block=314000">Explorer</a>';
  const legacy = await fetchGuide(input, navigationRoute(input));
  assert.equal(await legacy.text(), '<link rel="canonical" href="https://bitcointimelapse.com/"><a class="btn" href="https://bitcointimelapse.com/explorer?block=314000">Explorer</a>');
  const head = new Request('https://bitcointimelapse.com/guide/', { method: 'HEAD' });
  const result = await fetchGuide(head, navigationRoute(head));
  assert.equal(observed.method, 'HEAD');
  assert.equal(result.body, null);
  assert.equal(result.headers.get('Cache-Control'), 'no-cache');
} finally { globalThis.fetch = realFetch; }
console.log('PASS: first-visit welcome, remembered choice, explorer options, explicit guide, legacy links, assets, private cache and origin headers.');
