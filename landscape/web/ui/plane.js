// Plane mode (landscape/SPEC.md §8): a simple flight model for a small plane over the
// landscape, its chase camera, the gamepad mapping and the readout of the ground below.
// Pure module (no three.js, no DOM) so node --test drives it directly.
//
// Angles follow ui/controls.js: yaw 0 looks toward -z and turning right lowers yaw; pitch > 0
// is nose up. bank > 0 is the right wing down. The plane flies like a plane: the stick (keys,
// mouse or gamepad) rolls it and pitches it, and the bank is what turns it. Sideways stick
// rolls at up to maxRollRate; once banked the plane turns at a rate that grows with the bank
// (tan bank, as a coordinated turn) and shrinks at higher speed. Pulling back while banked
// tightens the turn, since the nose moves along the tilted wings. With the stick centred the
// plane keeps its bank and slowly rolls level (dihedral). Pitch follows flight-sim convention:
// pull back (mouse or stick down, the down arrow) for nose up; camera.invertY switches it.
// The mouse is a joystick that springs back to the centre. There is no engine start, stall,
// fuel or gravity: with the stick centred and the wings level the plane flies straight on.

import { columnBlocks } from '../data/grid.js';
import { rowAmountRange } from '../data/axis.js';
import { fmtInt, fmtAmount, isoUtc } from './format.js';

const DEG = Math.PI / 180;

