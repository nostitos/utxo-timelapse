// Plane mode flight model (landscape/web/ui/plane.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANE, createPlane, stepPlane, stickByMouse, chasePose, shakeOffset, gamepadInput, groundReadout,
  speedFor, turnRate, wrapAngle, planeKeyRows,
} from '../web/ui/plane.js';
import { gridFromManifest } from '../web/data/grid.js';
import { buildMinAmtTable } from '../web/data/axis.js';
import { engineTargets } from '../web/ui/plane-sound.js';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const flat = () => 0;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ': ' + a + ' vs ' + b);

function fly(p, seconds, { input = {}, env = {}, dt = DT, until = null } = {}) {
  const e = { ground: flat, collision: true, ...env };
  let bumped = false;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const r = stepPlane(p, input, dt, e);
    if (r.bumped) bumped = true;
    if (until && until(p, r)) break;
  }
  return bumped;
}

test('with the stick centred and the wings level the plane flies straight at the throttle speed', () => {
  const p = createPlane({ x: 100, y: 5, z: 100, yaw: 0 });
  near(p.speed, 4, 1e-9, 'start speed');
  fly(p, 2);
  near(p.x, 100, 1e-9, 'x');
  near(p.y, 5, 1e-9, 'y');
  near(p.z, 100 - 8, 1e-6, 'z: 2 s at 4 units/s toward -z');
  assert.equal(p.yaw, 0);
  assert.equal(p.bank, 0);
});

test('throttle and boost set the speed: 1 to 16 units/s, Shift 3x', () => {
  assert.equal(speedFor(0), 1);
  assert.equal(speedFor(1), 16);
  assert.equal(speedFor(1, true), 48);
  const p = createPlane({ y: 5 });
  fly(p, 2, { input: { throttle: 1 } });
  near(p.throttle, 1, 1e-9, 'W for 2 s reaches full throttle (0.4/s)');
  fly(p, 3, { input: { boost: true } });
  near(p.speed, 48, 0.1, 'boost settles at 3x');
  fly(p, 5, { input: { throttle: -1 } });
  assert.equal(p.throttle, 0);
  near(p.speed, 1, 0.1, 'S slows to the minimum; the plane never stops or falls');
});

test('bank to turn: sideways stick rolls first, and the turn only builds with the bank', () => {
  const p = createPlane({ y: 20, yaw: 0 });
  fly(p, 0.2, { input: { roll: 1 } });
  assert.ok(p.bank > 4 * DEG, 'banked right after 0.2 s (' + (p.bank / DEG).toFixed(1) + ' deg)');
  assert.ok(Math.abs(p.yaw) < 0.5 * DEG, 'heading has barely moved (' + (p.yaw / DEG).toFixed(2) + ' deg)');
  // Keep rolling to about 30 degrees, then centre the stick: the plane keeps turning right.
  fly(p, 2, { input: { roll: 1 }, until: (q) => q.bank >= 30 * DEG });
  const bank = p.bank;
  const yaw0 = p.yaw;
  fly(p, 1);
  assert.ok(p.yaw < yaw0 - 10 * DEG, 'banked, the plane turns right with the stick centred (' + ((yaw0 - p.yaw) / DEG).toFixed(1) + ' deg in 1 s)');
  assert.ok(p.bank > 0.6 * bank, 'and keeps most of its bank (' + (p.bank / DEG).toFixed(1) + ' of ' + (bank / DEG).toFixed(1) + ' deg)');
  // Level wings, no turn: rolling back left stops the turn.
  fly(p, 2, { input: { roll: -1 }, until: (q) => q.bank <= 0 });
  fly(p, 0.3); // the key eases out
  p.bank = 0;
  const yaw1 = p.yaw;
  fly(p, 1);
  near(p.yaw, yaw1, 1e-12, 'wings level: no turn');
  // Rolling left turns left.
  fly(p, 1, { input: { roll: -1 } });
  const yaw2 = p.yaw;
  fly(p, 0.5);
  assert.ok(p.yaw > yaw2, 'left bank turns left');
});

test('the turn follows the bank like a coordinated turn and widens at speed', () => {
  near(turnRate(45 * DEG, 4), 35 * DEG, 1e-12, '45 deg at 4 units/s');
  assert.ok(turnRate(20 * DEG, 4) < turnRate(45 * DEG, 4), 'more bank, faster turn');
  near(turnRate(-45 * DEG, 4), -35 * DEG, 1e-12, 'left');
  near(turnRate(45 * DEG, 16), 17.5 * DEG, 1e-12, 'four times the speed: half the rate');
  assert.equal(turnRate(0, 4), 0);
  assert.ok(turnRate(75 * DEG, 1) <= PLANE.maxTurnRate + 1e-12, 'capped');
});

