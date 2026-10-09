// Tests for landscape/web/data/grid.js and axis.js (owner: js_replay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as G from '../web/data/grid.js';
import * as A from '../web/data/axis.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const mapping = await import(new URL('cloudflare/utxo-video-worker/src/mapping.js', 'file://' + ROOT).href);
const NUM_BLOCKS = 966828;
const grid = G.gridFromManifest({ numBlocks: NUM_BLOCKS });

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('grid table equals SPEC section 2', () => {
  const want = [
    [0, 15107, 2072, 60, 9, 0], [1, 7554, 1036, 30, 5, 540], [2, 3777, 518, 15, 3, 690],
    [3, 1889, 259, 8, 2, 735], [4, 945, 130, 4, 1, 751], [5, 473, 130, 2, 1, 755], [6, 237, 130, 1, 1, 757],
  ];
  assert.equal(grid.l0Columns, 15107);
  assert.equal(grid.tiles, 758);
  assert.equal(grid.tip, 966827);
  assert.equal(grid.levels.length, 7);
  for (const [l, cols, rows, tx, ty, first] of want) {
    const L = grid.levels[l];
    assert.deepEqual([L.level, L.columns, L.rows, L.tilesX, L.tilesY, L.firstTile], [l, cols, rows, tx, ty, first]);
    assert.equal(L.columnShift, l);
    assert.equal(L.rowShift, Math.min(l, 4));
  }
});

test('gridFromManifest checks manifest values', () => {
  const ok = G.gridFromManifest({ numBlocks: NUM_BLOCKS, tip: NUM_BLOCKS - 1, grid: {
    blocksPerColumn: 64, rows: 2072, l0Columns: 15107, tileSize: 256, border: 1, tiles: 758,
    levels: grid.levels.map((L) => ({ ...L })) } });
  assert.deepEqual(ok, grid);
  assert.throws(() => G.gridFromManifest({ numBlocks: NUM_BLOCKS, grid: { tiles: 757 } }), /tiles 757/);
  assert.throws(() => G.gridFromManifest({ numBlocks: NUM_BLOCKS, grid: { levels: [{ level: 0, firstTile: 1 }] } }), /levels.length|firstTile/);
  assert.throws(() => G.gridFromManifest({ numBlocks: NUM_BLOCKS, tip: 5 }), /tip/);
  assert.throws(() => G.gridFromManifest({}), TypeError);
  const small = G.gridFromManifest({ numBlocks: 1000 });
  assert.equal(small.l0Columns, 16);
  // 1 x 9 + 1 x 5 + 1 x 3 + 1 x 2 + 1 + 1 + 1 tiles: the row axis is always 2072 rows.
  assert.equal(small.tiles, 22);
});

test('tile ids, info, cells and neighbours are consistent', () => {
  let seen = 0;
  for (const L of grid.levels) {
    for (let ty = 0; ty < L.tilesY; ty++) {
      for (let tx = 0; tx < L.tilesX; tx++) {
        const id = G.tileId(grid, L.level, tx, ty);
        assert.equal(id, seen++);
        const t = G.tileInfo(grid, id);
        assert.deepEqual([t.level, t.tx, t.ty, t.col0, t.row0], [L.level, tx, ty, tx * 256, ty * 256]);
        assert.ok(t.cols >= 1 && t.cols <= 256 && t.rows >= 1 && t.rows <= 256);
        assert.equal(G.tileOfCell(grid, L.level, t.col0, t.row0), id);
        assert.equal(G.tileOfCell(grid, L.level, t.col0 + t.cols - 1, t.row0 + t.rows - 1), id);
        assert.equal(G.levelOfTile(grid, id), L.level);
        assert.equal(G.neighborTile(grid, id, 0, 0), id);
        assert.equal(G.neighborTile(grid, id, 1, 0), tx + 1 < L.tilesX ? id + 1 : -1);
        assert.equal(G.neighborTile(grid, id, 0, -1), ty > 0 ? id - L.tilesX : -1);
      }
    }
  }
  assert.equal(seen, 758);
  assert.equal(G.tileInfo(grid, 758), null);
  assert.equal(G.tileInfo(grid, -1), null);
  assert.equal(G.tileId(grid, 0, 60, 0), -1);
  assert.equal(G.tileOfCell(grid, 0, 15107, 0), -1);
  assert.equal(G.tileOfCell(grid, 0, 0, 2072), -1);
  const last = G.tileInfo(grid, 539);
  assert.deepEqual([last.cols, last.rows], [15107 - 59 * 256, 2072 - 8 * 256]);
  assert.deepEqual(G.tileInfo(grid, 757), { id: 757, level: 6, tx: 0, ty: 0, col0: 0, row0: 0, cols: 237, rows: 130 });
});

