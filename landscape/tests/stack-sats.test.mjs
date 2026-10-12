// Stack sats (landscape/web/ui/stack-sats.js) and the Fun memory (ui/fun-store.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STACK, createStackSats, startStackSats, stopStackSats, stepStackSats, spawnCoins, coinValue, reaches, fmtStack, timeLeft,
} from '../web/ui/stack-sats.js';
import { FUN_KEY, defaultFun, parseFun, loadFun, saveFun, recordBest, bestOf } from '../web/ui/fun-store.js';
import { createPlane } from '../web/ui/plane.js';
import { buildMinAmtTable, rowAmountRange } from '../web/data/axis.js';

const rows = buildMinAmtTable();
const DT = 1 / 60;

// Cone towers: height h at (x, z), falling to 0 within 0.6.
function towers(list) {
  return (x, z) => {
    let g = 0;
    for (const t of list) g = Math.max(g, t.h * Math.max(0, 1 - Math.hypot(x - t.x, z - t.z) / 0.6));
    return g;
  };
}

// A craft at (50, 5, 50) heading -z at 2 units/s: R = 8, the square spans x 42..58, z 38..54.
const craft = (o = {}) => Object.assign(createPlane({ x: 50, y: 5, z: 50, yaw: 0 }), o);
const field = [
  { x: 44, z: 40, h: 10 }, { x: 48, z: 40, h: 9 }, { x: 52, z: 40, h: 8 }, { x: 56, z: 40, h: 7 },
  { x: 44, z: 44, h: 6 }, { x: 48, z: 44, h: 5 }, { x: 52, z: 44, h: 4 }, { x: 56, z: 44, h: 3 },
  { x: 44, z: 48, h: 2 }, { x: 56, z: 48, h: 1.5 },
  { x: 49, z: 40, h: 9.5 }, // 1 unit from the 9 tower: only one coin of the two
  { x: 50.4, z: 49.6, h: 20 }, // next to the craft: no coin
];

test('coins: up to 8 over the tallest local maxima, 1.5 apart and away from the craft, worth their row', () => {
  const s = startStackSats(createStackSats({ rows }), 'plane');
  const p = craft();
  const ground = towers(field);
  const coins = spawnCoins(s, p, ground);
  assert.equal(coins.length, 8);
  const tops = coins.map((c) => Math.round((c.y - STACK.hover) * 2) / 2);
  assert.deepEqual(tops, [10, 9.5, 8, 7, 6, 5, 4, 3], 'tallest first; the 9.5 tower takes the coin of the 9 tower 1 unit away: ' + tops);
  for (const c of coins) {
    for (const d of coins) if (c !== d) assert.ok(Math.hypot(c.x - d.x, c.z - d.z) >= STACK.gap - 1e-9, 'gap');
    assert.ok(Math.hypot(c.x - p.x, c.z - p.z) >= STACK.gap, 'away from the craft');
    assert.equal(c.value, rowAmountRange(rows, Math.floor(c.z * 10)).min, 'value of the row');
    assert.ok(c.value > 0);
  }
  assert.ok(!coins.some((c) => c.y > 20), 'no coin on the tower next to the craft');
  assert.equal(spawnCoins(s, p, ground).length, 0, 'full: nothing more');
});

test('no coins over low or empty ground or outside the landscape', () => {
  const s = startStackSats(createStackSats({ rows }), 'plane');
  assert.equal(spawnCoins(s, craft(), () => 0.2).length, 0, 'below 0.25');
  const outside = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.equal(spawnCoins(s, craft(), towers(field), outside).length, 0, 'outside the extent');
});

test('collection: only within the craft reach, horizontally and vertically, also when a frame skips over the coin', () => {
  const coin = { x: 0, y: 1, z: 0 };
  assert.ok(reaches({ x: -1, y: 1, z: 0.6 }, { x: 1, y: 1, z: 0.6 }, coin, 0.7), 'plane passes 0.6 to the side');
  assert.ok(!reaches({ x: -1, y: 1, z: 0.6 }, { x: 1, y: 1, z: 0.6 }, coin, 0.5), 'the bird must come closer');
  assert.ok(!reaches({ x: -1, y: 1.8, z: 0 }, { x: 1, y: 1.8, z: 0 }, coin, 0.7), '0.8 above is too high');
  assert.ok(reaches({ x: 0, y: 1, z: 3 }, { x: 0, y: 1, z: -3 }, coin, 1.2), 'a jet frame of 6 units still collects it');

  const s = startStackSats(createStackSats({ rows }), 'bird');
  s.nextSpawn = Infinity;
  s.coins.push({ id: 1, x: 0, y: 1, z: -1, value: 5e9, born: 0, gone: null, taken: false });
  s.coins.push({ id: 2, x: 0.6, y: 1, z: -3, value: 546, born: 0, gone: null, taken: false });
  const p = createPlane({ craft: 'bird', x: 0, y: 1, z: 0, yaw: 0 });
  let got = [];
  for (let i = 0; i < 600 && p.z > -4; i++) {
    p.z -= 0.02;
    got = got.concat(stepStackSats(s, p, DT).collected);
  }
  assert.deepEqual(got.map((c) => c.id), [1], 'the coin on the path, not the one 0.6 aside');
  assert.equal(s.score, 5e9);
  assert.equal(s.collected, 1);
  assert.equal(s.coins.find((c) => c.id === 1), undefined, 'gone after the fade');
});

