// Spend-flash sound (landscape/SPEC.md §8): a short pitched tick of narrow-band noise for spend
// flashes on screen, after the film's audio synthesizer (src/cpp/buv/AudioSynthesizer.h) moved
// up to 1-6 kHz: the age of the spent coins picks the band (old coins a lower tok, young
// ones a high tick), the BTC moved sets the level (the flash sprite's amount scale), and the
// distance from the camera lowers and dulls it. Nothing sounds below 400 Hz: the film's 80 Hz
// thuds came out as surges and near-silences on a MacBook's built-in speakers, and a 480 Hz
// lowest band still sounded muddy.
// Distance is measured against the view, not in world units: flashes at the median distance
// of the frame's flashes on screen play at full level, nearer ones no louder, farther ones fall
// off and pass through a low-pass filter, so zooming changes the balance but not the overall
// level. The loudest flashes of a
// frame get their own tick from a budget that refills at MAX_VOICES_SECOND a second and holds
// at most MAX_VOICES_FRAME, so busy playback ticks steadily (about one a frame at 60 fps) and
// each tick stays audible; the rest feed a soft crackle that grows with their summed level.
// Ticks are scheduled LEAD_S ahead of the audio clock and spread over the time each frame
// stands for, so frames arriving unevenly do not bunch them. Only advance frames
// (playback and steps forward) sound, so seeks and scrubs stay silent, and only while the
// shared switch (ui/sound.js) is on. flashVoices plans a frame (pure); buildFlashGraph is the
// Web Audio graph on any BaseAudioContext.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bands by the age of the spent coins in blocks (below maxAge): the film's age bands, higher. */
export const FLASH_BANDS = Object.freeze([
  Object.freeze({ id: 'air', maxAge: 100, freq: 6000, q: 2, gain: 0.7, decay: 0.005 }),
  Object.freeze({ id: 'high', maxAge: 1000, freq: 3600, q: 2.5, gain: 0.8, decay: 0.007 }),
  Object.freeze({ id: 'mid', maxAge: 10000, freq: 2500, q: 3, gain: 0.75, decay: 0.008 }),
  Object.freeze({ id: 'low', maxAge: 100000, freq: 1600, q: 3.5, gain: 0.65, decay: 0.01 }),
  Object.freeze({ id: 'deep', maxAge: Infinity, freq: 1000, q: 4, gain: 0.55, decay: 0.012 }),
]);
/** Stereo positions a click snaps to (left edge of the screen to the right edge). */
export const FLASH_PANS = Object.freeze([-1, -0.5, 0, 0.5, 1]);
export const MAX_VOICES_FRAME = 6;
export const MAX_VOICES_SECOND = 60;
export const SCREEN_MARGIN = 1.1; // NDC: flashes just outside the frame still sound
export const FAR_RATIO = 2; // beyond this many reference distances a click is low-passed
export const FAR_LOWPASS_HZ = 2000;
export const HIGHPASS_HZ = 400; // nothing below (24 dB an octave): no boom, no mud
export const REF_MIN = 1;
export const REF_MAX = 1000;
export const REF_TAU_S = 0.5;
export const EDGE_LEVEL = 0.35; // spends of coins created near the creation edge
export const CROWD_MAX = 0.06;
export const CROWD_REF = 200; // summed level of the unvoiced flashes that reaches CROWD_MAX
export const LEAD_S = 0.06; // ticks are scheduled at least this far ahead of the audio clock
export const DRIFT_S = 0.2; // and at most this much further, when frames arrive faster than they play
const ATTACK_S = 0.001;
const SLICE_S = 0.12;
const NOISE_S = 0.5;
const NOISE_RMS = 0.2;
const CRACKLE_S = 2;
const CRACKLE_RATE = 400; // clicks per second in the crowd loop
const MASTER_GAIN = 1.1;
const FRAME_S_MIN = 1 / 240;
const FRAME_S_MAX = 0.1; // the longest stretch one frame's ticks are spread over

/** Index into FLASH_BANDS for coins 'age' blocks old. */
export function bandIndex(age) {
  for (let i = 0; i < FLASH_BANDS.length; i++) if (age < FLASH_BANDS[i].maxAge) return i;
  return FLASH_BANDS.length - 1;
}

/** Level factor for a flash 'd' from the camera with reference distance 'ref': 1 up to ref, 0.4 at 2x, 0.118 at 4x. */
export function distanceGain(d, ref) {
  if (!(ref > 0) || !(d >= 0)) return 1;
  const r = d / ref;
  return Math.min(1, 2 / (1 + r * r));
}

