// landscape/tools/owners-check.mjs on a tiny synthetic landscape and owner data built from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeDataset, syntheticChain, ReferenceState } from './replay-fixtures.mjs';
import { rowOfAmount } from '../web/data/axis.js';
import { DecodedBlock, decodeBlock, encodeBlock } from '../web/replay/blk2.js';
import { parseOwnerRecords } from '../web/replay/owners.js';
import { checkOwners, unmatchedEvents } from '../tools/owners-check.mjs';

// The fixed record file vector shared with the build (landscape/web/replay/owners.js).
const GOLDEN = '4255564f574e3100010000000300000064050100000080e497d01200c801c01f80809dd085bedd0301';

/** Record file of [{created, life, sats, entity}] in file order. */
function encodeRecords(records) {
  const n = records.length;
  const out = [0x42, 0x55, 0x56, 0x4f, 0x57, 0x4e, 0x31, 0x00, 1, 0, 0, 0, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
  const varu = (v) => {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v) b |= 128;
      out.push(b);
    } while (v);
  };
  let prev = 0;
  for (const r of records) {
    varu(r.created - prev);
    varu(r.life);
    varu(r.sats);
    varu(r.entity);
    prev = r.created;
  }
  return Uint8Array.from(out);
}

const base = mkdtempSync(join(tmpdir(), 'landscape-owners-check-'));
test.after(() => rmSync(base, { recursive: true, force: true }));
const data = join(base, 'landscape');
// A low spend rate lets the output set grow, so many owned cells are alive at the tip; amounts
// a thousand times smaller keep the coarse snapshot cells below 2^53 sats.
const chain = syntheticChain({ numBlocks: 3000, seed: 11, spendRate: 0.3 })
  .map((b) => ({ ...b, changes: b.changes.map(([s, h]) => [Math.sign(s) * Math.ceil(Math.abs(s) / 1000), h]) }));
const ds = await writeDataset(data, { chain, chunkBytes: 16 * 1024, snapshotIntervalBytes: 96 * 1024 });
const TIP = ds.manifest.tip;

// Every output with sats > 0 and the block that spends it (Infinity while unspent).
const outputs = [];
const unspent = new Map();
for (const { height, changes } of ds.blocks) {
  for (const [s, h] of changes) {
    if (s <= 0) continue;
    if (!unspent.has(s + ',' + h)) unspent.set(s + ',' + h, []);
    unspent.get(s + ',' + h).push(outputs.length);
    outputs.push({ created: h, sats: s, spent: Infinity });
  }
  for (const [s, h] of changes) if (s < 0) outputs[unspent.get(-s + ',' + h).pop()].spent = height;
}
// Every third output is owned, alternately by two entities.
const OWNED = outputs.filter((_, i) => i % 3 === 0).map((o, i) => ({ ...o, entity: i % 2 }));

/** Owner data cut at tip like the build: created <= tip, a spend after tip counts as unspent, same-block spends dropped. */
function writeOwners(name, { tip = TIP, shortLife = 64, tipHash = '0'.repeat(64), edit = (list) => list } = {}) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'short'), { recursive: true });
  const records = edit(OWNED.filter((o) => o.created <= tip && o.spent !== o.created)
    .map((o) => ({ created: o.created, life: o.spent <= tip ? o.spent - o.created : 0, sats: o.sats, entity: o.entity })))
    .sort((a, b) => a.created - b.created || a.entity - b.entity || a.sats - b.sats || a.life - b.life);
  const file = (path, list) => {
    const bytes = encodeRecords(list);
    writeFileSync(join(dir, path), bytes);
    return { file: path, records: list.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const isLong = (r) => r.life === 0 || r.life > shortLife;
  const short = Map.groupBy(records.filter((r) => !isLong(r)), (r) => Math.floor(r.created / shortLife));
  const files = {
    long: file('long.bin', records.filter(isLong)),
    short: [...short].sort((a, b) => a[0] - b[0]).map(([chunk, list]) => ({ chunk, ...file('short/' + String(chunk).padStart(4, '0') + '.bin', list) })),
  };
  const entities = ['binance', 'other'].map((id, e) => {
    const mine = records.filter((r) => r.entity === e);
    const left = mine.filter((r) => r.life === 0);
    return { id, name: id, color: '#F0B90B', addresses: 1, records: mine.length, unspent: left.length, unspentSats: left.reduce((a, r) => a + r.sats, 0), evidence: [] };
  });
  writeFileSync(join(dir, 'owners.json'), JSON.stringify({ format: 'utxo-landscape-owners-1', id: 'o' + tip + '-20261102', createdUtc: new Date(0).toISOString(),
    tip, tipHash, shortLife, entities, files, source: { method: 'synthetic' } }));
  return { dir, records };
}
const editJson = (dir, change) => {
  const meta = JSON.parse(readFileSync(join(dir, 'owners.json'), 'utf8'));
  change(meta);
  writeFileSync(join(dir, 'owners.json'), JSON.stringify(meta));
};

test('the test encoder writes the fixed record format', () => {
  const golden = [{ created: 100, life: 5, sats: 1, entity: 0 }, { created: 100, life: 0, sats: 5e9, entity: 0 }, { created: 300, life: 4032, sats: 2.1e15, entity: 1 }];
  assert.equal(Buffer.from(encodeRecords(golden)).toString('hex'), GOLDEN);
  assert.deepEqual([...parseOwnerRecords(Buffer.from(GOLDEN, 'hex')).spent], [105, 0xffffffff, 4332]);
});

test('owner events must be a sub-multiset of the block changes, keyed by signed sats and creation height', () => {
  const dec = new DecodedBlock();
  decodeBlock(encodeBlock(100, [[-7, 50], [-7, 60], [-7, 60], [5, 100], [5, 100], [3, 100]]), 0, dec);
  const check = (list) => unmatchedEvents(dec, Float64Array.from(list, (e) => e[0]), Uint32Array.from(list, (e) => e[1]), 0, list.length);
  assert.deepEqual(check([[5, 100], [-7, 60], [-7, 60], [5, 100], [-7, 50], [3, 100]]), []);
  assert.deepEqual(check([[5, 100], [5, 100], [5, 100]]), [{ sats: 5, height: 100, need: 3, have: 2 }]);
  assert.deepEqual(check([[-7, 50], [-7, 50], [-7, 60]]), [{ sats: -7, height: 50, need: 2, have: 1 }]);
  assert.deepEqual(check([[7, 100], [-7, 70], [4, 100]]), [{ sats: -7, height: 70, need: 1, have: 0 }, { sats: 4, height: 100, need: 1, have: 0 },
    { sats: 7, height: 100, need: 1, have: 0 }]);
});

test('owner data that matches the landscape passes', async () => {
  const { dir, records } = writeOwners('o-good');
  const r = await checkOwners({ data, owners: dir });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.records, records.length);
  assert.equal(r.events, records.length + records.filter((x) => x.life > 0).length);
  assert.equal(r.snapshot, TIP);
  assert.ok(r.chunks > 5 && r.blocksWithEvents > 500 && r.cells > 100, JSON.stringify(r));

  // Cut below the landscape tip: owned cells are replayed to the latest snapshot below.
  const i = ds.snapshots.findIndex((s, k) => k > 0 && ds.snapshots[k + 1] && ds.snapshots[k + 1].block - s.block > 10);
  const below = writeOwners('o-below', { tip: ds.snapshots[i].block + 5 });
  const b = await checkOwners({ data, owners: below.dir });
  assert.deepEqual(b.problems, []);
  assert.equal(b.snapshot, ds.snapshots[i].block);
  assert.ok(b.records < records.length);
});

