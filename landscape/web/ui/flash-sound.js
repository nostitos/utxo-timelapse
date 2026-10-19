// Spend-flash sound (landscape/SPEC.md §8): a short click of filtered noise for each spend
// flash on screen, after the film's audio synthesizer (src/cpp/buv/AudioSynthesizer.h). The
// age of the spent coins picks the band (old coins a low thud, young ones a high tick), the
// BTC moved sets the level (the flash sprite's amount scale), and the distance from the camera
// lowers and dulls it. Distance is measured against the view, not in world units: flashes at
// the distance the camera looks at (the nearer of the terrain at the centre of the view and
// the median distance of the frame's flashes on screen) play at full level, nearer ones no
// louder, farther ones fall off and pass through a low-pass filter. The loudest flashes of a
// frame get their own click from a budget that refills at MAX_VOICES_SECOND a second and holds
// at most MAX_VOICES_FRAME (so busy playback clicks steadily, about 5 a frame at 60 fps); the
// rest feed one crackle whose level follows their sum. Only advance frames
// (playback and steps forward) sound, so seeks and scrubs stay silent, and only while the
// shared switch (ui/sound.js) is on. flashVoices plans a frame (pure); buildFlashGraph is the
// Web Audio graph on any BaseAudioContext.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bands by the age of the spent coins in blocks (below maxAge), as in the film's synthesizer. */
export const FLASH_BANDS = Object.freeze([
  Object.freeze({ id: 'air', maxAge: 100, freq: 12000, q: 0.8, gain: 0.45, decay: 0.018 }),
  Object.freeze({ id: 'high', maxAge: 1000, freq: 4000, q: 1.0, gain: 0.55, decay: 0.025 }),
  Object.freeze({ id: 'mid', maxAge: 10000, freq: 1500, q: 1.0, gain: 0.7, decay: 0.035 }),
  Object.freeze({ id: 'low', maxAge: 100000, freq: 200, q: 1.5, gain: 0.9, decay: 0.06 }),
  Object.freeze({ id: 'sub', maxAge: Infinity, freq: 80, q: 2.0, gain: 1.0, decay: 0.09 }),
]);
/** Stereo positions a click snaps to (left edge of the screen to the right edge). */
export const FLASH_PANS = Object.freeze([-1, -0.5, 0, 0.5, 1]);
export const MAX_VOICES_FRAME = 16;
export const MAX_VOICES_SECOND = 300;
export const SCREEN_MARGIN = 1.1; // NDC: flashes just outside the frame still sound
export const FAR_RATIO = 2; // beyond this many reference distances a click is low-passed
export const FAR_LOWPASS_HZ = 1200;
export const REF_MIN = 1;
export const REF_MAX = 1000;
export const REF_TAU_S = 0.5;
export const EDGE_LEVEL = 0.35; // spends of coins created near the creation edge
export const CROWD_PER_LEVEL = 0.02;
export const CROWD_MAX = 0.35;
const ATTACK_S = 0.002;
const SLICE_S = 0.12;
const NOISE_S = 0.5;
const NOISE_RMS = 0.2;
const CRACKLE_S = 2;
const CRACKLE_RATE = 400; // clicks per second in the crowd loop
const MASTER_GAIN = 0.5;
const SPREAD_MAX_S = 0.05; // a frame's clicks spread over the time since the previous frame

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
 * camera: {x, y, z, elements} from view.cameraView(); focus: distance to the terrain at the
 * centre of the view, or null; block: the frame's block; now: ms; state: createFlashPlanState().
 * Returns {voices: [{band, pan, far, level, ndcX, distance}], crowd: {gain, pan}, dRef, onScreen}.
 */
export function flashVoices(items, { camera, focus = null, block = NaN, now = 0, state = createFlashPlanState() } = {}) {
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
    const target = clamp(Number.isFinite(focus) && focus > 0 ? Math.min(focus, median) : median, REF_MIN, REF_MAX);
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
    crowd: { gain: Math.min(CROWD_MAX, CROWD_PER_LEVEL * sum), pan: sum > 0 ? panSum / sum : 0 },
    dRef: state.dRef,
    onScreen: on.length,
  };
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
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 6;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  comp.connect(master).connect(destination);
  const near = ctx.createGain();
  near.connect(comp);
  const far = ctx.createBiquadFilter();
  far.type = 'lowpass';
  far.frequency.value = FAR_LOWPASS_HZ;
  far.Q.value = 0.7;
  far.connect(comp);
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
  crowdBand.frequency.value = 1200;
  crowdBand.Q.value = 0.5;
  const crowdGain = ctx.createGain();
  crowdGain.gain.value = 0;
  const crowdPan = panner(0, comp);
  crackle.connect(crowdBand).connect(crowdGain).connect(crowdPan);
  crackle.start(ctx.currentTime);

  return {
    /** One click at time t (voice from flashVoices). */
    play(voice, t = ctx.currentTime) {
      const b = FLASH_BANDS[voice.band] || FLASH_BANDS[2];
      const src = ctx.createBufferSource();
      src.buffer = buffers[voice.band] || buffers[2];
      const g = ctx.createGain();
      const peak = Math.max(1e-4, voice.level * b.gain);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + ATTACK_S);
      g.gain.setTargetAtTime(0, t + ATTACK_S, b.decay / 4);
      src.connect(g).connect((voice.far ? buses.far : buses.near)[voice.pan] || buses.near[2]);
      src.onended = () => g.disconnect();
      src.start(t, Math.random() * (NOISE_S - SLICE_S), SLICE_S);
    },
    /** The crowd crackle: rises to gain now and fades out unless the next frame renews it. */
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

/** Live flash sound on the shared switch: spawn(items, {block, reason, camera, focus}) and state for checks. */
export function createFlashSound({ sound, now = () => performance.now() } = {}) {
  let graph = null;
  let graphCtx = null;
  let lastSpawn = null;
  let lastFrame = null;
  const plan = createFlashPlanState();
  const totals = { voices: 0, frames: 0 };
  return {
    /** One frame's new flashes (render/terrain/flashes.js onSpawn) with the camera. */
    spawn(items, { block = NaN, reason = 'advance', camera = null, focus = null } = {}) {
      if (!sound || !sound.running || !items || !items.length || !camera || !camera.elements) return null;
      if (reason !== 'advance') return null;
      const ctx = sound.context;
      if (!graph || graphCtx !== ctx) {
        if (graph) graph.dispose();
        graph = buildFlashGraph(ctx);
        graphCtx = ctx;
      }
      const t = now();
      const p = flashVoices(items, { camera, focus, block, now: t, state: plan });
      const spread = lastSpawn === null ? 0 : clamp((t - lastSpawn) / 1000, 0, SPREAD_MAX_S);
      lastSpawn = t;
      const t0 = ctx.currentTime + 0.005;
      let maxLevel = 0;
      for (const v of p.voices) {
        graph.play(v, t0 + Math.random() * spread);
        if (v.level > maxLevel) maxLevel = v.level;
      }
      graph.crowd(p.crowd.gain, p.crowd.pan, ctx.currentTime);
      totals.voices += p.voices.length;
      totals.frames++;
      lastFrame = { block, candidates: items.length, onScreen: p.onScreen, voiced: p.voices.length, crowdGain: p.crowd.gain, maxLevel };
      return p;
    },
    get state() {
      const ctx = sound ? sound.context : null;
      return { created: !!graph, context: ctx ? ctx.state : null, dRef: plan.dRef, lastFrame, totals: { ...totals } };
    },
  };
}
