// Plane mode engine sound (landscape/SPEC.md §8), synthesized with Web Audio (no audio
// files): two detuned sawtooth oscillators and a sub-octave sine through a low-pass filter,
// pulsed by a slow oscillator for the propeller's beat, plus filtered noise for the wind.
// Pitch and brightness follow the throttle and boost, the wind follows the airspeed, the
// sound pans a little with the bank, and a bump plays a short thump. M mutes it (remembered
// in localStorage). The audio context starts on the key press or click that takes off;
// browsers keep it silent until such a gesture.

const STORE_KEY = 'utxo-landscape-plane-sound';
const MAX_BANK = (75 * Math.PI) / 180;
const MAX_SPEED = 48; // full throttle with boost (ui/plane.js)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Audio targets for a flight state. Pure: { throttle 0..1, speed, boost, bank (radians),
 * on } -> { freq (Hz), cutoff (Hz), beat (Hz), engine, wind, windFreq, pan, gain }.
 */
export function engineTargets({ throttle = 0, speed = 0, boost = false, bank = 0, on = true } = {}, volume = 0.18) {
  const rpm = clamp(0.3 + 0.7 * clamp(throttle, 0, 1) + (boost ? 0.35 : 0), 0, 1.4);
  const freq = 46 + 58 * rpm;
  const airspeed = clamp(speed / MAX_SPEED, 0, 1);
  return {
    freq,
    cutoff: 240 + 1100 * rpm,
    beat: freq / 4,
    engine: 0.32 + 0.28 * rpm,
    wind: 0.02 + 0.16 * airspeed,
    windFreq: 450 + 1600 * airspeed,
    pan: clamp((bank / MAX_BANK) * 0.25, -0.25, 0.25),
    gain: on ? volume : 0,
  };
}

function noiseBuffer(ctx, seconds) {
  const n = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    d[i] = ((x >>> 0) / 4294967296) * 2 - 1;
  }
  return buffer;
}

/** The engine graph on any BaseAudioContext (live or offline). Returns { set, bump, last, dispose }. */
export function buildEngine(ctx, { destination = ctx.destination, volume = 0.18 } = {}) {
  const master = ctx.createGain();
  master.gain.value = 0;
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) pan.connect(master);
  master.connect(destination);
  const out = pan || master;

  const saw1 = ctx.createOscillator();
  const saw2 = ctx.createOscillator();
  const sub = ctx.createOscillator();
  saw1.type = 'sawtooth';
  saw2.type = 'sawtooth';
  saw2.detune.value = 11;
  sub.type = 'sine';
  const sawMix = ctx.createGain();
  sawMix.gain.value = 0.45;
  const subMix = ctx.createGain();
  subMix.gain.value = 0.7;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.Q.value = 0.9;
  const beat = ctx.createGain();
  beat.gain.value = 0.75;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.25;
  const engine = ctx.createGain();
  engine.gain.value = 0.4;
  saw1.connect(sawMix);
  saw2.connect(sawMix);
  sub.connect(subMix);
  sawMix.connect(lowpass);
  subMix.connect(lowpass);
  lowpass.connect(beat);
  lfo.connect(lfoDepth).connect(beat.gain);
  beat.connect(engine).connect(out);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 2);
  noise.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.7;
  const wind = ctx.createGain();
  wind.gain.value = 0;
  noise.connect(band).connect(wind).connect(out);
  const bumpNoise = noiseBuffer(ctx, 0.3);

  const t0 = ctx.currentTime;
  // Start at the idle note so takeoff does not slide down from the 440 Hz default.
  const idle = engineTargets({ throttle: 0.5, speed: 2 }, volume);
  saw1.frequency.value = idle.freq;
  saw2.frequency.value = idle.freq;
  sub.frequency.value = idle.freq / 2;
  lfo.frequency.value = idle.beat;
  lowpass.frequency.value = idle.cutoff;
  band.frequency.value = idle.windFreq;
  for (const node of [saw1, saw2, sub, lfo, noise]) node.start(t0);

  const api = {
    last: null,
    /** params as engineTargets; t: when (default now); tau: smoothing time constant (s). */
    set(params, t = ctx.currentTime, tau = 0.08) {
      const g = engineTargets(params, volume);
      api.last = g;
      saw1.frequency.setTargetAtTime(g.freq, t, tau);
      saw2.frequency.setTargetAtTime(g.freq, t, tau);
      sub.frequency.setTargetAtTime(g.freq / 2, t, tau);
      lfo.frequency.setTargetAtTime(g.beat, t, tau);
      lowpass.frequency.setTargetAtTime(g.cutoff, t, tau);
      engine.gain.setTargetAtTime(g.engine, t, tau);
      wind.gain.setTargetAtTime(g.wind, t, tau * 2);
      band.frequency.setTargetAtTime(g.windFreq, t, tau * 2);
      if (pan) pan.pan.setTargetAtTime(g.pan, t, tau * 2);
      master.gain.setTargetAtTime(g.gain, t, g.gain > 0 ? 0.15 : 0.1);
    },
    /** A short thump: a falling low sine and a burst of muffled noise. */
    bump(t = ctx.currentTime) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(1.1, t + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(og).connect(out);
      const n = ctx.createBufferSource();
      n.buffer = bumpNoise;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.6, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      n.connect(lp).connect(ng).connect(out);
      o.start(t);
      o.stop(t + 0.32);
      n.start(t);
      n.stop(t + 0.2);
    },
    dispose() {
      for (const node of [saw1, saw2, sub, lfo, noise]) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      master.disconnect();
    },
  };
  return api;
}

