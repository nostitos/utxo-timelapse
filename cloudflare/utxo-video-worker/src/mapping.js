import { RELEASE } from './release.js';
export const CONFIG = Object.freeze({
  imageWidth: 3840,
  imageHeight: 2160,
  graphRect: Object.freeze({ x: 0, y: 10, w: 3720, h: 2072 }),
  numBlocks: RELEASE.numBlocks,
  minSatoshi: 1,
  maxSatoshi: 10000000000000,
  epochBlocks: 105000,
  epochRatio: 0.5,
  epochTransitionBlocks: 120,
});

function epochWidth(epoch, currentEpoch) {
  const { w } = CONFIG.graphRect;
  const ratio = CONFIG.epochRatio;
  if (epoch > currentEpoch) return 0;
  if ((currentEpoch + 1) * ratio <= 1) return w * ratio;
  if (epoch === currentEpoch) return w * ratio;
  const olderSpace = w * (1 - ratio);
  const geometricSum = 2 * (1 - Math.pow(0.5, currentEpoch));
  const baseWidth = olderSpace / geometricSum;
  return baseWidth * Math.pow(0.5, currentEpoch - epoch - 1);
}

function epochStart(epoch, currentEpoch) {
  const { w } = CONFIG.graphRect;
  if (epoch > currentEpoch) return w;
  if ((currentEpoch + 1) * CONFIG.epochRatio <= 1) {
    return epoch * w * CONFIG.epochRatio;
  }
  let x = 0;
  for (let e = 0; e < epoch; e++) x += epochWidth(e, currentEpoch);
  return x;
}

function layoutXDouble(height, currentEpoch) {
  const blockEpoch = Math.floor(height / CONFIG.epochBlocks);
  const position = (height % CONFIG.epochBlocks) / CONFIG.epochBlocks;
  return Math.min(
    CONFIG.graphRect.w - 1,
    epochStart(blockEpoch, currentEpoch) + position * epochWidth(blockEpoch, currentEpoch),
  );
}

function contextFor(block) {
  const epoch = Math.floor(block / CONFIG.epochBlocks);
  const offset = block % CONFIG.epochBlocks;
  if (epoch > 0 && offset < CONFIG.epochTransitionBlocks) {
    const t = (offset + 1) / CONFIG.epochTransitionBlocks;
    return { epoch, from: epoch - 1, ease: t * t * (3 - 2 * t) };
  }
  return { epoch, from: null, ease: 1 };
}

export function blockToX(height, contextBlock) {
  const c = contextFor(contextBlock);
  let local;
  if (c.from !== null) {
    const oldX = layoutXDouble(height, c.from);
    const newX = layoutXDouble(height, c.epoch);
    local = Math.floor(oldX + (newX - oldX) * c.ease);
  } else {
    local = Math.floor(layoutXDouble(height, c.epoch));
  }
  return CONFIG.graphRect.x + Math.min(CONFIG.graphRect.w - 1, Math.max(0, local));
}

export function columnBlockRange(imageX, contextBlock) {
  const target = imageX;
  const maxHeight = contextBlock;
  const xOf = (height) => blockToX(height, contextBlock);
  let lo = 0;
  let hi = maxHeight;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (xOf(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  if (xOf(lo) !== target) {
    let left = 0;
    let right = maxHeight;
    while (left < right) {
      const mid = left + Math.floor((right - left + 1) / 2);
      if (xOf(mid) <= target) left = mid;
      else right = mid - 1;
    }
    if (xOf(left) > target) return null;
    return columnBlockRange(xOf(left), contextBlock);
  }
  const first = lo;
  let left = lo;
  let right = maxHeight;
  while (left < right) {
    const mid = left + Math.floor((right - left + 1) / 2);
    if (xOf(mid) === target) left = mid;
    else right = mid - 1;
  }
  return [first, left];
}

export function satoshiToY(satoshi) {
  const amount = Math.abs(satoshi);
  const logValue = Math.log(amount);
  const log100 = Math.log(100);
  const logTop = Math.log(1e12);
  const logMax = Math.log(1e13);
  const height = CONFIG.graphRect.h;
  const lowHeight = ((log100 / logMax) * height) / 3;
  const unit = (height - lowHeight) / 10.15;
  const middleHeight = 10 * unit;
  const topHeight = 0.15 * unit;
  let y;
  if (logValue >= logMax) y = 0;
  else if (logValue >= logTop) {
    y = topHeight * (1 - (logValue - logTop) / (logMax - logTop));
  } else if (logValue > log100) {
    y = topHeight + middleHeight * (1 - (logValue - log100) / (logTop - log100));
  } else {
    y = height - lowHeight * (logValue / log100);
  }
  return CONFIG.graphRect.y + Math.min(height - 1, Math.max(0, Math.floor(y)));
}

export function rowSatoshiRange(imageY) {
  const target = imageY;
  let lo = CONFIG.minSatoshi;
  let hi = CONFIG.maxSatoshi;
  if (satoshiToY(lo) < target || satoshiToY(hi) > target) return null;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (satoshiToY(mid) > target) lo = mid + 1;
    else hi = mid;
  }
  const minimum = lo;
  lo = minimum;
  hi = CONFIG.maxSatoshi;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo + 1) / 2);
    if (satoshiToY(mid) < target) hi = mid - 1;
    else lo = mid;
  }
  let maximum = lo;
  // Mirrors C++ INT64_MAX after JSON's double conversion. Real Bitcoin output
  // amounts remain far below Number.MAX_SAFE_INTEGER, so record filtering is exact.
  if (imageY === CONFIG.graphRect.y) maximum = 9223372036854776000;
  if (satoshiToY(minimum) !== target && satoshiToY(maximum) !== target) return null;
  return [minimum, maximum];
}

export function validatePixelParams(url) {
  const raw = ["block", "x", "y"].map((name) => url.searchParams.get(name));
  if (raw.some((v) => v === null || !/^\d{1,16}$/.test(v))) {
    return { error: "block, x, y must be non-negative integers" };
  }
  let [block, x, y] = raw.map(Number);
  block = Math.min(block, CONFIG.numBlocks - 1);
  if (x >= CONFIG.imageWidth || y >= CONFIG.imageHeight) {
    return { error: "x/y outside image" };
  }
  const r = CONFIG.graphRect;
  if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) {
    return { error: "outside graphRect" };
  }
  return { block, x, y };
}
