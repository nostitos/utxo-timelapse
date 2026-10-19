// Spend-flash sound planning and the shared sound switch (landscape/web/ui/flash-sound.js,
// landscape/web/ui/sound.js; SPEC §8). The Web Audio graphs run in the browser checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH_BANDS, FLASH_PANS, MAX_VOICES_FRAME, MAX_VOICES_SECOND, CROWD_MAX, REF_MAX, EDGE_LEVEL,
  bandIndex, distanceGain, projectPoint, panIndex, flashVoices, createFlashPlanState, bandNoise, crackleNoise,
  createFlashSound,
} from '../web/ui/flash-sound.js';
import { createSound, readSoundPref, SOUND_KEY, LEGACY_PLANE_KEY } from '../web/ui/sound.js';
import { createPlaneSound } from '../web/ui/plane-sound.js';

// A camera at c looking along -z: 90 degree vertical field of view, aspect 1, near 0.1, far 1000.
// Column-major view-projection P * T(-c), as view.cameraView() returns it.
function lookDownZ(c = { x: 0, y: 0, z: 0 }) {
  const f = 1; // 1 / tan(45 degrees)
  const n = 0.1;
  const far = 1000;
  const A = (far + n) / (n - far);
  const B = (2 * far * n) / (n - far);
  const e = new Array(16).fill(0);
  e[0] = f; e[5] = f; e[10] = A; e[11] = -1;
  e[12] = -f * c.x; e[13] = -f * c.y; e[14] = -c.z * A + B; e[15] = c.z;
  return { ...c, elements: e };
}
const CAM = lookDownZ();
// A flash d units straight ahead, offset sideways by s (screen x = s / d), of amount scale t.
const ahead = (d, { s = 0, t = 1, old = true, xEnd = 0 } = {}) => ({ x: s, y: 0, z: -d, t, old, xEnd });
const plan = (items, o = {}) => flashVoices(items, { camera: CAM, block: 900000, now: 0, state: createFlashPlanState(), ...o });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('projection: ahead lands at the centre, behind the camera is dropped, the edges reach NDC 1', () => {
  const m = CAM.elements;
  const p = projectPoint(m, 0, 0, -10);
  assert.ok(near(p.x, 0) && near(p.y, 0));
  assert.equal(projectPoint(m, 0, 0, 10), null);
  assert.ok(near(projectPoint(m, 10, 0, -10).x, 1, 1e-9), 'x = d is the right edge at 90 degrees');
  assert.ok(near(projectPoint(lookDownZ({ x: 5, y: 0, z: 0 }).elements, 5, 0, -10).x, 0), 'the camera position is subtracted');
  assert.equal(panIndex(-1), 0);
  assert.equal(panIndex(1), FLASH_PANS.length - 1);
  assert.equal(FLASH_PANS[panIndex(0.1)], 0);
});

test('distance relative to the view: full at the reference and nearer, 0.4 at twice, 0.118 at four times', () => {
  assert.equal(distanceGain(10, 10), 1);
  assert.equal(distanceGain(2, 10), 1, 'nearer is never louder');
  assert.ok(near(distanceGain(20, 10), 0.4));
  assert.ok(near(distanceGain(40, 10), 2 / 17));
  // The same ratios hold zoomed far out: only distance over the reference counts.
  assert.ok(near(distanceGain(800, 400), distanceGain(2, 1)));
  const p = plan([ahead(5), ahead(10), ahead(20), ahead(40)], { focus: 10 });
  assert.equal(p.dRef, 10);
  const byDistance = new Map(p.voices.map((v) => [Math.round(v.distance), v]));
  assert.equal(byDistance.get(5).level, 1);
  assert.equal(byDistance.get(10).level, 1);
  assert.ok(near(byDistance.get(20).level, 0.4));
  assert.ok(near(byDistance.get(40).level, 2 / 17));
  assert.ok(!byDistance.get(20).far && byDistance.get(40).far, 'beyond twice the reference the click is low-passed');
  assert.ok(p.voices.every((v) => v.level <= 1));
});

