// Checks that every public hostname of both Workers serves the release recorded in this
// checkout's release.js files, and that the checkout is the fetched origin/master, so a deploy
// from a branch (which would roll back someone else's release) is caught right away.
//
//   git switch master && git pull --ff-only
//   ... deploy ...
//   node scripts/check_live_release.mjs [--wait 120] [--any-commit]
//
// --wait N retries for up to N seconds: aliases can serve the previous release for a short
// while after a deploy. --any-commit skips the origin/master comparison (for a rollback drill).
// Exit 0 when every hostname answers /health with the expected X-Worker-Version.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE as LANDSCAPE } from '../cloudflare/utxo-landscape-worker/src/release.js';
import { RELEASE as VIDEO } from '../cloudflare/utxo-video-worker/src/release.js';

export const HOSTS = Object.freeze({
  'utxo-video-cdn (2D explorer)': Object.freeze({ version: VIDEO.version, hosts: Object.freeze([
    'bitcointimelapse.com', 'www.bitcointimelapse.com', 'utxo-cdn.hat39.com',
    'utxo-video-cdn.nostisos.workers.dev']) }),
  'utxo-landscape (3D landscape)': Object.freeze({ version: LANDSCAPE.version, hosts: Object.freeze([
    'bitcoinlandscape.com', 'www.bitcoinlandscape.com', '3d.bitcointimelapse.com',
    'utxo-landscape.nostisos.workers.dev']) }),
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const waitSeconds = args.includes('--wait') ? Number(args[args.indexOf('--wait') + 1]) : 0;
const anyCommit = args.includes('--any-commit');

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
}

async function served(host) {
  try {
    const r = await fetch('https://' + host + '/health', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    return r.headers.get('x-worker-version') || 'HTTP ' + r.status + ' without X-Worker-Version';
  } catch (e) {
    return 'unreachable (' + (e.cause?.code || e.message) + ')';
  }
}

let ok = true;
if (!anyCommit) {
  const head = git('rev-parse', 'HEAD');
  const master = git('rev-parse', 'origin/master');
  const dirty = git('status', '--porcelain', '--', 'cloudflare/utxo-landscape-worker/src/release.js',
    'cloudflare/utxo-video-worker/src/release.js');
  if (head !== master) {
    console.log('FAIL checkout ' + head.slice(0, 7) + ' is not origin/master ' + master.slice(0, 7) +
      ' (git fetch, then deploy from master after the PR merges)');
    ok = false;
  } else if (dirty) {
    console.log('FAIL release.js has uncommitted changes:\n' + dirty);
    ok = false;
  } else {
    console.log('ok   checkout is origin/master ' + master.slice(0, 7));
  }
}

const deadline = Date.now() + waitSeconds * 1000;
for (const [worker, { version, hosts }] of Object.entries(HOSTS)) {
  for (const host of hosts) {
    let got = await served(host);
    while (got !== version && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      got = await served(host);
    }
    const pass = got === version;
    ok &&= pass;
    console.log((pass ? 'ok   ' : 'FAIL ') + host + ' ' + got + (pass ? '' : ' (expected ' + version + ', ' + worker + ')'));
  }
}
process.exit(ok ? 0 : 1);
