// Cutoff metadata comes from the history edition, even for a future/empty cell.
import assert from 'node:assert/strict';
import { lifecycleJson } from '../../cloudflare/utxo-video-worker/src/history.js';
import { CONFIG } from '../../cloudflare/utxo-video-worker/src/mapping.js';
const times = new Uint32Array(CONFIG.numBlocks).fill(1231006505);
times[times.length - 1] = 1792353324;
const bucket = { async get(key, { range } = {}) {
  assert.ok(key.endsWith('block_times.bin'), 'future cell needs only history metadata');
  const bytes = range ? new Uint8Array(times.buffer).slice(range.offset, range.offset + range.length) : new Uint8Array(times.buffer);
  return { arrayBuffer: async () => bytes.buffer };
} };
const response = await lifecycleJson({ VIDEO_BUCKET: bucket }, {
  block: 1000, heights: [1024, 1087], sats: [1, 1], row: 2071, lead: { col: 16, row: 2071 },
});
const body = await response.json();
assert.equal(body.block, 1000);
assert.equal(body.cutoffBlock, CONFIG.numBlocks - 1);
assert.equal(body.cutoffDate, '2026-10-18');
assert.equal(body.count, 0);
assert.deepEqual(body.utxos, []);
assert.equal(body.pop.length, 48);
console.log('History response: selected block, cutoff, date and empty cohort verified');