export const PLANE = Object.freeze({
  minSpeed: 0.25, // world units per second at throttle 0 (about four columns a second)
  maxSpeed: 16, // at throttle 1 (genesis to tip in about a minute)
  // The throttle is logarithmic: speed = minSpeed * (maxSpeed / minSpeed) ^ throttle, so each
  // quarter of the bar multiplies the speed by 2.83 and the slow end stays controllable.
  startThrottle: 0.5, // 2 units/s
  throttleRate: 0.4, // throttle change per second (W/S, full trigger)
  boost: 3, // Shift multiplies the speed
  speedEase: 3, // 1/s: how quickly the speed follows the throttle and boost
  maxRollRate: 80 * DEG, // full sideways stick
  maxBank: 75 * DEG,
  rollStability: 0.3, // 1/s: with the stick centred the bank decays toward level
  maxPitchRate: 35 * DEG, // full stick back or forward, along the plane's own axis
  maxPitch: 70 * DEG,
  turnAt45: 35 * DEG, // turn rate at 45 degrees of bank and turnSpeed units/s
  turnSpeed: 4, // turn rate scales with sqrt(turnSpeed / speed): faster flies wider turns
  maxTurnRate: 75 * DEG,
  inputRamp: 4, // 1/s: keys and the gamepad stick ease in and out
  mouseFullPx: 160, // mouse pixels for full stick deflection (divided by camera.sensitivity)
  mouseReturn: 3, // 1/s: the mouse stick springs back to the centre
  deadStick: 0.02, // below this the stick counts as centred (dihedral levels the wings)
  clearance: 0.15, // above the terrain with collision on
  stepUp: 0.35, // rises up to this are ridden over; taller ones bump
  sweepStep: 0.05, // collision samples along each frame's movement
  maxSamples: 64, // a frame moves at most maxSamples * sweepStep horizontally
  bumpSpeed: 0.5, // speed kept after a bump
  bumpPitch: 15 * DEG, // the nose pitches up to at least this after a bump
  bumpCooldown: 0.4,
  shakeSeconds: 0.25,
  floor: 0.05, // with collision off the plane still stays above the ground plane
  ceiling: 300,
  margin: 30, // the plane may leave the landscape by this much
  spawnHeight: 3,
  modelScale: 0.5, // render/plane-model.js builds a 0.8-unit wingspan; flown at 0.4
  chaseDistance: 2,
  chaseMin: 0.8,
  chaseMax: 40,
  chaseRise: 0.25, // the camera sits this fraction of the distance above the plane
  chaseFollow: 4, // 1/s: the camera swings after the plane's heading and pitch
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

/** Airspeed the plane settles at for a throttle (0..1) and boost: logarithmic between minSpeed and maxSpeed. */
export function speedFor(throttle, boost = false) {
  const s = PLANE.minSpeed * Math.pow(PLANE.maxSpeed / PLANE.minSpeed, clamp(throttle, 0, 1));
  return boost ? s * PLANE.boost : s;
}

/** Turn rate (radians/s, + = right) of a coordinated turn at this bank and speed. */
export function turnRate(bank, speed) {
  const b = clamp(bank, -PLANE.maxBank, PLANE.maxBank);
  const r = PLANE.turnAt45 * Math.tan(b) * Math.sqrt(PLANE.turnSpeed / Math.max(speed, PLANE.minSpeed));
  return clamp(r, -PLANE.maxTurnRate, PLANE.maxTurnRate);
}

/** A plane flying level along yaw at the start throttle (angles in radians). */
export function createPlane({ x = 0, y = PLANE.spawnHeight, z = 0, yaw = 0, pitch = 0, throttle = PLANE.startThrottle } = {}) {
  const p = clamp(pitch, -PLANE.maxPitch, PLANE.maxPitch);
  const w = wrapAngle(yaw);
  return {
    x, y, z,
    yaw: w, pitch: p, bank: 0,
    throttle: clamp(throttle, 0, 1), speed: speedFor(throttle), boosting: false,
    rollIn: 0, pitchIn: 0, // keys and gamepad, eased
    mouseX: 0, mouseY: 0, // the mouse stick, springing back to the centre
    roll: 0, pull: 0, // the combined stick this frame: roll + = right, pull + = nose up
    camYaw: w, camPitch: p, // the chase camera's direction, following the plane
    cooldown: 0, shake: 0, bumps: 0, time: 0,
  };
}

/**
 * Mouse movement in pixels moves the mouse stick: right banks right, down (pulling back)
 * raises the nose; invertY flips the vertical. The stick springs back in stepPlane.
 */
export function stickByMouse(p, dx, dy, { sensitivity = 1, invertY = false } = {}) {
  const k = Math.max(0.05, sensitivity) / PLANE.mouseFullPx;
  p.mouseX = clamp(p.mouseX + dx * k, -1, 1);
  p.mouseY = clamp(p.mouseY + dy * k * (invertY ? -1 : 1), -1, 1);
}

/**
 * Advance the plane by dt seconds.
 * input: { roll: -1..1 (+ banks right), pitch: -1..1 (+ pulls back, nose up), throttle: -1..1
 * (rate), boost }. Keys and the gamepad ease toward the input at inputRamp per second; the
 * mouse stick (stickByMouse) adds to them.
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

  // The stick: eased keys or gamepad plus the mouse stick, which springs back to the centre.
  const ramp = PLANE.inputRamp * h;
  const toward = (v, target) => (target > v ? Math.min(target, v + ramp) : Math.max(target, v - ramp));
  p.rollIn = toward(p.rollIn || 0, clamp(Number(input.roll) || 0, -1, 1));
  p.pitchIn = toward(p.pitchIn || 0, clamp(Number(input.pitch) || 0, -1, 1));
  const spring = Math.exp(-PLANE.mouseReturn * h);
  p.roll = clamp(p.rollIn + p.mouseX, -1, 1);
  p.pull = clamp(p.pitchIn + p.mouseY, -1, 1);
  p.mouseX *= spring;
  p.mouseY *= spring;
  if (Math.abs(p.mouseX) < 1e-4) p.mouseX = 0;
  if (Math.abs(p.mouseY) < 1e-4) p.mouseY = 0;

  p.throttle = clamp(p.throttle + clamp(Number(input.throttle) || 0, -1, 1) * PLANE.throttleRate * h, 0, 1);
  p.boosting = !!input.boost;
  p.speed += (speedFor(p.throttle, p.boosting) - p.speed) * (1 - Math.exp(-PLANE.speedEase * h));

  // Roll: the sideways stick sets the roll rate; centred, the wings slowly come level.
  if (Math.abs(p.roll) > PLANE.deadStick) p.bank += p.roll * PLANE.maxRollRate * h;
  else p.bank *= Math.exp(-PLANE.rollStability * h);
  p.bank = clamp(p.bank, -PLANE.maxBank, PLANE.maxBank);

  // Turn: the bank turns the plane; pulling back moves the nose along the tilted wings, so it
  // raises the nose when level and tightens the turn when banked.
  const q = p.pull * PLANE.maxPitchRate;
  p.yaw = wrapAngle(p.yaw - (turnRate(p.bank, p.speed) + q * Math.sin(p.bank)) * h);
  p.pitch = clamp(p.pitch + q * Math.cos(p.bank) * h, -PLANE.maxPitch, PLANE.maxPitch);

  // The chase camera swings after the plane.
  const follow = 1 - Math.exp(-PLANE.chaseFollow * h);
  p.camYaw = wrapAngle(p.camYaw + wrapAngle(p.yaw - p.camYaw) * follow);
  p.camPitch += (p.pitch - p.camPitch) * follow;

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
    p.pitch = Math.max(p.pitch, PLANE.bumpPitch);
    p.cooldown = PLANE.bumpCooldown;
    p.shake = PLANE.shakeSeconds;
    p.bumps++;
    return { bumped: true };
  }
  return { bumped: false };
}

/**
 * Chase camera: behind the plane along the camera direction (which swings after the plane's
 * heading and pitch), raised by chaseRise times the distance and kept above the terrain.
 * Angles in radians; no roll, so the horizon stays level and the plane's bank shows.
 */
export function chasePose(p, distance = PLANE.chaseDistance, ground = null) {
  const d = clamp(distance, PLANE.chaseMin, PLANE.chaseMax);
  const yaw = p.camYaw ?? p.yaw;
  const pitch = p.camPitch ?? p.pitch;
  const f = forward(yaw, pitch);
  const pose = { x: p.x - f.x * d, y: p.y - f.y * d + d * PLANE.chaseRise, z: p.z - f.z * d, yaw, pitch };
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
 * A standard-mapping gamepad as plane input: the left stick rolls and pitches (dead zone
 * rescaled, then squared for fine control near the centre; pull back for nose up), RT/LT move
 * the throttle, A boosts, Start toggles plane mode and B leaves it. null when absent.
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
    roll: axis(0),
    pitch: axis(1) * (invertY ? -1 : 1), // axis 1 is + when the stick is pulled back
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

/** Controls card rows [keys HTML, action] for the pitch convention (invertY = push up for nose up) and the sound state. */
export function planeKeyRows({ invertY = false, muted = false } = {}) {
  return [
    ['Mouse', invertY ? 'Stick \u00b7 sideways banks \u00b7 up raises the nose' : 'Stick \u00b7 sideways banks \u00b7 back raises the nose'],
    [kbd('A') + kbd('D') + ' ' + kbd('\u2190') + kbd('\u2192'), 'Bank left \u00b7 right (banking turns)'],
    [invertY ? kbd('\u2191') + kbd('\u2193') : kbd('\u2193') + kbd('\u2191'), 'Nose up \u00b7 down (back in a bank: tighter turn)'],
    [kbd('W') + kbd('S'), 'Faster \u00b7 slower'],
    [kbd('Shift'), 'Boost'],
    ['Wheel', 'Camera closer \u00b7 farther'],
    [kbd('M'), muted ? 'Sound off' : 'Sound on'],
    [kbd('Esc') + ' ' + kbd('T'), 'Land in map mode'],
  ];
}
