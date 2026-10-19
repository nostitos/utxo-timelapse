// Spend-flash sound planning, mixing and the shared sound switch (landscape/web/ui/flash-sound.js,
// landscape/web/ui/sound.js; SPEC §8). The Web Audio graphs run in the browser checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH_BANDS, MAX_VOICES_FRAME, MAX_VOICES_SECOND, REF_MAX, EDGE_LEVEL, LEAD_S, DRIFT_S, HIGHPASS_HZ, DENSITY_KNEE,
  DENSITY_GAIN_MAX, TAIL_S, bandIndex, distanceGain, projectPoint, flashVoices, createFlashPlanState, bandNoise, tickNoise,
  mixFrame, densityGain, frameSpan, createFlashSound, tickEvents, tickRenderer,
} from '../web/ui/flash-sound.js';
import { createSound, readSoundPref, SOUND_KEY, LEGACY_PLANE_KEY } from '../web/ui/sound.js';
import { EVENT_FIELDS } from '../web/ui/flash-worklet.js';
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
// A seeded random source for the mixer.
function seeded(seed = 7) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

test('projection: ahead lands at the centre, behind the camera is dropped, the edges reach NDC 1', () => {
  const m = CAM.elements;
  const p = projectPoint(m, 0, 0, -10);
  assert.ok(near(p.x, 0) && near(p.y, 0));
  assert.equal(projectPoint(m, 0, 0, 10), null);
  assert.ok(near(projectPoint(m, 10, 0, -10).x, 1, 1e-9), 'x = d is the right edge at 90 degrees');
  assert.ok(near(projectPoint(lookDownZ({ x: 5, y: 0, z: 0 }).elements, 5, 0, -10).x, 0), 'the camera position is subtracted');
  const lr = plan([ahead(10, { s: -10 }), ahead(10, { s: 10 }), ahead(10, { s: 30 })]);
  assert.deepEqual(lr.voices.map((v) => v.pan).sort(), [-1, 1], 'pan is the screen x; off screen is dropped');
});

test('distance relative to the view: full at the reference and nearer, 0.4 at twice, 0.118 at four times', () => {
  assert.equal(distanceGain(10, 10), 1);
  assert.equal(distanceGain(2, 10), 1, 'nearer is never louder');
  assert.ok(near(distanceGain(20, 10), 0.4));
  assert.ok(near(distanceGain(40, 10), 2 / 17));
  assert.ok(near(distanceGain(800, 400), distanceGain(2, 1)), 'only distance over the reference counts');
  const p = plan([ahead(5), ahead(10), ahead(10, { s: 1e-6 }), ahead(20), ahead(40)]);
  assert.ok(near(p.dRef, 10), 'the median flash on screen');
  const byDistance = new Map(p.voices.map((v) => [Math.round(v.distance), v]));
  assert.equal(byDistance.get(5).level, 1);
  assert.equal(byDistance.get(10).level, 1);
  assert.ok(near(byDistance.get(20).level, 0.4));
  assert.ok(near(byDistance.get(40).level, 2 / 17));
  assert.ok(!byDistance.get(20).far && byDistance.get(40).far, 'beyond twice the reference the tick is low-passed');
});

test('reference distance: the median flash on screen, clamped and eased', () => {
  assert.equal(plan([ahead(8), ahead(10), ahead(12)]).dRef, 10);
  assert.equal(plan([ahead(2), ahead(3), ahead(400), ahead(500), ahead(600)]).dRef, 400, 'mostly far flashes: the far ones set the level');
  assert.equal(plan([ahead(0.3)]).dRef, 1);
  assert.equal(plan([ahead(4000)]).dRef, REF_MAX);
  const state = createFlashPlanState();
  plan([ahead(10)], { state, now: 0 });
  const eased = plan([ahead(40)], { state, now: 500 }).dRef;
  assert.ok(near(eased, 10 * 4 ** (1 - Math.exp(-1)), 1e-9), 'half a second moves it 63% of the way (log scale): ' + eased);
  assert.ok(Math.abs(plan([ahead(40)], { state, now: 10500 }).dRef - 40) < 1e-3, 'a long pause catches up');
  const before = state.dRef;
  assert.equal(plan([{ x: 0, y: 0, z: 30, t: 1 }], { state, now: 11000 }).dRef, before, 'no flash on screen: unchanged');
});

