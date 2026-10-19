// Spend ticks on the audio thread (ui/flash-sound.js; landscape/SPEC.md §8). TickRenderer
// synthesizes ticks from compact events: each a slice of a band's noise with a 1 ms attack and
// an exponential decay, at a start frame of the audio clock, with left and right gains. The
// AudioWorklet below runs it on the audio thread, so mixing thousands of ticks a second costs
// the page nothing; ui/flash-sound.js uses the same class to mix on the main thread where
// AudioWorklet is missing, and the tests use it directly. No imports: an AudioWorklet module
// should load on its own.

/** Samples a tick of each band lasts: attack plus decaysPerTick decays (decays in seconds). */
export function tickLengths(decays, sampleRate, attackS = 0.001, decaysPerTick = 3) {
  const attack = Math.max(1, Math.round(attackS * sampleRate));
  return decays.map((d) => attack + Math.round(decaysPerTick * d * sampleRate));
}

/** Fields of one event in the Float64Array that TickRenderer.add takes. */
export const EVENT_FIELDS = 6; // start frame, band, noise offset, left gain, right gain, far (0 or 1)
const MAX_PENDING = 20000;

export class TickRenderer {
  /** near, far: per-band noise (Float32Array); decays: per-band decay (s). */
  constructor({ sampleRate, near, far, decays, attackS = 0.001, decaysPerTick = 3 }) {
    this.attack = Math.max(1, Math.round(attackS * sampleRate));
    this.len = tickLengths(decays, sampleRate, attackS, decaysPerTick);
    this.fall = decays.map((d) => Math.exp(-1 / ((d / 3) * sampleRate)));
    this.near = near;
    this.far = far;
    this.pending = [];
    this.active = [];
  }

  /** Queues events: Float64Array of EVENT_FIELDS numbers per tick. */
  add(events) {
    for (let k = 0; k + EVENT_FIELDS <= events.length && this.pending.length < MAX_PENDING; k += EVENT_FIELDS) {
      this.pending.push({ start: events[k], band: events[k + 1] | 0, offset: events[k + 2] | 0, gl: events[k + 3], gr: events[k + 4],
        far: events[k + 5] > 0, i: 0, env: 1 });
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
      const src = (t.far ? this.far : this.near)[t.band];
      const len = this.len[t.band];
      const fall = this.fall[t.band];
      let i = t.i;
      let env = t.env;
      let o = t.start + i - frame0;
      const gl = t.gl;
      const gr = t.gr;
      while (o < n && i < len) {
        let e;
        if (i < attack) e = (i + 1) / attack;
        else {
          e = env;
          env *= fall;
        }
        const s = src[t.offset + i] * e;
        left[o] += s * gl;
        right[o] += s * gr;
        i++;
        o++;
      }
      t.i = i;
      t.env = env;
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
