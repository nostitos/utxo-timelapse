#!/usr/bin/env node
// Measures each place of the Places menu (web/ui/places.js) in a landscape snapshot, so the
// descriptions can be checked against new data. For every place it prints the unspent outputs
// and BTC of its rows over all blocks and inside its blocks (column-aligned, 64 blocks a column),
// and the share created in the last 52,560 blocks (about a year). It also prints the subsidy
// row of every era, the evidence that only the first era left a line, and each round amount
// against the rows beside it. Reads level 0 of one snapshot; Node 20, no dependencies.
//
//   node landscape/tools/places-survey.mjs --data "/Volumes/4T Data/buv_render/landscape_972052" [--block N]
//
// --block picks a snapshot listed in manifest.json (default: the latest).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridFromManifest, tileInfo } from '../web/data/grid.js';
import { readSnapshotDirectory, decodeTileBlob } from '../web/data/snapshot.js';
import { parseRowsBin, rowOfAmount } from '../web/data/axis.js';
import { PLACES, regionRows } from '../web/ui/places.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const dir = opt('data');
if (!dir) {
  console.error('usage: node landscape/tools/places-survey.mjs --data DATASET_DIR [--block N]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const grid = gridFromManifest(manifest);
const want = opt('block') !== undefined ? Number(opt('block')) : manifest.tip;
const snap = manifest.snapshots.find((s) => s.block === want);
if (!snap) throw new Error('no snapshot at block ' + want + ' in manifest.json');
const rowsBytes = readFileSync(join(dir, manifest.files.rows || 'rows.bin'));
const minAmt = parseRowsBin(new Uint8Array(rowsBytes.buffer, rowsBytes.byteOffset, rowsBytes.byteLength), grid.rows);
const file = readFileSync(join(dir, snap.file));
const u8 = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
const { dir: tiles } = readSnapshotDirectory(u8, grid, want, u8.byteLength);

// Outputs and satoshis per level-0 cell, column-major per row: [row * columns + col].
const C = grid.l0Columns;
const count = new Float64Array(C * grid.rows);
const sats = new Float64Array(C * grid.rows);
const cells = new Float64Array(65536 * 4);
const L0 = grid.levels[0];
for (let id = L0.firstTile; id < L0.firstTile + L0.tilesX * L0.tilesY; id++) {
  if (!tiles.bytes[id]) continue;
  const t = tileInfo(grid, id);
  cells.fill(0);
  decodeTileBlob(u8, tiles.offset[id], tiles.offset[id] + tiles.bytes[id], cells);
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      const o = (r * grid.tileSize + c) * 4;
      const k = (t.row0 + r) * C + t.col0 + c;
      count[k] = cells[o] + cells[o + 2];
      sats[k] = cells[o + 1] + cells[o + 3];
    }
  }
}
const col = (b) => Math.min(C - 1, Math.floor(b / grid.blocksPerColumn));
function sum(rows, b0, b1) {
  let n = 0;
  let s = 0;
  for (const r of rows) for (let c = col(b0); c <= col(b1); c++) { n += count[r * C + c]; s += sats[r * C + c]; }
  return { n, s };
}
const allRows = Array.from({ length: grid.rows }, (_, r) => r);
const total = sum(allRows, 0, want);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0') + '%';
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const btc = (s) => fmt(s / 1e8) + ' BTC';
const year = Math.max(0, want - 52559);

console.log('Block ' + fmt(want) + ': ' + fmt(total.n) + ' unspent outputs, ' + btc(total.s));
for (const p of PLACES) {
  if (!p.region) continue;
  const span = regionRows(minAmt, p.region);
  const rows = span.rows || allRows.slice(span.rowMin, span.rowMax + 1);
  const [b0, b1raw] = p.region.blocks;
  const b1 = b1raw === 'tip' ? want : Math.min(b1raw, want);
  const all = sum(rows, 0, want);
  const inside = b0 <= want ? sum(rows, b0, b1) : { n: 0, s: 0 };
  const recent = sum(rows, year, want);
  console.log('\n' + p.name + ' (' + p.id + '): rows ' + (span.rows ? rows.join(', ') : span.rowMin + '-' + span.rowMax));
  console.log('  all blocks:   ' + fmt(all.n) + ' outputs (' + pct(all.n, total.n) + ' of all), ' + btc(all.s) + ' (' + pct(all.s, total.s) + ' of all)');
  console.log('  blocks ' + fmt(b0) + '-' + fmt(b1) + ': ' + fmt(inside.n) + ' outputs (' + pct(inside.n, all.n) + ' of the rows), ' + btc(inside.s) + ' (' + pct(inside.s, all.s) + ')');
  console.log('  last 52,560 blocks: ' + pct(recent.n, all.n) + ' of the outputs, ' + pct(recent.s, all.s) + ' of the BTC');
}

console.log('\nSubsidy rows, outputs still unspent from their own era (neighbour rows in brackets):');
for (let era = 0, reward = 50e8; era * 210000 <= want; era++, reward /= 2) {
  const r = rowOfAmount(minAmt, reward);
  const b0 = era * 210000;
  const b1 = Math.min(want, b0 + 209999);
  const n = (row) => fmt(sum([row], b0, b1).n);
  console.log('  ' + reward / 1e8 + ' BTC, blocks ' + fmt(b0) + '-' + fmt(b1) + ': ' + n(r) + ' (' + n(r - 1) + ', ' + n(r + 1) + ')');
}

console.log('\nRound amounts against the rows beside them (all blocks):');
for (const a of [1e8, 1e7, 1e6, 1e5]) {
  const r = rowOfAmount(minAmt, a);
  const n = (row) => sum([row], 0, want).n;
  const side = (n(r - 1) + n(r + 1)) / 2;
  console.log('  ' + a / 1e8 + ' BTC: ' + fmt(n(r)) + ' outputs, ' + (side ? (n(r) / side).toFixed(1) : '-') + 'x the mean of the rows beside it');
}