/** Click level: amount scale t (0..1), creation-edge spends quieter, times the distance factor. */
export function flashLevel(t, old, att) {
  return (0.25 + 0.75 * clamp(Number(t) || 0, 0, 1)) * (old ? 1 : EDGE_LEVEL) * att;
}

/** World point through a column-major 4x4 view-projection: NDC {x, y}, or null behind the camera. */
export function projectPoint(m, x, y, z) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(cw > 1e-6)) return null;
  return { x: cx / cw, y: cy / cw };
}

/** Index into FLASH_PANS nearest to NDC x. */
export function panIndex(ndcX) {
  return Math.round((clamp(ndcX, -1, 1) + 1) * 2);
}

/** State flashVoices keeps between frames: the eased reference distance and the click budget. */
export function createFlashPlanState() {
  return { dRef: null, at: null, tokens: MAX_VOICES_FRAME, tokenAt: null };
}

/**
 * Plans the sound of one frame's flashes. items: [{x, y, z, xEnd, t, old}] from
 * render/terrain/flashes.js (world units; t = amount scale; xEnd = the cell's newest block / 1000);
 * camera: {x, y, z, elements} from view.cameraView(); block: the frame's block; now: ms;
 * state: createFlashPlanState().
 * Returns {voices: [{band, pan, far, level, ndcX, distance}], crowd: {gain, pan}, dRef, onScreen}.
 */
export function flashVoices(items, { camera, block = NaN, now = 0, state = createFlashPlanState() } = {}) {
  const m = camera.elements;
  const on = [];
  for (const it of items) {
    const p = projectPoint(m, it.x, it.y, it.z);
    if (!p || Math.abs(p.x) > SCREEN_MARGIN || Math.abs(p.y) > SCREEN_MARGIN) continue;
    on.push({ it, ndcX: p.x, d: Math.hypot(it.x - camera.x, it.y - camera.y, it.z - camera.z) });
  }
  if (on.length) {
    const ds = on.map((o) => o.d).sort((a, b) => a - b);
    const median = ds[ds.length >> 1];
    const target = clamp(median, REF_MIN, REF_MAX);
    if (!(state.dRef > 0)) state.dRef = target;
    else {
      const dt = Number.isFinite(state.at) ? Math.max(0, (now - state.at) / 1000) : 0;
      const k = 1 - Math.exp(-dt / REF_TAU_S);
      state.dRef = Math.exp(Math.log(state.dRef) + (Math.log(target) - Math.log(state.dRef)) * k);
    }
    state.at = now;
  }
  const ref = state.dRef > 0 ? state.dRef : REF_MIN;
  for (const o of on) {
    o.level = flashLevel(o.it.t, o.it.old !== false, distanceGain(o.d, ref));
    o.far = o.d > FAR_RATIO * ref;
    o.band = bandIndex(Number.isFinite(block) ? Math.max(0, block - (o.it.xEnd ?? o.it.x) * 1000) : Infinity);
  }
  on.sort((a, b) => b.level - a.level);
  if (Number.isFinite(state.tokenAt)) {
    state.tokens = Math.min(MAX_VOICES_FRAME, state.tokens + (Math.max(0, now - state.tokenAt) / 1000) * MAX_VOICES_SECOND);
  }
  state.tokenAt = now;
  const slots = Math.max(0, Math.min(on.length, Math.floor(state.tokens)));
  state.tokens -= slots;
  const voices = [];
  let sum = 0;
  let panSum = 0;
  for (let i = 0; i < on.length; i++) {
    const o = on[i];
    if (i < slots) {
      voices.push({ band: o.band, pan: panIndex(o.ndcX), far: o.far, level: o.level, ndcX: o.ndcX, distance: o.d });
    } else {
      sum += o.level;
      panSum += o.level * clamp(o.ndcX, -1, 1);
    }
  }
  return {
    voices,
    crowd: { gain: crowdGain(sum), pan: sum > 0 ? panSum / sum : 0 },
    dRef: state.dRef,
    onScreen: on.length,
  };
}

/** Crackle level for the summed level of a frame's unvoiced flashes: logarithmic, up to CROWD_MAX. */
export function crowdGain(sum) {
  if (!(sum > 0)) return 0;
  return CROWD_MAX * Math.min(1, Math.log1p(sum) / Math.log1p(CROWD_REF));
}

