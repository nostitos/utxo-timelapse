// Spend-flash sound (landscape/SPEC.md §8): a crisp click for each spend flash on screen, like a
// raindrop: a 0.2 ms rise and a 1-3 ms decay of white noise through a broad band-pass. The age of
// the spent coins sets its brightness (old coins centred at 1.6 kHz, young ones at 7 kHz), the
// BTC moved sets the level (the flash sprite's amount scale), and the distance from the camera
// lowers and darkens it. Clicks have no pitch: pitched noise ticks seemed to start high on old
// coins, and clean tones at 330 Hz-2.4 kHz sounded like bubbles under water. Nothing is below
// 300 Hz: the film's 80 Hz thuds came out as surges and near-silences on a MacBook's built-in
// speakers.
// Distance is measured against the view, not in world units: flashes at the median distance
// of the frame's flashes on screen play at full level, nearer ones no louder, farther ones fall
// off and sound darker, so zooming changes the balance but not the overall level.
// Density: up to MAX_VOICES_SECOND ticks a second (MAX_VOICES_FRAME at once), loudest first, so
// a few spends are distinct clicks and many overlap into the hiss of rain, as many raindrops do.
// Loudness follows the energy of every flash on screen, voiced or not, compressed above
// DENSITY_KNEE (power to DENSITY_POWER), so busy blocks are louder than quiet ones without a
// large jump. Each frame's ticks become compact events spread over the time the frame stands
// for, LEAD_S ahead of the audio clock, so frames arriving unevenly do not bunch them; an
// AudioWorklet (ui/flash-worklet.js) synthesizes them on the audio thread, so thousands of ticks
// a second cost the page almost nothing. Only
// advance frames (playback and steps forward) sound, so seeks and scrubs stay silent, and only
// while the shared switch (ui/sound.js) is on. flashVoices, tickEvents and mixFrame are pure;
// buildFlashGraph is the Web Audio graph on any BaseAudioContext.

import { TickRenderer, EVENT_FIELDS } from './flash-worklet.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Bands by the age of the spent coins in blocks (below maxAge): the film's age bands as clicks
 * centred on freq (band-pass Q q), darker and a little longer for older coins. decay is three
 * time constants (s).
 */
export const FLASH_BANDS = Object.freeze([
  Object.freeze({ id: 'air', maxAge: 100, freq: 7000, q: 0.9, gain: 0.8, decay: 0.0036 }),
  Object.freeze({ id: 'high', maxAge: 1000, freq: 4800, q: 0.9, gain: 0.85, decay: 0.0045 }),
  Object.freeze({ id: 'mid', maxAge: 10000, freq: 3300, q: 0.9, gain: 0.9, decay: 0.0057 }),
  Object.freeze({ id: 'low', maxAge: 100000, freq: 2300, q: 0.9, gain: 1, decay: 0.0069 }),
  Object.freeze({ id: 'deep', maxAge: Infinity, freq: 1600, q: 0.9, gain: 1.1, decay: 0.0084 }),
]);
export const MAX_VOICES_FRAME = 400; // the most flash sprites one frame spawns
export const MAX_VOICES_SECOND = 4000;
export const SCREEN_MARGIN = 1.1; // NDC: flashes just outside the frame still sound
export const FAR_RATIO = 2; // beyond this many reference distances a tick is darker
export const FAR_DARKEN = 0.6; // and its band-pass centre is this much lower
export const HIGHPASS_HZ = 300; // nothing below (24 dB an octave): no boom
export const REF_MIN = 1;
export const REF_MAX = 1000;
export const REF_TAU_S = 0.5;
export const EDGE_LEVEL = 0.35; // spends of coins created near the creation edge
export const DENSITY_KNEE = 40; // energy a second (sum of level squared) above which loudness is compressed
export const DENSITY_POWER = 0.4; // above the knee, 10x the energy is 4 dB louder instead of 10
export const DENSITY_GAIN_MAX = 2; // how far voiced ticks may be raised to stand for unvoiced ones
export const LEAD_S = 0.06; // ticks are scheduled at least this far ahead of the audio clock
export const DRIFT_S = 0.2; // and at most this much further, when frames arrive faster than they play
const ATTACK_S = 0.0002;
const DECAYS = 3; // a tick lasts ATTACK_S + DECAYS x its band's decay (it is then 78 dB down)
const CLICK_PEAK = 0.65; // the white noise's peak before the gains
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

/**
 * Tick events for one frame (EVENT_FIELDS numbers each, for TickRenderer): each voice starts at a
 * random point of the spanSamples samples after startFrame, centred on its band's frequency (far
 * ticks FAR_DARKEN lower), at level x band gain x gain, equal-power panned by its screen x, with
 * its own noise.
 */
