// Tests for the replay core (owner: js_replay): BLK2 decoding, snapshot codec, exact
// state apply/undo, packing and deltas, seek planning, and (when a built dataset exists)
// an independent cross-check of the C++ build: snapshot k + replay == snapshot k+1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { gridFromManifest, SLOT_CELLS, tileInfo } from '../web/data/grid.js';
import { rowOfAmount, parseRowsBin } from '../web/data/axis.js';
import { DecodedBlock, decodeBlock, encodeBlock, indexRecords } from '../web/replay/blk2.js';
import {
  crc32, encodeTileBlob, decodeTileBlob, buildSnapshotFile, parseSnapshotHeader, parseSnapshotDirectory,
  snapshotPrefixBytes, checkSnapshotHeader, readSnapshotDirectory,
} from '../web/data/snapshot.js';
import { LandscapeState, TileSlot, makeApplier, makeGenericApplier } from '../web/replay/state.js';
import { FrameBuilder, packFull, measureCode } from '../web/replay/pack.js';
import { planSeek, snapshotAtOrBelow } from '../web/replay/planner.js';
import { ChunkStore } from '../web/replay/chunks.js';
import { rng, syntheticChain, ReferenceState, cppLikeRows, fileSource } from './replay-fixtures.mjs';

const BLK = '/Volumes/4T Data/buv_render/changes.blk1.full964k';
const HAVE_BLK = existsSync(BLK) && existsSync(BLK + '.idx');

// ---------------------------------------------------------------- helpers
function readRealBlocks(first, last) {
  const fi = openSync(BLK + '.idx', 'r');
  const fb = openSync(BLK, 'r');
  try {
    const offs = Buffer.alloc(8 * (last - first + 2));
    readSync(fi, offs, 0, offs.length, 40 + first * 8);
    const a = Number(offs.readBigUInt64LE(0));
    const e = Number(offs.readBigUInt64LE(offs.length - 8));
    const buf = Buffer.allocUnsafeSlow(e - a);
    readSync(fb, buf, 0, e - a, a);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    closeSync(fi);
    closeSync(fb);
  }
}

// Straightforward BigInt decoder used as an independent reference.
function refDecode(u8, pos) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  assert.equal(dv.getUint32(pos, true), 0x024b4c42);
  const height = dv.getUint32(pos + 4, true);
  const n = dv.getUint32(pos + 8, true);
  let p = pos + 12;
  const end = p + n;
  const time = dv.getUint32(p + 108, true);
  p += 124;
  const varu = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = u8[p++];
      v |= BigInt(b & 127) << shift;
      shift += 7n;
      if (b < 128) return v;
    }
  };
  const zz = (z) => (z >> 1n) ^ -(z & 1n);
  const nTx = varu();
  const size = varu();
  varu();
  varu();
  const changes = [];
  let s = zz(varu());
  let bh = varu();
  changes.push([s, bh]);
  while (p < end) {
    s += varu();
    if (s <= 0n) { bh += zz(varu()); changes.push([s, bh]); }
    else changes.push([s, BigInt(height)]);
  }
  return { height, time, nTx: Number(nTx), size: Number(size), changes, end: p };
}

const ROWS_JS = cppLikeRows();

// ------------------------------------------------------------------ BLK2
test('BLK2 decode equals a BigInt reference on real blocks from every era', { skip: !HAVE_BLK && 'source BLK not mounted' }, () => {
  const ranges = [[0, 60], [170, 175], [100000, 100010], [210000, 210020], [481824, 481830], [630000, 630012], [840000, 840006], [900000, 900020], [966790, 966827]];
  const dec = new DecodedBlock(16);
  let blocks = 0;
  let changes = 0;
  for (const [a, b] of ranges) {
    const u8 = readRealBlocks(a, b);
    const idx = indexRecords(u8, a);
    assert.equal(idx.lastBlock, b);
    for (let i = 0; i < idx.count; i++) {
      const pos = idx.offsets[i];
      const end = decodeBlock(u8, pos, dec);
      const ref = refDecode(u8, pos);
      assert.equal(end, idx.offsets[i + 1]);
      assert.equal(ref.end, end);
      assert.equal(dec.height, a + i);
      assert.equal(dec.time, ref.time);
      assert.equal(dec.nTx, ref.nTx);
      assert.equal(dec.size, ref.size);
      assert.equal(dec.count, ref.changes.length, 'block ' + dec.height);
      let created = 0;
      let spent = 0;
      for (let k = 0; k < dec.count; k++) {
        assert.equal(BigInt(dec.sats[k]), ref.changes[k][0], 'block ' + dec.height + ' change ' + k);
        assert.equal(BigInt(dec.heights[k]), ref.changes[k][1], 'block ' + dec.height + ' change ' + k);
        if (k) assert.ok(dec.sats[k] >= dec.sats[k - 1], 'sorted');
        if (dec.sats[k] > 0) { created++; assert.equal(dec.heights[k], dec.height); }
        if (dec.sats[k] < 0) { spent++; assert.ok(dec.heights[k] <= dec.height && dec.heights[k] >= 0); }
      }
      assert.equal(dec.created, created);
      assert.equal(dec.spent, spent);
      assert.equal(dec.zero, dec.count - created - spent);
      assert.ok(created >= 1, 'coinbase output');
      blocks++;
      changes += dec.count;
    }
  }
  assert.ok(blocks === 185 && changes > 1000000, blocks + ' blocks, ' + changes + ' changes');
});

