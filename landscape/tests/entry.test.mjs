import test from 'node:test';
import assert from 'node:assert/strict';
import { entryDestination, hasExplorerCookie, explorerCookie } from '../web/ui/entry.js';

const home = path => new URL(path, 'https://bitcoinlandscape.com');

test('a fresh public home visit opens the guide, preserving campaign parameters', () => {
  assert.equal(entryDestination(home('/')), '/guide/');
  assert.equal(entryDestination(home('/index.html')), '/guide/');
  assert.equal(entryDestination(new URL('https://www.bitcoinlandscape.com/')), '/guide/');
  assert.equal(entryDestination(home('/?utm_source=friend&utm_campaign=launch')), '/guide/?utm_source=friend&utm_campaign=launch');
});

test('entering the explorer is an explicit bypass, even when storage is blocked', () => {
  assert.equal(entryDestination(home('/explorer')), null);
  assert.equal(entryDestination(home('/guide/')), null);
  assert.equal(entryDestination(home('/'), true), null);
});

test('a shared composition and explicit app options never detour through the guide', () => {
  assert.equal(entryDestination(home('/#b=969652&cam=950,70,95,0,-89&preset=Ultra')), null);
  for (const query of ['?startup=high', '?webgl=1', '?data=/fixture/', '?explorer=http://127.0.0.1:12989', '?explorer2d=https://example.com']) {
    assert.equal(entryDestination(home('/' + query)), null, query);
  }
});

test('existing service aliases and local development retain direct app entry', () => {
  for (const host of ['3d.bitcointimelapse.com', 'utxo-landscape.nostisos.workers.dev', 'localhost', '127.0.0.1']) {
    assert.equal(entryDestination(new URL('https://' + host + '/')), null, host);
  }
});

test('the one-year explorer preference uses exact cookie matching and HTTPS security', () => {
  assert.equal(hasExplorerCookie('other=1; bl_explorer=1; extra=2'), true);
  for (const cookie of ['', 'bl_explorer=0', 'not_bl_explorer=1', 'bl_explorer=11']) {
    assert.equal(hasExplorerCookie(cookie), false, cookie);
  }
  assert.equal(explorerCookie('https:'), 'bl_explorer=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  assert.equal(explorerCookie('http:').includes('Secure'), false);
});
