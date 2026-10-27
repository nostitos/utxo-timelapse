import test from 'node:test';
import assert from 'node:assert/strict';
import { showsWelcome, hasExplorerCookie, explorerCookie } from '../web/ui/entry.js';

const home = path => new URL(path, 'https://bitcoinlandscape.com');

test('a fresh visit to the bare public domain shows the welcome, also with campaign parameters', () => {
  assert.equal(showsWelcome(home('/')), true);
  assert.equal(showsWelcome(home('/index.html')), true);
  assert.equal(showsWelcome(new URL('https://www.bitcoinlandscape.com/')), true);
  assert.equal(showsWelcome(home('/?utm_source=friend&utm_campaign=launch')), true);
});

test('a returning visitor and the explicit /explorer entry open the app directly', () => {
  assert.equal(showsWelcome(home('/'), true), false);
  assert.equal(showsWelcome(home('/explorer')), false);
  assert.equal(showsWelcome(home('/guide/')), false);
});

test('a shared composition and explicit app options never show the welcome', () => {
  assert.equal(showsWelcome(home('/#b=969652&cam=950,70,95,0,-89&preset=Ultra')), false);
  for (const query of ['?startup=high', '?webgl=1', '?data=/fixture/', '?explorer=http://127.0.0.1:12989', '?explorer2d=https://example.com']) {
    assert.equal(showsWelcome(home('/' + query)), false, query);
  }
});

test('existing service aliases and local development retain direct app entry', () => {
  for (const host of ['3d.bitcointimelapse.com', 'utxo-landscape.nostisos.workers.dev', 'localhost', '127.0.0.1']) {
    assert.equal(showsWelcome(new URL('https://' + host + '/')), false, host);
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
