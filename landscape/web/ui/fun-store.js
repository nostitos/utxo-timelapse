// Fun menu memory (landscape/SPEC.md §8): the chosen craft and the best Stack sats run per
// craft, in this browser only (localStorage key utxo-landscape-fun). Pure apart from the
// storage passed in; anything unreadable falls back to the defaults.
//
// { craft: 'plane' | 'bird' | 'jet', best: { 'stack-sats': { <craft>: { sats, coins, at } } } }

import { CRAFTS } from './plane.js';

export const FUN_KEY = 'utxo-landscape-fun';
export const GAMES = Object.freeze(['stack-sats']);

export function defaultFun() {
  return { craft: 'plane', best: { 'stack-sats': {} } };
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const sats = Number(e.sats);
  const coins = Number(e.coins);
  if (!Number.isFinite(sats) || sats < 0 || !Number.isInteger(coins) || coins < 0) return null;
  const at = Number(e.at);
  return { sats, coins, at: Number.isFinite(at) ? at : 0 };
}

/** Parse stored JSON text; invalid parts are dropped, invalid JSON gives the defaults. */
export function parseFun(textValue) {
  const out = defaultFun();
  let raw = null;
  try {
    raw = JSON.parse(textValue);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.craft === 'string' && CRAFTS[raw.craft]) out.craft = raw.craft;
  const best = raw.best && typeof raw.best === 'object' ? raw.best : {};
  for (const game of GAMES) {
    const per = best[game] && typeof best[game] === 'object' ? best[game] : {};
    for (const id of Object.keys(CRAFTS)) {
      const e = cleanEntry(per[id]);
      if (e) out.best[game][id] = e;
    }
  }
  return out;
}

export function loadFun(storage) {
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    const v = storage ? storage.getItem(FUN_KEY) : null;
    return v == null ? defaultFun() : parseFun(v);
  } catch {
    return defaultFun();
  }
}

export function saveFun(storage, data) {
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    if (storage) storage.setItem(FUN_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // private mode or full: not remembered
  }
}

/** The best run of a game with a craft, or null. */
export function bestOf(data, game, craft) {
  return (data && data.best && data.best[game] && data.best[game][craft]) || null;
}

/**
 * Record a finished run { sats, coins }: it becomes the best when it stacked more than the
 * previous best (and more than nothing). Mutates data; returns { best, isBest, previous }.
 */
export function recordBest(data, game, craft, { sats, coins }, at = Date.now()) {
  if (!data.best[game]) data.best[game] = {};
  const previous = bestOf(data, game, craft);
  const isBest = sats > 0 && (!previous || sats > previous.sats);
  if (isBest) data.best[game][craft] = { sats, coins, at };
  return { best: bestOf(data, game, craft), isBest, previous };
}
