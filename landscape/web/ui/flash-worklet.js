// Spend ticks on the audio thread (ui/flash-sound.js; landscape/SPEC.md §8). TickRenderer
// synthesizes ticks from compact events: each a sine at its own frequency and phase with a
// raised-cosine attack and an exponential decay, at a start frame of the audio clock, with left
// and right gains. The AudioWorklet below runs it on the audio thread, so mixing thousands of
// ticks a second costs the page nothing; ui/flash-sound.js uses the same class to mix on the
// main thread where AudioWorklet is missing, and the tests use it directly. No imports: an
// AudioWorklet module should load on its own.

/** Samples a tick of each band lasts: attack plus decaysPerTick decays (decays in seconds). */
export function tickLengths(decays, sampleRate, attackS = 0.004, decaysPerTick = 3) {
  const attack = Math.max(1, Math.round(attackS * sampleRate));
  return decays.map((d) => attack + Math.round(decaysPerTick * d * sampleRate));
}

/** Fields of one event in the Float64Array that TickRenderer.add takes. */
export const EVENT_FIELDS = 6; // start frame, band, frequency (Hz), left gain, right gain, phase (radians)
const MAX_PENDING = 20000;

export class TickRenderer {
  /** decays: per-band decay (s, three time constants); a tick is attackS plus decaysPerTick decays. */
  constructor({ sampleRate, decays, attackS = 0.004, decaysPerTick = 3 }) {
    this.sampleRate = sampleRate;
    this.attack = Math.max(1, Math.round(attackS * sampleRate));
    this.len = tickLengths(decays, sampleRate, attackS, decaysPerTick);
    this.fall = decays.map((d) => Math.exp(-1 / ((d / 3) * sampleRate)));
    // Raised-cosine attack: no corner at the start, so a tick has only its own pitch.
    this.rise = new Float32Array(this.attack);
    for (let i = 0; i < this.attack; i++) this.rise[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / this.attack);
    this.pending = [];
    this.active = [];
  }

  /** Queues events: Float64Array of EVENT_FIELDS numbers per tick. */
  add(events) {
    for (let k = 0; k + EVENT_FIELDS <= events.length && this.pending.length < MAX_PENDING; k += EVENT_FIELDS) {
      const w = (2 * Math.PI * Math.min(events[k + 2], this.sampleRate * 0.45)) / this.sampleRate;
      const phase = events[k + 5];
      // The sine by its two-term recurrence: s[n+1] = c s[n] - s[n-1].
      this.pending.push({ start: events[k], band: events[k + 1] | 0, gl: events[k + 3], gr: events[k + 4], c: 2 * Math.cos(w),
        s1: Math.sin(phase), s0: Math.sin(phase - w), i: 0, env: 1 });
    }
  }

  /** Adds frames [frame0, frame0 + n) of every tick into left and right. A late tick starts at frame0. */
  render(left, right, frame0, n) {
    const end = frame0 + n;
    if (this.pending.length) {
      let w = 0;
      for (const t of this.pending) {
        if (t.start < end) {
          if (t.start < frame0) t.start = frame0;
          this.active.push(t);
        } else this.pending[w++] = t;
      }
      this.pending.length = w;
    }
    const attack = this.attack;
    const rise = this.rise;
    let w = 0;
    for (const t of this.active) {
      const len = this.len[t.band];
      const fall = this.fall[t.band];
      let i = t.i;
      let env = t.env;
      let s0 = t.s0;
      let s1 = t.s1;
      const c = t.c;
      let o = t.start + i - frame0;
      const gl = t.gl;
      const gr = t.gr;
      while (o < n && i < len) {
        let e;
        if (i < attack) e = rise[i];
        else {
          e = env;
          env *= fall;
        }
        const s = s1 * e;
        left[o] += s * gl;
        right[o] += s * gr;
        const next = c * s1 - s0;
        s0 = s1;
        s1 = next;
        i++;
        o++;
      }
      t.i = i;
      t.env = env;
      t.s0 = s0;
      t.s1 = s1;
      if (i < len) this.active[w++] = t;
    }
    this.active.length = w;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('flash-ticks', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.renderer = null;
      this.port.onmessage = (e) => {
        const m = e.data;
        // eslint-disable-next-line no-undef
        if (m.type === 'init') this.renderer = new TickRenderer({ sampleRate, ...m });
        else if (m.type === 'ticks' && this.renderer) this.renderer.add(m.events);
      };
    }

    process(inputs, outputs) {
      const out = outputs[0];
      // eslint-disable-next-line no-undef
      if (this.renderer && out && out.length >= 2) this.renderer.render(out[0], out[1], currentFrame, out[0].length);
      return true;
    }
  });
}
