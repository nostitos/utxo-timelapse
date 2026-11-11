// landscape/tools/app-hash.mjs: the hash follows every app file and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appHash } from '../tools/app-hash.mjs';

test('app hash follows the app files, not the guide, dev pages or dotfiles', () => {
  const web = mkdtempSync(join(tmpdir(), 'app-hash-'));
  try {
    for (const d of ['ui', 'guide', 'dev']) mkdirSync(join(web, d));
    writeFileSync(join(web, 'main.js'), 'a');
    writeFileSync(join(web, 'ui/x.js'), 'b');
    const h = appHash(web);
    assert.match(h, /^[0-9a-f]{16}$/);
    for (const f of ['guide/index.html', 'dev/t.html', '.DS_Store', 'ui/.DS_Store', 'app-hash.txt']) writeFileSync(join(web, f), 'z');
    assert.equal(appHash(web), h, 'files outside the app do not count');
    writeFileSync(join(web, 'ui/x.js'), 'c');
    assert.notEqual(appHash(web), h, 'an edited app file changes it');
    writeFileSync(join(web, 'ui/x.js'), 'b');
    assert.equal(appHash(web), h);
    writeFileSync(join(web, 'ui/y.js'), '');
    assert.notEqual(appHash(web), h, 'a new empty file changes it');
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});
