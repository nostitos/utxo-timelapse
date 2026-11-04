// Tests for the owner layer (replay/owners.js and its use in the replay engine): record
// parsing against the golden vector shared with scripts/landscape_owners.py, the ledger's
// per-level maps against brute force on random walks, and what the engine sends against brute
// force on a synthetic chain: owner planes (full tiles, deltas, owner refresh frames), flashes
// only for owner spends, and the owner-only view's tile data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gridFromManifest, SLOT, SLOT_CELLS, tileInfo } from '../web/data/grid.js';
import { rowOfAmount } from '../web/data/axis.js';
import {
  parseOwnerRecords, OwnerLedger, ownerWord, chunkRange, checkOwnerManifest, UNSPENT, OWNER_COUNT_MAX, ENTRY_GROUP,
} from '../web/replay/owners.js';
import { ReplayEngine } from '../web/replay/engine.js';
import { rng, writeDataset, fileSource, cppLikeRows, syntheticChain } from './replay-fixtures.mjs';

// Same bytes as scripts/tests/test_landscape_owners.py: (100, life 5, 1 sat, e0),
// (100, unspent, 5e9 sats, e0), (300, life 4032, 2.1e15 sats, e1).
const GOLDEN = '4255564f574e3100010000000300000064050100000080e497d01200c801c01f80809dd085bedd0301';
const hexBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');