test('parent and child tiles cover each other exactly', () => {
  for (let id = 0; id < grid.tiles; id++) {
    const t = G.tileInfo(grid, id);
    const kids = G.childTiles(grid, id);
    if (t.level === 0) { assert.deepEqual(kids, []); continue; }
    const C = grid.levels[t.level - 1];
    const L = grid.levels[t.level];
    // Every child cell maps into this tile, and every cell of this tile has a child cell.
    let covered = 0;
    for (const k of kids) {
      assert.equal(G.parentTile(grid, k), id);
      const c = G.tileInfo(grid, k);
      assert.equal(c.level, t.level - 1);
      for (const [cc, rr] of [[c.col0, c.row0], [c.col0 + c.cols - 1, c.row0 + c.rows - 1]]) {
        const pc = cc >> (L.columnShift - C.columnShift);
        const pr = rr >> (L.rowShift - C.rowShift);
        assert.equal(G.tileOfCell(grid, t.level, pc, pr), id);
      }
      covered += c.cols * c.rows;
    }
    const factor = 2 * (C.rowShift < L.rowShift ? 2 : 1);
    // Child cells per parent cell is factor, except along the grid's right/bottom edges.
    assert.ok(covered <= t.cols * t.rows * factor && covered > (t.cols * t.rows * factor) / 4, 'tile ' + id);
  }
  assert.equal(G.parentTile(grid, 757), null);
  // All L5 tiles share the L6 parent.
  assert.equal(G.parentTile(grid, 755), 757);
  assert.equal(G.parentTile(grid, 756), 757);
  assert.deepEqual(G.childTiles(grid, 757), [755, 756]);
  assert.deepEqual(G.childTiles(grid, 751), [735, 736, 743, 744]);
});

test('cell areas sum to the L0 grid at every level', () => {
  const total = grid.l0Columns * grid.rows;
  for (const L of grid.levels) {
    let sum = 0;
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.columns; c++) sum += G.cellArea(grid, L.level, c, r);
    assert.equal(sum, total, 'level ' + L.level);
    assert.equal(G.cellArea(grid, L.level, L.columns, 0), 0);
  }
  assert.equal(G.cellArea(grid, 6, 236, 129), (15107 - 236 * 64) * (2072 - 129 * 16));
  assert.equal(G.cellArea(grid, 3, 5, 5), 64);
  assert.deepEqual(G.cellOfL0(grid, 6, 15106, 2071), { col: 236, row: 129 });
  assert.deepEqual(G.cellOfL0(grid, 2, 7, 7), { col: 1, row: 1 });
});

test('columns, blocks and world coordinates', () => {
  assert.deepEqual(G.columnBlocks(grid, 0), [0, 63]);
  assert.deepEqual(G.columnBlocks(grid, 15106), [966784, 966827]);
  assert.equal(G.columnOfBlock(grid, 966827), 15106);
  assert.equal(G.worldX(966848), 966.848);
  assert.equal(G.worldZ(2072), 207.2);
  assert.equal(Math.floor(G.blockFromWorldX(G.worldX(314000))), 314000);
  assert.equal(Math.floor(G.rowFromWorldZ(G.worldZ(1515)) + 1e-9), 1515);
});

const table = A.buildMinAmtTable();

test('film row estimate equals mapping.js satoshiToY', () => {
  const next = rng(7);
  const amounts = [1, 2, 99, 100, 101, 545, 546, 547, 9999, 10000, 1e8, 5e8, 5e8 + 1, 1e9, 1e9 - 1, 5e9, 1e12 - 1, 1e12, 1e12 + 1, 1e13 - 1, 1e13, 2.1e15];
  for (let i = 0; i < 20000; i++) amounts.push(Math.max(1, Math.floor(Math.exp(next() * Math.log(2.1e15)))));
  for (const a of amounts) {
    assert.equal(A.filmRowEstimate(a), mapping.satoshiToY(a) - 10, 'amount ' + a);
    assert.equal(A.filmRowEstimate(-a), mapping.satoshiToY(a) - 10);
  }
  assert.equal(A.filmRowEstimate(1), 2071);
  assert.equal(A.filmRowEstimate(1e13), 0);
  assert.throws(() => A.filmRowEstimate(5, { ...A.FILM_AXIS, compressTopSatoshi: false }));
});

test('minAmt table: rowOfAmount equals the film formula at every boundary', () => {
  assert.equal(table.length, 2072);
  assert.equal(table[2071], 1);
  for (let r = 1; r < 2072; r++) assert.ok(table[r] <= table[r - 1]);
  for (let r = 0; r < 2072; r++) {
    for (const a of [table[r] - 1, table[r], table[r] + 1]) {
      if (a < 1) continue;
      assert.equal(A.rowOfAmount(table, a), A.filmRowEstimate(a), 'row ' + r + ' amount ' + a);
    }
  }
  const next = rng(11);
  for (let i = 0; i < 20000; i++) {
    const a = Math.max(1, Math.floor(Math.exp(next() * Math.log(2.1e15))));
    assert.equal(A.rowOfAmount(table, a), A.filmRowEstimate(a));
    assert.equal(A.rowOfAmount(table, -a), A.filmRowEstimate(a));
  }
  assert.equal(A.rowOfAmount(table, 0), 2071);
  assert.equal(A.rowOfAmount(table, 2.1e15), 0);
});