test('coins expire after 25 s; the run ends at 60 s with the score kept', () => {
  const s = startStackSats(createStackSats({ rows }), 'plane');
  const p = craft();
  const ground = towers(field);
  let spawned = 0;
  let ended = 0;
  for (let t = 0; t < 70; t += 0.1) {
    const ev = stepStackSats(s, p, 0.1, { ground });
    spawned += ev.spawned;
    if (ev.ended) ended++;
    if (Math.abs(t - 10) < 0.05) assert.equal(s.coins.filter((c) => c.gone == null).length, 8, 'still 8 at 10 s');
    // The first coins expire at 25.1 s, all at once, and are replaced at once.
    if (Math.abs(t - 25.5) < 0.05) assert.ok(spawned > 8 && s.coins.filter((c) => c.gone == null).length === 8, 'expired coins were replaced (' + spawned + ' placed)');
  }
  assert.equal(ended, 1, 'ends once');
  assert.equal(s.running, false);
  assert.equal(s.ended, true);
  assert.equal(s.t, 60);
  assert.equal(s.coins.length, 0, 'all coins gone after the end');
  assert.equal(timeLeft(s), '0:00');
});

test('nothing to collect yet: the game retries soon and fills up once the ground appears', () => {
  const s = startStackSats(createStackSats({ rows }), 'plane');
  let ground = () => 0;
  const p = craft();
  stepStackSats(s, p, 0.1, { ground: (x, z) => ground(x, z) });
  assert.equal(s.coins.length, 0);
  ground = towers(field);
  for (let i = 0; i < 6; i++) stepStackSats(s, p, 0.1, { ground });
  assert.equal(s.coins.length, 8, 'within half a second');
});

test('stop: abandoned or finished; start again clears the score', () => {
  const s = startStackSats(createStackSats({ rows }), 'jet');
  s.score = 7;
  stopStackSats(s);
  assert.equal(s.running, false);
  assert.equal(s.ended, false, 'abandoned');
  startStackSats(s, 'bird');
  assert.equal(s.score, 0);
  assert.equal(s.craft, 'bird');
  stopStackSats(s, { finished: true });
  assert.equal(s.ended, true);
  assert.equal(coinValue(rows, 47.45), rowAmountRange(rows, 474).min, '50 BTC row');
  assert.equal(coinValue(null, 47.45), 0);
});

test('stack format and time left', () => {
  assert.equal(fmtStack(0), '0 BTC');
  assert.equal(fmtStack(546), '546 sat');
  assert.equal(fmtStack(123456), '0.00123 BTC');
  assert.equal(fmtStack(12.3456789e8), '12.346 BTC');
  assert.equal(fmtStack(92379.80975827e8), '92,379.81 BTC');
  const s = createStackSats();
  s.t = 13.2;
  assert.equal(timeLeft(s), '0:47');
  s.t = 0;
  assert.equal(timeLeft(s), '1:00');
});

test('fun memory: craft and best per craft round trip; bad data falls back', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const data = loadFun(storage);
  assert.deepEqual(data, defaultFun());
  data.craft = 'jet';
  let r = recordBest(data, 'stack-sats', 'jet', { sats: 20e8, coins: 9 }, 1);
  assert.equal(r.isBest, true);
  r = recordBest(data, 'stack-sats', 'jet', { sats: 12e8, coins: 7 }, 2);
  assert.equal(r.isBest, false, 'less is not a best');
  assert.equal(r.best.sats, 20e8);
  assert.equal(recordBest(data, 'stack-sats', 'bird', { sats: 0, coins: 0 }).isBest, false, 'nothing stacked');
  recordBest(data, 'stack-sats', 'bird', { sats: 546, coins: 1 }, 3);
  saveFun(storage, data);
  const back = loadFun(storage);
  assert.equal(back.craft, 'jet');
  assert.deepEqual(bestOf(back, 'stack-sats', 'jet'), { sats: 20e8, coins: 9, at: 1 });
  assert.deepEqual(bestOf(back, 'stack-sats', 'bird'), { sats: 546, coins: 1, at: 3 });
  assert.equal(bestOf(back, 'stack-sats', 'plane'), null);
  assert.ok(mem.has(FUN_KEY));
  assert.deepEqual(parseFun('{not json'), defaultFun());
  assert.deepEqual(parseFun('null'), defaultFun());
  const odd = parseFun(JSON.stringify({ craft: 'rocket', best: { 'stack-sats': { jet: { sats: -1, coins: 2 }, bird: { sats: 5, coins: 1.5 }, plane: { sats: 9, coins: 1 } } } }));
  assert.equal(odd.craft, 'plane');
  assert.deepEqual(Object.keys(odd.best['stack-sats']), ['plane']);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(loadFun(broken), defaultFun());
  assert.equal(saveFun(broken, data), false);
});
