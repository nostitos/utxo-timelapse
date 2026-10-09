// Amount axis and 2D-film x mapping for the UTXO landscape (landscape/SPEC.md §2, §4, §5.0).
// Pure ES module: no DOM, no three.js, no Node APIs.
//
// Exact rows come from rows.bin (minAmt[r] = smallest integer amount a >= 1 whose film
// row is <= r). row(a) = min { r : a >= minAmt[r] }. The film formula below is a float
// port used for tests, first guesses and the JS-built table; it is not the authority.
// Known difference: the C++ tools build with -ffast-math, and 779,521,282,186 sat is row 49
// in C++ (rows.bin) but row 50 with strict IEEE math (this file, mapping.js). All other
// boundaries agree.

/** The published film axis (the only axis the C++ tools accept). */
export const FILM_AXIS = Object.freeze({
  graphRect: Object.freeze([0, 10, 3720, 2072]),
  minSatoshi: 1,
  maxSatoshi: 10000000000000,
  compressLowSatoshi: true,
  compressTopSatoshi: true,
  whiteHotTailMinSatoshi: 1000000000,
  epochBlocks: 105000,
  epochRatio: 0.5,
  epochTransitionBlocks: 120,
});

function rectOf(axis) {
  const g = (axis && axis.graphRect) || FILM_AXIS.graphRect;
  if (Array.isArray(g)) return { x: g[0], y: g[1], w: g[2], h: g[3] };
  return g;
}

/**
 * Exact graph row (0 = top = largest amounts, rows-1 = 1 sat) of an amount from the
 * rows.bin table. Negative amounts use their magnitude; amounts below 1 sat map to the
 * bottom row (the film skips zero amounts).
 */
export function rowOfAmount(minAmt, sats) {
  const a = sats < 0 ? -sats : sats;
  const n = minAmt.length;
  if (!(a >= minAmt[n - 1])) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (minAmt[mid] <= a) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Satoshi range {min, max} (inclusive integers) covered by a graph row, or null when no
 * integer amount maps to that row. Row 0 has max = Infinity (it holds every amount at or
 * above its minimum, like the film's top line).
 */
export function rowAmountRange(minAmt, row) {
  if (!Number.isInteger(row) || row < 0 || row >= minAmt.length) return null;
  const min = minAmt[row];
  const max = row === 0 ? Infinity : minAmt[row - 1] - 1;
  if (max < min) return null;
  return { min, max };
}

/**
 * Float port of SatoshiBlockheightToPixel::satoshiToPixelHeight(a) - graphRect.y for the
 * film's three-zone axis (compressLowSatoshi and compressTopSatoshi). Returns the
 * graph-local row. May differ from rows.bin by one row at exact boundaries if Math.log
 * and the C++ std::log differ in the last bit; use rowOfAmount for exact work.
 */
export function filmRowEstimate(sats, axis = FILM_AXIS) {
  if (!axis.compressLowSatoshi || !axis.compressTopSatoshi || !(axis.maxSatoshi >= 1e13)) {
    throw new Error('filmRowEstimate: only the film three-zone axis is supported');
  }
  const h = rectOf(axis).h;
  const a = sats < 0 ? -sats : sats;
  if (!(a >= 1)) return h - 1;
  const logValue = Math.log(a);
  const log100 = Math.log(100);
  const logTop = Math.log(1e12);
  const logMax = Math.log(1e13);
  const lowHeight = ((log100 / logMax) * h) / 3;
  const decadeUnit = (h - lowHeight) / 10.15;
  const midHeight = 10 * decadeUnit;
  const topHeight = 0.15 * decadeUnit;
  let y;
  if (logValue >= logMax) y = 0;
  else if (logValue >= logTop) y = topHeight * (1 - (logValue - logTop) / (logMax - logTop));
  else if (logValue > log100) y = topHeight + midHeight * (1 - (logValue - log100) / (logTop - log100));
  else y = h - lowHeight * (logValue / log100);
  return Math.min(h - 1, Math.max(0, Math.floor(y)));
}

/**
 * Builds a minAmt table from the float film formula (same layout as rows.bin). Used by
 * tests and as a stand-in before rows.bin exists; rows.bin is authoritative.
 */
export function buildMinAmtTable(axis = FILM_AXIS) {
  const n = rectOf(axis).h;
  const out = new Float64Array(n);
  const top = axis.maxSatoshi;
  for (let r = 0; r < n; r++) {
    let lo = 1;
    let hi = top;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (filmRowEstimate(mid, axis) <= r) hi = mid;
      else lo = mid + 1;
    }
    out[r] = lo;
  }
  return out;
}

/** Parses rows.bin (little-endian float64 per row) into a Float64Array. */
export function parseRowsBin(buffer, expectedRows) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength % 8 !== 0) throw new Error('rows.bin: size ' + bytes.byteLength + ' is not a multiple of 8');
  const n = bytes.byteLength / 8;
  if (expectedRows !== undefined && n !== expectedRows) throw new Error('rows.bin: ' + n + ' rows, expected ' + expectedRows);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat64(i * 8, true);
  for (let i = 1; i < n; i++) {
    if (!(out[i] <= out[i - 1])) throw new Error('rows.bin: minAmt must be non-increasing (row ' + i + ')');
  }
  if (out[n - 1] !== 1) throw new Error('rows.bin: last row must start at 1 sat');
  return out;
}

