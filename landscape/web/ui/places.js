// Places (landscape/SPEC.md §8): landmarks of the unspent set. Each is a spot on the field, a
// creation period and a row of amounts, that stands out in the data. Choosing one flies the
// camera there and keeps the block; a place newer than the block goes to the latest block first.
// The descriptions quote landscape/tools/places-survey.mjs at block 972,052 (18 October 2026).
// Halvings are not places: after the first era's 50 BTC row, no subsidy row stands out.
// Pure module: rows come from data/axis.js rowOfAmount on rows.bin.

import { rowOfAmount } from '../data/axis.js';

const BTC = 1e8;

/**
 * region: what the place covers, for the survey and the "newer than this block" test. blocks is
 * [first, last] ('tip' for the latest block); amounts lists exact amounts (one row each) or
 * gives {min} for every row from min up. view: the camera target, a block (or edge: blocks
 * relative to the current block) and an amount, and the camera's distance (world units) and yaw
 * and pitch (degrees) as in controls.poseLookingAt.
 */
export const PLACES = Object.freeze([
  Object.freeze({
    id: 'first-line', name: 'The first line', where: '50 BTC \u00b7 2009\u20132010',
    about: 'Block rewards of the first era nobody has spent, about 1.7 million BTC. No later halving left a line like it.',
    region: { blocks: [0, 209999], amounts: [50 * BTC] },
    view: { block: 40000, amount: 50 * BTC, distance: 55, yaw: 55, pitch: -16 },
  }),
  Object.freeze({
    id: 'flood-2015', name: 'The July 2015 flood', where: '1,000 sat \u00b7 9\u201313 July 2015',
    about: 'About 1.5 million outputs of 1,000 sat made in five days, still unspent: the tallest columns in the landscape.',
    region: { blocks: [364544, 365119], amounts: [1000] },
    view: { block: 364832, amount: 1000, distance: 26, yaw: 180, pitch: -10 },
  }),
  Object.freeze({
    id: 'round', name: 'Round amounts', where: '1 \u00b7 0.1 \u00b7 0.01 BTC',
    about: 'Four to ten times as many outputs hold these amounts as the rows beside them, so they draw lines across the years.',
    region: { blocks: [250000, 'tip'], amounts: [BTC, 0.1 * BTC, 0.01 * BTC] },
    view: { edge: -20000, amount: 0.1 * BTC, distance: 70, yaw: 0, pitch: -89 },
  }),
  Object.freeze({
    id: 'dust', name: 'The dust ridge', where: '546 \u00b7 330 \u00b7 294 sat',
    about: 'The smallest amounts standard outputs may hold. These three rows hold more than a third of all unspent outputs, most made since 2023.',
    region: { blocks: [769787, 'tip'], amounts: [546, 330, 294] },
    view: { block: 840000, amount: 546, distance: 50, yaw: 135, pitch: -28 },
  }),
  Object.freeze({
    id: 'towers', name: 'Towers at the edge', where: '100 BTC and more',
    about: 'Outputs of 100 BTC and more hold over half of all bitcoin, and almost half of that value was created in the last year.',
    region: { blocks: [0, 'tip'], amounts: { min: 100 * BTC } },
    view: { edge: -25000, amount: 300 * BTC, distance: 60, yaw: 25, pitch: -24 },
  }),
  Object.freeze({
    id: 'tip', name: 'The newest block', where: 'Latest block',
    about: 'The latest block in the opening view.',
    region: null, view: null,
  }),
]);

/** Inclusive graph-row range of a region's amounts (row 0 = largest amounts). */
export function regionRows(minAmt, region) {
  const a = region.amounts;
  if (Array.isArray(a)) {
    const rows = a.map((s) => rowOfAmount(minAmt, s));
    return { rowMin: Math.min(...rows), rowMax: Math.max(...rows), rows };
  }
  return { rowMin: 0, rowMax: rowOfAmount(minAmt, a.min), rows: null };
}

/** First block of a place's region (0 for the newest block, which is always there). */
export function placeFrom(place) {
  return place.region ? place.region.blocks[0] : 0;
}

/**
 * Resolve a place reference: a place id ('first-line', 'tip'), a block number (or numeric
 * string) or an object {block}. Returns {kind: 'place', id, name, where, about, from, tip,
 * view: {block, edge, row, distance, yaw, pitch} | null} | {kind: 'block', block, title} | null.
 * A block is not in the menu: links and the test hook use it to seek and fly to that creation
 * edge. Blocks beyond the dataset tip resolve to the tip.
 */
export function resolvePlace(place, { tip, minAmt }) {
  if (place == null) return null;
  if (typeof place === 'object') return place.block != null ? resolvePlace(place.block, { tip, minAmt }) : null;
  const key = String(place).trim();
  const p = PLACES.find((e) => e.id === key);
  if (p) {
    if (p.view && !minAmt) return null;
    const view = p.view ? { ...p.view, row: rowOfAmount(minAmt, p.view.amount) } : null;
    return { kind: 'place', id: p.id, name: p.name, where: p.where, about: p.about, from: placeFrom(p), tip: !p.view, view };
  }
  if (/^\d+$/.test(key)) {
    const b = Math.min(Number(key), tip);
    return { kind: 'block', block: b, title: 'Block ' + b.toLocaleString('en-US') };
  }
  return null;
}
