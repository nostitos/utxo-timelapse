// Plane mode engine sound (landscape/SPEC.md §8), synthesized with Web Audio (no audio
// files): two detuned sawtooth oscillators and a sub-octave sine through a low-pass filter,
// pulsed by a slow oscillator for the propeller's beat, plus filtered noise for the wind.
// Pitch and brightness follow the throttle and boost, the wind follows the airspeed, the
// sound pans a little with the bank, and a bump plays a short thump. Each craft has its own
// profile (engineTargets): the jet has no oscillator engine (a pitched sawtooth sounded like a
// vacuum cleaner) but a turbine heard from behind: a deep brown-noise rumble, a softer
// low-passed roar that opens up with the throttle, slow turbulence on both and a faint
// two-tone whine, with the afterburner adding rumble on boost; the bird has no engine, only
// wind pulsed at its wing beat, silent beat while it glides. A collected Stack sats coin plays a short two-note chime. M mutes it (remembered in
// localStorage). The audio context starts on the key press or click that takes off; browsers
// keep it silent until such a gesture.

import { craftSpec, flapRate } from './plane.js';

const STORE_KEY = 'utxo-landscape-plane-sound';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Audio targets for a flight state and craft (profile: 'plane', 'bird' or 'jet'). Pure:
 * { throttle 0..1, speed, boost, bank (radians), on } -> { freq (Hz), cutoff (Hz), beat (Hz),
 * beatDepth (engine pulse), windBeat (wind pulse), engine, wind, windFreq, rumble,
 * rumbleFreq, roar, roarFreq, whine, whineFreq (the jet's turbine; 0 for the others), pan,
 * gain, bumpGain }. The airspeed is measured against the craft's full throttle with boost.
 */
export function engineTargets({ throttle = 0, speed = 0, boost = false, bank = 0, on = true } = {}, volume = 0.18, profile = 'plane') {
  const S = craftSpec(profile);
  const rpm = clamp(0.3 + 0.7 * clamp(throttle, 0, 1) + (boost ? 0.35 : 0), 0, 1.4);
  const airspeed = clamp(speed / (S.maxSpeed * S.boost), 0, 1);
  const pan = clamp((bank / S.maxBank) * 0.25, -0.25, 0.25);
  const gain = on ? volume : 0;
  const quiet = { rumble: 0, rumbleFreq: 150, roar: 0, roarFreq: 600, whine: 0, whineFreq: 1400 };
  if (S.id === 'jet') {
    const power = clamp((rpm - 0.3) / 1.1, 0, 1); // idle 0, full throttle 0.64, with boost 0.95
    return {
      freq: 60,
      cutoff: 200,
      beat: 2,
      beatDepth: 0,
      windBeat: 0,
      engine: 0,
      wind: 0.02 + 0.1 * airspeed,
      windFreq: 800 + 2400 * airspeed,
      rumble: 0.9 + 0.5 * power + (boost ? 0.3 : 0),
      rumbleFreq: 140 + 220 * power + (boost ? 120 : 0),
      roar: 0.3 + 0.6 * power + 0.2 * airspeed + (boost ? 0.2 : 0),
      roarFreq: 500 + 1500 * power,
      whine: 0.016 * (1 - 0.5 * power),
      whineFreq: 1500 + 1300 * power,
      pan,
      gain,
      bumpGain: 1,
    };
  }
  if (S.id === 'bird') {
    const flap = flapRate(throttle, boost);
    return {
      freq: 60,
      cutoff: 300,
      beat: flap > 0 ? flap : 2,
      beatDepth: 0,
      windBeat: flap > 0 ? 0.6 : 0,
      engine: 0,
      wind: 0.03 + 0.25 * airspeed,
      windFreq: 600 + 2000 * airspeed,
      ...quiet,
      pan,
      gain,
      bumpGain: 0.5,
    };
  }
  const freq = 46 + 58 * rpm;
  return {
    freq,
    cutoff: 240 + 1100 * rpm,
    beat: freq / 4,
    beatDepth: 0.25,
    windBeat: 0,
    engine: 0.32 + 0.28 * rpm,
    wind: 0.02 + 0.16 * airspeed,
    windFreq: 450 + 1600 * airspeed,
    ...quiet,
    pan,
    gain,
    bumpGain: 1,
  };
}

function noiseBuffer(ctx, seconds, seed = 0x9e3779b9) {
  const n = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    d[i] = ((x >>> 0) / 4294967296) * 2 - 1;
  }
  return buffer;
}

