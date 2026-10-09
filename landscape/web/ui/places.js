// Places: eras (seek + fly to that creation column) and amount bands (fly to that row),
// landscape/SPEC.md §8. Pure module: rows come from data/axis.js rowOfAmount on rows.bin.

import { rowOfAmount } from '../data/axis.js';

export const ERAS = Object.freeze([
  Object.freeze({ id: 'b50000', block: 50000, title: 'Early mining', short: '50,000' }),
  Object.freeze({ id: 'b210000', block: 210000, title: 'First halving', short: '210,000' }),
  Object.freeze({ id: 'b314000', block: 314000, title: 'A denser field', short: '314,000' }),
  Object.freeze({ id: 'b420000', block: 420000, title: 'Second halving', short: '420,000' }),
  Object.freeze({ id: 'b500000', block: 500000, title: 'Half a million blocks', short: '500,000' }),
  Object.freeze({ id: 'b630000', block: 630000, title: 'Third halving', short: '630,000' }),
  Object.freeze({ id: 'b700000', block: 700000, title: 'Seven hundred thousand', short: '700,000' }),
  Object.freeze({ id: 'b840000', block: 840000, title: 'Fourth halving', short: '840,000' }),
  Object.freeze({ id: 'b900000', block: 900000, title: 'Recent output structure', short: '900,000' }),
  Object.freeze({ id: 'tip', block: 'tip', title: 'Latest block', short: 'Tip' }),
]);

// Amount bands in satoshis. min..max is the amount range; rows follow from rows.bin.
export const BANDS = Object.freeze([
  Object.freeze({ id: 'coinbase50', label: '50 BTC coinbase row', min: 5e9, max: 5e9 }),
  Object.freeze({ id: 'whale', label: '\u2265 10 BTC', min: 1e9, max: Infinity }),
  Object.freeze({ id: 'btc1', label: '1 BTC', min: 1e8, max: 1e8 }),
  Object.freeze({ id: 'sat10000', label: '10,000 sat', min: 1e4, max: 1e4 }),
  Object.freeze({ id: 'dust546', label: '546 sat', min: 546, max: 546 }),
  Object.freeze({ id: 'sat1to100', label: '1\u2013100 sat', min: 1, max: 100 }),
]);

export function eraBlock(era, tip) {
  return era.block === 'tip' ? tip : Math.min(era.block, tip);
}

/** Inclusive graph-row range of a band (row 0 = largest amounts). */
export function bandRows(minAmt, band) {
  const top = band.max === Infinity ? 0 : rowOfAmount(minAmt, band.max);
  const bottom = rowOfAmount(minAmt, band.min);
  return { rowMin: Math.min(top, bottom), rowMax: Math.max(top, bottom) };
}

/**
 * Resolve a place reference: an era id ('b314000', 'tip'), a band id ('btc1'), a block
 * number (or numeric string), or an object {block} / {band}. Eras beyond the dataset tip
 * resolve to the tip. Returns {kind: 'era', id, block, title} |
 * {kind: 'band', id, label, rowMin, rowMax} | null.
 */
export function resolvePlace(place, { tip, minAmt }) {
  if (place == null) return null;
  if (typeof place === 'object') {
    if (place.band != null) return resolvePlace(String(place.band), { tip, minAmt });
    if (place.block != null) return resolvePlace(place.block, { tip, minAmt });
    return null;
  }
  const key = String(place).trim();
  const era = ERAS.find((e) => e.id === key || e.id === 'b' + key);
  if (era) return { kind: 'era', id: era.id, block: eraBlock(era, tip), title: era.title };
  const band = BANDS.find((b) => b.id === key);
  if (band) {
    if (!minAmt) return null;
    return { kind: 'band', id: band.id, label: band.label, ...bandRows(minAmt, band) };
  }
  if (/^\d+$/.test(key)) {
    const b = Math.min(Number(key), tip);
    return { kind: 'era', id: 'block', block: b, title: 'Block ' + b.toLocaleString('en-US') };
  }
  return null;
}