test('level follows the BTC moved; spends near the creation edge are quieter; the age picks the band', () => {
  const p = plan([ahead(10, { t: 0 }), ahead(10, { t: 1, s: 1 }), ahead(10, { t: 1, s: -1, old: false })]);
  const lv = (s) => p.voices.find((v) => near(v.pan, s / 10)).level;
  assert.ok(near(lv(0), 0.25), 'the smallest spend is still heard');
  assert.ok(near(lv(1), 1));
  assert.ok(near(lv(-1), EDGE_LEVEL));
  const ages = [[0, 'air'], [99, 'air'], [100, 'high'], [999, 'high'], [1000, 'mid'], [9999, 'mid'], [10000, 'low'],
    [99999, 'low'], [100000, 'deep'], [800000, 'deep']];
  for (const [age, id] of ages) assert.equal(FLASH_BANDS[bandIndex(age)].id, id, 'age ' + age);
  assert.ok(FLASH_BANDS.every((b) => b.freq >= 2 * HIGHPASS_HZ), 'every band well above the high-pass');
});

test('busy frames: hundreds of ticks a frame, loudest first, up to 4,000 a second, every frame', () => {
  const many = [];
  for (let i = 0; i < 1000; i++) many.push(ahead(10 + (i % 30), { t: (i % 11) / 10, s: ((i % 21) - 10) / 2 }));
  const p = plan(many);
  assert.equal(p.onScreen, 1000);
  assert.equal(p.voices.length, MAX_VOICES_FRAME);
  assert.ok(p.voicedEnergy <= p.energy && p.voicedEnergy > 0.4 * p.energy, 'the voiced ticks carry most of the energy');
  const state = createFlashPlanState();
  const perFrame = [];
  for (let f = 0; f < 60; f++) perFrame.push(plan(many, { state, now: f * 1000 / 60 }).voices.length);
  const total = perFrame.reduce((a, b) => a + b, 0);
  assert.equal(perFrame[0], MAX_VOICES_FRAME, 'the first frame after a quiet moment voices its 400 sprites');
  assert.ok(total <= MAX_VOICES_SECOND + MAX_VOICES_FRAME && total >= MAX_VOICES_SECOND - 100, 'one second at 60 frames: ' + total + ' ticks');
  assert.ok(perFrame.slice(1).every((n) => n >= 60 && n <= 70), 'about 66 ticks every frame: ' + perFrame.slice(1, 8).join(' '));
  const few = plan([ahead(10), ahead(11), ahead(12), ahead(13), ahead(14)]);
  assert.equal(few.voices.length, 5, 'a quiet frame voices every flash');
  const nothing = plan([{ x: 0, y: 0, z: 10, t: 1 }, { x: 30, y: 0, z: -10, t: 1 }]);
  assert.equal(nothing.voices.length + nothing.onScreen, 0, 'behind or beside the view: silence');
});

test('loudness follows every flash on screen: unchanged when sparse, compressed when dense', () => {
  assert.equal(densityGain(5, 5), 1, 'a few flashes, all voiced: their own level');
  assert.equal(densityGain(DENSITY_KNEE, DENSITY_KNEE), 1);
  // Dense, all voiced: 10x the energy plays 4 dB louder instead of 10.
  const g10 = densityGain(10 * DENSITY_KNEE, 10 * DENSITY_KNEE);
  const louder = 10 * Math.log10((g10 * g10 * 10 * DENSITY_KNEE) / DENSITY_KNEE);
  assert.ok(near(louder, 4, 1e-9), '10x the energy: ' + louder.toFixed(2) + ' dB louder');
  // Only part voiced: the voiced ticks are raised to stand for the rest, at most DENSITY_GAIN_MAX.
  assert.ok(densityGain(20, 5) > 1 && densityGain(20, 5) <= DENSITY_GAIN_MAX);
  assert.equal(densityGain(1e6, 1e-6), DENSITY_GAIN_MAX);
  assert.equal(densityGain(10, 0), 0);
});

