// Plane mode flight model (landscape/web/ui/plane.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANE, createPlane, stepPlane, steerAim, aimByMouse, chasePose, shakeOffset, gamepadInput, groundReadout,
  speedFor, wrapAngle,
  planeKeyRows,
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

test('with no input the plane cruises straight and level at the throttle speed', () => {
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

test('aiming right banks right and the heading settles without overshooting', () => {
  const p = createPlane({ y: 20, yaw: 0 });
  steerAim(p, -60 * DEG, 0);
  fly(p, 0.3);
  assert.ok(p.yaw < 0, 'turning right lowers yaw');
  assert.ok(p.bank > 20 * DEG, 'banks right (bank ' + (p.bank / DEG).toFixed(1) + ' deg)');
  assert.ok(p.bank <= PLANE.maxBank + 1e-9);
  let lowest = 0;
  for (let i = 0; i < 300; i++) {
    stepPlane(p, {}, DT, { ground: flat });
    lowest = Math.min(lowest, p.yaw);
  }
  near(p.yaw, -60 * DEG, 0.5 * DEG, 'heading reaches the aim');
  assert.ok(lowest >= -70 * DEG, 'overshoot under 10 deg (lowest ' + (lowest / DEG).toFixed(2) + ')');
  near(p.bank, 0, 2 * DEG, 'wings level once the turn ends');
});

test('turn and pitch rates are capped; the mouse moves the aim, pulling back climbs', () => {
  const p = createPlane({ y: 50 });
  steerAim(p, -100 * DEG, 0);
  near(p.aimYaw, -60 * DEG, 1e-12, 'aim lead capped at 60 deg');
  const y0 = p.yaw;
  stepPlane(p, {}, 0.1, {});
  assert.ok(y0 - p.yaw <= PLANE.maxTurnRate * 0.1 + 1e-9, 'turn rate at most 55 deg/s');
  const q = createPlane({ y: 50 });
  aimByMouse(q, 100, 0);
  near(q.aimYaw, -0.1, 1e-12, 'mouse right aims right, 0.001 rad per pixel');
  aimByMouse(q, 0, 100);
  near(q.aimPitch, 0.1, 1e-12, 'mouse down (pulling back) climbs');
  aimByMouse(q, 0, 100, { invertY: true });
  near(q.aimPitch, 0, 1e-12, 'invertY flips it');
});

test('keys ease in and out: full rate after 0.25 s, 45 deg/s turning and 30 deg/s climbing', () => {
  const k = createPlane({ y: 50 });
  stepPlane(k, { turn: 1, climb: 1 }, 0.1, {});
  near(k.turnIn, 0.4, 1e-12, 'eased in');
  near(k.aimYaw, -0.4 * 4.5 * DEG, 1e-12, 'first 0.1 s: 40% of 45 deg/s');
  near(k.aimPitch, 0.4 * 3 * DEG, 1e-12, 'first 0.1 s: 40% of 30 deg/s');
  const a = createPlane({ y: 50 });
  for (let i = 0; i < 15; i++) stepPlane(a, { turn: 1, climb: 1 }, 1 / 60, {});
  near(a.turnIn, 1, 1e-12, 'full after 0.25 s');
  const yaw0 = a.aimYaw;
  const pitch0 = a.aimPitch;
  const lead0 = a.aimYaw - a.yaw;
  stepPlane(a, { turn: 1, climb: 1 }, 0.05, {});
  near(a.aimPitch - pitch0, 30 * DEG * 0.05, 1e-9, 'climb rate');
  assert.ok(a.aimYaw < yaw0 && lead0 < 0, 'D turns the aim right');
  for (let i = 0; i < 6; i++) stepPlane(a, {}, 0.05, {});
  assert.equal(a.turnIn, 0, 'eased out after release');
  assert.equal(a.climbIn, 0);
});

test('aim limits: pitch within 70 deg, yaw within 60 deg of the heading', () => {
  const p = createPlane({ y: 100, yaw: 0.5 });
  steerAim(p, 0, 2);
  near(p.aimPitch, 70 * DEG, 1e-12, 'aim pitch');
  steerAim(p, 0, -4);
  near(p.aimPitch, -70 * DEG, 1e-12, 'aim pitch down');
  steerAim(p, -3, 0);
  near(wrapAngle(p.aimYaw - p.yaw), -60 * DEG, 1e-12, 'aim lead right');
  steerAim(p, 6, 0);
  near(wrapAngle(p.aimYaw - p.yaw), 60 * DEG, 1e-12, 'aim lead left');
  const c = createPlane({ y: 299, yaw: 0 });
  steerAim(c, 0, 2);
  fly(c, 3);
  assert.ok(c.pitch <= 70 * DEG + 1e-9, 'plane pitch capped');
  assert.ok(c.y <= PLANE.ceiling, 'ceiling at 300 (y ' + c.y + ')');
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
  const p = createPlane({ y: 6, yaw: 0, throttle: 1 });
  steerAim(p, 0, -1.2);
  const bumped = fly(p, 3, { input: { boost: true } });
  assert.equal(bumped, false);
  near(p.y, PLANE.clearance, 1e-9, 'kept at the clearance');
  assert.ok(p.z < -20, 'still moving (z ' + p.z + ')');
});

test('a 10-unit tower bumps: stop at the tower, half speed, aim pitched up, cooldown', () => {
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
  assert.ok(p.aimPitch >= 15 * DEG - 1e-12, 'aim pitched up');
  assert.equal(p.bumps, 1);
  assert.ok(p.shake > 0 && p.cooldown > 0);
  // Within the 0.4 s cooldown the tower still blocks, but no second bump starts.
  steerAim(p, 0, -p.aimPitch);
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

test('collision off: through towers, still above the floor; ceiling and bounds hold', () => {
  const wall = (x, z) => (z < -2 ? 10 : 0);
  const p = createPlane({ y: 3, yaw: 0 });
  const bumped = fly(p, 2, { env: { ground: wall, collision: false } });
  assert.equal(bumped, false);
  assert.ok(p.z < -5, 'passed through (z ' + p.z + ')');
  const d = createPlane({ y: 3, yaw: 0 });
  steerAim(d, 0, -1.2);
  fly(d, 4, { env: { collision: false } });
  near(d.y, PLANE.floor, 1e-12, 'floor');
  const b = createPlane({ x: 5, y: 3, z: 5, yaw: 90 * DEG });
  const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  fly(b, 10, { input: { throttle: 1 }, env: { bounds } });
  assert.equal(b.x, -PLANE.margin, 'held 30 units beyond the edge');
  near(b.z, 5, 1e-9, 'slides along the bound');
});

test('chase camera sits behind and above the plane along the aim, above the terrain', () => {
  const p = createPlane({ x: 10, y: 3, z: 10, yaw: 0 });
  const c = chasePose(p);
  near(c.x, 10, 1e-12, 'x');
  near(c.z, 10 + PLANE.chaseDistance, 1e-12, 'behind (+z when heading -z)');
  near(c.y, 3 + PLANE.chaseDistance * PLANE.chaseRise, 1e-12, 'raised');
  assert.equal(c.yaw, p.aimYaw);
  const high = chasePose(p, 100, () => 50);
  near(high.z, 10 + PLANE.chaseMax, 1e-12, 'distance clamped to 40');
  near(high.y, 50 + PLANE.cameraClearance, 1e-12, 'kept above the terrain');
});

test('gamepad: left stick aims with a rescaled dead zone, triggers throttle, A boost, Start, B', () => {
  const btn = (value) => ({ pressed: value > 0.5, value });
  const buttons = Array.from({ length: 17 }, () => btn(0));
  buttons[0] = btn(1);
  buttons[6] = btn(0.25);
  buttons[7] = btn(1);
  buttons[9] = btn(1);
  const gp = { connected: true, mapping: 'standard', axes: [0.1, 1, 0, 0], buttons };
  const g = gamepadInput(gp);
  assert.equal(g.turn, 0, 'inside the dead zone');
  near(g.climb, 1, 1e-12, 'stick pulled back climbs');
  near(gamepadInput({ ...gp, axes: [0, -1] }).climb, -1, 1e-12, 'stick pushed forward dives');
  near(g.throttle, 0.75, 1e-12, 'RT - LT');
  assert.equal(g.boost, true);
  assert.equal(g.start, true);
  assert.equal(g.exit, false);
  near(gamepadInput({ ...gp, axes: [0.575, 0] }).turn, 0.25, 1e-12, 'rescaled past the dead zone, then squared');
  near(gamepadInput({ ...gp, axes: [-1, 0] }).turn, -1, 1e-12, 'full left');
  near(gamepadInput(gp, { invertY: true }).climb, -1, 1e-12, 'invertY');
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

test('controls card: pull back to climb by default, Invert Y swaps it, M shows the sound state', () => {
  const rows = planeKeyRows();
  assert.match(rows[0][1], /pull back to climb/);
  assert.ok(rows[2][0].indexOf('\u2193') < rows[2][0].indexOf('\u2191'), 'down arrow listed first for climb');
  assert.match(planeKeyRows({ invertY: true })[0][1], /push up to climb/);
  assert.ok(rows.some(([, d]) => d === 'Sound on'));
  assert.ok(planeKeyRows({ muted: true }).some(([, d]) => d === 'Sound off'));
});
