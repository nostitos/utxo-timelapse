// Stack sats (landscape/web/ui/stack-sats.js) and the Fun memory (ui/fun-store.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STACK, createStackSats, startStackSats, stopStackSats, stepStackSats, spawnTrail, spawnBonus, coinValue, reaches,
  fmtStack, timeLeft,
} from '../web/ui/stack-sats.js';
import { FUN_KEY, defaultFun, parseFun, loadFun, saveFun, recordBest, bestOf } from '../web/ui/fun-store.js';
import { createPlane, CRAFTS } from '../web/ui/plane.js';
import { buildMinAmtTable, rowAmountRange } from '../web/data/axis.js';

const rows = buildMinAmtTable();
const DT = 1 / 60;
const live = (s) => s.coins.filter((c) => c.gone == null);
const flat = () => 0.2; // below the bonus threshold: trails only

// Towers: height h with a flat top of radius 0.3 at (x, z), falling to 0 at 1.2 (wider than the
// bonus sampling, so a sample lands on every top).
function towers(list, base = 0) {
  return (x, z) => {
    let g = base;
    for (const t of list) g = Math.max(g, t.h * Math.min(1, Math.max(0, (1.2 - Math.hypot(x - t.x, z - t.z)) / 0.9)));
    return g;
  };
}

// A craft at (50, 3, 50) heading -z at its cruise speed (2 units/s for the plane).
const craft = (o = {}) => Object.assign(createPlane({ x: 50, y: 3, z: 50, yaw: 0 }), o);
const run = (craftId = 'plane', seed = 7) => startStackSats(createStackSats({ rows }), craftId, { seed });

test('a trail: 10 coins ahead along the heading, 0.45 s of flight apart, curving smoothly at the craft height', () => {
  const s = run();
  const p = craft();
  const ev = stepStackSats(s, p, DT, { ground: flat });
  const coins = live(s);
  assert.equal(ev.spawned, STACK.trailCoins);
  assert.ok(coins.every((c) => c.kind === 'trail'));
  near(50 - coins[0].z, 3, 0.4, 'first coin 1.5 s of flight ahead');
  for (let i = 1; i < coins.length; i++) {
    near(Math.hypot(coins[i].x - coins[i - 1].x, coins[i].z - coins[i - 1].z), 0.9, 1e-9, 'spacing 0.45 s at 2 units/s');
    assert.ok(Math.abs(coins[i].y - coins[i - 1].y) <= STACK.trailClimb + 1e-9, 'climbs gently');
    if (i >= 2) {
      const a = Math.atan2(coins[i - 1].x - coins[i - 2].x, coins[i - 1].z - coins[i - 2].z);
      const b = Math.atan2(coins[i].x - coins[i - 1].x, coins[i].z - coins[i - 1].z);
      assert.ok(Math.abs(b - a) <= STACK.trailBend + 1e-9, 'turns at most 8 degrees a coin');
    }
  }
  for (const c of coins) {
    assert.ok(c.z < p.z, 'ahead');
    assert.ok(Math.abs(c.y - p.y) <= STACK.trailCoins * STACK.trailClimb, 'near the craft height (' + c.y.toFixed(2) + ')');
    assert.equal(c.value, rowAmountRange(rows, Math.floor(c.z * 10)).min, 'worth its row');
  }
});

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, (msg || '') + ': ' + a + ' vs ' + b);
}

test('trail coins ride over the columns and stay within 8 of the ground', () => {
  const s = run();
  const ground = towers([{ x: 50, z: 46, h: 6 }, { x: 49, z: 44, h: 3 }], 0.2);
  const high = craft({ y: 40 });
  spawnTrail(s, high, ground);
  for (const c of live(s)) {
    assert.ok(c.y >= ground(c.x, c.z) + STACK.hover - 1e-9, 'above the column');
    assert.ok(c.y <= Math.max(ground(c.x, c.z), 6) + STACK.hover + STACK.trailHigh + 1e-9, 'at most 8 above the ground');
  }
});