test('reference distance: the nearer of the focus and the median flash, clamped and eased', () => {
  const flashes = [ahead(8), ahead(10), ahead(12)];
  assert.equal(plan(flashes, { focus: 3 }).dRef, 3);
  assert.equal(plan(flashes, { focus: null }).dRef, 10);
  assert.equal(plan(flashes, { focus: 50 }).dRef, 10);
  assert.equal(plan([ahead(0.3)], {}).dRef, 1);
  assert.equal(plan([ahead(4000)], { focus: 5000 }).dRef, REF_MAX);
  const state = createFlashPlanState();
  plan([ahead(10)], { state, now: 0 });
  const eased = plan([ahead(40)], { state, now: 500 }).dRef;
  assert.ok(near(eased, 10 * 4 ** (1 - Math.exp(-1)), 1e-9), 'half a second moves it 63% of the way (log scale): ' + eased);
  assert.ok(Math.abs(plan([ahead(40)], { state, now: 10500 }).dRef - 40) < 1e-3, 'a long pause catches up');
  const before = state.dRef;
  assert.equal(plan([{ x: 0, y: 0, z: 30, t: 1 }], { state, now: 11000 }).dRef, before, 'no flash on screen: unchanged');
});

test('level follows the BTC moved; spends near the creation edge are quieter', () => {
  // All three within the reference distance (the median, 10.05), so only amount and age differ.
  const p = plan([ahead(10, { t: 0 }), ahead(10, { t: 1, s: 1 }), ahead(10, { t: 1, s: -1, old: false })], { focus: 20 });
  const lv = (s) => p.voices.find((v) => near(v.ndcX, s / 10)).level;
  assert.ok(near(lv(0), 0.25), 'the smallest spend is still heard');
  assert.ok(near(lv(1), 1));
  assert.ok(near(lv(-1), EDGE_LEVEL));
});

test('the age of the spent coins picks the band, from the high air band to the sub band', () => {
  const ages = [[0, 'air'], [99, 'air'], [100, 'high'], [999, 'high'], [1000, 'mid'], [9999, 'mid'], [10000, 'low'],
    [99999, 'low'], [100000, 'sub'], [800000, 'sub']];
  for (const [age, id] of ages) assert.equal(FLASH_BANDS[bandIndex(age)].id, id, 'age ' + age);
  // xEnd is the cell's newest block / 1000: a cell 200,000 blocks back is ancient.
  const p = plan([ahead(10, { xEnd: 700 }), ahead(10, { xEnd: 899.95, s: 1 })], { block: 900000 });
  assert.deepEqual(p.voices.map((v) => FLASH_BANDS[v.band].id).sort(), ['air', 'sub']);
});

test('busy frames: the loudest get clicks, the rest feed the crackle; 300 clicks a second, spread evenly', () => {
  // 16 large spends at the reference distance among 984 dust spends four times farther.
  const quiet = [];
  for (let i = 0; i < 984; i++) quiet.push(ahead(40, { t: 0, s: ((i % 21) - 10) * 2 }));
  const loud = [];
  for (let i = 0; i < 16; i++) loud.push(ahead(10, { t: 1 }));
  const many = [...quiet.slice(0, 500), ...loud, ...quiet.slice(500)];
  const p = plan(many, { focus: 10 });
  assert.equal(p.voices.length, MAX_VOICES_FRAME);
  assert.equal(p.onScreen, 1000);
  assert.ok(p.voices.every((v) => v.level === 1 && near(v.distance, 10)), 'the voiced flashes are the loudest ones');
  assert.equal(p.crowd.gain, CROWD_MAX, 'hundreds of quiet spends: the crackle at its ceiling');
  const some = plan([...loud, ...quiet.slice(0, 20)], { focus: 10 });
  assert.ok(some.crowd.gain > 0 && some.crowd.gain < CROWD_MAX, 'twenty quiet spends: a faint crackle (' + some.crowd.gain + ')');
  const few = plan([ahead(10), ahead(11), ahead(12), ahead(13), ahead(14)]);
  assert.equal(few.voices.length, 5);
  assert.equal(few.crowd.gain, 0);

  const state = createFlashPlanState();
  const perFrame = [];
  for (let f = 0; f < 100; f++) perFrame.push(plan(many.slice(0, 100), { state, now: f * 10 }).voices.length);
  const total = perFrame.reduce((a, b) => a + b, 0);
  assert.equal(perFrame[0], MAX_VOICES_FRAME, 'a quiet moment allows a burst');
  assert.ok(total <= MAX_VOICES_SECOND + MAX_VOICES_FRAME && total >= MAX_VOICES_SECOND - 10, 'one second of 100-flash frames: ' + total + ' clicks');
  assert.ok(perFrame.slice(1).every((n) => n >= 2 && n <= 4), 'clicks every frame, never a silent gap: ' + perFrame.slice(1, 12).join(' '));
  plan([], { state, now: 2000 });
  assert.equal(plan(many.slice(0, 100), { state, now: 2000 }).voices.length, MAX_VOICES_FRAME, 'the budget refills after a pause');
});

