// Stack sats (landscape/SPEC.md §8), the Fun menu's game: a 60-second run in plane mode
// collecting coins that hover over the tallest columns near the craft. Each coin is worth the
// amount of the row it sits on (rowAmountRange(rows, row).min: the 50 BTC row pays 50 BTC,
// the 546 sat row 546 sat), so the big coins sit far back over the whale rows. The score is
// the stack in satoshis; best stacks per craft live in ui/fun-store.js. Pure module (no
// three.js, no DOM): main.js steps it every frame and render/coins.js draws the coins.
//
// Spawning keeps up to 8 coins, topping up every 3 s: it samples the ground on a square of
// side 2R (R = 4 x speed, 5 to 24 units) centred 0.5 R ahead of the craft, takes the local
// maxima at least 0.25 high, tallest first, at least 1.5 units from other coins and from the
// craft, and hovers each 0.5 above the highest ground within 0.15 of it; when the last coin
// goes, new ones are placed at once. Coins vanish 25 s after they appear. A coin is collected when the craft's path this frame passes within the
// craft's coinReach of it, horizontally and vertically.

import { rowAmountRange } from '../data/axis.js';
import { craftSpec } from './plane.js';

export const STACK = Object.freeze({
  duration: 60, // seconds per run
  maxCoins: 8,
  spawnEvery: 3, // seconds between top-ups
  retry: 0.5, // seconds before trying again when no coin could be placed and none is left
  life: 25, // seconds a coin stays
  minGround: 0.25, // coins only over ground at least this high
  gap: 1.5, // horizontal distance from other coins and from the craft
  hover: 0.5, // above the highest ground nearby
  top: 0.15, // the highest ground is looked for within this distance
  samples: 40, // ground samples from the centre to each side of the square
  radiusPerSpeed: 4,
  minRadius: 5,
  maxRadius: 24,
  ahead: 0.5, // the square's centre, in radii ahead of the craft
  fade: 0.25, // seconds a collected or expired coin takes to disappear
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A game that is not running. rows: rows.bin (minAmt per row) for the coin values. */
export function createStackSats({ rows = null, duration = STACK.duration } = {}) {
  return {
    rows, duration,
    running: false, ended: false,
    t: 0, // seconds into the run
    clock: 0, // seconds of game time, running or not (coin fades)
    score: 0, // satoshis
    collected: 0,
    coins: [], // { id, x, y, z, row, value, born, gone, taken }
    craft: 'plane',
    nextSpawn: 0,
    nextId: 1,
    last: null, // the craft's position at the previous step
  };
}

/** Start a run for a craft: score, time and coins from zero; the first coins appear at the next step. */
export function startStackSats(s, craft = 'plane') {
  for (const c of s.coins) if (c.gone == null) c.gone = s.clock;
  Object.assign(s, {
    running: true, ended: false, t: 0, score: 0, collected: 0,
    craft: craftSpec(craft).id, nextSpawn: 0, last: null,
  });
  return s;
}

/** Stop a run now. finished = true ends it as if the time ran out (ended), else it is abandoned. */
export function stopStackSats(s, { finished = false } = {}) {
  if (!s.running) return s;
  s.running = false;
  s.ended = !!finished;
  s.last = null;
  for (const c of s.coins) if (c.gone == null) c.gone = s.clock;
  return s;
}

/** Satoshi value of the row at world z (z = row / 10), or 0 without rows or for an empty row. */
export function coinValue(rows, z) {
  if (!rows || !rows.length) return 0;
  const row = clamp(Math.floor(z * 10), 0, rows.length - 1);
  const r = rowAmountRange(rows, row);
  return r ? r.min : 0;
}

/** Whether the path from a to b passes within reach of coin c, horizontally and vertically. */
export function reaches(a, b, c, reach) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((c.x - a.x) * dx + (c.z - a.z) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  const y = a.y + (b.y - a.y) * t;
  return Math.hypot(c.x - x, c.z - z) <= reach && Math.abs(c.y - y) <= reach;
}

/**
 * Place new coins ahead of the craft p (ui/plane.js state) up to STACK.maxCoins. ground(x, z)
 * is the terrain height; extent ({minX, maxX, minZ, maxZ}) limits the coins to the landscape.
 * Returns the new coins (already added to s.coins).
 */
export function spawnCoins(s, p, ground, extent = null) {
  const alive = s.coins.filter((c) => c.gone == null);
  const want = STACK.maxCoins - alive.length;
  if (want <= 0 || typeof ground !== 'function') return [];
  const e = extent || { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  const R = clamp(STACK.radiusPerSpeed * (p.speed || 0), STACK.minRadius, STACK.maxRadius);
  const cx = p.x - Math.sin(p.yaw) * STACK.ahead * R;
  const cz = p.z - Math.cos(p.yaw) * STACK.ahead * R;
  const n = STACK.samples;
  const N = 2 * n + 1;
  const step = R / n;
  const h = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = cz + (j - n) * step;
    for (let i = 0; i < N; i++) {
      const x = cx + (i - n) * step;
      const inside = x >= e.minX && x < e.maxX && z >= e.minZ && z < e.maxZ;
      const g = inside ? ground(x, z) : -Infinity;
      h[j * N + i] = Number.isFinite(g) ? g : -Infinity;
    }
  }
  const candidates = [];
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const v = h[j * N + i];
      if (!(v >= STACK.minGround)) continue;
      let top = true;
      for (let dj = -1; dj <= 1 && top; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di || dj) && h[(j + dj) * N + i + di] > v) {
            top = false;
            break;
          }
        }
      }
      if (top) candidates.push({ x: cx + (i - n) * step, z: cz + (j - n) * step, g: v });
    }
  }
  candidates.sort((a, b) => b.g - a.g);
  const taken = alive.map((c) => ({ x: c.x, z: c.z }));
  taken.push({ x: p.x, z: p.z });
  const out = [];
  for (const c of candidates) {
    if (out.length >= want) break;
    if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < STACK.gap)) continue;
    const value = coinValue(s.rows, c.z);
    if (s.rows && !(value > 0)) continue;
    let g = c.g;
    for (const dz of [-STACK.top, 0, STACK.top]) {
      for (const dx of [-STACK.top, 0, STACK.top]) {
        const v = ground(c.x + dx, c.z + dz);
        if (Number.isFinite(v) && v > g) g = v;
      }
    }
    const coin = {
      id: s.nextId++, x: c.x, y: g + STACK.hover, z: c.z, row: Math.floor(c.z * 10), value,
      born: s.clock, gone: null, taken: false,
    };
    out.push(coin);
    taken.push(coin);
  }
  s.coins.push(...out);
  return out;
}