export function tickEvents(voices, { spanSamples, gain = 1, startFrame = 0, random = Math.random }) {
  const out = new Float64Array(voices.length * EVENT_FIELDS);
  let k = 0;
  for (const v of voices) {
    const band = FLASH_BANDS[v.band] ? v.band : 2;
    const amp = v.level * FLASH_BANDS[band].gain * gain * MIX_GAIN * CLICK_PEAK;
    if (!(amp > 0)) continue;
    const angle = ((clamp(v.pan ?? 0, -1, 1) + 1) * Math.PI) / 4;
    out[k++] = startFrame + Math.floor(random() * Math.max(1, spanSamples));
    out[k++] = band;
    out[k++] = FLASH_BANDS[band].freq * (v.far ? FAR_DARKEN : 1);
    out[k++] = amp * Math.cos(angle);
    out[k++] = amp * Math.sin(angle);
    out[k++] = 1 + Math.floor(random() * 0xfffffffe);
  }
  return k === out.length ? out : out.slice(0, k);
}

const DECAY_LIST = FLASH_BANDS.map((b) => b.decay);
const RENDERER_OPTIONS = { decays: DECAY_LIST, qs: FLASH_BANDS.map((b) => b.q), attackS: ATTACK_S, decaysPerTick: DECAYS };

/** A TickRenderer at 'sampleRate'. */
export function tickRenderer(sampleRate) {
  return new TickRenderer({ sampleRate, ...RENDERER_OPTIONS });
}

/**
 * Mixes one frame's ticks into a stereo buffer on this thread (the fallback without
 * AudioWorklet, and the tests): {left, right} of length spanSamples + the longest tick.
 */
export function mixFrame(voices, { sampleRate, spanSamples, gain = 1, random = Math.random }) {
  const renderer = tickRenderer(sampleRate);
  const length = Math.max(1, spanSamples) + Math.ceil(TAIL_S * sampleRate) + 1;
  renderer.add(tickEvents(voices, { spanSamples, gain, random }));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  renderer.render(left, right, 0, length);
  return { left, right };
}

/**
 * The flash graph on any BaseAudioContext: {queue(voices, {start, spanSamples, gain}), mode,
 * dispose()}. Ticks are synthesized by the 'flash-ticks' AudioWorklet (ui/flash-worklet.js) on
 * the audio thread; until it has loaded, or where AudioWorklet is missing, each frame is mixed
 * here and played as one buffer.
 */
export function buildFlashGraph(ctx, { destination = ctx.destination, worklet = true } = {}) {
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
  const sampleRate = ctx.sampleRate;
  let node = null;
  let mode = 'main';
  if (worklet && ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    mode = 'loading';
    ctx.audioWorklet.addModule(new URL('./flash-worklet.js', import.meta.url)).then(() => {
      node = new AudioWorkletNode(ctx, 'flash-ticks', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.postMessage({ type: 'init', ...RENDERER_OPTIONS });
      node.connect(highpass);
      mode = 'worklet';
    }).catch((err) => {
      console.warn('flash sound: AudioWorklet unavailable, mixing on the main thread', err);
      mode = 'main';
    });
  }
  function playMixed(voices, start, spanSamples, gain) {
    const { left, right } = mixFrame(voices, { sampleRate, spanSamples, gain });
    const buffer = ctx.createBuffer(2, left.length, sampleRate);
    buffer.getChannelData(0).set(left);
    buffer.getChannelData(1).set(right);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(highpass);
    src.onended = () => src.disconnect();
    src.start(start);
  }
  return {
    get mode() {
      return mode;
    },
    /** One frame's voices from 'start' (audio time) over spanSamples, at density gain 'gain'. */
    queue(voices, { start, spanSamples, gain }) {
      if (mode === 'worklet') {
        const events = tickEvents(voices, { spanSamples, gain, startFrame: Math.round(start * sampleRate) });
        node.port.postMessage({ type: 'ticks', events }, [events.buffer]);
      } else playMixed(voices, start, spanSamples, gain);
    },
    dispose() {
      if (node) node.disconnect();
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
  const totals = { voices: 0, frames: 0, mainMs: 0 };
  return {
    /** One frame's new flashes (render/terrain/flashes.js onSpawn) with the camera. */
    spawn(items, { block = NaN, reason = 'advance', camera = null } = {}) {
      if (!sound || !sound.running || !items || !items.length || !camera || !camera.elements) return null;
      if (reason !== 'advance') return null;
      const t = now();
      const ctx = sound.context;
      if (!graph || graphCtx !== ctx) {
        if (graph) graph.dispose();
        graph = buildFlashGraph(ctx);
        graphCtx = ctx;
        cursor = null;
      }
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
      const lead = span.start - ctx.currentTime;
      if (p.voices.length && gain > 0) graph.queue(p.voices, { start: span.start, spanSamples: Math.round(d * ctx.sampleRate), gain });
      const mainMs = now() - t;
      totals.voices += p.voices.length;
      totals.frames++;
      totals.mainMs += mainMs;
      lastFrame = { block, candidates: items.length, onScreen: p.onScreen, voiced: p.voices.length, gain, maxLevel,
        energyRate: p.energy / d, lead, mainMs, mode: graph.mode };
      return p;
    },
    get state() {
      const ctx = sound ? sound.context : null;
      return { created: !!graph, mode: graph ? graph.mode : null, context: ctx ? ctx.state : null, dRef: plan.dRef, lastFrame,
        totals: { ...totals } };
    },
  };
}