/**
 * Where one frame's ticks go on the audio clock. cursor: the end of the previous frame's span
 * (or null); now: the context's currentTime; span: the time the frame stands for (s). Returns
 * {start, end}: the span starts at the cursor unless that fell behind now + LEAD_S (a stall: it
 * restarts there) or ran beyond now + LEAD_S + DRIFT_S (frames arriving faster: it is pulled in).
 */
export function frameSpan(cursor, now, span) {
  const d = clamp(Number.isFinite(span) ? span : FRAME_S_MIN, FRAME_S_MIN, FRAME_S_MAX);
  let start = Number.isFinite(cursor) ? cursor : now + LEAD_S;
  if (start < now + LEAD_S) start = now + LEAD_S;
  if (start > now + LEAD_S + DRIFT_S) start = now + LEAD_S + DRIFT_S;
  return { start, end: start + d };
}

function xorshift(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  };
}

/** RBJ band-pass (0 dB peak), as computeBandpass in the film's synthesizer. */
function bandpass(freq, q, sampleRate) {
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

function normalize(d, rms) {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const k = s > 0 ? rms / Math.sqrt(s / d.length) : 0;
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return d;
}

/**
 * White noise through a band's filter twice, scaled to the same RMS for every band
 * (Float32Array). One pass of the film's band-pass falls off only 6 dB an octave, which on
 * white noise leaves the 80 Hz band mostly hiss; two passes keep each band near its frequency.
 */
export function bandNoise(sampleRate, seconds, band, seed = 0x2545f491) {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const warm = Math.round(sampleRate * 0.05);
  const c = bandpass(band.freq, band.q, sampleRate);
  const rnd = xorshift(seed);
  const out = new Float32Array(n);
  let a1 = 0;
  let a2 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = -warm; i < n; i++) {
    const x = rnd();
    const y = c.b0 * x + a1;
    a1 = -c.a1 * y + a2;
    a2 = c.b2 * x - c.a2 * y;
    const w = c.b0 * y + b1;
    b1 = -c.a1 * w + b2;
    b2 = c.b2 * y - c.a2 * w;
    if (i >= 0) out[i] = w;
  }
  return normalize(out, NOISE_RMS);
}

/** A loop of sparse clicks (Poisson, 'rate' a second, random strength) for the crowd. */
export function crackleNoise(sampleRate, seconds, rate = CRACKLE_RATE, seed = 0x5bd1e995) {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(n);
  const rnd = xorshift(seed);
  const u = () => (rnd() + 1) / 2;
  const len = Math.round(sampleRate * 0.004);
  let t = 0;
  for (;;) {
    t += -Math.log(Math.max(1e-9, u())) / rate;
    const start = Math.floor(t * sampleRate);
    if (start >= n) break;
    const amp = -Math.log(Math.max(1e-9, u())) * 0.5;
    for (let k = 0; k < len; k++) out[(start + k) % n] += amp * rnd() * Math.exp((-6 * k) / len);
  }
  return normalize(out, NOISE_RMS);
}