function varuint(n, out) {
  while (n >= 128) {
    out.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

const lifeOf = (r) => (r.spent === UNSPENT ? 0 : r.spent - r.created);

/** Test encoder for the record format (the producer is scripts/landscape_owners.py). */
function encodeRecords(records) {
  const sorted = records.slice().sort((a, b) => a.created - b.created || a.entity - b.entity || a.sats - b.sats || lifeOf(a) - lifeOf(b));
  const body = [];
  let prev = 0;
  for (const r of sorted) {
    varuint(r.created - prev, body);
    varuint(lifeOf(r), body);
    varuint(r.sats, body);
    varuint(r.entity, body);
    prev = r.created;
  }
  const out = new Uint8Array(16 + body.length);
  out.set([0x42, 0x55, 0x56, 0x4f, 0x57, 0x4e, 0x31, 0x00], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 1, true);
  dv.setUint32(12, sorted.length, true);
  out.set(body, 16);
  return out;
}

/** Owner dataset files (in memory) for records, split into long.bin and short chunks. */
function ownerFiles(records, { tip, life, entities = 2, id = 'o000001-20261102' }) {
  const isLong = (r) => r.spent === UNSPENT || r.spent - r.created > life;
  const files = new Map();
  const long = encodeRecords(records.filter(isLong));
  files.set('long.bin', long);
  const byChunk = new Map();
  for (const r of records) {
    if (isLong(r)) continue;
    const k = Math.floor(r.created / life);
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(r);
  }
  const short = [];
  for (const [k, list] of [...byChunk].sort((a, b) => a[0] - b[0])) {
    const file = 'short/' + String(k).padStart(4, '0') + '.bin';
    const bytes = encodeRecords(list);
    files.set(file, bytes);
    short.push({ chunk: k, file, records: list.length, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    format: 'utxo-landscape-owners-1', id, createdUtc: new Date(0).toISOString(), tip, tipHash: '00'.repeat(32), shortLife: life,
    entities: Array.from({ length: entities }, (_, e) => ({ id: 'entity-' + e, name: 'Entity ' + e, color: e ? '#3366ff' : '#f0b90b' })),
    files: { long: { file: 'long.bin', records: records.filter(isLong).length, bytes: long.length, sha256: sha256(long) }, short },
  };
  return { files, manifest };
}

/** Lifecycles of the outputs of a synthetic chain: [{created, spent, sats}] (zero amounts dropped). */
function lifecycles(blocks) {
  const live = new Map();
  const out = [];
  for (const b of blocks) {
    for (const [s, h] of b.changes) {
      if (s === 0) continue;
      const key = Math.abs(s) + ':' + h;
      if (s > 0) {
        const r = { created: h, spent: UNSPENT, sats: s };
        out.push(r);
        if (!live.has(key)) live.set(key, []);
        live.get(key).push(r);
      } else {
        const list = live.get(key);
        const r = list.pop();
        if (!list.length) live.delete(key);
        r.spent = b.height;
      }
    }
  }
  return out;
}

/** Brute force: per level, Map cellKey -> Float64Array(4E) of the records alive at b, dense per entity (see sparse). */
function bruteCells(grid, rows, records, b, E, tip) {
  const maps = grid.levels.map(() => new Map());
  if (b > tip) return maps;
  for (const r of records) {
    if (!(r.created <= b && r.spent > b && r.spent !== r.created)) continue;
    const c0 = Math.floor(r.created / 64);
    const r0 = rowOfAmount(rows, r.sats);
    grid.levels.forEach((L, l) => {
      const key = (c0 >>> L.columnShift) * 4096 + (r0 >>> L.rowShift);
      let e = maps[l].get(key);
      if (!e) maps[l].set(key, (e = new Float64Array(4 * E)));
      const o = 4 * r.entity + (r.sats > 5e8 ? 2 : 0);
      e[o] += 1;
      e[o + 1] += r.sats;
    });
  }
  return maps;
}

/** Count of the visible entities' outputs in a brute-force entry. */
const countOf = (e, visible) => visible.reduce((n, x) => n + e[4 * x] + e[4 * x + 2], 0);

/** A ledger cell entry (n, then entity and its four values for each entity holding outputs) from per-entity values. */
function sparse(perEntity) {
  const out = [0];
  for (let e = 0; e < perEntity.length / 4; e++) {
    if (perEntity[4 * e] + perEntity[4 * e + 2] === 0) continue;
    out[0]++;
    out.push(e, ...perEntity.slice(4 * e, 4 * e + 4));
  }
  return Float64Array.from(out);
}

/** Per-entity [countSmall, satsSmall, countLarge, satsLarge] of a ledger cell entry. */
function dense(entry, E) {
  const out = new Float64Array(4 * E);
  for (let o = 1; o < 1 + entry[0] * ENTRY_GROUP; o += ENTRY_GROUP) out.set(entry.subarray(o + 1, o + ENTRY_GROUP), 4 * entry[o]);
  return out;
}

/** Per level, the set of cell keys holding a visible record spent in blocks a+1..b. */
function bruteSpendCells(grid, rows, records, a, b, visible) {
  const sets = grid.levels.map(() => new Set());
  for (const r of records) {
    if (!(r.spent > a && r.spent <= b && visible.includes(r.entity))) continue;
    const c0 = Math.floor(r.created / 64);
    const r0 = rowOfAmount(rows, r.sats);
    grid.levels.forEach((L, l) => sets[l].add((c0 >>> L.columnShift) * 4096 + (r0 >>> L.rowShift)));
  }
  return sets;
}

test('record files: golden vector, encoder and malformed input', () => {
  const r = parseOwnerRecords(hexBytes(GOLDEN));
  assert.equal(r.count, 3);
  assert.deepEqual(Array.from(r.created), [100, 100, 300]);
  assert.deepEqual(Array.from(r.spent), [105, UNSPENT, 4332]);
  assert.deepEqual(Array.from(r.sats), [1, 5e9, 2.1e15]);
  assert.deepEqual(Array.from(r.entity), [0, 0, 1]);
  const again = encodeRecords([
    { created: 100, spent: UNSPENT, sats: 5e9, entity: 0 }, { created: 300, spent: 4332, sats: 2.1e15, entity: 1 },
    { created: 100, spent: 105, sats: 1, entity: 0 },
  ]);
  assert.equal(toHex(again), GOLDEN);
  const bytes = hexBytes(GOLDEN);
  assert.throws(() => parseOwnerRecords(bytes.slice(0, bytes.length - 1)), /truncated/);
  assert.throws(() => parseOwnerRecords(Uint8Array.from([...bytes, 0])), /trailing/);
  const bad = bytes.slice();
  bad[0] = 0x41;
  assert.throws(() => parseOwnerRecords(bad), /magic/);
  const zero = encodeRecords([{ created: 1, spent: 2, sats: 1, entity: 0 }]);
  zero[zero.length - 2] = 0; // sats 0
  assert.throws(() => parseOwnerRecords(zero), /amount/);
});

test('owner words and chunk ranges', () => {
  const vis = Uint8Array.from([1, 1, 0]);
  // Per entity [countSmall, satsSmall, countLarge, satsLarge].
  const entry = (...perEntity) => sparse(perEntity.flat());
  const none = [0, 0, 0, 0];
  assert.equal(ownerWord(entry(none, none, none), vis), 0);
  assert.equal(ownerWord(entry([3, 9, 0, 0], none, none), vis), 1 * 16777216 + 3);
  assert.equal(ownerWord(entry(none, [0, 0, 2, 2e9], none), vis), 2 * 16777216 + 2);
  assert.equal(ownerWord(entry([2, 9, 3, 3e9], none, none), vis), 1 * 16777216 + 5, 'small and large outputs both count');
  assert.equal(ownerWord(entry([1, 9, 0, 0], [0, 0, 2, 2e9], none), vis), 2 * 16777216 + 3, 'the entity with most outputs colours the cell');
  assert.equal(ownerWord(entry([1, 9, 0, 0], [1, 9, 0, 0], none), vis), 1 * 16777216 + 2, 'a tie goes to the lower index');
  assert.equal(ownerWord(entry(none, none, [7, 9, 0, 0]), vis), 0, 'hidden entity');
  assert.equal(ownerWord(entry([2e7, 9, 0, 0], [1, 9, 0, 0], none), vis), 16777216 + OWNER_COUNT_MAX, 'capped count');
  // Slots: entities lit as one group count together and take the group's code (its first member's).
  const all = Uint8Array.from([1, 1, 1]);
  const grouped = [0, 1, 0];
  assert.equal(ownerWord(entry([2, 9, 0, 0], [3, 9, 0, 0], [2, 9, 0, 0]), all), 2 * 16777216 + 7, 'alone, entity 1 holds the most');
  assert.equal(ownerWord(entry([2, 9, 0, 0], [3, 9, 0, 0], [2, 9, 0, 0]), all, grouped), 1 * 16777216 + 7, 'together 0 and 2 hold more');
  assert.equal(ownerWord(entry(none, [3, 9, 0, 0], [3, 9, 0, 0]), all, grouped), 1 * 16777216 + 6, 'a tie goes to the lower slot');
  assert.equal(ownerWord(entry(none, none, [1, 9, 0, 0]), Uint8Array.from([1, 1, 0]), grouped), 0, 'a hidden member counts for nothing');
  // The entry lists entities in any order (removals move the last one into the gap).
  assert.equal(ownerWord(Float64Array.from([2, 1, 4, 9, 0, 0, 0, 4, 9, 0, 0]), vis), 1 * 16777216 + 8, 'order does not matter on a tie');
  assert.deepEqual(chunkRange(0, 0, 100), { from: 0, to: 0 });
  assert.deepEqual(chunkRange(150, 150, 100), { from: 0, to: 1 });
  assert.deepEqual(chunkRange(199, 199, 100), { from: 1, to: 1 });
  assert.deepEqual(chunkRange(450, 210, 100), { from: 1, to: 4 });
  assert.throws(() => checkOwnerManifest({ format: 'x' }), /format/);
});

test('ledger maps equal brute force on random walks (forward, backward, jumps, past the tip)', async () => {
  const numBlocks = 9000;
  const grid = gridFromManifest({ numBlocks });
  const rows = cppLikeRows();
  const all = lifecycles(syntheticChain({ numBlocks, seed: 11 }));
  const r = rng(5);
  const records = [];
  for (const rec of all) {
    if (rec.spent === rec.created) continue;
    const x = r();
    if (x < 0.25) records.push({ ...rec, entity: 0 });
    else if (x < 0.32) records.push({ ...rec, entity: 1 });
  }
  const tip = numBlocks - 1 - 200; // owner data ends before the dataset
  const kept = records.filter((rec) => rec.created <= tip).map((rec) => (rec.spent > tip ? { ...rec, spent: UNSPENT } : rec));
  const life = 300;
  const { files, manifest } = ownerFiles(kept, { tip, life });
  let fetches = 0;
  const ledger = new OwnerLedger({ grid, minAmt: rows, manifest, fetchFile: async (entry) => { fetches++; return files.get(entry.file); } });
  ledger.setVisible([0, 1]);
  const check = async (b) => {
    const want = bruteCells(grid, rows, kept, b, 2, tip);
    grid.levels.forEach((L, l) => {
      assert.equal(ledger.cells[l].size, want[l].size, 'cells at level ' + l + ' block ' + b);
      for (const [key, e] of want[l]) {
        const got = ledger.cells[l].get(key);
        assert.deepEqual(got ? Array.from(dense(got, 2)) : [], Array.from(e), 'cell ' + l + '/' + key + ' block ' + b);
      }
    });
    const m = ledger.meta();
    assert.equal(m.active, b <= tip);
    let n0 = 0;
    for (const e of want[0].values()) n0 += e[0] + e[2];
    assert.equal(m.entities[0].count, n0);
    // values(): the visible entities' sums of a cell.
    const out = [0, 0, 0, 0];
    for (const [key, e] of [...want[3]].slice(0, 40)) {
      assert.equal(ledger.values(3, Math.floor(key / 4096), key % 4096, out), countOf(e, [0, 1]) > 0);
      assert.deepEqual(out, [0, 1, 2, 3].map((k) => e[k] + e[4 + k]), 'values of ' + key + ' at ' + b);
    }
    // spendsAt(): amount -> creation heights of the outputs spent in a block.
    for (const s of [b, b + 1]) {
      if (s > numBlocks - 1) continue;
      await ledger.ensure(Math.max(0, s - 1), s);
      const exp = new Map();
      if (s <= tip) for (const rec of kept) if (rec.spent === s) exp.set(rec.sats, [...(exp.get(rec.sats) || []), rec.created]);
      const got = ledger.spendsAt(s);
      for (const list of [...exp.values(), ...got.values()]) list.sort((x, y) => x - y);
      assert.deepEqual(got, exp, 'spends in block ' + s);
    }
  };
  let b = 0;
  const steps = [1, 1, 5, 17, 64, 299, 300, 301, 650, -1, -7, -300, -301, -650, 2500, -4000, 40];
  for (let i = 0; i < 60; i++) {
    const step = i < steps.length ? steps[i] : Math.round((r() - 0.45) * (r() < 0.2 ? 3000 : 400));
    const next = Math.max(0, Math.min(numBlocks - 1, b + step));
    await ledger.ensure(b, next);
    ledger.moveTo(next);
    b = next;
    await check(b);
  }
  for (const target of [tip, tip + 1, numBlocks - 1, tip - 3]) {
    await ledger.ensure(b, target);
    ledger.moveTo(target);
    b = target;
    await check(b);
  }
  assert.ok(fetches >= 3, 'loads long.bin and several chunks');
  assert.ok(ledger.chunks.size <= 16 + 3);
});

// ------------------------------------------------------------------ engine
/** Applies frames like the terrain atlas does to its owner planes: tile id -> Uint32Array. */
function applyOwnerFrame(planes, f) {
  for (const id of f.evicted || []) planes.delete(id);
  for (const t of f.full) {
    if (t.empty) { planes.delete(t.id); continue; }
    if (f.owners) planes.set(t.id, t.owners ? t.owners.slice() : new Uint32Array(SLOT_CELLS));
  }
  const d = f.deltas;
  if (f.owners && d && d.ids.length) {
    for (let k = 0; k < d.ids.length; k++) {
      let p = planes.get(d.ids[k]);
      if (!p) planes.set(d.ids[k], (p = new Uint32Array(SLOT_CELLS)));
      for (let i = d.offsets[k]; i < d.offsets[k + 1]; i++) p[d.index[i]] = d.owners[i];
    }
  }
  for (const t of f.ownerTiles || []) planes.set(t.id, t.owners ? t.owners.slice() : new Uint32Array(SLOT_CELLS));
}

/** Applies frames' tile data like the atlas does: tile id -> {data: [h, heat, heatBlock, colour] per cell, counts}. */
function applyDataFrame(tiles, f) {
  for (const id of f.evicted || []) tiles.delete(id);
  for (const t of f.full) {
    if (t.empty) tiles.delete(t.id);
    else tiles.set(t.id, { data: t.data.slice(), counts: t.counts.slice() });
  }
  const d = f.deltas;
  for (let k = 0; d && k < d.ids.length; k++) {
    let t = tiles.get(d.ids[k]);
    if (!t) tiles.set(d.ids[k], (t = { data: new Float32Array(SLOT_CELLS * 4), counts: new Uint32Array(SLOT_CELLS) }));
    for (let i = d.offsets[k]; i < d.offsets[k + 1]; i++) {
      t.data.set(d.data.subarray(i * 4, i * 4 + 4), d.index[i] * 4);
      t.counts[d.index[i]] = d.counts[i];
    }
  }
}

/** fn(level, cellKey, data, o, count) for every interior cell of the delivered tiles. */
function eachCell(grid, tiles, fn) {
  for (const [id, t] of tiles) {
    const info = tileInfo(grid, id);
    for (let ly = 0; ly < info.rows; ly++) {
      for (let lx = 0; lx < info.cols; lx++) {
        const ci = (ly + 1) * SLOT + lx + 1;
        fn(info.level, (info.col0 + lx) * 4096 + info.row0 + ly, t.data, ci * 4, t.counts[ci]);
      }
    }
  }
}

function expectedWords(grid, rows, records, b, visible, tip, slots = null) {
  const vis = Uint8Array.from([0, 1].map((e) => (visible.includes(e) ? 1 : 0)));
  const maps = bruteCells(grid, rows, records, b, 2, tip);
  return maps.map((m) => {
    const w = new Map();
    for (const [key, e] of m) {
      const word = ownerWord(sparse(Array.from(e)), vis, slots);
      if (word) w.set(key, word);
    }
    return w;
  });
}

function checkPlanes(grid, planes, want, label) {
  let owned = 0;
  for (const [id, plane] of planes) {
    const t = tileInfo(grid, id);
    for (let ly = 0; ly < t.rows; ly++) {
      for (let lx = 0; lx < t.cols; lx++) {
        const got = plane[(ly + 1) * SLOT + lx + 1];
        const exp = want[t.level].get((t.col0 + lx) * 4096 + t.row0 + ly) || 0;
        if (got !== exp) assert.fail(label + ': tile ' + id + ' cell ' + (t.col0 + lx) + '/' + (t.row0 + ly) + ' level ' + t.level + ' word ' + got + ' != ' + exp);
        if (got) owned++;
      }
    }
  }
  return owned;
}

test('engine frames carry owner words equal to brute force after seeks, playback and toggles', async () => {
  const dir = join(tmpdir(), 'landscape-owners-engine-' + process.pid);
  const { blocks, grid, rows } = await writeDataset(dir, { numBlocks: 7000, seed: 21 });
  try {
    const all = lifecycles(blocks).filter((rec) => rec.spent !== rec.created);
    const r = rng(9);
    const records = all.filter(() => r() < 0.3).map((rec) => ({ ...rec, entity: r() < 0.8 ? 0 : 1 }));
    const tip = blocks.length - 1;
    const { files, manifest } = ownerFiles(records, { tip, life: 250 });
    const ownersDir = join(dir, 'owners');
    for (const [name, bytes] of files) {
      mkdirSync(join(ownersDir, name.includes('/') ? 'short' : ''), { recursive: true });
      writeFileSync(join(ownersDir, name), bytes);
    }
    const msgs = [];
    const waiters = [];
    const post = (m) => { msgs.push(m); for (const w of waiters.splice(0)) w(); };
    const engine = new ReplayEngine({ source: fileSource(dir), post, ownersSource: () => fileSource(ownersDir) });
    await engine.init({ maxResidentTiles: 400, chunkCacheMB: 64 });
    const until = async (pred) => {
      for (;;) {
        const i = msgs.findIndex(pred);
        if (i >= 0) return msgs[i];
        await new Promise((res) => waiters.push(res));
      }
    };
    const planes = new Map();
    const tiles = new Map();
    let read = 0;
    const drain = () => {
      for (; read < msgs.length; read++) {
        const m = msgs[read];
        if (m.type === 'frame') {
          applyOwnerFrame(planes, m.frame);
          applyDataFrame(tiles, m.frame);
        }
        if (m.type === 'error') assert.fail('engine error: ' + m.message);
      }
    };
    // Commands arrive as separate tasks, as worker messages do.
    const send = (m) => setImmediate(() => engine.command(m));
    const allTiles = Array.from({ length: grid.tiles }, (_, i) => i);
    send({ type: 'setTiles', ids: allTiles });
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [0, 1] });
    let id = 1;
    const seek = async (b) => {
      const sid = id++;
      send({ type: 'seek', id: sid, block: b });
      await until((m) => m.type === 'seekDone' && m.id === sid);
      await new Promise((res) => setTimeout(res, 20)); // owner refresh after the first seek
      drain();
    };
    const advance = async (target) => {
      for (;;) {
        const aid = id++;
        send({ type: 'advance', id: aid, target, budgetMs: 50 });
        const done = await until((m) => m.type === 'advanceDone' && m.id === aid);
        drain();
        if (done.error) assert.fail(done.error);
        if (done.block === target) return;
      }
    };
    let visible = [0, 1];
    let slots = null;
    const verify = (b, label) => checkPlanes(grid, planes, expectedWords(grid, rows, records, b, visible, tip, slots), label);
    // Cells whose flash (heat) is from blocks a+1..b, per level.
    const heatCells = (a, b) => {
      const got = grid.levels.map(() => new Set());
      eachCell(grid, tiles, (l, key, data, o) => { if (data[o + 1] > 0 && data[o + 2] > a && data[o + 2] <= b) got[l].add(key); });
      return got;
    };
    // Each cell's raw count, and height only where outputs are, against the given records.
    const checkCounts = (b, recs, vis, label) => {
      const want = bruteCells(grid, rows, recs, b, 2, Infinity);
      let n = 0;
      eachCell(grid, tiles, (l, key, data, o, count) => {
        const e = want[l].get(key);
        const exp = e ? countOf(e, vis) : 0;
        if (count !== exp || (data[o] !== 0) !== (exp !== 0)) assert.fail(label + ': level ' + l + ' cell ' + key + ' count ' + count + ' != ' + exp + ', height ' + data[o]);
        if (exp) n++;
      });
      return n;
    };
    const everyone = all.map((rec) => ({ ...rec, entity: 0 }));

    await seek(3200);
    assert.ok(verify(3200, 'seek 3200') > 0, 'some owned cells');
    await advance(3260);
    verify(3260, 'forward 60');
    // While the layer is on, only the lit owners' spends flash.
    const ownerSpends = bruteSpendCells(grid, rows, records, 3200, 3260, [0, 1]);
    const hot = heatCells(3200, 3260);
    grid.levels.forEach((L, l) => assert.deepEqual([...hot[l]].sort(), [...ownerSpends[l]].sort(), 'flashing cells at level ' + l));
    assert.ok(ownerSpends[0].size > 0, 'owner spends in blocks 3201..3260');
    assert.ok(bruteSpendCells(grid, rows, everyone, 3200, 3260, [0])[0].size > ownerSpends[0].size, 'other spends there too');
    await advance(3000);
    verify(3000, 'back 260');
    await seek(6100);
    verify(6100, 'seek 6100');
    await advance(6400);
    verify(6400, 'forward across chunks');
    await seek(tip);
    verify(tip, 'tip');

    visible = [1];
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && m.frame.ownerTiles && msgs.indexOf(m) >= read);
    drain();
    const owned1 = verify(tip, 'only entity 1');
    visible = [0, 1];
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && msgs.indexOf(m) >= read);
    drain();
    assert.ok(verify(tip, 'both again') >= owned1);
    // Both lit as one group: every cell either holds takes the group's code, entity 0's.
    slots = [0, 0];
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible, slots });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && msgs.indexOf(m) >= read);
    drain();
    verify(tip, 'one group');
    for (const plane of planes.values()) for (const w of plane) assert.ok(w === 0 || w >>> 24 === 1, 'group code ' + (w >>> 24));
    await seek(3200);
    verify(3200, 'one group after a seek');
    slots = null;
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && msgs.indexOf(m) >= read);
    drain();
    await seek(tip);
    verify(tip, 'separate again');

    // Cell lookups report the owner breakdown at the state block.
    const want = bruteCells(grid, rows, records, tip, 2, tip)[0];
    const [key, e] = want.entries().next().value;
    const cid = id++;
    send({ type: 'cell', id: cid, level: 0, col: Math.floor(key / 4096), row: key % 4096 });
    const res = await until((m) => m.type === 'cellResult' && m.id === cid);
    const counts = res.cell.owners.map((o) => [o.entity, o.count, o.sats]);
    assert.deepEqual(counts, [0, 1].filter((x) => countOf(e, [x]) > 0).map((x) => [x, countOf(e, [x]), e[4 * x + 1] + e[4 * x + 3]]));
    const meta = msgs.filter((m) => m.type === 'frame').pop().frame.meta.owners;
    assert.equal(meta.active, true);
    assert.equal(meta.tip, tip);

    // Owner-only view: the tiles carry the lit owners' outputs alone, through seeks and playback.
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [0, 1], only: true });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && m.frame.full.length > 0 && msgs.indexOf(m) >= read);
    drain();
    assert.ok(checkCounts(tip, records, [0, 1], 'owner-only at the tip') > 0);
    await seek(3200);
    checkCounts(3200, records, [0, 1], 'owner-only after a seek');
    await advance(3260);
    checkCounts(3260, records, [0, 1], 'owner-only after playback');
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [1], only: true });
    await until((m) => m.type === 'frame' && m.frame.reason === 'owners' && m.frame.full.length > 0 && msgs.indexOf(m) >= read);
    drain();
    checkCounts(3260, records, [1], 'owner-only, one entity');
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [1], only: false });
    await until((m) => m.type === 'frame' && m.frame.reason === 'measure' && msgs.indexOf(m) >= read);
    drain();
    checkCounts(3260, everyone, [0], 'every output again');

    // Flatten the rest: each cell's count and height come from the lit records (the height
    // exactly at L0, where a cell's area is 1), and it has a colour wherever any output is
    // (hidden: only where the lit records are, as Hide the rest, which wins over Flatten).
    const checkFlat = (b, vis, label, hidden = false) => {
      const lit = bruteCells(grid, rows, records, b, 2, Infinity);
      const all = bruteCells(grid, rows, everyone, b, 2, Infinity);
      const seen = { owned: 0, flat: 0 };
      eachCell(grid, tiles, (l, key, data, o, count) => {
        const e = lit[l].get(key);
        const exp = e ? countOf(e, vis) : 0;
        const a = all[l].get(key);
        const any = hidden ? exp : a ? countOf(a, [0]) : 0;
        const height = l === 0 && exp ? Math.fround(vis.reduce((s, x) => s + e[4 * x], 0) + vis.reduce((s, x) => s + e[4 * x + 3], 0) / 5e8) : null;
        if (count !== exp || (data[o] !== 0) !== (exp !== 0) || (height !== null && data[o] !== height) || (data[o + 3] !== 0) !== (any !== 0)) {
          assert.fail(label + ': level ' + l + ' cell ' + key + ': count ' + count + ' (lit ' + exp + '), height ' + data[o] +
            (height !== null ? ' (lit ' + height + ')' : '') + ', colour ' + data[o + 3] + ' (' + any + ' outputs)');
        }
        if (exp) seen.owned++;
        else if (any) seen.flat++;
      });
      return seen;
    };
    const ownersFrame = () => until((m) => m.type === 'frame' && m.frame.reason === 'owners' && m.frame.full.length > 0 && msgs.indexOf(m) >= read);
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [0, 1], flat: true });
    await ownersFrame();
    drain();
    const flatAt = checkFlat(3260, [0, 1], 'flat');
    assert.ok(flatAt.owned > 0 && flatAt.flat > 0, 'owned and flat cells: ' + JSON.stringify(flatAt));
    await seek(3200);
    checkFlat(3200, [0, 1], 'flat after a seek');
    await advance(3260);
    checkFlat(3260, [0, 1], 'flat after playback');
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [0, 1], only: true, flat: true });
    await ownersFrame();
    drain();
    checkFlat(3260, [0, 1], 'hide wins over flatten', true);
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [1], flat: true });
    await ownersFrame();
    drain();
    checkFlat(3260, [1], 'flat, one entity');
    send({ type: 'setOwners', url: 'file:///owners/', manifest, visible: [1] });
    await until((m) => m.type === 'frame' && m.frame.reason === 'measure' && msgs.indexOf(m) >= read);
    drain();
    checkCounts(3260, everyone, [0], 'every output after flatten');
    engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
