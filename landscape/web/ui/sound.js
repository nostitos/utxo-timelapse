// Sound switch (landscape/SPEC.md §8): one remembered on/off for every sound in the app, the
// spend flashes (ui/flash-sound.js) and the plane mode engine (ui/plane-sound.js), and the one
// Web Audio context they share. Off by default; the toolbar's Sound button and M toggle it.
// Browsers keep a context silent until a key press or click, so the context is created inside
// the gesture that turns the sound on, and any later key press or click resumes it (unlock).
// With the sound off, or the page hidden, the context is suspended.

export const SOUND_KEY = 'utxo-landscape-sound';
/** The plane engine's own switch before the shared one: 'on' only after a mute and unmute. */
export const LEGACY_PLANE_KEY = 'utxo-landscape-plane-sound';
const SUSPEND_MS = 600; // after turning off, so the engine and the last clicks fade out first

/** Stored preference: SOUND_KEY when set, else on only if the old plane switch was 'on'. */
export function readSoundPref(storage) {
  try {
    if (!storage) return false;
    const v = storage.getItem(SOUND_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
    return storage.getItem(LEGACY_PLANE_KEY) === 'on';
  } catch {
    return false;
  }
}

/** createSound() -> { on, context, set(on), toggle(), unlock(), onChange(fn), state }. */
export function createSound({ storage, AudioContextClass = null } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  let on = readSoundPref(storage);
  let ctx = null;
  let suspendTimer = 0;
  const listeners = new Set();
  const hidden = () => typeof document !== 'undefined' && document.hidden;

  function ensure() {
    if (ctx) return ctx;
    const AC = AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      ctx = null;
    }
    return ctx;
  }
  function resume() {
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !hidden()) ctx.resume().catch(() => {});
  }
  function suspendSoon() {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (ctx && !on && ctx.state === 'running') ctx.suspend().catch(() => {});
    }, SUSPEND_MS);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (hidden()) ctx.suspend().catch(() => {});
      else if (on) resume();
    });
  }

  const api = {
    /** Whether sound is on (the user's choice; the context may still wait for a gesture). */
    get on() {
      return on;
    },
    /** The shared context once a gesture created it, else null. */
    get context() {
      return ctx;
    },
    /** Whether sounds can play now: on, the context running and the page visible. */
    get running() {
      return on && !!ctx && ctx.state === 'running' && !hidden();
    },
    /** Turn sound on or off and remember it. Call from a key press or click to start the sound. */
    set(want) {
      const next = !!want;
      try {
        if (storage) storage.setItem(SOUND_KEY, next ? 'on' : 'off');
      } catch {
        /* private mode: not remembered */
      }
      if (next) {
        clearTimeout(suspendTimer);
        ensure();
        resume();
      } else suspendSoon();
      if (next === on) return on;
      on = next;
      for (const fn of listeners) fn(on);
      return on;
    },
    toggle() {
      return api.set(!on);
    },
    /** Any key press or click: browsers may have kept the context suspended. */
    unlock() {
      if (!on) return;
      ensure();
      resume();
    },
    /** fn(on) after every change; returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get state() {
      return { on, context: ctx ? ctx.state : null };
    },
  };
  return api;
}
