#!/usr/bin/env node
// CSP hash of index.html's inline import map, which the online Worker allows by hash
// (cloudflare/utxo-landscape-worker/src/release.js importMapHash).
//
//   node landscape/tools/csp-hash.mjs            prints 'sha256-…' for landscape/web/index.html
//   node landscape/tools/csp-hash.mjs --check    exits 1 when release.js carries a different hash
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url);
export const INDEX_HTML = fileURLToPath(new URL('../web/index.html', here));
export const RELEASE_JS = fileURLToPath(new URL('../../cloudflare/utxo-landscape-worker/src/release.js', here));

/** 'sha256-<base64>' of the text inside <script type="importmap">…</script>, exactly as the browser hashes it. */
export function importMapHash(html) {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no inline import map found');
  return 'sha256-' + createHash('sha256').update(m[1], 'utf8').digest('base64');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hash = importMapHash(readFileSync(INDEX_HTML, 'utf8'));
  if (process.argv.includes('--check')) {
    const { RELEASE } = await import(pathToFileURL(RELEASE_JS).href);
    if (RELEASE.importMapHash !== hash) {
      console.error('release.js importMapHash ' + RELEASE.importMapHash + ' != index.html ' + hash);
      process.exit(1);
    }
    console.log('ok ' + hash);
  } else {
    console.log(hash);
  }
}

