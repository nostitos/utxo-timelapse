// Spend-flash sound (landscape/SPEC.md §8): a short pitched tick of narrow-band noise for each
// spend flash on screen, after the film's audio synthesizer (src/cpp/buv/AudioSynthesizer.h)
// moved up to 1-6 kHz: the age of the spent coins picks the band (old coins a lower tick, young
// ones a higher one), the BTC moved sets the level (the flash sprite's amount scale), and the
// distance from the camera lowers and dulls it. Nothing sounds below 400 Hz: the film's 80 Hz
// thuds came out as surges and near-silences on a MacBook's built-in speakers, and a 480 Hz
// lowest band still sounded muddy.
// Distance is measured against the view, not in world units: flashes at the median distance
// of the frame's flashes on screen play at full level, nearer ones no louder, farther ones fall
// off and are low-passed, so zooming changes the balance but not the overall level.
// Density: up to MAX_VOICES_SECOND ticks a second (MAX_VOICES_FRAME at once), loudest first, so
// a few spends are distinct ticks and many overlap into a rain-like hiss, as many raindrops do.
// Loudness follows the energy of every flash on screen, voiced or not, compressed above
// DENSITY_KNEE (power to DENSITY_POWER), so busy blocks are louder than quiet ones without a
// large jump. Each frame's ticks are mixed in JavaScript (mixFrame) into one stereo buffer that
// spans the time the frame stands for, scheduled LEAD_S ahead of the audio clock, so frames
// arriving unevenly do not bunch them and thousands of ticks cost one node a frame. Only
// advance frames (playback and steps forward) sound, so seeks and scrubs stay silent, and only
// while the shared switch (ui/sound.js) is on. flashVoices and mixFrame are pure; buildFlashGraph
// is the Web Audio graph on any BaseAudioContext.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bands by the age of the spent coins in blocks (below maxAge): the film's age bands, higher. */
export const FLASH_BANDS = Object.freeze([
  Object.freeze({ id: 'air', maxAge: 100, freq: 6000, q: 2, gain: 0.7, decay: 0.005 }),
  Object.freeze({ id: 'high', maxAge: 1000, freq: 3600, q: 2.5, gain: 0.8, decay: 0.007 }),
  Object.freeze({ id: 'mid', maxAge: 10000, freq: 2500, q: 3, gain: 0.75, decay: 0.008 }),
  Object.freeze({ id: 'low', maxAge: 100000, freq: 1600, q: 3.5, gain: 0.65, decay: 0.01 }),
  Object.freeze({ id: 'deep', maxAge: Infinity, freq: 1000, q: 4, gain: 0.55, decay: 0.012 }),
]);
export const MAX_VOICES_FRAME = 400; // the most flash sprites one frame spawns
export const MAX_VOICES_SECOND = 4000;
export const SCREEN_MARGIN = 1.1; // NDC: flashes just outside the frame still sound
export const FAR_RATIO = 2; // beyond this many reference distances a tick is low-passed
export const FAR_LOWPASS_HZ = 2000;
export const HIGHPASS_HZ = 400; // nothing below (24 dB an octave): no boom, no mud
export const REF_MIN = 1;
export const REF_MAX = 1000;
export const REF_TAU_S = 0.5;
export const EDGE_LEVEL = 0.35; // spends of coins created near the creation edge
export const DENSITY_KNEE = 40; // energy a second (sum of level squared) above which loudness is compressed
export const DENSITY_POWER = 0.4; // above the knee, 10x the energy is 4 dB louder instead of 10
export const DENSITY_GAIN_MAX = 2; // how far voiced ticks may be raised to stand for unvoiced ones
export const LEAD_S = 0.06; // ticks are scheduled at least this far ahead of the audio clock
export const DRIFT_S = 0.2; // and at most this much further, when frames arrive faster than they play
const ATTACK_S = 0.001;
const DECAYS = 5; // a tick lasts ATTACK_S + DECAYS x its band's decay
const NOISE_S = 0.5;
const NOISE_RMS = 0.2;
const MIX_GAIN = 0.65;
const MASTER_GAIN = 1.1;
const FRAME_S_MIN = 1 / 240;
const FRAME_S_MAX = 0.1; // the longest stretch one frame's ticks are spread over
export const TAIL_S = ATTACK_S + DECAYS * Math.max(...FLASH_BANDS.map((b) => b.decay));

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

