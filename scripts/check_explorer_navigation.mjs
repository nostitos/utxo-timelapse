import assert from 'node:assert/strict';
import { navigationRoute, explorerCookie, fetchGuide, GUIDE_ORIGIN } from '../cloudflare/utxo-video-worker/src/navigation.js';

const request = (path, cookie = '', host = 'bitcointimelapse.com') => new Request(`https://${host}${path}`, { headers: { Cookie: cookie } });
assert.deepEqual(navigationRoute(request('/')), { kind: 'guide', path: '/index.html', entry: true });
assert.deepEqual(navigationRoute(request('/', 'other=1; btl_explorer=1')), { kind: 'redirect', path: '/explorer' });
assert.equal(navigationRoute(request('/', 'btl_explorer=10')).kind, 'guide');
assert.equal(navigationRoute(request('/', 'prefix_btl_explorer=1')).kind, 'guide');
assert.equal(navigationRoute(request('/', '', 'www.bitcointimelapse.com')).kind, 'guide');
assert.equal(navigationRoute(request('/', '', 'utxo.aiception.ai')).kind, 'explorer');
for (const path of ['/explorer', '/explorer/', '/explorer.html']) assert.equal(navigationRoute(request(path)).kind, 'explorer');
assert.deepEqual(navigationRoute(request('/?block=314000&x=3000&y=1525')), { kind: 'redirect', path: '/explorer?block=314000&x=3000&y=1525' });
assert.deepEqual(navigationRoute(request('/guide/', 'btl_explorer=1')), { kind: 'guide', path: '/index.html' });
assert.deepEqual(navigationRoute(request('/guide')), { kind: 'redirect', path: '/guide/' });
assert.deepEqual(navigationRoute(request('/guide/technical.html')), { kind: 'guide', path: '/technical.html' });
assert.deepEqual(navigationRoute(request('/guide/assets/fonts/fonts.css')), { kind: 'guide', path: '/assets/fonts/fonts.css' });
for (const path of ['/api/info', '/hls/v5/media.m3u8', '/src/index.js', '/assets/.env', '/guide//example.com']) assert.equal(navigationRoute(request(path)), null);
assert.match(explorerCookie(request('/explorer')), /Path=\/;.*HttpOnly; Secure$/);
assert.doesNotMatch(explorerCookie(new Request('http://localhost/explorer')), /Secure/);

const realFetch = globalThis.fetch;
let observed;
let sourceBody = 'guide';
globalThis.fetch = async (url, init) => {
  observed = { url: String(url), ...init };
  return new Response(init.method === 'HEAD' ? null : sourceBody, { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'origin_cookie=1', 'Cache-Control': 'public, max-age=600' } });
};
try {
  const input = new Request('https://bitcointimelapse.com/', { headers: { Cookie: 'private=1', Authorization: 'private', Range: 'bytes=0-99' } });
  const output = await fetchGuide(input, navigationRoute(input));
  assert.equal(observed.url, GUIDE_ORIGIN + 'index.html');
  assert.equal(observed.headers.get('Range'), 'bytes=0-99');
  assert.equal(observed.headers.get('Cookie'), null);
  assert.equal(observed.headers.get('Authorization'), null);
  assert.equal(output.headers.get('Set-Cookie'), null);
  assert.equal(output.headers.get('Cache-Control'), 'no-store');
  assert.equal(output.headers.get('Vary'), 'Cookie');
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
console.log('PASS: first visit, remembered choice, explicit guide, legacy links, assets, private cache and origin headers.');
