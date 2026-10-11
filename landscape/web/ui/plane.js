// Plane mode (landscape/SPEC.md §8): an arcade flight model for a small plane over the
// landscape, its chase camera, the gamepad mapping and the readout of the ground below.
// Pure module (no three.js, no DOM) so node --test drives it directly.
//
// Angles follow ui/controls.js: yaw 0 looks toward -z and turning right lowers yaw; pitch > 0
// climbs. bank > 0 is the right wing down. The player moves an aim direction (mouse, keys,
// gamepad); the plane turns toward it at a limited rate and banks with the turn. There is no
// engine start, stall, fuel or gravity: with no input the plane flies straight on. Pitch
// follows flight-sim convention: pull back (mouse or stick down, the down arrow) to climb;
// camera.invertY switches to push-up-to-climb.

import { columnBlocks } from '../data/grid.js';
import { rowAmountRange } from '../data/axis.js';
import { fmtInt, fmtAmount, isoUtc } from './format.js';

const DEG = Math.PI / 180;

export const PLANE = Object.freeze({
  minSpeed: 1, // world units per second at throttle 0
  maxSpeed: 16, // at throttle 1 (genesis to tip in about a minute)
  startThrottle: 0.2, // 4 units/s
  throttleRate: 0.4, // throttle change per second (W/S, full trigger)
  boost: 3, // Shift multiplies the speed
  speedEase: 3, // 1/s: how quickly the speed follows the throttle and boost
  turnGain: 1.5, // 1/s: yaw rate per radian of yaw error
  maxTurnRate: 55 * DEG,
  pitchGain: 2,
  maxPitchRate: 40 * DEG,
  maxBank: 55 * DEG,
  bankEase: 4,
  maxAimPitch: 70 * DEG,
  maxAimLead: 60 * DEG, // the aim stays within this of the plane's heading
  keyTurnRate: 45 * DEG, // A/D, arrows, full stick
  keyPitchRate: 30 * DEG,
  inputRamp: 4, // 1/s: keys and the stick ease in and out instead of jumping to full rate
  mouseRadPerPx: 0.001, // times camera.sensitivity (half of flight-mode mouse look)
  clearance: 0.15, // above the terrain with collision on
  stepUp: 0.35, // rises up to this are ridden over; taller ones bump
  sweepStep: 0.05, // collision samples along each frame's movement
  maxSamples: 64, // a frame moves at most maxSamples * sweepStep horizontally
  bumpSpeed: 0.5, // speed kept after a bump
  bumpAimPitch: 15 * DEG, // the aim pitches up to at least this after a bump
  bumpCooldown: 0.4,
  shakeSeconds: 0.25,
  floor: 0.05, // with collision off the plane still stays above the ground plane
  ceiling: 300,
  margin: 30, // the plane may leave the landscape by this much
  spawnHeight: 3,
  chaseDistance: 2.6,
  chaseMin: 1.5,
  chaseMax: 40,
  chaseRise: 0.25, // the camera sits this fraction of the distance above the plane
  cameraClearance: 0.08,
  gamepadDeadZone: 0.15,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a) {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

/** Unit direction for a yaw/pitch pair (radians), as forwardOf in ui/controls.js. */
export function forward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Airspeed the plane settles at for a throttle (0..1) and boost. */
export function speedFor(throttle, boost = false) {
  const s = PLANE.minSpeed + clamp(throttle, 0, 1) * (PLANE.maxSpeed - PLANE.minSpeed);
  return boost ? s * PLANE.boost : s;
}

/** A plane flying level along yaw at the start throttle (angles in radians). */
export function createPlane({ x = 0, y = PLANE.spawnHeight, z = 0, yaw = 0, pitch = 0, throttle = PLANE.startThrottle } = {}) {
  const p = clamp(pitch, -PLANE.maxAimPitch, PLANE.maxAimPitch);
  return {
    x, y, z,
    yaw: wrapAngle(yaw), pitch: p, bank: 0,
    aimYaw: wrapAngle(yaw), aimPitch: p,
    throttle: clamp(throttle, 0, 1), speed: speedFor(throttle), boosting: false,
    turnIn: 0, climbIn: 0, cooldown: 0, shake: 0, bumps: 0, time: 0,
  };
}

function clampAim(p) {
  p.aimPitch = clamp(p.aimPitch, -PLANE.maxAimPitch, PLANE.maxAimPitch);
  const lead = clamp(wrapAngle(p.aimYaw - p.yaw), -PLANE.maxAimLead, PLANE.maxAimLead);
  p.aimYaw = wrapAngle(p.yaw + lead);
}

/** Move the aim by dYaw/dPitch radians (dYaw < 0 turns right). */
export function steerAim(p, dYaw, dPitch) {
  // Clamp the lead before wrapping, so a large move cannot wrap round to the other side.
  const lead = clamp(wrapAngle(p.aimYaw - p.yaw) + dYaw, -PLANE.maxAimLead, PLANE.maxAimLead);
  p.aimYaw = wrapAngle(p.yaw + lead);
  p.aimPitch = clamp(p.aimPitch + dPitch, -PLANE.maxAimPitch, PLANE.maxAimPitch);
}

/** Mouse movement in pixels: right turns right, down (pulling back) climbs; invertY flips it. */
export function aimByMouse(p, dx, dy, { sensitivity = 1, invertY = false } = {}) {
  const k = PLANE.mouseRadPerPx * sensitivity;
  steerAim(p, -dx * k, dy * k * (invertY ? -1 : 1));
}

/** Step toward target: exponential with gain (1/s), at most maxRate * dt. */
function approach(value, target, gain, maxRate, dt) {
  return clamp((target - value) * (1 - Math.exp(-gain * dt)), -maxRate * dt, maxRate * dt);
}

/**
 * Advance the plane by dt seconds.
 * input: { throttle: -1..1 (rate), turn: -1..1 (+ right), climb: -1..1 (+ up), boost }; turn
 * and climb ease toward the input at inputRamp per second.
 * env: { ground(x, z) -> terrain height, collision (bool), bounds: {minX, maxX, minZ, maxZ} }.
 * Returns { bumped } (true when a bump started this step).
 */
export function stepPlane(p, input = {}, dt = 0, env = {}) {
  const h = clamp(Number(dt) || 0, 0, 0.1);
  if (!(h > 0)) return { bumped: false };
  const ground = typeof env.ground === 'function' ? env.ground : () => 0;
  const groundAt = (x, z) => {
    const g = ground(x, z);
    return Number.isFinite(g) ? g : 0;
  };
  const collision = env.collision !== false;
  p.time += h;
  p.cooldown = Math.max(0, p.cooldown - h);
  p.shake = Math.max(0, p.shake - h);

  // Keys and sticks move the aim (eased in and out); the throttle and boost set the speed.
  const ramp = PLANE.inputRamp * h;
  const toward = (v, target) => (target > v ? Math.min(target, v + ramp) : Math.max(target, v - ramp));
  p.turnIn = toward(p.turnIn || 0, clamp(Number(input.turn) || 0, -1, 1));
  p.climbIn = toward(p.climbIn || 0, clamp(Number(input.climb) || 0, -1, 1));
  if (p.turnIn || p.climbIn) steerAim(p, -p.turnIn * PLANE.keyTurnRate * h, p.climbIn * PLANE.keyPitchRate * h);
  p.throttle = clamp(p.throttle + clamp(Number(input.throttle) || 0, -1, 1) * PLANE.throttleRate * h, 0, 1);
  p.boosting = !!input.boost;
  p.speed += (speedFor(p.throttle, p.boosting) - p.speed) * (1 - Math.exp(-PLANE.speedEase * h));

  // Turn toward the aim; bank with the turn.
  const yawStep = approach(0, wrapAngle(p.aimYaw - p.yaw), PLANE.turnGain, PLANE.maxTurnRate, h);
  p.yaw = wrapAngle(p.yaw + yawStep);
  p.pitch = clamp(p.pitch + approach(p.pitch, p.aimPitch, PLANE.pitchGain, PLANE.maxPitchRate, h), -PLANE.maxAimPitch, PLANE.maxAimPitch);
  const bankTarget = -PLANE.maxBank * clamp(yawStep / h / PLANE.maxTurnRate, -1, 1);
  p.bank += (bankTarget - p.bank) * (1 - Math.exp(-PLANE.bankEase * h));
  clampAim(p);

  // Move. A frame never moves farther horizontally than the collision sweep covers, so a slow
  // frame slows the plane rather than letting it skip a thin tower.
  const f = forward(p.yaw, p.pitch);
  let dist = p.speed * h;
  const horiz = Math.hypot(f.x, f.z) * dist;
  const maxHoriz = PLANE.maxSamples * PLANE.sweepStep;
  if (horiz > maxHoriz) dist *= maxHoriz / horiz;
  const b = env.bounds || { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  const toX = clamp(p.x + f.x * dist, b.minX - PLANE.margin, b.maxX + PLANE.margin);
  const toZ = clamp(p.z + f.z * dist, b.minZ - PLANE.margin, b.maxZ + PLANE.margin);
  const toY = Math.min(p.y + f.y * dist, PLANE.ceiling);

  if (!collision) {
    p.x = toX;
    p.z = toZ;
    p.y = Math.max(toY, PLANE.floor);
    return { bumped: false };
  }

  // The terrain may have risen under the plane (playback, a seek): lift at once.
  const start = groundAt(p.x, p.z) + PLANE.clearance;
  if (p.y < start) p.y = start;

  // Sweep the move: ride over small rises, stop at tall ones. A rise is measured from the
  // plane's height at the previous sample, so diving onto flat ground skims instead of bumping.
  const dx = toX - p.x;
  const dz = toZ - p.z;
  const n = Math.min(PLANE.maxSamples, Math.max(1, Math.ceil(Math.hypot(dx, dz) / PLANE.sweepStep)));
  const dy = (toY - p.y) / n;
  let cx = p.x;
  let cz = p.z;
  let cy = p.y;
  let hit = false;
  for (let i = 1; i <= n; i++) {
    const sx = p.x + (dx * i) / n;
    const sz = p.z + (dz * i) / n;
    const need = groundAt(sx, sz) + PLANE.clearance;
    let sy = cy + dy;
    if (sy < need) {
      if (need - cy > PLANE.stepUp) {
        hit = true;
        break;
      }
      sy = need;
    }
    cx = sx;
    cz = sz;
    cy = Math.min(sy, PLANE.ceiling);
  }
  p.x = cx;
  p.z = cz;
  p.y = cy;
  if (hit && p.cooldown <= 0) {
    p.speed *= PLANE.bumpSpeed;
    p.aimPitch = Math.max(p.aimPitch, PLANE.bumpAimPitch);
    clampAim(p);
    p.cooldown = PLANE.bumpCooldown;
    p.shake = PLANE.shakeSeconds;
    p.bumps++;
    return { bumped: true };
  }
  return { bumped: false };
}

/**
 * Chase camera: looking along the aim from behind the plane, raised by chaseRise times the
 * distance and kept above the terrain. Angles in radians; no roll.
 */
export function chasePose(p, distance = PLANE.chaseDistance, ground = null) {
  const d = clamp(distance, PLANE.chaseMin, PLANE.chaseMax);
  const f = forward(p.aimYaw, p.aimPitch);
  const pose = { x: p.x - f.x * d, y: p.y - f.y * d + d * PLANE.chaseRise, z: p.z - f.z * d, yaw: p.aimYaw, pitch: p.aimPitch };
  if (typeof ground === 'function') {
    const g = ground(pose.x, pose.z);
    if (Number.isFinite(g)) pose.y = Math.max(pose.y, g + PLANE.cameraClearance);
  }
  return pose;
}

/** Camera offset (x right, y up, world units) for the bump shake; zero once it has settled. */
export function shakeOffset(p, distance = PLANE.chaseDistance) {
  if (!(p.shake > 0)) return { x: 0, y: 0 };
  const a = 0.04 * clamp(distance, PLANE.chaseMin, PLANE.chaseMax) * (p.shake / PLANE.shakeSeconds);
  return { x: a * Math.sin(p.time * 91), y: a * Math.cos(p.time * 73) };
}

/**
 * A standard-mapping gamepad as plane input: the left stick aims (dead zone rescaled, then
 * squared for fine control near the centre; pull back to climb), RT/LT move the throttle,
 * A boosts, Start toggles plane mode and B leaves it. null when absent.
 */
export function gamepadInput(gp, { deadZone = PLANE.gamepadDeadZone, invertY = false } = {}) {
  if (!gp || gp.connected === false) return null;
  const axis = (i) => {
    const v = Number(gp.axes && gp.axes[i]) || 0;
    const a = Math.abs(v);
    if (a <= deadZone) return 0;
    const r = (Math.min(1, a) - deadZone) / (1 - deadZone);
    return Math.sign(v) * r * r;
  };
  const button = (i) => {
    const btn = gp.buttons && gp.buttons[i];
    if (btn == null) return 0;
    if (typeof btn === 'object') return Number(btn.value) || (btn.pressed ? 1 : 0);
    return Number(btn) || 0;
  };
  return {
    turn: axis(0),
    climb: axis(1) * (invertY ? -1 : 1), // axis 1 is + when the stick is pulled back
    throttle: button(7) - button(6),
    boost: button(0) > 0.5,
    start: button(9) > 0.5,
    exit: button(1) > 0.5,
  };
}

/**
 * One line about the ground under (x, z): the 64-block column with its UTC date and the
 * amount of the row. grid from data/grid.js, rows = rows.bin (minAmt), blocktimes in seconds,
 * block = the replayed block (columns created after it are not there yet).
 */
export function groundReadout(x, z, { grid, rows, blocktimes, block } = {}) {
  if (!grid || !(x >= 0) || !(z >= 0)) return 'Outside the landscape';
  const col = Math.floor((x * 1000) / grid.blocksPerColumn);
  const row = Math.floor(z * 10);
  if (col * grid.blocksPerColumn >= grid.numBlocks || row >= grid.rows) return 'Outside the landscape';
  const [first, last] = columnBlocks(grid, col);
  const parts = ['Blocks ' + fmtInt(first) + '\u2013' + fmtInt(last)];
  const t = blocktimes ? blocktimes[first] : NaN;
  if (Number.isFinite(t)) parts.push(isoUtc(t, { time: false }));
  const r = rows ? rowAmountRange(rows, row) : null;
  if (r) {
    if (r.max === Infinity) parts.push('\u2265 ' + fmtAmount(r.min));
    else if (r.min === r.max) parts.push(fmtAmount(r.min));
    else parts.push(fmtAmount(r.min) + '\u2013' + fmtAmount(r.max));
  }
  if (Number.isInteger(block) && first > block) parts.push('not created yet at block ' + fmtInt(block));
  return parts.join(' \u00b7 ');
}

const kbd = (k) => '<kbd>' + k + '</kbd>';

/** Controls card rows [keys HTML, action] for the pitch convention (invertY = push up to climb) and the sound state. */
export function planeKeyRows({ invertY = false, muted = false } = {}) {
  return [
    ['Mouse', invertY ? 'Steer \u00b7 push up to climb' : 'Steer \u00b7 pull back to climb'],
    [kbd('A') + kbd('D') + ' ' + kbd('\u2190') + kbd('\u2192'), 'Turn'],
    [invertY ? kbd('\u2191') + kbd('\u2193') : kbd('\u2193') + kbd('\u2191'), 'Climb \u00b7 dive'],
    [kbd('W') + kbd('S'), 'Faster \u00b7 slower'],
    [kbd('Shift'), 'Boost'],
    ['Wheel', 'Camera closer \u00b7 farther'],
    [kbd('M'), muted ? 'Sound off' : 'Sound on'],
    [kbd('Esc') + ' ' + kbd('T'), 'Land in map mode'],
  ];
}