/**
 * Advance the game by dt seconds with the craft p (null while it is not flying: only the coin
 * fades advance). env: { ground(x, z), extent }. Returns { collected: [coins], spawned, ended }.
 */
export function stepStackSats(s, p, dt, env = {}) {
  const out = { collected: [], spawned: 0, ended: false };
  const h = clamp(Number(dt) || 0, 0, 0.1);
  s.clock += h;
  if (s.coins.length) s.coins = s.coins.filter((c) => c.gone == null || s.clock - c.gone < STACK.fade);
  if (!s.running || !p) {
    s.last = null;
    return out;
  }
  s.t += h;
  const reach = craftSpec(s.craft).coinReach;
  const here = { x: p.x, y: p.y, z: p.z };
  const from = s.last || here;
  let alive = 0;
  for (const c of s.coins) if (c.gone == null) alive++;
  for (const c of s.coins) {
    if (c.gone != null) continue;
    if (reaches(from, here, c, reach)) {
      c.gone = s.clock;
      c.taken = true;
      s.score += c.value;
      s.collected++;
      out.collected.push(c);
    } else if (s.clock - c.born >= STACK.life) {
      c.gone = s.clock;
    }
  }
  s.last = here;
  if (s.t >= s.duration) {
    s.t = s.duration;
    stopStackSats(s, { finished: true });
    out.ended = true;
    return out;
  }
  // The last coin just went (collected or expired): place new ones now.
  if (alive > 0 && !s.coins.some((c) => c.gone == null)) s.nextSpawn = Math.min(s.nextSpawn, s.t);
  if (s.t >= s.nextSpawn) {
    out.spawned = spawnCoins(s, p, env.ground, env.extent).length;
    const left = s.coins.some((c) => c.gone == null);
    s.nextSpawn = s.t + (out.spawned || left ? STACK.spawnEvery : STACK.retry);
  }
  return out;
}

/** A stack for the HUD and the end card: 12.345 BTC, 0.00123 BTC, 546 sat. */
export function fmtStack(sats) {
  if (!(sats > 0)) return '0 BTC';
  if (sats >= 1e8) return (sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' BTC';
  if (sats >= 1e5) return (sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 5 }) + ' BTC';
  return Math.round(sats).toLocaleString('en-US') + ' sat';
}

/** Time left in the run as m:ss (rounded up, so the last second shows 0:01). */
export function timeLeft(s) {
  const left = Math.max(0, Math.ceil(s.duration - s.t - 1e-9));
  return Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}