/** Tick level: amount scale t (0..1), creation-edge spends quieter, times the distance factor. */
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

/** State flashVoices keeps between frames: the eased reference distance and the tick budget. */
export function createFlashPlanState() {
  return { dRef: null, at: null, tokens: MAX_VOICES_FRAME, tokenAt: null };
}

/**
 * Plans the sound of one frame's flashes. items: [{x, y, z, xEnd, t, old}] from
 * render/terrain/flashes.js (world units; t = amount scale; xEnd = the cell's newest block / 1000);
 * camera: {x, y, z, elements} from view.cameraView(); block: the frame's block; now: ms;
 * state: createFlashPlanState().
 * Returns {voices: [{band, pan, far, level, distance}], energy (sum of level squared of every
 * flash on screen), voicedEnergy, dRef, onScreen}; pan is the screen x, -1 to 1.
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
  let energy = 0;
  for (const o of on) {
    o.level = flashLevel(o.it.t, o.it.old !== false, distanceGain(o.d, ref));
    o.far = o.d > FAR_RATIO * ref;
    o.band = bandIndex(Number.isFinite(block) ? Math.max(0, block - (o.it.xEnd ?? o.it.x) * 1000) : Infinity);
    energy += o.level * o.level;
  }
  on.sort((a, b) => b.level - a.level);
  if (Number.isFinite(state.tokenAt)) {
    state.tokens = Math.min(MAX_VOICES_FRAME, state.tokens + (Math.max(0, now - state.tokenAt) / 1000) * MAX_VOICES_SECOND);
  }
  state.tokenAt = now;
  const slots = Math.max(0, Math.min(on.length, Math.floor(state.tokens)));
  state.tokens -= slots;
  const voices = [];
  let voicedEnergy = 0;
  for (let i = 0; i < slots; i++) {
    const o = on[i];
    voices.push({ band: o.band, pan: clamp(o.ndcX, -1, 1), far: o.far, level: o.level, distance: o.d });
    voicedEnergy += o.level * o.level;
  }
  return { voices, energy, voicedEnergy, dRef: state.dRef, onScreen: on.length };
}

/**
 * Gain on a frame's voiced ticks so the output's power follows the energy of every flash on
 * screen: unchanged up to DENSITY_KNEE a second, compressed to the power DENSITY_POWER above it.
 * energyRate, voicedRate: sum of level squared a second, of all flashes and of the voiced ones.
 */