test('the same seed lays the same trail; another seed bends it differently', () => {
  const a = run('plane', 3);
  const b = run('plane', 3);
  const c = run('plane', 4);
  spawnTrail(a, craft(), flat);
  spawnTrail(b, craft(), flat);
  spawnTrail(c, craft(), flat);
  assert.deepEqual(a.coins.map((k) => [k.x, k.y, k.z]), b.coins.map((k) => [k.x, k.y, k.z]));
  assert.notDeepEqual(a.coins.map((k) => k.x), c.coins.map((k) => k.x));
});

// Fly like a player following the coins: head for the nearest coin ahead at the craft's speed.
function followCoins(s, p, seconds, env) {
  for (let t = 0; t < seconds; t += DT) {
    const target = live(s).filter((c) => (c.x - p.x) * -Math.sin(p.yaw) + (c.z - p.z) * -Math.cos(p.yaw) > -0.5)
      .sort((u, v) => Math.hypot(u.x - p.x, u.z - p.z) - Math.hypot(v.x - p.x, v.z - p.z))[0];
    if (target) {
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) p.yaw = Math.atan2(-dx, -dz);
      p.y += Math.max(-1, Math.min(1, target.y - p.y)) * Math.min(1, p.speed * DT);
    }
    p.x += -Math.sin(p.yaw) * p.speed * DT;
    p.z += -Math.cos(p.yaw) * p.speed * DT;
    stepStackSats(s, p, DT, env);
    if (!s.running) break;
  }
}

test('trails keep coming: a pilot following them collects dozens of coins', () => {
  for (const id of ['plane', 'bird', 'jet']) {
    const s = run(id);
    const p = craft({ craft: id, speed: { plane: 2, bird: 0.63, jet: 7.8 }[id] });
    followCoins(s, p, 20, { ground: flat });
    const min = { plane: 25, bird: 12, jet: 25 }[id];
    assert.ok(s.collected >= min, id + ' collected ' + s.collected + ' coins in 20 s');
    assert.ok(s.score > 0);
    assert.ok(live(s).length <= STACK.maxCoins);
  }
});

test('at the edge of the landscape trails turn back inside', () => {
  const s = run();
  const extent = { minX: 0, maxX: 60, minZ: 0, maxZ: 60 };
  const p = craft({ x: 58, z: 30, yaw: -Math.PI / 2 }); // heading +x, off the landscape
  spawnTrail(s, p, flat, extent);
  const coins = live(s);
  assert.ok(coins.length >= 8, coins.length + ' coins');
  assert.ok(coins.every((c) => c.x >= 0 && c.x < 60 && c.z >= 0 && c.z < 60), 'all inside');
  assert.ok(coins[coins.length - 1].x < coins[0].x, 'heading back in');
});

// Bonus coins on the tallest columns.
const field = [
  { x: 44, z: 40, h: 10 }, { x: 48, z: 40, h: 9 }, { x: 52, z: 40, h: 8 }, { x: 56, z: 40, h: 7 },
  { x: 44, z: 44, h: 6 }, { x: 48, z: 44, h: 5 }, { x: 52, z: 44, h: 4 }, { x: 56, z: 44, h: 3 },
  { x: 49, z: 40, h: 9.5 }, // 1 unit from the 9 tower: only one coin of the two
  { x: 50.4, z: 49.6, h: 20 }, // next to the craft: no coin
];

test('bonus coins: up to 6 on the tallest local maxima, 1.5 apart and away from the craft', () => {
  const s = run();
  const p = craft();
  const coins = spawnBonus(s, p, towers(field));
  const tops = coins.map((c) => Math.round((c.y - STACK.hover) * 2) / 2);
  assert.deepEqual(tops, [10, 9.5, 8, 7, 6, 5], 'tallest first; the 9.5 tower takes the coin of the 9 tower: ' + tops);
  for (const c of coins) {
    assert.equal(c.kind, 'bonus');
    for (const d of coins) if (c !== d) assert.ok(Math.hypot(c.x - d.x, c.z - d.z) >= STACK.gap - 1e-9, 'gap');
    assert.ok(Math.hypot(c.x - p.x, c.z - p.z) >= STACK.gap, 'away from the craft');
    assert.equal(c.value, rowAmountRange(rows, Math.floor(c.z * 10)).min);
  }
  assert.equal(spawnBonus(s, p, towers(field)).length, 0, 'six is the most');
  assert.equal(spawnBonus(run(), p, flat).length, 0, 'none over low ground');
});

