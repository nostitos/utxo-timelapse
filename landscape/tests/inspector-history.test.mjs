import { test } from 'node:test';
import assert from 'node:assert/strict';
import { populationTimeline, survivalTimeline } from '../web/ui/inspector-history.js';

const history = (overrides = {}) => ({
  count: 3, stillUnspent: 1, cutoffBlock: 130, truncated: false,
  utxos: [
    { created: 80, spent: null },
    { created: 90, spent: 110 },
    { created: 100, spent: 110 },
  ],
  ...overrides,
});

test('survival uses exact spend heights and groups simultaneous spends', () => {
  assert.deepEqual(survivalTimeline(history(), 100), [[100, 3], [110, 3], [110, 1], [130, 1]]);
});

test('zero outputs, unchanged counts and selection at cutoff are valid', () => {
  assert.deepEqual(survivalTimeline(history({ count: 0, stillUnspent: 0, utxos: [] }), 100), [[100, 0], [130, 0]]);
  assert.deepEqual(survivalTimeline(history({ count: 1, utxos: [{ created: 80, spent: null }] }), 130), [[130, 1], [130, 1]]);
});

test('incomplete lists and mismatched aggregates never produce an exact chart', () => {
  assert.equal(survivalTimeline(history({ truncated: true }), 100), null);
  assert.equal(survivalTimeline(history({ count: 4 }), 100), null);
  assert.equal(survivalTimeline(history({ stillUnspent: 2 }), 100), null);
});

test('missing cutoff and out-of-range lifecycle records are rejected', () => {
  assert.equal(survivalTimeline(history({ cutoffBlock: undefined }), 100), null);
  assert.equal(survivalTimeline(history(), 131), null);
  for (const u of [{ created: 101, spent: null }, { created: 90, spent: 100 }, { created: 90, spent: 140 }]) {
    assert.equal(survivalTimeline(history({ utxos: [u], count: 1 }), 100), null);
  }
});

// Regression: the user's 376,384–376,447 / 10,291–10,413 sat cell at block 950,048.
// Native history has 636 earlier spends; showing only 130 -> 129 loses its lifecycle.
const reportedCell = {
  blockRange: [376384, 376447], cutoffBlock: 972052, count: 130, stillUnspent: 129,
  pastCount: 636, pastTruncated: true, viewBin: 46,
  pop: [405,348,320,308,299,292,285,283,278,270,215,209,207,206,170,168,166,163,160,157,156,156,152,149,146,146,142,141,139,139,138,138,138,138,137,136,134,133,133,133,132,131,131,131,130,130,130,129],
};

test('primary history includes earlier spends and spans creation through cutoff', () => {
  const curve = populationTimeline(reportedCell, 950048);
  assert.equal(curve.start, 376384);
  assert.equal(curve.end, 972052);
  assert.equal(curve.selected, 950048);
  assert.deepEqual(curve.points[0], [388793, 405]);
  assert.deepEqual(curve.points.at(-1), [972052, 129]);
  assert.ok(curve.points[0][1] > reportedCell.count, 'history must not start with only the current survivors');
  assert.deepEqual(curve.points.map(p => p[1]), reportedCell.pop);
});

test('capped or absent record lists do not remove or change the lifetime curve', () => {
  const expected = populationTimeline(reportedCell, 950048);
  assert.deepEqual(populationTimeline({ ...reportedCell, truncated: true, utxos: [], pastUtxos: [] }, 950048), expected);
});

test('legacy responses keep population samples without inventing cutoff heights', () => {
  const curve = populationTimeline({ ...reportedCell, cutoffBlock: undefined }, 950048);
  assert.equal(curve.start, 0);
  assert.equal(curve.end, 47);
  assert.equal(curve.selected, 46);
  assert.deepEqual(curve.points.at(-1), [47, 129]);
});

test('empty, single-sample and invalid population histories are handled explicitly', () => {
  assert.equal(populationTimeline({ ...reportedCell, pop: [] }, 950048), null);
  assert.equal(populationTimeline({ ...reportedCell, pop: [NaN] }, 950048), null);
  assert.equal(populationTimeline({ ...reportedCell, pop: [-1] }, 950048), null);
  const zero = populationTimeline({ ...reportedCell, pop: [0] }, 950048);
  assert.deepEqual(zero.points, [[972052, 0]]);
});