function toBuffer(ctx, data) {
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/** The flash graph on any BaseAudioContext: {play(voice, t), crowd(gain, pan, t), dispose()}. */
export function buildFlashGraph(ctx, { destination = ctx.destination } = {}) {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  // A peak limiter only: sparse ticks rarely reach it, so it does not pump.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = HIGHPASS_HZ;
  highpass.Q.value = 0.7;
  const highpass2 = ctx.createBiquadFilter();
  highpass2.type = 'highpass';
  highpass2.frequency.value = HIGHPASS_HZ;
  highpass2.Q.value = 0.7;
  const input = highpass; // everything enters here
  highpass.connect(highpass2).connect(limiter).connect(master).connect(destination);
  const near = ctx.createGain();
  near.connect(input);
  const far = ctx.createBiquadFilter();
  far.type = 'lowpass';
  far.frequency.value = FAR_LOWPASS_HZ;
  far.Q.value = 0.7;
  far.connect(input);
  const panner = (value, out) => {
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (p.pan) p.pan.value = value;
    p.connect(out);
    return p;
  };
  const buses = { near: FLASH_PANS.map((v) => panner(v, near)), far: FLASH_PANS.map((v) => panner(v, far)) };
  const buffers = FLASH_BANDS.map((b, i) => toBuffer(ctx, bandNoise(ctx.sampleRate, NOISE_S, b, 0x2545f491 + i * 7919)));

  const crackle = ctx.createBufferSource();
  crackle.buffer = toBuffer(ctx, crackleNoise(ctx.sampleRate, CRACKLE_S));
  crackle.loop = true;
  const crowdBand = ctx.createBiquadFilter();
  crowdBand.type = 'bandpass';
  crowdBand.frequency.value = 2500;
  crowdBand.Q.value = 0.7;
  const crowdGain = ctx.createGain();
  crowdGain.gain.value = 0;
  const crowdPan = panner(0, input);
  crackle.connect(crowdBand).connect(crowdGain).connect(crowdPan);
  crackle.start(ctx.currentTime);

  return {
    /** One tick at time t (voice from flashVoices). */
    play(voice, t = ctx.currentTime) {
      const b = FLASH_BANDS[voice.band] || FLASH_BANDS[2];
      const src = ctx.createBufferSource();
      src.buffer = buffers[voice.band] || buffers[2];
      const g = ctx.createGain();
      const peak = Math.max(1e-4, voice.level * b.gain);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + ATTACK_S);
      g.gain.setTargetAtTime(0, t + ATTACK_S, b.decay / 3);
      src.connect(g).connect((voice.far ? buses.far : buses.near)[voice.pan] || buses.near[2]);
      src.onended = () => g.disconnect();
      src.start(t, Math.random() * (NOISE_S - SLICE_S), Math.min(SLICE_S, ATTACK_S + b.decay * 5));
    },
    /** The crowd crackle: rises to gain at t and fades out unless the next frame renews it. */
    crowd(gain, pan, t = ctx.currentTime) {
      crowdGain.gain.cancelScheduledValues(t);
      crowdGain.gain.setTargetAtTime(gain, t, 0.12);
      crowdGain.gain.setTargetAtTime(0, t + 0.25, 0.2);
      if (crowdPan.pan) crowdPan.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.1);
    },
    dispose() {
      try {
        crackle.stop();
      } catch {
        /* already stopped */
      }
      master.disconnect();
    },
  };
}

/** Live flash sound on the shared switch: spawn(items, {block, reason, camera}) and state for checks. */
export function createFlashSound({ sound, now = () => performance.now() } = {}) {
  let graph = null;
  let graphCtx = null;
  let lastSpawn = null;
  let frameS = 1 / 60; // eased time between frames: the span one frame's ticks are spread over
  let cursor = null; // audio time where the next frame's ticks start
  let lastFrame = null;
  const plan = createFlashPlanState();
  const totals = { voices: 0, frames: 0 };
  return {
    /** One frame's new flashes (render/terrain/flashes.js onSpawn) with the camera. */
    spawn(items, { block = NaN, reason = 'advance', camera = null } = {}) {
      if (!sound || !sound.running || !items || !items.length || !camera || !camera.elements) return null;
      if (reason !== 'advance') return null;
      const ctx = sound.context;
      if (!graph || graphCtx !== ctx) {
        if (graph) graph.dispose();
        graph = buildFlashGraph(ctx);
        graphCtx = ctx;
        cursor = null;
      }
      const t = now();
      const p = flashVoices(items, { camera, block, now: t, state: plan });
      if (lastSpawn !== null) {
        const gap = (t - lastSpawn) / 1000;
        // A pause (paused playback, a seek) restarts the schedule instead of stretching the span.
        if (gap > 0.5) cursor = null;
        else frameS += (clamp(gap, FRAME_S_MIN, FRAME_S_MAX) - frameS) * 0.2;
      }
      lastSpawn = t;
      const span = frameSpan(cursor, ctx.currentTime, frameS);
      cursor = span.end;
      let maxLevel = 0;
      for (const v of p.voices) {
        graph.play(v, span.start + Math.random() * (span.end - span.start));
        if (v.level > maxLevel) maxLevel = v.level;
      }
      graph.crowd(p.crowd.gain, p.crowd.pan, span.start);
      totals.voices += p.voices.length;
      totals.frames++;
      lastFrame = { block, candidates: items.length, onScreen: p.onScreen, voiced: p.voices.length, crowdGain: p.crowd.gain, maxLevel,
        lead: span.start - ctx.currentTime };
      return p;
    },
    get state() {
      const ctx = sound ? sound.context : null;
      return { created: !!graph, context: ctx ? ctx.state : null, dRef: plan.dRef, lastFrame, totals: { ...totals } };
    },
  };
}
