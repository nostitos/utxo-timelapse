// Spend ticks on the audio thread (ui/flash-sound.js; landscape/SPEC.md §8). TickRenderer
// synthesizes ticks from compact events: each a click of white noise with a 0.2 ms rise and an
// exponential decay, through its own band-pass at the event's centre frequency, at a start
// frame of the audio clock, with left and right gains. The AudioWorklet below runs it on the
// audio thread, so mixing thousands of ticks a second costs the page nothing; ui/flash-sound.js
// uses the same class to mix on the main thread where AudioWorklet is missing, and the tests use
// it directly. No imports: an AudioWorklet module should load on its own.

/** Samples a tick of each band lasts: attack plus decaysPerTick decays (decays in seconds). */
export function tickLengths(decays, sampleRate, attackS = 0.0002, decaysPerTick = 3) {
  const attack = Math.max(1, Math.round(attackS * sampleRate));
  return decays.map((d) => attack + Math.round(decaysPerTick * d * sampleRate));
}

/** Fields of one event in the Float64Array that TickRenderer.add takes. */
export const EVENT_FIELDS = 6; // start frame, band, centre frequency (Hz), left gain, right gain, noise seed
const MAX_PENDING = 20000;

export class TickRenderer {
  /**
   * decays: per-band decay (s, three time constants); qs: per-band band-pass Q. A tick is
   * attackS plus decaysPerTick decays.
   */
  constructor({ sampleRate, decays, qs, attackS = 0.0002, decaysPerTick = 3 }) {
    this.sampleRate = sampleRate;
    this.attack = Math.max(1, Math.round(attackS * sampleRate));
    this.len = tickLengths(decays, sampleRate, attackS, decaysPerTick);
    this.fall = decays.map((d) => Math.exp(-1 / ((d / 3) * sampleRate)));
    this.qs = qs;
    this.pending = [];
    this.active = [];
  }

  /** Queues events: Float64Array of EVENT_FIELDS numbers per tick. */
  add(events) {
    for (let k = 0; k + EVENT_FIELDS <= events.length && this.pending.length < MAX_PENDING; k += EVENT_FIELDS) {
      const band = events[k + 1] | 0;
      // RBJ band-pass, 0 dB at its centre.
      const w = (2 * Math.PI * Math.min(events[k + 2], this.sampleRate * 0.45)) / this.sampleRate;
      const alpha = Math.sin(w) / (2 * (this.qs[band] || 1));
      const a0 = 1 + alpha;
      this.pending.push({ start: events[k], band, gl: events[k + 3], gr: events[k + 4], b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0,
        a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0, seed: (events[k + 5] >>> 0) || 0x9e3779b9, i: 0, env: 1 });
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
    let w = 0;
    for (const t of this.active) {
      const len = this.len[t.band];
      const fall = this.fall[t.band];
      const { b0, a1, a2, gl, gr } = t;
      let { i, env, x1, x2, y1, y2, seed } = t;
      let o = t.start + i - frame0;
      while (o < n && i < len) {
        let e;
        if (i < attack) e = (i + 1) / attack;
        else {
          e = env;
          env *= fall;
        }
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const x = ((seed >>> 0) / 2147483648 - 1) * e;
        const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        left[o] += y * gl;
        right[o] += y * gr;
        i++;
        o++;
      }
      // Field by field: the audio thread should not allocate per tick and block.
      t.i = i;
      t.env = env;
      t.x1 = x1;
      t.x2 = x2;
      t.y1 = y1;
      t.y2 = y2;
      t.seed = seed;
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