// ---- 2D film x mapping (port of cloudflare/utxo-video-worker/src/mapping.js) ----

function epochWidth(epoch, currentEpoch, w, ratio) {
  if (epoch > currentEpoch) return 0;
  if ((currentEpoch + 1) * ratio <= 1) return w * ratio;
  if (epoch === currentEpoch) return w * ratio;
  const olderSpace = w * (1 - ratio);
  const geometricSum = 2 * (1 - Math.pow(0.5, currentEpoch));
  const baseWidth = olderSpace / geometricSum;
  return baseWidth * Math.pow(0.5, currentEpoch - epoch - 1);
}

function epochStart(epoch, currentEpoch, w, ratio) {
  if (epoch > currentEpoch) return w;
  if ((currentEpoch + 1) * ratio <= 1) return epoch * w * ratio;
  let x = 0;
  for (let e = 0; e < epoch; e++) x += epochWidth(e, currentEpoch, w, ratio);
  return x;
}

function layoutXDouble(height, currentEpoch, axis, w) {
  const blockEpoch = Math.floor(height / axis.epochBlocks);
  const position = (height % axis.epochBlocks) / axis.epochBlocks;
  return Math.min(
    w - 1,
    epochStart(blockEpoch, currentEpoch, w, axis.epochRatio) + position * epochWidth(blockEpoch, currentEpoch, w, axis.epochRatio),
  );
}

/**
 * Image x of creation height 'height' in the 2D film frame for block 'block'
 * (normalizedGeometric epochs with the smooth transition). Equals mapping.js blockToX.
 */
export function blockToX(height, block, axis = FILM_AXIS) {
  const ax = axis.epochBlocks ? axis : FILM_AXIS;
  const rect = rectOf(ax);
  const epoch = Math.floor(block / ax.epochBlocks);
  const offset = block % ax.epochBlocks;
  let local;
  if (epoch > 0 && offset < ax.epochTransitionBlocks) {
    const t = (offset + 1) / ax.epochTransitionBlocks;
    const ease = t * t * (3 - 2 * t);
    const oldX = layoutXDouble(height, epoch - 1, ax, rect.w);
    const newX = layoutXDouble(height, epoch, ax, rect.w);
    local = Math.floor(oldX + (newX - oldX) * ease);
  } else {
    local = Math.floor(layoutXDouble(height, epoch, ax, rect.w));
  }
  return rect.x + Math.min(rect.w - 1, Math.max(0, local));
}

/** Image y (film pixel row) of a graph row: row + graphRect.y. */
export function rowToImageY(row, axis = FILM_AXIS) {
  return rectOf(axis).y + row;
}
