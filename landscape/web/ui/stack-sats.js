// Stack sats (landscape/SPEC.md §8), the Fun menu's game: a 60-second run in plane mode
// collecting coins, each worth the amount of the row it floats over
// (rowAmountRange(rows, row).min: the 50 BTC row pays 50 BTC, the 546 sat row 546 sat), so the
// big coins are far back over the whale rows. The score is the stack in satoshis; best stacks
// per craft live in ui/fun-store.js. Pure module (no three.js, no DOM): main.js steps it every
// frame and render/coins.js draws the coins.
//
// Most coins come in trails: a chain of 10 coins laid ahead along the craft's heading, 0.45 s of
// flight apart (at least 0.7 units), curving smoothly left or right and up or down (the turn
// and climb per coin change a little from coin to coin), at the craft's height but always
// above the columns under them and at most 8 above the ground.
// A trail starts 1.5 s of flight ahead and the next one continues from the end of the last,
// so there is always a winding path to follow; a new trail is laid whenever fewer than 8 trail
// coins are still ahead (at most one a second). Trails turn back toward the landscape at its
// edges. Bonus coins sit on the tallest columns nearby: up to 6, placed every 3 s on a square
// of side 2R (R = 4 x speed, 5 to 24) centred 0.5 R ahead, at local maxima at least 0.25 high,
// 1.5 apart, 0.5 above the highest ground within 0.15. Coins vanish 20 s after they appear or
// once they are well behind the craft (3 s of flight, at least 12 units); at most 60 are out
// at once. A coin is collected when the craft's path this frame passes within the craft's
// coinReach of it, horizontally and vertically. Randomness comes from a seeded generator, so a
// run is repeatable for a given seed.

import { rowAmountRange } from '../data/axis.js';
import { craftSpec } from './plane.js';

const DEG = Math.PI / 180;