test('centred stick: the bank holds for a while and the wings slowly come level', () => {
  const p = createPlane({ y: 50 });
  p.bank = 40 * DEG;
  fly(p, 1);
  assert.ok(p.bank > 28 * DEG, 'after 1 s (' + (p.bank / DEG).toFixed(1) + ' deg)');
  fly(p, 9);
  assert.ok(p.bank < 3 * DEG, 'after 10 s (' + (p.bank / DEG).toFixed(1) + ' deg)');
});

test('pitch: back raises the nose when level, and tightens the turn when banked', () => {
  const p = createPlane({ y: 50 });
  fly(p, 0.5, { input: { pitch: 1 } });
  assert.ok(p.pitch > 10 * DEG, 'nose up (' + (p.pitch / DEG).toFixed(1) + ' deg)');
  assert.ok(Math.abs(p.yaw) < 1e-9, 'no turn when level');
  const a = createPlane({ y: 50 });
  a.bank = 60 * DEG;
  const b = createPlane({ y: 50 });
  b.bank = 60 * DEG;
  fly(a, 0.5);
  fly(b, 0.5, { input: { pitch: 1 } });
  assert.ok(b.yaw < a.yaw - 3 * DEG, 'pulling back in a right bank turns tighter (' + ((a.yaw - b.yaw) / DEG).toFixed(1) + ' deg more)');
  assert.ok(b.pitch < p.pitch, 'and raises the nose less than when level');
  const d = createPlane({ y: 50 });
  fly(d, 0.5, { input: { pitch: -1 } });
  assert.ok(d.pitch < -10 * DEG, 'forward lowers the nose');
});

test('limits: bank 75 deg, pitch 70 deg, ceiling 300', () => {
  const p = createPlane({ y: 299 });
  fly(p, 3, { input: { roll: 1, pitch: 1 } });
  near(p.bank, 75 * DEG, 1e-12, 'bank');
  assert.ok(p.pitch <= 70 * DEG + 1e-12, 'pitch');
  assert.ok(p.y <= PLANE.ceiling, 'ceiling (y ' + p.y + ')');
  const q = createPlane({ y: 50 });
  fly(q, 4, { input: { pitch: 1 } });
  near(q.pitch, 70 * DEG, 1e-12, 'pitch limit when level');
});

test('the mouse is a stick that springs back: right banks right, down raises the nose', () => {
  const p = createPlane({ y: 50 });
  stickByMouse(p, 80, 0);
  near(p.mouseX, 0.5, 1e-12, '80 px is half the stick');
  stickByMouse(p, 400, 0);
  assert.equal(p.mouseX, 1, 'clamped at full');
  stepPlane(p, {}, DT, {});
  assert.ok(p.bank > 0 && p.roll === 1, 'banks right');
  fly(p, 1.5);
  assert.ok(Math.abs(p.mouseX) < 0.02, 'sprung back to the centre (' + p.mouseX + ')');
  const bank = p.bank;
  fly(p, 0.2);
  assert.ok(p.bank > 0.9 * bank, 'the bank stays once the stick is centred');
  const q = createPlane({ y: 50 });
  stickByMouse(q, 0, 160);
  stepPlane(q, {}, DT, {});
  assert.ok(q.pitch > 0, 'mouse down (pulling back) raises the nose');
  const r = createPlane({ y: 50 });
  stickByMouse(r, 0, 160, { invertY: true });
  stepPlane(r, {}, DT, {});
  assert.ok(r.pitch < 0, 'invertY flips it');
  const s = createPlane({ y: 50 });
  stickByMouse(s, 80, 0, { sensitivity: 2 });
  near(s.mouseX, 1, 1e-12, 'camera.sensitivity scales it');
});

test('keys ease in and out over a quarter second', () => {
  const k = createPlane({ y: 50 });
  stepPlane(k, { roll: 1, pitch: 1 }, 0.1, {});
  near(k.rollIn, 0.4, 1e-12, 'eased in');
  near(k.bank, 0.4 * 80 * DEG * 0.1, 1e-12, 'first 0.1 s: 40% of 80 deg/s');
  for (let i = 0; i < 15; i++) stepPlane(k, { roll: 1 }, 1 / 60, {});
  near(k.rollIn, 1, 1e-12, 'full after 0.25 s');
  for (let i = 0; i < 6; i++) stepPlane(k, {}, 0.05, {});
  assert.equal(k.rollIn, 0, 'eased out after release');
  assert.equal(k.pitchIn, 0);
});

test('a 0.2 rise is ridden over', () => {
  const ground = (x, z) => (z < -2 ? 0.2 : 0);
  const p = createPlane({ y: PLANE.clearance, yaw: 0 });
  const bumped = fly(p, 2, { env: { ground } });
  assert.equal(bumped, false);
  assert.ok(p.z < -5, 'passed the step (z ' + p.z + ')');
  near(p.y, 0.2 + PLANE.clearance, 1e-9, 'rides at the clearance');
});