function rms(d) {
  let s = 0;
  for (const v of d) s += v * v;
  return Math.sqrt(s / d.length);
}

test('many ticks overlap into a hiss: few are separate clicks with gaps, hundreds an even noise', () => {
  const rate = 48000;
  const noise = tickNoise(rate);
  const span = Math.round(0.1 * rate);
  const flatness = (n) => {
    const voices = [];
    for (let i = 0; i < n; i++) voices.push({ band: i % 5, pan: 0, far: false, level: 1 });
    const { left } = mixFrame(voices, { sampleRate: rate, spanSamples: span, gain: 1 / Math.sqrt(n), noise, random: seeded(n) });
    // Envelope over the span in 2 ms windows: how much it varies (0 for steady noise) and how much is near-silent.
    const w = Math.round(0.002 * rate);
    const env = [];
    for (let s = 0; s + w <= span; s += w) env.push(rms(left.subarray(s, s + w)));
    const mu = env.reduce((a, b) => a + b, 0) / env.length;
    const sd = Math.sqrt(env.reduce((a, b) => a + (b - mu) ** 2, 0) / env.length);
    return { cv: sd / mu, gaps: env.filter((e) => e < 0.1 * mu).length / env.length, level: rms(left.subarray(0, span)) };
  };
  const sparse = flatness(6);
  const dense = flatness(400);
  assert.ok(sparse.gaps > 0.2 && sparse.cv > 1, 'six ticks: separate clicks with silence between (' + JSON.stringify(sparse) + ')');
  assert.ok(dense.gaps === 0 && dense.cv < 0.45, '400 ticks: an even hiss (' + JSON.stringify(dense) + ')');
  // With the gain at 1 / sqrt(n), the power stays about the same however many ticks there are.
  assert.ok(Math.abs(20 * Math.log10(dense.level / sparse.level)) < 3, 'same power: ' + sparse.level.toFixed(4) + ' vs ' + dense.level.toFixed(4));
  // Ticks stay inside the buffer: the span plus the longest tick.
  const one = mixFrame([{ band: 4, pan: -1, far: false, level: 1 }], { sampleRate: rate, spanSamples: span, noise, random: () => 0.999 });
  assert.equal(one.left.length, span + Math.ceil(TAIL_S * rate) + 1);
  assert.ok(rms(one.right) < 1e-6 && rms(one.left) > 0, 'pan -1 is the left channel only');
});

test('ticks are scheduled ahead of the audio clock and spread evenly, even when frames arrive unevenly', () => {
  let cursor = null;
  let audio = 10;
  const spans = [];
  for (let i = 0; i < 5; i++) {
    const s = frameSpan(cursor, audio, 1 / 60);
    spans.push(s);
    cursor = s.end;
    audio += 1 / 60;
  }
  assert.ok(near(spans[0].start, 10 + LEAD_S));
  for (let i = 1; i < spans.length; i++) assert.ok(near(spans[i].start, spans[i - 1].end), 'contiguous');
  const clump = [];
  for (let i = 0; i < 5; i++) {
    const s = frameSpan(cursor, audio, 1 / 60);
    clump.push(s.start);
    cursor = s.end;
  }
  assert.ok(clump.every((t, i) => i === 0 || t > clump[i - 1] + 0.016), 'a clump is spread out');
  assert.ok(near(frameSpan(cursor, audio + 2, 1 / 60).start, audio + 2 + LEAD_S), 'after a stall it restarts ahead');
  assert.ok(near(frameSpan(audio + 5, audio, 1 / 60).start, audio + LEAD_S + DRIFT_S), 'never more than DRIFT_S further');
});