test('BLK2 encode/decode round trip on synthetic blocks', () => {
  const r = rng(5);
  const dec = new DecodedBlock(4);
  const cases = [
    [[5000000000, 7]],
    [[-2.1e15, 3], [-1, 0], [0, 6], [0, 7], [1, 7], [2.1e15, 7]],
    [[-5e8, 1], [-(5e8 + 1), 2], [5e8, 7], [5e8 + 1, 7], [-3, 7], [3, 7]],
  ];
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(r() * 300);
    const ch = [];
    for (let k = 0; k < n; k++) {
      const a = Math.floor(Math.exp(r() * Math.log(2.1e15)));
      if (r() < 0.5) ch.push([-a, Math.floor(r() * 8)]);
      else ch.push([a, 7]);
      if (r() < 0.05) ch.push([0, Math.floor(r() * 8)]);
    }
    cases.push(ch);
  }
  for (const ch of cases) {
    const rec = encodeBlock(7, ch, { time: 123, nTx: 9, size: 1e6 + 7 });
    const end = decodeBlock(rec, 0, dec);
    assert.equal(end, rec.length);
    const sorted = ch.map((c) => [c[0], c[1]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    assert.equal(dec.count, sorted.length);
    for (let k = 0; k < dec.count; k++) {
      assert.equal(dec.sats[k], sorted[k][0]);
      if (sorted[k][0] <= 0) assert.equal(dec.heights[k], sorted[k][1]);
      else assert.equal(dec.heights[k], 7);
    }
    assert.equal(dec.time, 123);
    assert.equal(dec.nTx, 9);
    assert.equal(dec.size, 1e6 + 7);
  }
  assert.throws(() => encodeBlock(7, []), /at least one change/);
  assert.throws(() => encodeBlock(7, [[5, 6]]), /record height/);
  const bad = encodeBlock(7, [[5, 7]]);
  bad[0] = 0;
  assert.throws(() => decodeBlock(bad, 0, dec), /magic/);
  const r1 = encodeBlock(3, [[1, 3]]);
  const r2 = encodeBlock(5, [[1, 5]]);
  const joined = new Uint8Array(r1.length + r2.length);
  joined.set(r1);
  joined.set(r2, r1.length);
  assert.throws(() => indexRecords(joined, 3), /consecutive/);
});

// -------------------------------------------------------------- snapshot
test('crc32 matches the IEEE check value and a bytewise implementation', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const slow = (u8) => {
    let c = 0xffffffff;
    for (const b of u8) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const r = rng(9);
  for (let i = 0; i < 50; i++) {
    const u8 = new Uint8Array(Math.floor(r() * 3000));
    for (let k = 0; k < u8.length; k++) u8[k] = Math.floor(r() * 256);
    assert.equal(crc32(u8), slow(u8));
    const a = Math.floor(r() * u8.length);
    assert.equal(crc32(u8, a, u8.length), slow(u8.subarray(a)));
  }
});

test('tile blob encode/decode round trip, including 2^52-scale sums', () => {
  const r = rng(13);
  for (let rep = 0; rep < 20; rep++) {
    const cells = new Float64Array(65536 * 4);
    const n = Math.floor(r() * 3000);
    for (let i = 0; i < n; i++) {
      const li = Math.floor(r() * 65536);
      const o = li * 4;
      const small = r() < 0.8;
      const large = !small || r() < 0.2;
      if (small) { cells[o] = 1 + Math.floor(r() * 1e6); cells[o + 1] = cells[o] + Math.floor(r() * 5e8 * cells[o] * 0.001); }
      if (large) { cells[o + 2] = 1 + Math.floor(r() * 1e4); cells[o + 3] = Math.min(2 ** 52, cells[o + 2] * 5e8 + Math.floor(r() * 2 ** 50)); }
    }
    if (rep === 0) { cells[0] = 1; cells[1] = 1; cells[65535 * 4 + 2] = 1; cells[65535 * 4 + 3] = 2 ** 52; }
    const blob = encodeTileBlob(cells);
    const back = new Float64Array(65536 * 4);
    if (!blob) { assert.equal(cells.some((v) => v !== 0), false); continue; }
    const t = decodeTileBlob(blob, 0, blob.length, back);
    assert.deepEqual(back, cells);
    let occ = 0;
    for (let i = 0; i < 65536; i++) if (cells[i * 4] || cells[i * 4 + 2]) occ++;
    assert.equal(t.occupied, occ);
  }
  assert.equal(encodeTileBlob(new Float64Array(65536 * 4)), null);
});

test('BUVLSN1 file round trip: header, directory, blobs, SHA-256', async () => {
  const grid = gridFromManifest({ numBlocks: 966828 });
  const tiles = new Map();
  const r = rng(21);
  for (const id of [0, 5, 539, 540, 757]) {
    const c = new Float64Array(65536 * 4);
    const t = tileInfo(grid, id); // edge tiles are partial: stay inside the grid
    for (let i = 0; i < 500; i++) {
      const o = (Math.floor(r() * t.rows) * 256 + Math.floor(r() * t.cols)) * 4;
      c[o] = 3; c[o + 1] = 300;
    }
    tiles.set(id, c);
  }
  const totals = { countSmall: 12, countLarge: 3, satsSmall: 2 ** 52, satsLarge: 2100000000000000 };
  const file = await buildSnapshotFile(grid, grid.tip, 123456789012, tiles, totals);
  const h = parseSnapshotHeader(file);
  assert.equal(checkSnapshotHeader(h, grid, grid.tip).tiles, grid.tiles);
  assert.equal(h.blkEnd, 123456789012);
  assert.deepEqual(h.totals, totals);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', file.subarray(128))).toString('hex');
  assert.equal(h.sha256, digest);
  const dir = parseSnapshotDirectory(file, grid.tiles, file.length);
  for (let id = 0; id < grid.tiles; id++) {
    if (!tiles.has(id)) { assert.equal(dir.bytes[id], 0); continue; }
    const back = new Float64Array(65536 * 4);
    assert.equal(crc32(file, dir.offset[id], dir.offset[id] + dir.bytes[id]), dir.crc[id]);
    decodeTileBlob(file, dir.offset[id], dir.offset[id] + dir.bytes[id], back);
    assert.deepEqual(back, tiles.get(id));
  }
  assert.throws(() => checkSnapshotHeader(h, grid, 1), /block/);
  assert.equal(snapshotPrefixBytes(758), 128 + 758 * 16);
  // Tiles beyond the block's columns cannot be stored.
  await assert.rejects(buildSnapshotFile(grid, 314000, 1, tiles, totals), /beyond its columns/);
});

test('BUVLSN1 snapshots describe their own grid and read in any larger dataset', async () => {
  const block = 16000; // L0 column 250, inside the first tile column
  const tight = gridFromManifest({ numBlocks: block + 1 });
  const exact = gridFromManifest({ numBlocks: 256 * 64 });
  const wide = gridFromManifest({ numBlocks: 256 * 64 + 3 * 64 });
  assert.equal(exact.levels[0].tilesX, 1);
  assert.equal(wide.levels[0].tilesX, 2);
  assert.ok(wide.tiles > exact.tiles);
  // Same occupied cells, keyed by each grid's own tile ids.
  const placed = [[0, 0, 1, 1000, 0, 0], [17, 2071, 3, 1.5e9, 0, 0], [128, 900, 0, 0, 1, 6e8], [250, 1500, 2, 7, 4, 4e9]];
  const cellsFor = (g) => {
    const tiles = new Map();
    for (let l = 0; l < g.levels.length; l++) {
      const L = g.levels[l];
      for (const [c0, r0, cs, ss, cl, sl] of placed) {
        const col = Math.floor(c0 / 2 ** L.columnShift);
        const row = Math.floor(r0 / 2 ** L.rowShift);
        const id = L.firstTile + Math.floor(row / 256) * L.tilesX + Math.floor(col / 256);
        if (!tiles.has(id)) tiles.set(id, new Float64Array(65536 * 4));
        const o = ((row % 256) * 256 + (col % 256)) * 4;
        const t = tiles.get(id);
        t[o] += cs; t[o + 1] += ss; t[o + 2] += cl; t[o + 3] += sl;
      }
    }
    return tiles;
  };
  const totals = { countSmall: 6, countLarge: 5, satsSmall: 1.5e9 + 1007, satsLarge: 4.6e9 };
  const a = await buildSnapshotFile(tight, block, 4242, cellsFor(tight), totals);
  const b = await buildSnapshotFile(exact, block, 4242, cellsFor(exact), totals);
  const c = await buildSnapshotFile(wide, block, 4242, cellsFor(wide), totals);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  const readIn = (file, g) => {
    const { header, own, dir } = readSnapshotDirectory(file, g, block, file.length);
    const tiles = new Map();
    for (let id = 0; id < g.tiles; id++) {
      if (!dir.bytes[id]) continue;
      const cells = new Float64Array(65536 * 4);
      assert.equal(crc32(file, dir.offset[id], dir.offset[id] + dir.bytes[id]), dir.crc[id]);
      decodeTileBlob(file, dir.offset[id], dir.offset[id] + dir.bytes[id], cells);
      tiles.set(id, cells);
    }
    return { header, own, tiles };
  };
  const got = readIn(c, wide);
  assert.equal(got.header.numBlocks, block + 1);
  assert.equal(got.own.tiles, tight.tiles);
  assert.deepEqual([...got.tiles.keys()].sort((x, y) => x - y), [...cellsFor(wide).keys()].sort((x, y) => x - y));
  for (const [id, cells] of cellsFor(wide)) assert.deepEqual(got.tiles.get(id), cells);
  // A dataset shorter than the snapshot's own grid cannot hold it.
  assert.throws(() => readSnapshotDirectory(a, gridFromManifest({ numBlocks: block }), block, a.length), /outside the dataset/);
  // Files written before this format record their dataset's numBlocks: the tip
  // file of 'exact', relabelled as an earlier block, is such a file.
  const legacy = (await buildSnapshotFile(exact, exact.tip, 4242, cellsFor(exact), totals)).slice();
  new DataView(legacy.buffer).setUint32(16, block, true);
  const old = readIn(legacy, wide);
  assert.equal(old.header.numBlocks, exact.numBlocks);
  assert.equal(old.own.tiles, exact.tiles);
  for (const [id, cells] of cellsFor(wide)) assert.deepEqual(old.tiles.get(id), cells);
  const bad = a.slice();
  new DataView(bad.buffer).setUint32(36, tight.l0Columns + 1, true);
  assert.throws(() => readSnapshotDirectory(bad, wide, block, bad.length), /l0Columns/);
});

// ----------------------------------------------------------------- state
function fullState(grid, rows) {
  const st = new LandscapeState(grid, rows);
  for (let id = 0; id < grid.tiles; id++) { const s = new TileSlot(grid, id); st.slotOf[id] = s; }
  st.block = -1;
  return st;
}

function compareToReference(st, ref, where) {
  const want = ref.tiles();
  for (let id = 0; id < st.slotOf.length; id++) {
    const s = st.slotOf[id];
    if (s === null) continue;
    const w = want.get(id);
    const c = s.cells;
    for (let i = 0; i < c.length; i++) {
      const expect = w ? w[i] : 0;
      if (c[i] !== expect) assert.fail(where + ': tile ' + id + ' cell ' + (i >> 2) + ' field ' + (i & 3) + ' = ' + c[i] + ', expected ' + expect);
    }
  }
  const t = st.totals;
  assert.deepEqual([t[0], t[2], t[1], t[3]], [ref.totals.countSmall, ref.totals.countLarge, ref.totals.satsSmall, ref.totals.satsLarge], where + ' totals');
}

test('apply/undo on a synthetic chain equals the reference at every level and returns to zero', () => {
  const blocks = syntheticChain({ numBlocks: 20000, seed: 3 });
  const grid = gridFromManifest({ numBlocks: blocks.length });
  const st = fullState(grid, ROWS_JS);
  const ref = new ReferenceState(grid, ROWS_JS);
  const recs = blocks.map((b) => encodeBlock(b.height, b.changes));
  const dec = new DecodedBlock();
  const checks = new Set([0, 1, 777, 5000, 12345, 19999]);
  for (let h = 0; h < blocks.length; h++) {
    decodeBlock(recs[h], 0, dec);
    st.apply(dec, 1, st.slotOf, null, st.totals);
    ref.applyBlock(blocks[h].changes, 1);
    if (checks.has(h)) compareToReference(st, ref, 'forward ' + h);
  }
  for (let h = blocks.length - 1; h >= 0; h--) {
    decodeBlock(recs[h], 0, dec);
    st.apply(dec, -1, st.slotOf, null, st.totals);
    ref.applyBlock(blocks[h].changes, -1);
    if (h === 10000) compareToReference(st, ref, 'backward ' + (h - 1));
  }
  for (const s of st.slotOf) assert.ok(s.cells.every((v) => v === 0), 'tile ' + s.id + ' back to zero');
  assert.deepEqual(Array.from(st.totals), [0, 0, 0, 0]);
});

test('apply edge cases: zero amounts skipped, 5 BTC boundary, same-block create+spend, rows.bin row 49', () => {
  const grid = gridFromManifest({ numBlocks: 1000 });
  const st = fullState(grid, ROWS_JS);
  const dec = new DecodedBlock();
  decodeBlock(encodeBlock(130, [[0, 130], [0, 5], [5e8, 130], [5e8 + 1, 130], [779521282186, 130], [42, 130], [-42, 130]]), 0, dec);
  st.apply(dec, 1, st.slotOf, null, st.totals);
  const c0 = 130 >> 6;
  const at = (amount, level = 0) => {
    const r0 = rowOfAmount(ROWS_JS, amount);
    const L = grid.levels[level];
    return st.cellAt(level, c0 >> L.columnShift, r0 >> L.rowShift);
  };
  assert.equal(rowOfAmount(ROWS_JS, 779521282186), 49);
  const five = at(5e8);
  assert.equal(five.countSmall, 1);
  assert.equal(five.satsSmall, 5e8);
  const big = at(5e8 + 1);
  assert.equal(big.countLarge, 1);
  assert.equal(big.satsLarge, 5e8 + 1);
  const whale = at(779521282186);
  assert.equal(whale.row, 49);
  assert.equal(whale.countLarge, 1);
  const tiny = at(42);
  assert.equal(tiny.countSmall, 0);
  assert.equal(tiny.satsSmall, 0);
  assert.deepEqual([st.totals[0], st.totals[1], st.totals[2], st.totals[3]], [1, 5e8, 2, 5e8 + 1 + 779521282186]);
  // Every level holds the same totals.
  for (const L of grid.levels) {
    let cs = 0;
    let sl = 0;
    for (let id = L.firstTile; id < L.firstTile + L.tilesX * L.tilesY; id++) {
      const c = st.slotOf[id].cells;
      for (let i = 0; i < c.length; i += 4) { cs += c[i]; sl += c[i + 3]; }
    }
    assert.deepEqual([cs, sl], [1, 5e8 + 1 + 779521282186], 'level ' + L.level);
  }
});

test('row walk in apply equals binary-search rows on real blocks', { skip: !HAVE_BLK && 'source BLK not mounted' }, () => {
  const grid = gridFromManifest({ numBlocks: 966828 });
  const rows = ROWS_JS;
  for (const [a, b] of [[481824, 481826], [840000, 840002], [966825, 966827]]) {
    const u8 = readRealBlocks(a, b);
    const idx = indexRecords(u8, a);
    const dec = new DecodedBlock();
    for (let i = 0; i < idx.count; i++) {
      decodeBlock(u8, idx.offsets[i], dec);
      // Reference per change and level.
      const want = new Map();
      const touched = new Set();
      for (let k = 0; k < dec.count; k++) {
        const s = dec.sats[k];
        if (s === 0) continue;
        const amt = Math.abs(s);
        const r0 = rowOfAmount(rows, amt);
        const c0 = Math.floor(dec.heights[k] / 64);
        for (const L of grid.levels) {
          const col = c0 >> L.columnShift;
          const row = r0 >> L.rowShift;
          const id = L.firstTile + (row >> 8) * L.tilesX + (col >> 8);
          touched.add(id);
          const key = id * 65536 + ((row & 255) << 8 | (col & 255));
          let v = want.get(key);
          if (!v) want.set(key, (v = [0, 0, 0, 0]));
          const dc = s > 0 ? 1 : -1;
          if (amt > 5e8) { v[2] += dc; v[3] += s; } else { v[0] += dc; v[1] += s; }
        }
      }
      const st = new LandscapeState(grid, rows);
      for (const id of touched) st.slotOf[id] = new TileSlot(grid, id);
      st.apply(dec, 1, st.slotOf, null, null);
      for (const id of touched) {
        const c = st.slotOf[id].cells;
        for (let li = 0; li < 65536; li++) {
          const v = want.get(id * 65536 + li) || [0, 0, 0, 0];
          const o = li * 4;
          if (c[o] !== v[0] || c[o + 1] !== v[1] || c[o + 2] !== v[2] || c[o + 3] !== v[3]) {
            assert.fail('block ' + dec.height + ' tile ' + id + ' cell ' + li + ': ' + [c[o], c[o + 1], c[o + 2], c[o + 3]] + ' vs ' + v);
          }
        }
      }
    }
  }
});

test('unrolled and generic appliers agree on cells, heat, dirty lists and totals', () => {
  const blocks = syntheticChain({ numBlocks: 40000, seed: 17, maxCreate: 7 });
  const grid = gridFromManifest({ numBlocks: 966828 });
  const recs = blocks.map((b) => encodeBlock(b.height + 900000, b.changes.map(([s, h]) => [s, h + 900000])));
  const fast = makeApplier(grid, ROWS_JS);
  const slow = makeGenericApplier(grid, ROWS_JS);
  assert.notEqual(fast.toString(), slow.toString(), 'standard grid uses the unrolled applier');
  const mk = () => {
    const st = new LandscapeState(grid, ROWS_JS);
    // Resident: every tile the chain can touch at L1..L6, plus a sparse L0 band.
    for (let id = 540; id < grid.tiles; id++) st.slotOf[id] = new TileSlot(grid, id);
    for (let id = 0; id < 540; id += 3) st.slotOf[id] = new TileSlot(grid, id);
    st.setHalfLife(7.5);
    return st;
  };
  const A = mk();
  const B = mk();
  const dec = new DecodedBlock();
  let changes = 0;
  for (let k = 0; k < recs.length; k++) {
    decodeBlock(recs[k], 0, dec);
    const sign = k % 5 === 4 ? -1 : 1;
    const heat = sign > 0 ? A.heatFor(900000 + k) : null;
    const na = fast(dec, sign, A.slotOf, heat, A.totals);
    const nb = slow(dec, sign, B.slotOf, heat ? B.heatFor(900000 + k) : null, B.totals);
    assert.equal(na, nb);
    changes += na;
    if (k % 997 === 0) {
      for (let id = 0; id < grid.tiles; id++) {
        const a = A.slotOf[id];
        const b = B.slotOf[id];
        if (!a) continue;
        assert.deepEqual([a.dirtyN, a.dirtyAll, a.heatActive], [b.dirtyN, b.dirtyAll, b.heatActive], 'tile ' + id);
        assert.deepEqual(a.dirty.subarray(0, a.dirtyN), b.dirty.subarray(0, b.dirtyN));
        a.dirtyN = 0; b.dirtyN = 0; a.dirtyAll = false; b.dirtyAll = false;
      }
    }
  }
  for (let id = 0; id < grid.tiles; id++) {
    const a = A.slotOf[id];
    if (!a) continue;
    assert.deepEqual(a.cells, B.slotOf[id].cells, 'cells of tile ' + id);
    if (a.heat || B.slotOf[id].heat) assert.deepEqual(a.heat, B.slotOf[id].heat, 'heat of tile ' + id);
  }
  assert.deepEqual(A.totals, B.totals);
  assert.ok(changes > 100000, changes + ' changes');
});

test('heat: spends add BTC with half-life decay; seeks/backward clear it', () => {
  const grid = gridFromManifest({ numBlocks: 1000 });
  const st = fullState(grid, ROWS_JS);
  st.setHalfLife(10);
  const dec = new DecodedBlock();
  decodeBlock(encodeBlock(100, [[3e8, 100], [7e8, 100]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(100), st.totals);
  decodeBlock(encodeBlock(110, [[-3e8, 100], [1, 110]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(110), st.totals);
  decodeBlock(encodeBlock(120, [[-7e8, 100], [1, 120]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(120), st.totals);
  st.block = 120;
  const r3 = rowOfAmount(ROWS_JS, 3e8);
  const r7 = rowOfAmount(ROWS_JS, 7e8);
  const c3 = st.cellAt(0, 1, r3);
  assert.equal(c3.countSmall, 0);
  assert.equal(c3.heatBlock, 110);
  assert.ok(Math.abs(c3.heat - 3 * 0.5) < 1e-6, 'decayed one half-life: ' + c3.heat);
  const c7 = st.cellAt(0, 1, r7);
  assert.ok(Math.abs(c7.heat - 7) < 1e-6);
  // Same cell spent twice at different blocks accumulates with decay (coarse level shares cells).
  const top = st.cellAt(6, 0, r3 >> 4);
  assert.ok(top.heat > 0);
  st.clearHeat();
  assert.equal(st.cellAt(0, 1, r7).heat, 0);
  // Fractional half-lives (settings allow >= 0.5 blocks) decay per block gap exactly.
  st.setHalfLife(0.5);
  assert.equal(st.decay[1], 0.25);
  assert.equal(st.decay[3], 2 ** -6);
  decodeBlock(encodeBlock(130, [[-1e8, 100], [1, 130]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(130), st.totals);
  st.block = 131;
  const c1 = st.cellAt(0, 1, rowOfAmount(ROWS_JS, 1e8));
  assert.equal(c1.heatBlock, 130);
  assert.ok(Math.abs(c1.heat - 0.25) < 1e-7, 'one block at H = 0.5 quarters the heat: ' + c1.heat);
});

test('packed heat is the raw BTC sum at every level (not divided by cell area)', () => {
  const grid = gridFromManifest({ numBlocks: 1000 });
  const st = fullState(grid, ROWS_JS);
  st.setHalfLife(10);
  const dec = new DecodedBlock();
  decodeBlock(encodeBlock(100, [[3e8, 100]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(100), st.totals);
  decodeBlock(encodeBlock(101, [[-3e8, 100], [1, 101]]), 0, dec);
  st.apply(dec, 1, st.slotOf, st.heatFor(101), st.totals);
  st.block = 101;
  const r3 = rowOfAmount(ROWS_JS, 3e8);
  const top = grid.tiles - 1;
  const out = packFull(st.slotOf, st.slotOf[top], measureCode('density'), measureCode('density'));
  const o = (((r3 >> 4) + 1) * 258 + 1) * 4;
  assert.ok(Math.abs(out[o + 1] - 3) < 1e-6, 'coarse heat is the raw 3 BTC sum: ' + out[o + 1]);
  assert.equal(out[o + 2], 101);
  const info = tileInfo(grid, top);
  assert.ok(info.level === 6, 'top tile is level 6');
});

// ------------------------------------------------------------ pack/deltas
function applyFrameToMirror(mirror, frame) {
  for (const id of frame.evicted) mirror.delete(id);
  for (const f of frame.full) mirror.set(f.id, f.empty ? new Float32Array(SLOT_CELLS * 4) : new Float32Array(f.data));
  const d = frame.deltas;
  for (let k = 0; k < d.ids.length; k++) {
    const m = mirror.get(d.ids[k]);
    assert.ok(m, 'delta for a tile the main thread does not hold: ' + d.ids[k]);
    for (let i = d.offsets[k]; i < d.offsets[k + 1]; i++) m.set(d.data.subarray(i * 4, i * 4 + 4), d.index[i] * 4);
  }
}

function checkMirror(st, mirror, hm, cm, where) {
  for (let id = 0; id < st.slotOf.length; id++) {
    if (st.delivered[id]) assert.ok(mirror.has(id), where + ': delivered tile ' + id + ' missing on the main thread');
  }
  for (const [id, m] of mirror) {
    assert.ok(st.delivered[id] && st.slotOf[id] !== null, where + ': main thread holds tile ' + id + ' that is not delivered');
    const want = packFull(st.slotOf, st.slotOf[id], hm, cm) || new Float32Array(SLOT_CELLS * 4);
    for (let i = 0; i < want.length; i++) {
      if (m[i] !== want[i]) assert.fail(where + ': tile ' + id + ' slot cell ' + (i >> 2) + ' (' + ((i >> 2) % 258) + ',' + Math.floor((i >> 2) / 258) + ') field ' + (i & 3) + ' mirror ' + m[i] + ' fresh ' + want[i]);
    }
  }
}

test('frames: full tiles plus deltas keep a main-thread mirror identical to fresh packs', () => {
  const blocks = syntheticChain({ numBlocks: 20000, seed: 7, maxCreate: 9 });
  const grid = gridFromManifest({ numBlocks: blocks.length });
  const recs = blocks.map((b) => encodeBlock(b.height, b.changes));
  const st = new LandscapeState(grid, ROWS_JS);
  st.setHalfLife(40);
  const ref = new ReferenceState(grid, ROWS_JS);
  const fb = new FrameBuilder(grid);
  const dec = new DecodedBlock();
  const mirror = new Map();
  const r = rng(99);
  let hm = measureCode('density');
  let cm = measureCode('value');
  st.block = -1;
  const setDesired = (ids) => {
    const want = new Uint8Array(grid.tiles);
    for (const id of ids) want[id] = 1;
    for (let id = 0; id < grid.tiles; id++) {
      st.desired[id] = want[id];
      if (!want[id] && st.delivered[id]) { st.delivered[id] = 0; st.evicted.push(id); }
      if (want[id] && st.slotOf[id] !== null && !st.delivered[id]) st.wantFull[id] = 1;
    }
  };
  const loadSlot = (id) => {
    const s = st.newSlot(id);
    const t = ref.tiles().get(id);
    if (t) s.cells.set(t);
    st.attach(s);
  };
  let frames = 0;
  let deltaFrames = 0;
  for (let h = 0; h < blocks.length; h++) {
    decodeBlock(recs[h], 0, dec);
    st.apply(dec, 1, st.slotOf, st.heatFor(h), st.totals);
    ref.applyBlock(blocks[h].changes, 1);
    st.block = h;
    if (h % 997 === 5) {
      // Residency change: drop some, add some, keep some warm (resident, not desired).
      const ids = [];
      for (let id = 0; id < grid.tiles; id++) if (r() < 0.55) ids.push(id);
      for (const id of st.residentIds()) if (r() < 0.3 && !ids.includes(id)) st.detach(id);
      for (const id of ids) if (st.slotOf[id] === null) loadSlot(id);
      for (let id = 0; id < grid.tiles; id++) if (st.slotOf[id] === null && r() < 0.2) loadSlot(id);
      setDesired(ids);
    }
    if (h % 3001 === 2000) st.clearHeat();
    if (h % 4999 === 4000) { hm = (hm + 1) % 3; cm = (cm + 2) % 3; for (let id = 0; id < grid.tiles; id++) if (st.delivered[id]) st.wantFull[id] = 1; }
    if (h % 7 === 0 || h === blocks.length - 1) {
      const { frame, deltaCells } = fb.build(st, hm, cm, 'advance', h);
      applyFrameToMirror(mirror, frame);
      frames++;
      if (deltaCells) deltaFrames++;
      if (h % 140 === 0 || h > blocks.length - 3) checkMirror(st, mirror, hm, cm, 'block ' + h);
    }
  }
  assert.ok(frames > 2000 && deltaFrames > 1000, frames + ' frames, ' + deltaFrames + ' with deltas');
});

test('pack: borders copy resident neighbours, else the nearest interior cell; outside grid is 0', () => {
  const grid = gridFromManifest({ numBlocks: 966828 });
  const st = new LandscapeState(grid, ROWS_JS);
  const a = st.newSlot(0);
  const b = st.newSlot(1);
  // a: cell (255, 10) and (0, 0); b: cell (0, 10).
  a.cells[((10 << 8) | 255) << 2] = 5;
  a.cells[0] = 7;
  b.cells[(10 << 8) << 2] = 9;
  st.attach(a);
  let p = packFull(st.slotOf, a, 1, 1);
  assert.equal(p[((11 * 258) + 257) * 4], 5, 'right border copies own edge while neighbour absent');
  assert.equal(p[((11 * 258) + 256) * 4], 5);
  assert.equal(p[0], 0, 'corner outside the grid (tile 0 has no upper-left neighbour)');
  assert.equal(p[(1 * 258 + 0) * 4], 0, 'left border outside the grid');
  st.attach(b);
  p = packFull(st.slotOf, a, 1, 1);
  assert.equal(p[((11 * 258) + 257) * 4], 9, 'right border holds neighbour cell');
  const pb = packFull(st.slotOf, b, 1, 1);
  assert.equal(pb[((11 * 258) + 0) * 4], 5, 'neighbour left border holds our edge');
  // Area normalisation: L6 cell of the last column covers (15107 - 236*64) * 16 L0 cells.
  const top = st.newSlot(757);
  top.cells[((5 << 8) | 236) << 2] = 300;
  st.attach(top);
  const pt = packFull(st.slotOf, top, 1, 1);
  assert.equal(pt[((6 * 258) + 237) * 4], 300 / ((15107 - 236 * 64) * 16));
  assert.equal(pt[((6 * 258) + 238) * 4], 0, 'cells beyond the last column are outside the grid');
});

// --------------------------------------------------------------- planner
test('seek planner picks the cheapest of current, snapshot below and snapshot above', () => {
  const snaps = [0, 1000, 2000, 3000].map((b) => ({ block: b, blkEnd: (b + 1) * 1000 }));
  const blkStart = (b) => b * 1000;
  const base = { snapshots: snaps, blkStart, applyBytesPerMs: 1000, decodeBytesPerMs: 10000, loadMsPerTile: 1, tilesToLoad: 10 };
  assert.equal(snapshotAtOrBelow([0, 1000, 2000], 999), 0);
  assert.equal(snapshotAtOrBelow([0, 1000, 2000], 1000), 1);
  assert.equal(snapshotAtOrBelow([5], 3), -1);
  assert.equal(planSeek({ ...base, target: 1100, current: null }).kind, 'below');
  assert.equal(planSeek({ ...base, target: 1900, current: null }).kind, 'above');
  assert.equal(planSeek({ ...base, target: 1500, current: 1495, missingTiles: 0 }).kind, 'current');
  assert.equal(planSeek({ ...base, target: 1500, current: 1505, missingTiles: 0 }).kind, 'current');
  assert.equal(planSeek({ ...base, target: 2950, current: 500 }).kind, 'above');
  const p = planSeek({ ...base, target: 3000, current: null });
  assert.equal(p.kind, 'below');
  assert.equal(p.from, 3000);
  assert.equal(p.bytes, 0);
});

// -------------------------------------------- independent check of a C++ build
// LANDSCAPE_DATA=dir limits the check to one dataset; otherwise every built dataset found.
const DATASETS = (process.env.LANDSCAPE_DATA ? [process.env.LANDSCAPE_DATA] : ['/tmp/landscape_dev_small', '/tmp/landscape_dev', '/Volumes/4T Data/buv_render/landscape_966827', '/Volumes/4T Data/buv_render/landscape_970658'])
  .filter((d) => existsSync(d + '/manifest.json'));
// Default: first, last and a few evenly spaced pairs per dataset; LANDSCAPE_CHECK_PAIRS=all for every pair.
const PAIR_LIMIT = process.env.LANDSCAPE_CHECK_PAIRS === 'all' ? Infinity : Number(process.env.LANDSCAPE_CHECK_PAIRS || 4);

async function readTiles(src, snap, ids, grid) {
  const prefix = await src.bytes(snap.file, 0, Math.min(snapshotPrefixBytes(grid.tiles), snap.bytes));
  const { header, dir } = readSnapshotDirectory(prefix, grid, snap.block, snap.bytes);
  const out = new Map();
  for (const id of ids) {
    const slot = new TileSlot(grid, id);
    if (dir.bytes[id] > 0) {
      const buf = await src.bytes(snap.file, dir.offset[id], dir.offset[id] + dir.bytes[id]);
      assert.equal(crc32(buf), dir.crc[id], snap.file + ' tile ' + id + ' crc');
      decodeTileBlob(buf, 0, buf.length, slot.cells);
    }
    out.set(id, slot);
  }
  return { header, dir, slots: out };
}

for (const dir of DATASETS) {
  test('dataset ' + dir + ': snapshot k + exact replay == snapshot k+1 (and backward)', { timeout: 3600000 }, async (t) => {
    const src = fileSource(dir);
    const manifest = await src.json('manifest.json');
    const grid = gridFromManifest(manifest);
    const rows = parseRowsBin(await src.bytes('rows.bin'), grid.rows);
    const chunks = new ChunkStore(src, await src.json('chunks.json'), grid.numBlocks, { cacheBytes: 1 << 30, verify: true });
    const snaps = manifest.snapshots;
    const pairs = [];
    for (let k = 0; k + 1 < snaps.length; k++) pairs.push(k);
    // Always include the first and last pairs; sample the rest evenly.
    let chosen = pairs;
    if (pairs.length > PAIR_LIMIT) {
      chosen = [pairs[0], pairs[pairs.length - 1]];
      const step = (pairs.length - 1) / Math.max(1, PAIR_LIMIT - 1);
      for (let i = 1; i < PAIR_LIMIT - 1; i++) chosen.push(pairs[Math.round(i * step)]);
      chosen = [...new Set(chosen)].sort((a, b) => a - b);
    }
    const st = new LandscapeState(grid, rows);
    const dec = new DecodedBlock();
    let tilesChecked = 0;
    let blocksReplayed = 0;
    for (const k of chosen) {
      const A = snaps[k];
      const B = snaps[k + 1];
      const pa = await src.bytes(A.file, 0, Math.min(snapshotPrefixBytes(grid.tiles), A.bytes));
      const pb = await src.bytes(B.file, 0, Math.min(snapshotPrefixBytes(grid.tiles), B.bytes));
      const { header: ha, dir: da } = readSnapshotDirectory(pa, grid, A.block, A.bytes);
      const { header: hb, dir: db } = readSnapshotDirectory(pb, grid, B.block, B.bytes);
      assert.equal(ha.blkEnd, A.blkEnd);
      assert.equal(hb.blkEnd, B.blkEnd);
      const ids = [];
      for (let id = 0; id < grid.tiles; id++) if (da.bytes[id] > 0 || db.bytes[id] > 0) ids.push(id);
      for (let i = 0; i < ids.length; i += 96) {
        const batch = ids.slice(i, i + 96);
        const fromA = await readTiles(src, A, batch, grid);
        const fromB = await readTiles(src, B, batch, grid);
        // Forward A -> B on A's tiles; totals only once per pair.
        const slotOf = new Array(grid.tiles).fill(null);
        for (const [id, s] of fromA.slots) slotOf[id] = s;
        const totals = i === 0 ? Float64Array.from([ha.totals.countSmall, ha.totals.satsSmall, ha.totals.countLarge, ha.totals.satsLarge]) : null;
        for (let b = A.block + 1; b <= B.block; b++) {
          if (!chunks.hasBlock(b)) await chunks.loadBlock(b);
          const rec = chunks.record(b);
          decodeBlock(rec.u8, rec.pos, dec);
          st.apply(dec, 1, slotOf, null, totals);
          if (i === 0) blocksReplayed++;
        }
        if (totals) assert.deepEqual(Array.from(totals), [hb.totals.countSmall, hb.totals.satsSmall, hb.totals.countLarge, hb.totals.satsLarge], 'totals ' + A.block + '->' + B.block);
        for (const id of batch) {
          const x = fromA.slots.get(id).cells;
          const y = fromB.slots.get(id).cells;
          for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) assert.fail('forward ' + A.block + '->' + B.block + ' tile ' + id + ' cell ' + (j >> 2) + ' field ' + (j & 3) + ': ' + x[j] + ' vs ' + y[j]);
        }
        // Backward B -> A on B's tiles.
        const back = new Array(grid.tiles).fill(null);
        for (const [id, s] of fromB.slots) back[id] = s;
        for (let b = B.block; b > A.block; b--) {
          if (!chunks.hasBlock(b)) await chunks.loadBlock(b);
          const rec = chunks.record(b);
          decodeBlock(rec.u8, rec.pos, dec);
          st.apply(dec, -1, back, null, null);
        }
        const again = await readTiles(src, A, batch, grid);
        for (const id of batch) {
          const x = fromB.slots.get(id).cells;
          const y = again.slots.get(id).cells;
          for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) assert.fail('backward ' + B.block + '->' + A.block + ' tile ' + id + ' cell ' + (j >> 2) + ': ' + x[j] + ' vs ' + y[j]);
        }
        tilesChecked += batch.length;
      }
    }
    t.diagnostic(dir + ': ' + chosen.length + ' of ' + pairs.length + ' snapshot pairs, ' + tilesChecked + ' tile checks, ' + blocksReplayed + ' blocks replayed both ways');
  });
}