test('diving onto flat ground skims instead of bumping', () => {
  const p = createPlane({ y: 6, yaw: 0, throttle: 1, pitch: -60 * DEG });
  const bumped = fly(p, 3, { input: { boost: true } });
  assert.equal(bumped, false);
  near(p.y, PLANE.clearance, 1e-9, 'kept at the clearance');
  assert.ok(p.z < -20, 'still moving (z ' + p.z + ')');
});

test('a 10-unit tower bumps: stop at the tower, half speed, nose up, cooldown', () => {
  const ground = (x, z) => (z < -2 ? 10 : 0);
  const p = createPlane({ y: 3, yaw: 0 });
  let bump = null;
  for (let i = 0; i < 120 && !bump; i++) {
    const before = p.speed;
    if (stepPlane(p, {}, DT, { ground }).bumped) bump = { before, after: p.speed, z: p.z };
  }
  assert.ok(bump, 'bumped');
  assert.ok(bump.z >= -2, 'stopped at the tower (z ' + bump.z + ')');
  assert.ok(bump.after <= bump.before * 0.5 + 0.2, 'speed halved (' + bump.before.toFixed(2) + ' -> ' + bump.after.toFixed(2) + ')');
  assert.ok(p.pitch >= 15 * DEG - 1e-12, 'nose pitched up');
  assert.equal(p.bumps, 1);
  assert.ok(p.shake > 0 && p.cooldown > 0);
  // Within the 0.4 s cooldown the tower still blocks, but no second bump starts.
  p.pitch = 0;
  fly(p, 0.2, { env: { ground } });
  assert.equal(p.bumps, 1, 'cooldown');
  assert.ok(p.z >= -2, 'the tower still blocks');
  const s = shakeOffset(p);
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
});

test('a thin tower is caught at boost speed, even on a slow frame', () => {
  const thin = (x, z) => (z <= -5 && z > -5.064 ? 10 : 0);
  for (const dt of [DT, 0.1]) {
    const p = createPlane({ y: 3, yaw: 0, throttle: 1 });
    p.boosting = true;
    p.speed = speedFor(1, true);
    const bumped = fly(p, 2, { dt, input: { boost: true, throttle: 1 }, env: { ground: thin }, until: (_, r) => r.bumped });
    assert.ok(bumped, 'caught at dt ' + dt);
    assert.ok(p.z > -5, 'stopped in front of it at dt ' + dt + ' (z ' + p.z + ')');
  }
});

test('terrain rising under the plane lifts it at once', () => {
  let h = 0;
  const p = createPlane({ y: 1, yaw: 0 });
  h = 4;
  stepPlane(p, {}, DT, { ground: () => h });
  assert.ok(p.y >= 4 + PLANE.clearance, 'lifted (y ' + p.y + ')');
});

test('collision off: through towers, still above the floor; bounds hold', () => {
  const wall = (x, z) => (z < -2 ? 10 : 0);
  const p = createPlane({ y: 3, yaw: 0 });
  const bumped = fly(p, 2, { env: { ground: wall, collision: false } });
  assert.equal(bumped, false);
  assert.ok(p.z < -5, 'passed through (z ' + p.z + ')');
  const d = createPlane({ y: 3, yaw: 0, pitch: -60 * DEG });
  fly(d, 4, { env: { collision: false } });
  near(d.y, PLANE.floor, 1e-12, 'floor');
  const b = createPlane({ x: 5, y: 3, z: 5, yaw: 90 * DEG });
  const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  fly(b, 10, { input: { throttle: 1 }, env: { bounds } });
  assert.equal(b.x, -PLANE.margin, 'held 30 units beyond the edge');
  near(b.z, 5, 1e-9, 'slides along the bound');
});

test('chase camera: behind and above the plane, swinging after it in a turn, above the terrain', () => {
  const p = createPlane({ x: 10, y: 3, z: 10, yaw: 0 });
  const c = chasePose(p);
  near(c.x, 10, 1e-12, 'x');
  near(c.z, 10 + PLANE.chaseDistance, 1e-12, 'behind (+z when heading -z)');
  near(c.y, 3 + PLANE.chaseDistance * PLANE.chaseRise, 1e-12, 'raised');
  p.bank = 45 * DEG;
  fly(p, 0.5);
  assert.ok(p.camYaw < 0 && p.camYaw > p.yaw, 'the camera turns after the plane (' + (p.camYaw / DEG).toFixed(1) + ' vs ' + (p.yaw / DEG).toFixed(1) + ')');
  const turn = p.yaw;
  p.bank = 0;
  fly(p, 2);
  near(p.camYaw, turn, 0.1 * DEG, 'and catches up once the turn ends');
  const high = chasePose(p, 100, () => 50);
  near(high.y, 50 + PLANE.cameraClearance, 1e-12, 'kept above the terrain');
  near(Math.hypot(high.x - p.x, high.z - p.z), PLANE.chaseMax, 1e-6, 'distance clamped to 40');
});