test('a wrong amount or an extra record is reported at its block', async () => {
  let changed;
  const { dir } = writeOwners('o-events', {
    edit: (list) => {
      changed = list.find((r) => r.life > 0);
      changed.sats = 123456789123;
      const extra = list.find((r) => r.life === 0 && ds.blocks[r.created].changes.filter(([s, h]) => s === r.sats && h === r.created).length === 1);
      return [...list, { ...extra }];
    },
  });
  const r = await checkOwners({ data, owners: dir });
  assert.equal(r.ok, false);
  assert.equal(r.failures.event, 3, r.problems.join('\n'));
  assert.ok(r.problems.includes('block ' + changed.created + ': 1 creation of 123456789123 sat created at ' + changed.created + ', the block has 0'), r.problems.join('\n'));
  assert.ok(r.problems.includes('block ' + (changed.created + changed.life) + ': 1 spend of 123456789123 sat created at ' + changed.created + ', the block has 0'));
  assert.ok(r.problems.some((p) => /: 2 creations of \d+ sat created at \d+, the block has 1$/.test(p)));
});

test('an output kept unspent after its spend exceeds its landscape cell', async () => {
  const ref = new ReferenceState(ds.grid, ds.rows);
  for (const b of ds.blocks) ref.applyBlock(b.changes);
  const cellOf = (r) => Math.floor(r.created / 64) * ds.grid.rows + rowOfAmount(ds.rows, r.sats);
  let kept;
  const { dir } = writeOwners('o-cells', {
    edit: (list) => {
      kept = list.find((r) => r.life > 0 && !ref.cells.has(cellOf(r)));
      kept.life = 0;
      return list;
    },
  });
  const r = await checkOwners({ data, owners: dir });
  assert.equal(r.failures.event, 0, 'its creation still matches and no spend is claimed');
  assert.equal(r.failures.cell, 1);
  const small = kept.sats <= 5e8;
  assert.equal(r.problems[0], 'cell (col ' + Math.floor(kept.created / 64) + ', row ' + rowOfAmount(ds.rows, kept.sats) + ') at block ' + TIP + ': owned [' +
    (small ? [1, kept.sats, 0, 0] : [0, 0, 1, kept.sats]).join(', ') + '] exceeds the landscape [0, 0, 0, 0] (small count, sats; large count, sats)');
});

test('a wrong tip hash fails; damaged or inconsistent owner files are refused', async () => {
  const { dir } = writeOwners('o-hash', { tipHash: 'ab'.repeat(32) });
  const r = await checkOwners({ data, owners: dir });
  assert.deepEqual(r.failures, { event: 0, tipHash: 1, cell: 0 });
  for (const [change, why] of [
    [(m) => { m.files.long.sha256 = '0'.repeat(64); }, /long\.bin: SHA-256 differs/],
    [(m) => { m.files.short[0].records++; }, /records, owners\.json says/],
    [(m) => { m.shortLife = 32; }, /belongs in another file/],
    [(m) => { m.entities[1].unspentSats++; }, /other unspentSats/],
    [(m) => { m.tip = TIP + 1; m.id = 'o' + (TIP + 1) + '-20261102'; }, /past the landscape tip/],
    [(m) => { m.format = 'utxo-landscape-1'; }, /format/],
  ]) {
    const { dir: d } = writeOwners('o-bad');
    editJson(d, change);
    await assert.rejects(checkOwners({ data, owners: d }), why);
  }
});
