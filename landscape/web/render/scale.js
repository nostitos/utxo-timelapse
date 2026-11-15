// Resolution scale and auto-scale controller (render_post).
// Pure module: no DOM and no three.js, so it runs under node --test.
//
// The internal render resolution is cssSize × devicePixelRatio × scale. Scale 1 renders at
// the display's native resolution; 2 renders 4× the pixels (7680×4320 for a 4K canvas) and
// lets the browser downsample; 0.5 renders a quarter of the pixels.

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 2;
export const SCALE_STEP = 0.05;
/**
 * Share of the frame the GPU may take. The rest is the page's own work and the compositor's:
 * aiming GPU time at the whole frame held the scale where the GPU needed 14.5 to 17.2 ms of a
 * 16.7 ms frame, so every few frames missed the display's refresh.
 */
export const GPU_SHARE = 0.8;

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
 * frame time), aimed at GPU_SHARE of the frame, otherwise the frame interval. Pixel cost scales with scale², so a measured cost
 * ratio r moves the scale by about sqrt(r). Changes are quantised, bounded per step, and
 * followed by a settle period because resizing reallocates every render target.
 *
 * The frame interval cannot show headroom beyond the display's refresh, so without timestamps a
 * scale that holds the target is probed: after probeMs at one scale it tries a step larger. A
 * probe that holds resets the wait; one that is too slow shrinks back as usual and doubles the
 * wait, up to probeMaxMs.
 *
 * Measured headroom grows the scale only after growMs at one scale. A step up that has to be
 * undone doubles that wait, up to growMaxMs, and two steps up in a row reset it. Terrain detail
 * follows the resolution, so one step up can cost far more than its pixels (measured: 11.5 ms at
 * 0.9, 20 ms at 1), and near the target the scale otherwise went up and down about once a
 * second, each change reallocating every render target.
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
    this.probeMs = options.probeMs ?? 8000;
    this.probeMaxMs = options.probeMaxMs ?? 64000;
    this.growMs = options.growMs ?? 3000;
    this.growMaxMs = options.growMaxMs ?? 16000;
    this.scale = clampScale(options.scale ?? 1, this.min, this.max);
    this._samples = [];
    this._lastChange = -Infinity;
    this._usesGpu = false;
    this._holdUntil = -Infinity;
    this._probeWait = this.probeMs;
    this._probing = false;
    this._probeFrom = null; // when the current scale started counting toward a probe (the first frame, or the last change)
    this._growWait = this.growMs;
    this._grew = false; // the last change was a step up on measured headroom
  }

  configure({ enabled, min, max, targetFps, scale } = {}) {
    if (enabled !== undefined) this.enabled = !!enabled;
    if (min !== undefined) this.min = min;
    if (max !== undefined) this.max = max;
    if (targetFps !== undefined && targetFps > 0) this.targetFps = targetFps;
    if (scale !== undefined) this.scale = scale;
    this.scale = clampScale(this.scale, this.min, this.max);
    this._samples.length = 0;
    this._growWait = this.growMs;
    return this.scale;
  }

  /** Forget measurements, e.g. after a pipeline rebuild or a manual resize. */
  reset(nowMs = -Infinity) {
    this._samples.length = 0;
    this._lastChange = nowMs;
    if (Number.isFinite(nowMs)) this._probeFrom = nowMs;
  }

  /** Ignore frames until untilMs: startup, a pipeline rebuild, the first data, the end of an idle stretch. */
  hold(untilMs) {
    this._holdUntil = Math.max(this._holdUntil, untilMs);
    this._samples.length = 0;
  }

  /**
   * Record one frame. Returns the new scale when it should change, otherwise null.
   * @param {number} frameMs interval since the previous frame
   * @param {?number} gpuMs GPU time of the frame (timestamp queries), or null/NaN
   * @param {number} nowMs monotonic time
   */
  sample(frameMs, gpuMs, nowMs) {
    if (!this.enabled) return null;
    if (nowMs < this._holdUntil) return null;
    if (this._probeFrom === null) this._probeFrom = nowMs;
    const useGpu = Number.isFinite(gpuMs) && gpuMs > 0;
    if (useGpu !== this._usesGpu) { this._samples.length = 0; this._usesGpu = useGpu; }
    const cost = useGpu ? gpuMs : frameMs;
    if (!(cost > 0) || !Number.isFinite(cost)) return null;
    this._samples.push(cost);
    if (this._samples.length > this.windowFrames) this._samples.shift();
    if (nowMs - this._lastChange < this.settleMs) return null;
    if (this._samples.length < Math.max(4, this.windowFrames >> 1)) return null;

    const targetMs = (1000 / this.targetFps) * (useGpu ? GPU_SHARE : 1);
    const ratio = targetMs / median(this._samples);
    if (this._probing && ratio >= this.downThreshold) this._probeWait = this.probeMs;
    const probing = this._probing;
    this._probing = false;
    const waited = nowMs - Math.max(this._probeFrom, this._holdUntil);
    let next = this.scale;
    let grow = false;
    if (ratio < this.downThreshold) {
      next = this.scale * Math.max(this.maxDownFactor, Math.sqrt(ratio) * 0.98);
      if (probing) this._probeWait = Math.min(this.probeMaxMs, this._probeWait * 2);
    } else if (ratio > this.upThreshold) {
      // Frame-interval measurements cannot show headroom beyond the display refresh, so
      // growth on them only happens when the measured rate is clearly above the target.
      if (waited < this._growWait) return null;
      next = this.scale * Math.min(this.maxUpFactor, Math.sqrt(ratio) * 0.98);
      grow = true;
    } else if (!useGpu && this.scale < this.max && waited >= this._probeWait) {
      next = Math.max(this.scale * 1.1, this.scale + this.step);
      this._probing = true;
    } else {
      return null;
    }
    next = clampScale(quantizeScale(next, this.step), this.min, this.max);
    if (Math.abs(next - this.scale) < this.step * 0.5) {
      this._probing = false;
      return null;
    }
    if (grow) {
      if (this._grew) this._growWait = this.growMs;
    } else if (this._grew && next < this.scale) {
      this._growWait = Math.min(this.growMaxMs, this._growWait * 2);
    }
    this._grew = grow;
    this.scale = next;
    this._samples.length = 0;
    this._lastChange = nowMs;
    this._probeFrom = nowMs;
    return next;
  }
}