test('gamepad: left stick banks and pitches (pull back for nose up), triggers throttle, A boost, Start, B', () => {
  const btn = (value) => ({ pressed: value > 0.5, value });
  const buttons = Array.from({ length: 17 }, () => btn(0));
  buttons[0] = btn(1);
  buttons[6] = btn(0.25);
  buttons[7] = btn(1);
  buttons[9] = btn(1);
  const gp = { connected: true, mapping: 'standard', axes: [0.1, 1, 0, 0], buttons };
  const g = gamepadInput(gp);
  assert.equal(g.roll, 0, 'inside the dead zone');
  near(g.pitch, 1, 1e-12, 'stick pulled back: nose up');
  near(gamepadInput({ ...gp, axes: [0, -1] }).pitch, -1, 1e-12, 'stick pushed forward: nose down');
  near(g.throttle, 0.75, 1e-12, 'RT - LT');
  assert.equal(g.boost, true);
  assert.equal(g.start, true);
  assert.equal(g.exit, false);
  near(gamepadInput({ ...gp, axes: [0.575, 0] }).roll, 0.25, 1e-12, 'rescaled past the dead zone, then squared');
  near(gamepadInput({ ...gp, axes: [-1, 0] }).roll, -1, 1e-12, 'full left');
  near(gamepadInput(gp, { invertY: true }).pitch, -1, 1e-12, 'invertY');
  assert.equal(gamepadInput(null), null);
  assert.equal(gamepadInput({ ...gp, connected: false }), null);
});

test('readout: the column, its date and the row amount under the plane', () => {
  const grid = gridFromManifest({ numBlocks: 330001, tip: 330000 });
  const rows = buildMinAmtTable();
  const blocktimes = new Float64Array(330001).map((_, i) => 1231006505 + i * 600);
  const text = groundReadout(210.01, 0.05, { grid, rows, blocktimes, block: 330000 });
  assert.match(text, /^Blocks 209,984\u2013210,047 \u00b7 \d{4}-\d{2}-\d{2} \u00b7 \u2265 /);
  assert.ok(!text.includes('not created'));
  assert.match(groundReadout(210.01, 0.05, { grid, rows, blocktimes, block: 100000 }), /not created yet at block 100,000$/);
  assert.match(groundReadout(10, 207.15, { grid, rows, blocktimes, block: 1 }), / \u00b7 1 sat \u00b7 /);
  assert.equal(groundReadout(-1, 5, { grid, rows, blocktimes }), 'Outside the landscape');
  assert.equal(groundReadout(400, 5, { grid, rows, blocktimes }), 'Outside the landscape');
});

test('engine sound follows the throttle, boost, airspeed and bank; silent when off', () => {
  const idle = engineTargets({ throttle: 0.2, speed: 4 });
  const full = engineTargets({ throttle: 1, speed: 16 });
  const boost = engineTargets({ throttle: 1, speed: 48, boost: true });
  assert.ok(idle.freq < full.freq && full.freq < boost.freq, 'pitch rises: ' + [idle, full, boost].map((t) => t.freq.toFixed(0)).join(' < '));
  assert.ok(idle.cutoff < full.cutoff && full.cutoff < boost.cutoff, 'brighter');
  assert.ok(idle.wind < full.wind && full.wind < boost.wind, 'more wind');
  assert.ok(idle.freq > 40 && boost.freq < 140, 'a low engine note');
  assert.ok(idle.gain > 0 && engineTargets({ throttle: 1, on: false }).gain === 0, 'muted or landed: silent');
  assert.ok(engineTargets({ bank: 55 * DEG }).pan > 0 && engineTargets({ bank: -55 * DEG }).pan < 0, 'pans with the bank');
});

test('controls card: bank to turn, back raises the nose (Invert Y swaps it), M shows the sound state', () => {
  const rows = planeKeyRows();
  assert.match(rows[0][1], /sideways banks/);
  assert.match(rows[0][1], /back raises the nose/);
  assert.match(rows[1][1], /banking turns/);
  assert.ok(rows[2][0].indexOf('\u2193') < rows[2][0].indexOf('\u2191'), 'down arrow listed first for nose up');
  assert.match(planeKeyRows({ invertY: true })[0][1], /up raises the nose/);
  assert.ok(rows.some(([, d]) => d === 'Sound on'));
  assert.ok(planeKeyRows({ muted: true }).some(([, d]) => d === 'Sound off'));
});