function crossingsPerSecond(d, rate) {
  let n = 0;
  for (let i = 1; i < d.length; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) n++;
  return (n / d.length) * rate;
}

test('tick noise: each band filtered around its frequency, all at the same level; far ticks duller', () => {
  const rate = 48000;
  const zc = FLASH_BANDS.map((b) => {
    const d = bandNoise(rate, 0.5, b);
    assert.equal(d.length, 24000);
    assert.ok(Math.abs(rms(d) - 0.2) < 1e-3, b.id + ' rms ' + rms(d));
    return crossingsPerSecond(d, rate);
  });
  for (let i = 1; i < zc.length; i++) assert.ok(zc[i] < zc[i - 1], 'older coins sound lower: ' + zc.map(Math.round).join(', '));
  assert.ok(zc[4] > 1500 && zc[4] < 2600, 'deep ' + zc[4]);
  assert.ok(zc[3] > 2400 && zc[3] < 4200, 'low ' + zc[3]);
  assert.ok(zc[2] > 3800 && zc[2] < 6400, 'mid ' + zc[2]);
  const n = tickNoise(rate);
  assert.ok(rms(n.far[0]) < 0.5 * rms(n.near[0]), 'the 6 kHz band loses most of its energy through the far low-pass');
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

test('the audio-thread renderer: 128-frame blocks match one pass, late ticks play whole, events place and pan ticks', () => {
  const rate = 48000;
  const noise = tickNoise(rate);
  const renderer = () => tickRenderer(noise, rate);
  const voices = [];
  for (let i = 0; i < 300; i++) voices.push({ band: i % 5, pan: ((i % 9) - 4) / 4, far: i % 7 === 0, level: 0.2 + (i % 5) / 6 });
  const r0 = renderer();
  const events = tickEvents(voices, { sampleRate: rate, spanSamples: 800, gain: 1, startFrame: 48000, lengths: r0.len, noiseLength: noise.near[0].length, random: seeded(3) });
  assert.equal(events.length, voices.length * EVENT_FIELDS);
  for (let k = 0; k < events.length; k += EVENT_FIELDS) {
    assert.ok(events[k] >= 48000 && events[k] < 48800, 'starts inside the span');
    const v = voices[k / EVENT_FIELDS];
    const amp = Math.hypot(events[k + 3], events[k + 4]);
    assert.ok(Math.abs(amp - v.level * FLASH_BANDS[v.band].gain * 0.65) < 1e-9, 'equal-power pan keeps the level');
  }
  const total = 800 + Math.ceil(TAIL_S * rate) + 128;
  const a = { l: new Float32Array(total), r: new Float32Array(total) };
  r0.add(events);
  r0.render(a.l, a.r, 48000, total);
  const r1 = renderer();
  r1.add(events);
  const b = { l: new Float32Array(total), r: new Float32Array(total) };
  for (let f = 0; f < total; f += 128) {
    const n = Math.min(128, total - f);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    r1.render(l, r, 48000 + f, n);
    b.l.set(l, f);
    b.r.set(r, f);
  }
  let diff = 0;
  for (let i = 0; i < total; i++) diff = Math.max(diff, Math.abs(a.l[i] - b.l[i]), Math.abs(a.r[i] - b.r[i]));
  assert.ok(diff < 1e-6 && rms(a.l) > 0, 'blockwise equals one pass (max difference ' + diff + ')');
  assert.equal(r1.active.length + r1.pending.length, 0, 'every tick finished');
  // A tick queued after its start frame passed plays whole from the next block.
  const late = renderer();
  late.add(Float64Array.of(1000, 4, 0, 1, 0, 0));
  const out = new Float32Array(4000);
  late.render(out, new Float32Array(4000), 5000, 4000);
  const firstSound = out.findIndex((v) => v !== 0);
  assert.equal(firstSound, 0);
  assert.ok(out.slice(late.len[4]).every((v) => v === 0) && out[late.len[4] - 1] !== 0, 'the whole tick, ' + late.len[4] + ' samples');
});