test('rowAmountRange equals mapping.js rowSatoshiRange for every row', () => {
  let empty = 0;
  for (let r = 0; r < 2072; r++) {
    const mine = A.rowAmountRange(table, r);
    const theirs = mapping.rowSatoshiRange(r + 10);
    if (theirs === null) { assert.equal(mine, null, 'row ' + r); empty++; continue; }
    assert.ok(mine, 'row ' + r);
    assert.equal(mine.min, theirs[0], 'row ' + r);
    if (r === 0) assert.equal(mine.max, Infinity);
    else assert.equal(mine.max, theirs[1], 'row ' + r);
  }
  assert.ok(empty > 0, 'the film axis has empty low rows');
  assert.equal(A.rowAmountRange(table, 2072), null);
  assert.equal(A.rowAmountRange(table, 1.5), null);
});

test('parseRowsBin round trip and validation', () => {
  const bytes = new Uint8Array(table.length * 8);
  const dv = new DataView(bytes.buffer);
  table.forEach((v, i) => dv.setFloat64(i * 8, v, true));
  assert.deepEqual(A.parseRowsBin(bytes.buffer, 2072), table);
  assert.throws(() => A.parseRowsBin(bytes.buffer, 2071));
  dv.setFloat64(8 * 100, 1e15, true);
  assert.throws(() => A.parseRowsBin(bytes.buffer), /non-increasing/);
});

test('blockToX equals mapping.js on many heights and blocks', () => {
  const next = rng(3);
  const blocks = [0, 1, 119, 120, 104999, 105000, 105001, 105119, 105120, 210000, 314000, 630000, 840000, 840119, 945000, 966827];
  for (let e = 1; e <= 9; e++) for (const o of [0, 1, 59, 118, 119, 120]) blocks.push(e * 105000 + o);
  for (let i = 0; i < 300; i++) blocks.push(Math.floor(next() * 966828));
  let checks = 0;
  for (const b of blocks) {
    const heights = [0, b, Math.max(0, b - 1), Math.floor(b / 2), 104999, 105000];
    for (let i = 0; i < 40; i++) heights.push(Math.floor(next() * (b + 1)));
    for (const h of heights) {
      assert.equal(A.blockToX(h, b), mapping.blockToX(h, b), 'height ' + h + ' block ' + b);
      checks++;
    }
  }
  assert.ok(checks > 10000);
  assert.equal(A.rowToImageY(1515), 1525);
});

const DATASETS = (process.env.LANDSCAPE_DATA ? [process.env.LANDSCAPE_DATA] : ['/tmp/landscape_dev_small', '/tmp/landscape_dev', '/Volumes/4T Data/buv_render/landscape_966827'])
  .filter((d) => existsSync(d + '/rows.bin') && existsSync(d + '/manifest.json'));

// The C++ tools build with -ffast-math. Their row boundaries equal the strict IEEE port
// except one amount: 779,521,282,186 sat is row 49 in C++ and row 50 in JS/IEEE, so
// rows.bin has minAmt[49] one satoshi lower than the JS table. rows.bin is authoritative.
const KNOWN_CPP_BOUNDARY = { row: 49, cpp: 779521282186, ieee: 779521282187 };

test('JS film table has the known IEEE boundary at row 49', () => {
  assert.equal(table[KNOWN_CPP_BOUNDARY.row], KNOWN_CPP_BOUNDARY.ieee);
});

test('rows.bin of built datasets equals the JS film table except the known C++ boundary', { skip: DATASETS.length === 0 && 'no built dataset yet' }, () => {
  for (const dir of DATASETS) {
    const rows = A.parseRowsBin(readFileSync(dir + '/rows.bin'), 2072);
    const manifest = JSON.parse(readFileSync(dir + '/manifest.json', 'utf8'));
    G.gridFromManifest(manifest);
    const diff = [];
    for (let r = 0; r < 2072; r++) {
      if (rows[r] === table[r]) continue;
      if (r === KNOWN_CPP_BOUNDARY.row && rows[r] === KNOWN_CPP_BOUNDARY.cpp) continue;
      diff.push([r, rows[r], table[r]]);
    }
    assert.deepEqual(diff, [], dir + ': rows.bin differs from the JS film table beyond the known boundary');
    assert.equal(A.rowOfAmount(rows, KNOWN_CPP_BOUNDARY.cpp), rows[49] === KNOWN_CPP_BOUNDARY.cpp ? 49 : 50);
  }
});