export const STACK = Object.freeze({
  duration: 60, // seconds per run
  maxCoins: 60, // coins out at once
  life: 20, // seconds a coin stays
  fade: 0.25, // seconds a collected or expired coin takes to disappear
  hover: 0.5, // above the highest ground nearby
  top: 0.15, // the highest ground is looked for within this distance
  behind: 3, // seconds of flight: coins farther behind than this go
  behindMin: 12,
  ceiling: 300,
  // Trails
  trailCoins: 10,
  trailEvery: 1, // seconds between trails at most
  trailAhead: 8, // a new trail when fewer trail coins than this are ahead
  trailStart: 1.5, // seconds of flight from the craft to a new chain's first coin
  trailStartMin: 1.5,
  trailStartMax: 40,
  trailSpacing: 0.45, // seconds of flight between coins
  trailSpacingMin: 0.7,
  trailSpacingMax: 6,
  trailTurn: 25 * DEG, // a new chain heads up to this far off the heading
  trailBend: 8 * DEG, // each coin turns up to this much
  trailWobble: 3 * DEG, // and its turn differs from the previous coin's by up to this much
  trailEdgeTurn: 30 * DEG, // and up to this much back toward the landscape at its edge
  trailClimb: 0.15, // each coin rises or falls up to this much
  trailClimbWobble: 0.05, // and its climb differs from the previous coin's by up to this much
  trailHigh: 8, // trail coins stay at most this far above the ground
  // Bonus coins on the tallest columns
  bonusCoins: 6,
  bonusEvery: 3,
  minGround: 0.25,
  gap: 1.5,
  samples: 30, // ground samples from the centre to each side of the square
  radiusPerSpeed: 4,
  minRadius: 5,
  maxRadius: 24,
  ahead: 0.5,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const forwardXZ = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

/** Seeded uniform random numbers in [0, 1) (mulberry32). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A game that is not running. rows: rows.bin (minAmt per row) for the coin values. */
export function createStackSats({ rows = null, duration = STACK.duration } = {}) {
  return {
    rows, duration,
    running: false, ended: false,
    t: 0, // seconds into the run
    clock: 0, // seconds of game time, running or not (coin fades)
    score: 0, // satoshis
    collected: 0,
    coins: [], // { id, kind: 'trail' | 'bonus', x, y, z, row, value, born, gone, taken }
    craft: 'plane',
    nextTrail: 0,
    nextBonus: 0,
    nextId: 1,
    chain: null, // { id, x, y, z, dir, turn, climb }: the last trail coin, where the next trail continues
    random: seededRandom(1),
    last: null, // the craft's position at the previous step
  };
}

/** Start a run for a craft: score, time and coins from zero; the first coins appear at the next step. */
export function startStackSats(s, craft = 'plane', { seed = (Date.now() ^ (Math.random() * 4294967296)) >>> 0 } = {}) {
  for (const c of s.coins) if (c.gone == null) c.gone = s.clock;
  Object.assign(s, {
    running: true, ended: false, t: 0, score: 0, collected: 0,
    craft: craftSpec(craft).id, nextTrail: 0, nextBonus: 0, chain: null, last: null,
    random: seededRandom(seed),
  });
  return s;
}

/** Stop a run now. finished = true ends it as if the time ran out (ended), else it is abandoned. */
export function stopStackSats(s, { finished = false } = {}) {
  if (!s.running) return s;
  s.running = false;
  s.ended = !!finished;
  s.last = null;
  s.chain = null;
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

function topNear(ground, x, z) {
  let g = -Infinity;
  for (const dz of [-STACK.top, 0, STACK.top]) {
    for (const dx of [-STACK.top, 0, STACK.top]) {
      const v = ground(x + dx, z + dz);
      if (Number.isFinite(v) && v > g) g = v;
    }
  }
  return Number.isFinite(g) ? g : 0;
}

const inside = (e, x, z) => x >= e.minX && x < e.maxX && z >= e.minZ && z < e.maxZ;
/** Heading (yaw) from (x, z) toward the middle of the extent (or dir when it is unbounded). */
function towardMiddle(e, x, z, dir) {
  if (!Number.isFinite(e.minX + e.maxX + e.minZ + e.maxZ)) return dir;
  return Math.atan2(-((e.minX + e.maxX) / 2 - x), -((e.minZ + e.maxZ) / 2 - z));
}
const alive = (s) => s.coins.filter((c) => c.gone == null);

/**
 * Lay a trail of up to STACK.trailCoins ahead of the craft p, continuing the last trail when
 * its end is still ahead. ground(x, z) is the terrain height; extent ({minX, maxX, minZ, maxZ})
 * keeps the coins on the landscape. Returns the new coins (already added to s.coins).
 */
export function spawnTrail(s, p, ground, extent = null) {
  if (typeof ground !== 'function') return [];
  const room = STACK.maxCoins - alive(s).length;
  if (room <= 0) return [];
  const e = extent || { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  const rnd = s.random;
  const sym = () => rnd() * 2 - 1;
  const speed = Math.max(p.speed || 0, 0.1);
  const spacing = clamp(STACK.trailSpacing * speed, STACK.trailSpacingMin, STACK.trailSpacingMax);
  const f = forwardXZ(p.yaw);
  const head = s.chain && s.coins.some((c) => c.id === s.chain.id && c.gone == null) &&
    (s.chain.x - p.x) * f.x + (s.chain.z - p.z) * f.z > 0 ? s.chain : null;
  let x, y, z, dir, first;
  let turn = 0;
  let climb = 0;
  if (head) {
    ({ x, y, z, dir, turn, climb } = head);
    first = false;
  } else {
    dir = p.yaw + sym() * STACK.trailTurn;
    const start = clamp(STACK.trailStart * speed, STACK.trailStartMin, STACK.trailStartMax);
    x = p.x + f.x * start;
    z = p.z + f.z * start;
    y = p.y;
    first = true;
    if (!inside(e, x, z) && Number.isFinite(e.minX + e.maxX + e.minZ + e.maxZ)) {
      // Heading off the landscape: start just inside its edge, turned toward the middle.
      x = clamp(x, e.minX + 0.5, e.maxX - 0.5);
      z = clamp(z, e.minZ + 0.5, e.maxZ - 0.5);
      dir = towardMiddle(e, x, z, dir);
    }
  }
  const out = [];
  const n = Math.min(STACK.trailCoins, room);
  for (let i = 0; i < n; i++) {
    if (!first) {
      turn = clamp(turn + sym() * STACK.trailWobble, -STACK.trailBend, STACK.trailBend);
      dir += turn;
      let d = forwardXZ(dir);
      if (!inside(e, x + d.x * spacing, z + d.z * spacing)) {
        // At the edge: turn toward the middle of the landscape.
        const want = towardMiddle(e, x, z, dir);
        const turn = ((want - dir + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        dir += clamp(turn, -STACK.trailEdgeTurn, STACK.trailEdgeTurn);
        d = forwardXZ(dir);
      }
      x += d.x * spacing;
      z += d.z * spacing;
      climb = clamp(climb + sym() * STACK.trailClimbWobble, -STACK.trailClimb, STACK.trailClimb);
      y += climb;
    }
    first = false;
    if (!inside(e, x, z)) break;
    const value = coinValue(s.rows, z);
    if (s.rows && !(value > 0)) continue;
    const g = topNear(ground, x, z);
    const lo = g + STACK.hover;
    const hi = Math.min(g + STACK.hover + STACK.trailHigh, STACK.ceiling);
    // Held at the floor or the top: stop climbing that way.
    if (y < lo) climb = Math.max(climb, 0);
    if (y > hi) climb = Math.min(climb, 0);
    y = clamp(y, lo, hi);
    const coin = { id: s.nextId++, kind: 'trail', x, y, z, row: Math.floor(z * 10), value, born: s.clock, gone: null, taken: false };
    out.push(coin);
    s.chain = { id: coin.id, x, y, z, dir, turn, climb };
  }
  s.coins.push(...out);
  return out;
}

/**
 * Place bonus coins on the tallest columns ahead of the craft p, up to STACK.bonusCoins.
 * Returns the new coins (already added to s.coins).
 */
export function spawnBonus(s, p, ground, extent = null) {
  const live = alive(s);
  const bonus = live.filter((c) => c.kind === 'bonus');
  const want = Math.min(STACK.bonusCoins - bonus.length, STACK.maxCoins - live.length);
  if (want <= 0 || typeof ground !== 'function') return [];
  const e = extent || { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  const R = clamp(STACK.radiusPerSpeed * (p.speed || 0), STACK.minRadius, STACK.maxRadius);
  const f = forwardXZ(p.yaw);
  const cx = p.x + f.x * STACK.ahead * R;
  const cz = p.z + f.z * STACK.ahead * R;
  const n = STACK.samples;
  const N = 2 * n + 1;
  const step = R / n;
  const h = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = cz + (j - n) * step;
    for (let i = 0; i < N; i++) {
      const x = cx + (i - n) * step;
      const g = inside(e, x, z) ? ground(x, z) : -Infinity;
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
  const taken = bonus.map((c) => ({ x: c.x, z: c.z }));
  taken.push({ x: p.x, z: p.z });
  const out = [];
  for (const c of candidates) {
    if (out.length >= want) break;
    if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < STACK.gap)) continue;
    const value = coinValue(s.rows, c.z);
    if (s.rows && !(value > 0)) continue;
    const g = Math.max(c.g, topNear(ground, c.x, c.z));
    const coin = {
      id: s.nextId++, kind: 'bonus', x: c.x, y: g + STACK.hover, z: c.z, row: Math.floor(c.z * 10), value,
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
  const f = forwardXZ(p.yaw);
  const behind = -Math.max(STACK.behindMin, STACK.behind * (p.speed || 0));
  let ahead = 0;
  for (const c of s.coins) {
    if (c.gone != null) continue;
    if (reaches(from, here, c, reach)) {
      c.gone = s.clock;
      c.taken = true;
      s.score += c.value;
      s.collected++;
      out.collected.push(c);
      continue;
    }
    const along = (c.x - p.x) * f.x + (c.z - p.z) * f.z;
    if (s.clock - c.born >= STACK.life || along < behind) c.gone = s.clock;
    else if (c.kind === 'trail' && along > 0) ahead++;
  }
  s.last = here;
  if (s.t >= s.duration) {
    s.t = s.duration;
    stopStackSats(s, { finished: true });
    out.ended = true;
    return out;
  }
  if (s.t >= s.nextTrail && ahead < STACK.trailAhead) {
    const n = spawnTrail(s, p, env.ground, env.extent).length;
    out.spawned += n;
    s.nextTrail = s.t + (n ? STACK.trailEvery : 0.5);
  }
  if (s.t >= s.nextBonus) {
    out.spawned += spawnBonus(s, p, env.ground, env.extent).length;
    s.nextBonus = s.t + STACK.bonusEvery;
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