/** Brown (integrated) noise for the jet's rumble, tilted so the loop joins without a step. */
function brownNoiseBuffer(ctx, seconds) {
  const n = Math.max(2, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  let x = 0x2545f491;
  let b = 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b = (b + 0.02 * (((x >>> 0) / 4294967296) * 2 - 1)) / 1.02;
    d[i] = b * 3.5;
  }
  const step = d[n - 1] - d[0];
  for (let i = 0; i < n; i++) d[i] -= (step * i) / (n - 1);
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
  // The bird's wing beat pulses the wind: the same slow oscillator, at the flap rate.
  const windPulse = ctx.createGain();
  windPulse.gain.value = 1;
  const windDepth = ctx.createGain();
  windDepth.gain.value = 0;
  lfo.connect(windDepth).connect(windPulse.gain);
  const wind = ctx.createGain();
  wind.gain.value = 0;
  noise.connect(band).connect(windPulse).connect(wind).connect(out);
  const bumpNoise = noiseBuffer(ctx, 0.3);

  // The jet's turbine: rumble and roar through a turbulence gain, and a faint whine.
  const brown = ctx.createBufferSource();
  brown.buffer = brownNoiseBuffer(ctx, 4);
  brown.loop = true;
  const rumbleLp = ctx.createBiquadFilter();
  rumbleLp.type = 'lowpass';
  rumbleLp.Q.value = 0.5;
  const rumble = ctx.createGain();
  rumble.gain.value = 0;
  const roarNoise = ctx.createBufferSource();
  roarNoise.buffer = noiseBuffer(ctx, 3, 0x5bd1e995);
  roarNoise.loop = true;
  const roarHp = ctx.createBiquadFilter();
  roarHp.type = 'highpass';
  roarHp.frequency.value = 110;
  const roarLp = ctx.createBiquadFilter();
  roarLp.type = 'lowpass';
  roarLp.Q.value = 0.3;
  const roar = ctx.createGain();
  roar.gain.value = 0;
  const turbulence = ctx.createGain();
  turbulence.gain.value = 1;
  const turbA = ctx.createOscillator();
  turbA.frequency.value = 0.71;
  const turbB = ctx.createOscillator();
  turbB.frequency.value = 1.93;
  const turbADepth = ctx.createGain();
  turbADepth.gain.value = 0.09;
  const turbBDepth = ctx.createGain();
  turbBDepth.gain.value = 0.05;
  turbA.connect(turbADepth).connect(turbulence.gain);
  turbB.connect(turbBDepth).connect(turbulence.gain);
  brown.connect(rumbleLp).connect(rumble).connect(turbulence);
  roarNoise.connect(roarHp).connect(roarLp).connect(roar).connect(turbulence);
  turbulence.connect(out);
  const whineA = ctx.createOscillator();
  const whineB = ctx.createOscillator();
  const whineBMix = ctx.createGain();
  whineBMix.gain.value = 0.45;
  const whine = ctx.createGain();
  whine.gain.value = 0;
  whineA.connect(whine);
  whineB.connect(whineBMix).connect(whine);
  whine.connect(out);
  const jetSources = [brown, roarNoise, turbA, turbB, whineA, whineB];

  const t0 = ctx.currentTime;
  // Start at the idle note so takeoff does not slide down from the 440 Hz default.
  const idle = engineTargets({ throttle: 0.5, speed: 2 }, volume);
  saw1.frequency.value = idle.freq;
  saw2.frequency.value = idle.freq;
  sub.frequency.value = idle.freq / 2;
  lfo.frequency.value = idle.beat;
  lowpass.frequency.value = idle.cutoff;
  band.frequency.value = idle.windFreq;
  rumbleLp.frequency.value = idle.rumbleFreq;
  roarLp.frequency.value = idle.roarFreq;
  whineA.frequency.value = idle.whineFreq;
  whineB.frequency.value = idle.whineFreq * 1.502;
  for (const node of [saw1, saw2, sub, lfo, noise, ...jetSources]) node.start(t0);

  const api = {
    last: null,
    /** params and profile as engineTargets; t: when (default now); tau: smoothing time constant (s). */
    set(params, t = ctx.currentTime, tau = 0.08, profile = 'plane') {
      const g = engineTargets(params, volume, profile);
      api.last = g;
      saw1.frequency.setTargetAtTime(g.freq, t, tau);
      saw2.frequency.setTargetAtTime(g.freq, t, tau);
      sub.frequency.setTargetAtTime(g.freq / 2, t, tau);
      lfo.frequency.setTargetAtTime(g.beat, t, tau);
      lfoDepth.gain.setTargetAtTime(g.beatDepth, t, tau);
      windDepth.gain.setTargetAtTime(g.windBeat, t, tau * 2);
      lowpass.frequency.setTargetAtTime(g.cutoff, t, tau);
      engine.gain.setTargetAtTime(g.engine, t, tau);
      wind.gain.setTargetAtTime(g.wind, t, tau * 2);
      band.frequency.setTargetAtTime(g.windFreq, t, tau * 2);
      rumble.gain.setTargetAtTime(g.rumble, t, tau * 2);
      rumbleLp.frequency.setTargetAtTime(g.rumbleFreq, t, tau * 3);
      roar.gain.setTargetAtTime(g.roar, t, tau * 2);
      roarLp.frequency.setTargetAtTime(g.roarFreq, t, tau * 3);
      whine.gain.setTargetAtTime(g.whine, t, tau * 2);
      whineA.frequency.setTargetAtTime(g.whineFreq, t, tau * 4);
      whineB.frequency.setTargetAtTime(g.whineFreq * 1.502, t, tau * 4);
      if (pan) pan.pan.setTargetAtTime(g.pan, t, tau * 2);
      master.gain.setTargetAtTime(g.gain, t, g.gain > 0 ? 0.15 : 0.1);
    },
    /** A short thump: a falling low sine and a burst of muffled noise (gain scales both). */
    bump(t = ctx.currentTime, gain = 1) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(Math.max(0.001, 1.1 * gain), t + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(og).connect(out);
      const n = ctx.createBufferSource();
      n.buffer = bumpNoise;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.6 * gain, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      n.connect(lp).connect(ng).connect(out);
      o.start(t);
      o.stop(t + 0.32);
      n.start(t);
      n.stop(t + 0.2);
    },
    /** A Stack sats coin: two quick bright notes, the second held a little. */
    coin(t = ctx.currentTime) {
      const notes = [[988, 0, 0.07], [1319, 0.07, 0.32]];
      for (const [f, at, len] of notes) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(f, t + at);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.5, t + at + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
        o.connect(lp).connect(g).connect(out);
        o.start(t + at);
        o.stop(t + at + len + 0.02);
      }
    },
    dispose() {
      for (const node of [saw1, saw2, sub, lfo, noise, ...jetSources]) {
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
      engine.set({ throttle: plane.throttle, speed: plane.speed, boost: plane.boosting, bank: plane.bank, on: !muted && !hidden() },
        undefined, 0.08, plane.craft);
      if (lastBumps !== null && plane.bumps > lastBumps && !muted) engine.bump(undefined, engine.last ? engine.last.bumpGain : 1);
      lastBumps = plane.bumps;
    },
    /** A collected coin (Stack sats). */
    coin() {
      if (!active || muted || !engine || hidden()) return;
      engine.coin();
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
