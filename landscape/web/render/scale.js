// Resolution scale and auto-scale controller (render_post).
// Pure module: no DOM and no three.js, so it runs under node --test.
//
// The internal render resolution is cssSize × devicePixelRatio × scale. Scale 1 renders at
// the display's native resolution; 2 renders 4× the pixels (7680×4320 for a 4K canvas) and
// lets the browser downsample; 0.5 renders a quarter of the pixels.

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 2;
export const SCALE_STEP = 0.05;

export function clampScale(scale, min = SCALE_MIN, max = SCALE_MAX) {
  const lo = Math.max(SCALE_MIN, Math.min(min, max));
  const hi = Math.min(SCALE_MAX, Math.max(min, max));
  const s = Number.isFinite(scale) ? scale : 1;
  return Math.min(hi, Math.max(lo, s));
}

export function quantizeScale(scale, step = SCALE_STEP) {
  return Number((Math.round(scale / step) * step).toFixed(4));
}

/**
 * Pixel ratio and drawing-buffer size for a canvas, never exceeding maxDimension on
 * either axis (WebGPU maxTextureDimension2D, WebGL MAX_TEXTURE_SIZE).
 */
export function internalSize(cssWidth, cssHeight, devicePixelRatio, scale, maxDimension = 16384) {
  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));
  let ratio = Math.max(0.05, (devicePixelRatio || 1) * scale);
  const limit = Math.min(maxDimension / w, maxDimension / h);
  if (ratio > limit) ratio = limit;
  return { pixelRatio: ratio, width: Math.max(1, Math.floor(w * ratio)), height: Math.max(1, Math.floor(h * ratio)) };
}

function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/**
 * Adjusts the resolution scale toward a target frame rate.
 *
 * The cost signal is GPU time per frame when timestamps are available (vsync hides headroom in
 * frame time), otherwise the frame interval. Pixel cost scales with scale², so a measured cost
 * ratio r moves the scale by about sqrt(r). Changes are quantised, bounded per step, and
 * followed by a settle period because resizing reallocates every render target.
 */
export class AutoScaler {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.min = options.min ?? 0.5;
    this.max = options.max ?? 2;
    this.targetFps = options.targetFps ?? 60;
    this.step = options.step ?? SCALE_STEP;
    this.windowFrames = options.windowFrames ?? 30;
    this.settleMs = options.settleMs ?? 750;
    this.downThreshold = options.downThreshold ?? 0.97; // target/cost below this → shrink
    this.upThreshold = options.upThreshold ?? 1.15; // target/cost above this → grow
    this.maxUpFactor = options.maxUpFactor ?? 1.12;
    this.maxDownFactor = options.maxDownFactor ?? 0.7;
    this.scale = clampScale(options.scale ?? 1, this.min, this.max);
    this._samples = [];
    this._lastChange = -Infinity;
    this._usesGpu = false;
  }

  configure({ enabled, min, max, targetFps, scale } = {}) {
    if (enabled !== undefined) this.enabled = !!enabled;
    if (min !== undefined) this.min = min;
    if (max !== undefined) this.max = max;
    if (targetFps !== undefined && targetFps > 0) this.targetFps = targetFps;
    if (scale !== undefined) this.scale = scale;
    this.scale = clampScale(this.scale, this.min, this.max);
    this._samples.length = 0;
    return this.scale;
  }

  /** Forget measurements, e.g. after a pipeline rebuild or a manual resize. */
  reset(nowMs = -Infinity) {
    this._samples.length = 0;
    this._lastChange = nowMs;
  }

  /**
   * Record one frame. Returns the new scale when it should change, otherwise null.
   * @param {number} frameMs interval since the previous frame
   * @param {?number} gpuMs GPU time of the frame (timestamp queries), or null/NaN
   * @param {number} nowMs monotonic time
   */
  sample(frameMs, gpuMs, nowMs) {
    if (!this.enabled) return null;
    const useGpu = Number.isFinite(gpuMs) && gpuMs > 0;
    if (useGpu !== this._usesGpu) { this._samples.length = 0; this._usesGpu = useGpu; }
    const cost = useGpu ? gpuMs : frameMs;
    if (!(cost > 0) || !Number.isFinite(cost)) return null;
    this._samples.push(cost);
    if (this._samples.length > this.windowFrames) this._samples.shift();
    if (nowMs - this._lastChange < this.settleMs) return null;
    if (this._samples.length < Math.max(4, this.windowFrames >> 1)) return null;

    const targetMs = 1000 / this.targetFps;
    const ratio = targetMs / median(this._samples);
    let next = this.scale;
    if (ratio < this.downThreshold) {
      next = this.scale * Math.max(this.maxDownFactor, Math.sqrt(ratio) * 0.98);
    } else if (ratio > this.upThreshold) {
      // Frame-interval measurements cannot show headroom beyond the display refresh, so
      // growth on them only happens when the measured rate is clearly above the target.
      next = this.scale * Math.min(this.maxUpFactor, Math.sqrt(ratio) * 0.98);
    } else {
      return null;
    }
    next = clampScale(quantizeScale(next, this.step), this.min, this.max);
    if (Math.abs(next - this.scale) < this.step * 0.5) return null;
    this.scale = next;
    this._samples.length = 0;
    this._lastChange = nowMs;
    return next;
  }
}
