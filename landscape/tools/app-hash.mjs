#!/usr/bin/env node
// Content hash of the app files the landscape Worker serves under /app/<hash>/ (landscape/web
// without guide/ and dev/), written to landscape/web/app-hash.txt. Wrangler runs this before every
// deploy ([build] in cloudflare/utxo-landscape-worker/wrangler.toml), so the hash always names the
// uploaded files and the Worker can let browsers keep them as immutable.
//
//   node landscape/tools/app-hash.mjs          writes app-hash.txt and prints the hash
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HASH_FILE = 'app-hash.txt';
const OUTSIDE = new Set(['guide', 'dev', HASH_FILE]); // top-level names not served under /app/<hash>/

/** 16 hex digits of the SHA-256 over every app file's path and bytes. */
export function appHash(web) {
  const sha = createHash('sha256');
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.') || (!prefix && OUTSIDE.has(e.name))) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel + '/');
      else sha.update(rel + '\0').update(readFileSync(join(dir, e.name))).update('\0');
    }
  };
  walk(web, '');
  return sha.digest('hex').slice(0, 16);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const hash = appHash(web);
  writeFileSync(join(web, HASH_FILE), hash + '\n');
  console.log('app hash ' + hash);
}
