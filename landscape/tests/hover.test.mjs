// Hover readout (landscape/web/ui/hover.js): the ranges a cell covers at any level, and the
// card's text. The DOM part is checked in shell-browser-checks.mjs (check "hover").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellSpan, amountText, cardAmount, blocksText, liveText } from '../web/ui/hover.js';
import { gridFromManifest } from '../web/data/grid.js';
import { buildMinAmtTable, rowAmountRange } from '../web/data/axis.js';

const grid = gridFromManifest({ numBlocks: 966828 });
const rows = buildMinAmtTable();

test('an L0 cell covers one 64-block column and one row', () => {
  const s = cellSpan(grid, rows, 0, 100, 500);
  assert.deepEqual([s.first, s.last, s.columns, s.rows, s.rowMin, s.rowMax], [6400, 6463, 1, 1, 500, 500]);
  assert.deepEqual(s.amount, rowAmountRange(rows, 500));
  const end = cellSpan(grid, rows, 0, grid.l0Columns - 1, 500);
  assert.equal(end.last, grid.numBlocks - 1, 'the last column stops at the tip');
  assert.equal(cellSpan(grid, rows, 0, grid.l0Columns, 500), null);
  assert.equal(cellSpan(grid, rows, 0, 0, grid.rows), null);
});

test('a merged cell covers its columns and rows, clipped at the tip', () => {
  const s = cellSpan(grid, rows, 3, 10, 20); // 8 columns x 8 rows
  assert.deepEqual([s.columns, s.rows, s.first, s.last, s.rowMin, s.rowMax], [8, 8, 80 * 64, 88 * 64 - 1, 160, 167]);
  assert.equal(s.amount.min, rowAmountRange(rows, 167).min, 'smallest amount from the last row');
  assert.equal(s.amount.max, rowAmountRange(rows, 160).max, 'largest amount from the first row');
  const L6 = grid.levels[6];
  const tail = cellSpan(grid, rows, 6, L6.columns - 1, L6.rows - 1); // 64 columns x 16 rows, both clipped
  assert.equal(tail.last, grid.numBlocks - 1);
  assert.equal(tail.columns, grid.l0Columns - (L6.columns - 1) * 64);
  assert.equal(tail.rowMax, grid.rows - 1);
  assert.equal(tail.amount.min, 1);
});

test('rows without a whole amount are skipped at the ends of a merged cell', () => {
  let empty = -1;
  for (let r = grid.rows - 1; r > 0 && empty < 0; r--) if (!rowAmountRange(rows, r) && rowAmountRange(rows, r - 1)) empty = r;
  assert.ok(empty > 0, 'the low-amount zone has rows no integer maps to');
  assert.equal(cellSpan(grid, rows, 0, 0, empty).amount, null);
  assert.equal(amountText(null), 'No whole amount');
  const level = 4; // 16 rows per cell
  const s = cellSpan(grid, rows, level, 0, Math.floor(empty / 16));
  assert.ok(s.amount && s.amount.min >= 1 && s.amount.max >= s.amount.min);
});

test('amounts print with one shared unit; BTC bands round outward; row 0 is open at the top', () => {
  assert.equal(amountText({ min: 1000000, max: 1011500 }), '0.01\u20130.01012 BTC');
  assert.equal(amountText({ min: 14697344043, max: 17776813163 }), '146.9\u2013177.8 BTC');
  assert.equal(amountText({ min: 100000000, max: 101158624 }), '1\u20131.012 BTC');
  assert.equal(amountText({ min: 546, max: 600 }), '546\u2013600 sat');
  assert.equal(amountText({ min: 123456, max: 125012 }), '123,456\u2013125,012 sat');
  assert.equal(amountText({ min: 999000, max: 1000500 }), '0.00999\u20130.01001 BTC', 'a band across 0.01 BTC uses one unit');
  assert.equal(amountText({ min: 988961, max: 1000999 }), '0.009889\u20130.01001 BTC');
  assert.equal(amountText({ min: 1, max: 1 }), '1 sat');
  assert.equal(cardAmount(1e12, -1), '10,000 BTC');
  assert.equal(cardAmount(1234567890123, -1), '12,345 BTC');
  // Every band shown contains the exact band, row by row.
  for (let r = 1; r < grid.rows; r++) {
    const a = rowAmountRange(rows, r);
    if (!a || a.min < 1e6) continue;
    const lo = Number(cardAmount(a.min, -1).replace(/[^\d.]/g, '')) * 1e8;
    const hi = Number(cardAmount(a.max, 1).replace(/[^\d.]/g, '')) * 1e8;
    assert.ok(lo <= a.min + 1e-3 && hi >= a.max - 1e-3, 'row ' + r + ': ' + lo + '\u2013' + hi + ' vs ' + a.min + '\u2013' + a.max);
  }
  const top = cellSpan(grid, rows, 0, 5, 0);
  assert.equal(top.amount.max, Infinity);
  assert.match(amountText(top.amount), /^\u2265 [\d,.]+ BTC$/);
});

test('block dates and the live line', () => {
  const blocktimes = new Float64Array(grid.numBlocks);
  for (let b = 0; b < blocktimes.length; b++) blocktimes[b] = 1231006505 + b * 600;
  const one = blocksText(cellSpan(grid, rows, 0, 100, 500), blocktimes);
  assert.equal(one.blocks, '6,400\u20136,463');
  assert.match(one.dates, /^\d{4}-\d{2}-\d{2}$/, 'a column within one day shows one date');
  const wide = blocksText(cellSpan(grid, rows, 4, 100, 30), blocktimes);
  assert.match(wide.dates, /^\d{4}-\d{2}-\d{2} \u2192 \d{4}-\d{2}-\d{2}$/);
  assert.equal(blocksText(cellSpan(grid, rows, 0, 1, 1), null).dates, '');

  const s = cellSpan(grid, rows, 0, 3000, 900); // blocks 192,000-192,063
  assert.equal(liveText(s, null, 100000), 'Not created yet at block 100,000');
  assert.equal(liveText(s, null, 200000), null, 'no count until the worker answers');
  assert.equal(liveText(s, null, null), null);
  const cell = { countSmall: 1200, countLarge: 34, satsSmall: 250000000, satsLarge: 1000000000, block: 200000 };
  assert.equal(liveText(s, cell, 200000), '1,234 UTXOs \u00b7 12.5 BTC');
  assert.equal(liveText(s, { countSmall: 1, countLarge: 0, satsSmall: 546, satsLarge: 0 }, 200000), '1 UTXO \u00b7 546 sat');
  assert.equal(liveText(s, { countSmall: 0, countLarge: 0, satsSmall: 0, satsLarge: 0, block: 200000 }, 200000), 'None at block 200,000');
});