test('nothing on screen: silence', () => {
  const behind = [{ x: 0, y: 0, z: 10, t: 1 }];
  const aside = [{ x: 30, y: 0, z: -10, t: 1 }];
  for (const items of [behind, aside]) {
    const p = plan(items, { focus: 10 });
    assert.equal(p.voices.length, 0);
    assert.equal(p.onScreen, 0);
    assert.equal(p.crowd.gain, 0);
  }
  // Left and right of the screen pan to the sides.
  const lr = plan([ahead(10, { s: -10 }), ahead(10, { s: 10 })]);
  assert.deepEqual(lr.voices.map((v) => FLASH_PANS[v.pan]).sort(), [-1, 1]);
});

function rms(d) {
  let s = 0;
  for (const v of d) s += v * v;
  return Math.sqrt(s / d.length);
}
function crossingsPerSecond(d, rate) {
  let n = 0;
  for (let i = 1; i < d.length; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) n++;
  return (n / d.length) * rate;
}

test('click noise: each band filtered around its frequency, all at the same level; the crowd loop crackles', () => {
  const rate = 48000;
  const zc = FLASH_BANDS.map((b) => {
    const d = bandNoise(rate, 0.5, b);
    assert.equal(d.length, 24000);
    assert.ok(Math.abs(rms(d) - 0.2) < 1e-3, b.id + ' rms ' + rms(d));
    return crossingsPerSecond(d, rate);
  });
  for (let i = 1; i < zc.length; i++) assert.ok(zc[i] < zc[i - 1], 'older coins sound lower: ' + zc.map(Math.round).join(', '));
  // A narrow band crosses zero about twice per cycle of its centre frequency.
  assert.ok(zc[4] > 100 && zc[4] < 260, 'sub ' + zc[4]);
  assert.ok(zc[3] > 250 && zc[3] < 650, 'low ' + zc[3]);
  assert.ok(zc[2] > 2000 && zc[2] < 4500, 'mid ' + zc[2]);
  const c = crackleNoise(rate, 2);
  let peak = 0;
  for (const v of c) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(rms(c) - 0.2) < 1e-3);
  assert.ok(peak / rms(c) > 5, 'impulsive, not a hiss: crest ' + (peak / rms(c)).toFixed(1));
});

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
class FakeContext {
  static made = 0;
  constructor() {
    FakeContext.made++;
    this.state = 'suspended';
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
}

test('sound switch: off by default, remembered, the old plane switch carried over only when it was on', () => {
  assert.equal(readSoundPref(memoryStorage()), false);
  assert.equal(readSoundPref(memoryStorage({ [LEGACY_PLANE_KEY]: 'on' })), true);
  assert.equal(readSoundPref(memoryStorage({ [LEGACY_PLANE_KEY]: 'off' })), false);
  assert.equal(readSoundPref(memoryStorage({ [SOUND_KEY]: 'off', [LEGACY_PLANE_KEY]: 'on' })), false);
  assert.equal(readSoundPref(memoryStorage({ [SOUND_KEY]: 'on' })), true);
  assert.equal(readSoundPref({ getItem() { throw new Error('private mode'); } }), false);

  const storage = memoryStorage();
  FakeContext.made = 0;
  const sound = createSound({ storage, AudioContextClass: FakeContext });
  const changes = [];
  sound.onChange((on) => changes.push(on));
  sound.unlock();
  assert.equal(sound.context, null, 'no context before the sound is turned on');
  assert.equal(sound.set(true), true);
  assert.equal(storage.map.get(SOUND_KEY), 'on');
  assert.ok(sound.running && FakeContext.made === 1);
  assert.equal(sound.toggle(), false);
  assert.equal(storage.map.get(SOUND_KEY), 'off');
  assert.ok(!sound.running);
  sound.toggle();
  assert.equal(FakeContext.made, 1, 'one shared context');
  assert.deepEqual(changes, [true, false, true]);
  sound.set(false);
});

test('the engine and the flashes stay silent while the switch is off or the frame is a seek', () => {
  const off = createSound({ storage: memoryStorage(), AudioContextClass: FakeContext });
  const plane = createPlaneSound({ sound: off });
  plane.start();
  assert.equal(plane.state.created, false);
  assert.equal(plane.muted, true);
  const flashes = createFlashSound({ sound: off });
  assert.equal(flashes.spawn([ahead(10)], { camera: CAM, block: 900000, reason: 'advance' }), null);
  const on = { on: true, running: true, context: null };
  assert.equal(createFlashSound({ sound: on }).spawn([ahead(10)], { camera: CAM, reason: 'seek' }), null);
  assert.equal(flashes.state.totals.voices, 0);
});