test('collection: only within the craft reach, horizontally and vertically, also when a frame skips over the coin', () => {
  const coin = { x: 0, y: 1, z: 0 };
  assert.ok(reaches({ x: -1, y: 1, z: 0.9 }, { x: 1, y: 1, z: 0.9 }, coin, CRAFTS.plane.coinReach), 'plane passes 0.9 to the side');
  assert.ok(!reaches({ x: -1, y: 1, z: 0.9 }, { x: 1, y: 1, z: 0.9 }, coin, CRAFTS.bird.coinReach), 'the bird must come closer');
  assert.ok(!reaches({ x: -1, y: 2.2, z: 0 }, { x: 1, y: 2.2, z: 0 }, coin, CRAFTS.plane.coinReach), '1.2 above is too high');
  assert.ok(reaches({ x: 0, y: 1, z: 3 }, { x: 0, y: 1, z: -3 }, coin, CRAFTS.jet.coinReach), 'a jet frame of 6 units still collects it');

  const s = run('bird');
  s.nextTrail = Infinity;
  s.nextBonus = Infinity;
  s.coins.push({ id: 1, kind: 'trail', x: 0, y: 1, z: -1, value: 5e9, born: 0, gone: null, taken: false });
  s.coins.push({ id: 2, kind: 'trail', x: 0.9, y: 1, z: -3, value: 546, born: 0, gone: null, taken: false });
  const p = createPlane({ craft: 'bird', x: 0, y: 1, z: 0, yaw: 0 });
  let got = [];
  for (let i = 0; i < 600 && p.z > -4; i++) {
    p.z -= 0.02;
    got = got.concat(stepStackSats(s, p, DT).collected);
  }
  assert.deepEqual(got.map((c) => c.id), [1], 'the coin on the path, not the one 0.9 aside');
  assert.equal(s.score, 5e9);
  assert.equal(s.collected, 1);
  assert.equal(s.coins.find((c) => c.id === 1), undefined, 'gone after the fade');
});

test('coins expire after 20 s or once well behind the craft', () => {
  const s = run();
  s.nextTrail = Infinity;
  s.nextBonus = Infinity;
  s.coins.push({ id: 1, kind: 'trail', x: 50, y: 3, z: 30, value: 1, born: 0, gone: null, taken: false });
  s.coins.push({ id: 2, kind: 'trail', x: 50, y: 3, z: 63, value: 1, born: 0, gone: null, taken: false });
  const p = craft({ speed: 2 });
  stepStackSats(s, p, 0.1);
  assert.notEqual(s.coins.find((c) => c.id === 2).gone, null, '13 behind: gone');
  assert.equal(s.coins.find((c) => c.id === 1).gone, null);
  for (let t = 0; t < 19.95; t += 0.1) stepStackSats(s, p, 0.1);
  assert.notEqual(s.coins.find((c) => c.id === 1).gone, null, 'after 20 s');
});

test('the run ends at 60 s with the score kept and the coins gone', () => {
  const s = run();
  const p = craft();
  let ended = 0;
  for (let t = 0; t < 70; t += 0.1) if (stepStackSats(s, p, 0.1, { ground: towers(field, 0.2) }).ended) ended++;
  assert.equal(ended, 1, 'ends once');
  assert.equal(s.running, false);
  assert.equal(s.ended, true);
  assert.equal(s.t, 60);
  assert.equal(s.coins.length, 0);
  assert.equal(timeLeft(s), '0:00');
});

test('stop: abandoned or finished; start again clears the score', () => {
  const s = run('jet');
  s.score = 7;
  stopStackSats(s);
  assert.equal(s.running, false);
  assert.equal(s.ended, false, 'abandoned');
  startStackSats(s, 'bird', { seed: 1 });
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