export function densityGain(energyRate, voicedRate) {
  if (!(voicedRate > 0)) return 0;
  const target = energyRate <= DENSITY_KNEE ? energyRate : DENSITY_KNEE * (energyRate / DENSITY_KNEE) ** DENSITY_POWER;
  return Math.min(DENSITY_GAIN_MAX, Math.sqrt(target / voicedRate));
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
 * (Float32Array). One pass of the film's band-pass falls off only 6 dB an octave; two passes
 * keep each band near its frequency.
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

/** The same noise through two one-pole low-passes at 'freq' (the duller copy for far ticks). */
export function lowpassed(data, sampleRate, freq = FAR_LOWPASS_HZ) {
  const k = 1 - Math.exp((-2 * Math.PI * freq) / sampleRate);
  const out = new Float32Array(data.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    y1 += k * (data[i] - y1);
    y2 += k * (y1 - y2);
    out[i] = y2;
  }
  return out;
}

/** Near and far tick noise for every band at 'sampleRate': {near: [Float32Array], far: [...]}. */
export function tickNoise(sampleRate) {
  const near = FLASH_BANDS.map((b, i) => bandNoise(sampleRate, NOISE_S, b, 0x2545f491 + i * 7919));
  return { near, far: near.map((d) => lowpassed(d, sampleRate)) };
}

/**
 * Mixes one frame's ticks into a stereo buffer: each starts at a random point of the first
 * spanSamples samples, with a 1 ms attack and its band's exponential decay, equal-power panned
 * by its screen x, at level x band gain x gain. noise: tickNoise(sampleRate). Returns
 * {left, right} of length spanSamples + the longest tick (Float32Array).
 */
export function mixFrame(voices, { sampleRate, spanSamples, gain = 1, noise, random = Math.random }) {
  const attack = Math.max(1, Math.round(ATTACK_S * sampleRate));
  const length = Math.max(1, spanSamples) + Math.ceil(TAIL_S * sampleRate) + 1;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const v of voices) {
    const b = FLASH_BANDS[v.band] || FLASH_BANDS[2];
    const src = (v.far ? noise.far : noise.near)[v.band] || noise.near[2];
    const len = attack + Math.round(DECAYS * b.decay * sampleRate);
    const amp = v.level * b.gain * gain * MIX_GAIN;
    if (!(amp > 0)) continue;
    const start = Math.min(Math.floor(random() * Math.max(1, spanSamples)), length - len);
    const offset = Math.floor(random() * (src.length - len));
    const angle = ((clamp(v.pan ?? 0, -1, 1) + 1) * Math.PI) / 4;
    const gl = amp * Math.cos(angle);
    const gr = amp * Math.sin(angle);
    const fall = Math.exp(-1 / ((b.decay / 3) * sampleRate));
    let env = 1;
    for (let i = 0; i < len; i++) {
      let e;
      if (i < attack) e = (i + 1) / attack;
      else {
        e = env;
        env *= fall;
      }
      const s = src[offset + i] * e;
      left[start + i] += s * gl;
      right[start + i] += s * gr;
    }
  }
  return { left, right };
}

/** The flash graph on any BaseAudioContext: {play({left, right}, t), dispose()}. */
export function buildFlashGraph(ctx, { destination = ctx.destination } = {}) {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  // A peak limiter: dense frames are kept in check by densityGain, so it rarely acts.
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
  highpass.connect(highpass2).connect(limiter).connect(master).connect(destination);
  return {
    noise: tickNoise(ctx.sampleRate),
    /** One frame's mixed ticks (mixFrame) at time t. */
    play({ left, right }, t = ctx.currentTime) {
      const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
      buffer.getChannelData(0).set(left);
      buffer.getChannelData(1).set(right);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(highpass);
      src.onended = () => src.disconnect();
      src.start(t);
    },
    dispose() {
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
  const totals = { voices: 0, frames: 0, mixMs: 0 };
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
      const d = span.end - span.start;
      const gain = densityGain(p.energy / d, p.voicedEnergy / d);
      let maxLevel = 0;
      for (const v of p.voices) if (v.level > maxLevel) maxLevel = v.level;
      let mixMs = 0;
      let lead = span.start - ctx.currentTime;
      if (p.voices.length && gain > 0) {
        const m0 = now();
        const mix = mixFrame(p.voices, { sampleRate: ctx.sampleRate, spanSamples: Math.round(d * ctx.sampleRate), gain, noise: graph.noise });
        lead = span.start - ctx.currentTime; // when the buffer is queued, after mixing
        graph.play(mix, span.start);
        mixMs = now() - m0;
      }
      totals.voices += p.voices.length;
      totals.frames++;
      totals.mixMs += mixMs;
      lastFrame = { block, candidates: items.length, onScreen: p.onScreen, voiced: p.voices.length, gain, maxLevel,
        energyRate: p.energy / d, lead, mixMs };
      return p;
    },
    get state() {
      const ctx = sound ? sound.context : null;
      return { created: !!graph, context: ctx ? ctx.state : null, dRef: plan.dRef, lastFrame, totals: { ...totals } };
    },
  };
}