/** Live engine sound for plane mode: start(), stop(), update(plane), unlock(), toggleMuted(). */
export function createPlaneSound({ storage = globalThis.localStorage, volume = 0.18 } = {}) {
  let ctx = null;
  let engine = null;
  let active = false;
  let lastBumps = null;
  let suspendTimer = 0;
  let muted = false;
  try {
    muted = storage ? storage.getItem(STORE_KEY) === 'off' : false;
  } catch {
    muted = false;
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      engine = buildEngine(ctx, { volume });
    } catch {
      ctx = null;
      engine = null;
    }
    return ctx;
  }
  function resume() {
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  }
  function hidden() {
    return typeof document !== 'undefined' && document.hidden;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (hidden()) ctx.suspend().catch(() => {});
      else if (active && !muted) resume();
    });
  }

  return {
    /** Takeoff (call from the key press or click, so the browser lets the sound start). */
    start() {
      active = true;
      lastBumps = null;
      clearTimeout(suspendTimer);
      if (muted) return;
      ensure();
      resume();
    },
    /** Landing: fade out, then suspend the context. */
    stop() {
      active = false;
      if (!ctx || !engine) return;
      engine.set({ on: false });
      clearTimeout(suspendTimer);
      suspendTimer = setTimeout(() => {
        if (ctx && !active) ctx.suspend().catch(() => {});
      }, 600);
    },
    /** Per frame with the ui/plane.js state. */
    update(plane) {
      if (!active || !plane || !engine) return;
      engine.set({ throttle: plane.throttle, speed: plane.speed, boost: plane.boosting, bank: plane.bank, on: !muted && !hidden() });
      if (lastBumps !== null && plane.bumps > lastBumps && !muted) engine.bump();
      lastBumps = plane.bumps;
    },
    /** Any later key press or click: browsers may have kept the context suspended. */
    unlock() {
      if (active && !muted) {
        ensure();
        resume();
      }
    },
    toggleMuted() {
      muted = !muted;
      try {
        if (storage) storage.setItem(STORE_KEY, muted ? 'off' : 'on');
      } catch {
        /* private mode: not remembered */
      }
      if (muted) {
        if (engine) engine.set({ on: false });
      } else if (active) {
        ensure();
        resume();
      }
      return muted;
    },
    get muted() {
      return muted;
    },
    /** For checks: whether the graph exists, the context state and the last targets. */
    get state() {
      return { created: !!engine, context: ctx ? ctx.state : null, active, muted, target: engine ? engine.last : null };
    },
  };
}
