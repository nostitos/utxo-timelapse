// Axis labels for the UTXO Timelapse landscape (landscape/SPEC.md sections 2 and 6).
//
// HTML labels are positioned by projecting world anchor points into the #labels overlay
// (CSS pixels, pointer-events none). Block labels run along the long edge (z = 0 or
// z = rows / 10) nearer the camera, 1.5 world units outside it; amount labels, one per
// decade from 1 sat to 100,000 BTC, run along the nearer short edge (x = 0 or
// x = numBlocks / 1000), 2 units outside it. Anchors are at y = 0. When the nearer edge
// has nothing on screen the opposite edge is used. Labels behind the camera or off screen
// are hidden, and crowded labels are dropped greedily: block anchors stay at least 80 px
// apart, amount anchors at least 16 px apart, and estimated text boxes never overlap.
//
// A label is shown only when its anchor is in front of the camera and inside the viewport
// (plus VIEW_MARGIN_PX) and its whole text box fits on screen, so no label is cut in half
// at the border. Everything except createAxisLabels is pure (no DOM, no three.js), so
// landscape/tests/terrain-labels.test.mjs runs it in Node. Matrices are 16-element
// column-major arrays as three.js stores them, with viewProj = projectionMatrix x
// matrixWorldInverse. Only clip x, y and w are read, so the WebGL, WebGPU and
// reversed-depth conventions (which differ in the z row only) give identical results.

import { worldX, worldZ, BLOCKS_PER_WORLD_UNIT } from '../../data/grid.js';
import { rowOfAmount } from '../../data/axis.js';

/** Smallest block step for labels and grid lines. */
export const MIN_BLOCK_STEP = 1000;
/** Target number of block labels across the visible part of the labelled edge. */
export const BLOCK_TICK_TARGET = 8;
/** Minimum screen distance between block label anchors (CSS px). */
export const BLOCK_LABEL_GAP_PX = 80;
/** Minimum screen distance between amount label anchors (CSS px). */
export const AMOUNT_LABEL_GAP_PX = 16;
/** Block label anchors sit this many world units outside the long edge. */
export const BLOCK_EDGE_OFFSET = 1.5;
/** Amount label anchors sit this many world units outside the short edge. */
export const AMOUNT_EDGE_OFFSET = 2;
/** Anchors up to this far outside the viewport still count as visible (CSS px). */
export const VIEW_MARGIN_PX = 16;

const AMOUNT_DECADES = 14;      // 10^0 .. 10^13 sat
const EDGE_HYSTERESIS = 1;      // world units past the midline before the labelled edge switches
const W_EPS = 1e-6;             // clip w must exceed this for a point to be in front of the camera
const BLOCK_BOX_PAD = 6;        // px kept between block label boxes
const AMOUNT_BOX_PAD = 2;       // px kept between amount boxes, and between block and amount boxes
const BOX_SLACK = 1;            // px a shown label's text box may extend past the viewport
const DEFAULT_CHAR_W = 6.6;     // 11px IBM Plex Mono advance (0.6 em) until a probe is measured
const DEFAULT_LINE_H = 14;
const PROBE_TEXT = '0000000000';
const DASH = '\u2014';
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const BTC = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

/**
 * Smallest value from {1, 2, 5} x 10^k that is >= span / maxTicks, and never below
 * MIN_BLOCK_STEP (1,000 blocks). NaN, zero or negative spans give 1,000; an infinite
 * span gives Infinity. maxTicks below 1 counts as 1.
 */
export function niceStep(span, maxTicks = BLOCK_TICK_TARGET) {
  const target = span / (maxTicks >= 1 ? maxTicks : 1);
  if (!(target > MIN_BLOCK_STEP)) return MIN_BLOCK_STEP;
  if (target === Infinity) return Infinity;
  let p = 10 ** Math.floor(Math.log10(target));
  if (p > target) p /= 10;              // guard against log10 rounding at powers of ten
  else if (p * 10 <= target) p *= 10;
  if (p >= target) return p;
  if (2 * p >= target) return 2 * p;
  if (5 * p >= target) return 5 * p;
  return 10 * p;
}

/**
 * Multiples of step within [b0, b1], both ends inclusive, ascending. Returns [] for an
 * empty or invalid range; throws a RangeError above one million ticks.
 */
export function blockTicks(b0, b1, step) {
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(b0) || !Number.isFinite(b1)) return [];
  const first = Math.ceil(b0 / step);
  const last = Math.floor(b1 / step);
  const n = last - first + 1;
  if (!(n > 0)) return [];
  if (n > 1e6) throw new RangeError('blockTicks: ' + n + ' ticks; step ' + step + ' is too small for [' + b0 + ', ' + b1 + ']');
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (first + i) * step || 0; // "|| 0" turns -0 into 0
  return out;
}

/**
 * Amount text: whole satoshis below 100,000 sat ("1 sat", "546 sat", "10,000 sat"),
 * BTC from there on ("0.001 BTC", "1 BTC", "100,000 BTC").
 */
export function formatAmount(sats) {
  if (!Number.isFinite(sats)) return DASH;
  const s = sats === 0 ? 0 : sats; // never "-0 sat"
  return Math.abs(s) < 1e5 ? INT.format(s) + ' sat' : BTC.format(s / 1e8) + ' BTC';
}

/**
 * One tick per decade from 1 sat to 100,000 BTC: [{row, sats, label}] for sats = 10^k,
 * k = 0..13, with row = rowOfAmount(minAmt, sats). k = 0 (1 sat) is the bottom row.
 */
export function amountTicks(minAmt) {
  const out = [];
  for (let k = 0; k < AMOUNT_DECADES; k++) {
    const sats = 10 ** k;
    out.push({ row: rowOfAmount(minAmt, sats), sats, label: formatAmount(sats) });
  }
  return out;
}

/**
 * "420,000 \u00b7 2016-07": block number and the UTC year-month of its timestamp
 * (blocktimes holds unix seconds per height). Just the number when blocktimes is missing,
 * too short or has no time for that block.
 */
export function formatBlockLabel(block, blocktimes) {
  const n = INT.format(block);
  const t = blocktimes && block >= 0 && block < blocktimes.length ? blocktimes[block] : 0;
  if (!(t > 0)) return n;
  const d = new Date(t * 1000);
  const month = d.getUTCMonth() + 1;
  return n + ' \u00b7 ' + d.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month;
}

function projectInto(out, m, x, y, z, width, height, margin) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  out.depth = w;
  if (!(w > W_EPS)) {
    out.x = NaN;
    out.y = NaN;
    out.visible = false;
    return out;
  }
  const sx = (0.5 + (0.5 * (m[0] * x + m[4] * y + m[8] * z + m[12])) / w) * width;
  const sy = (0.5 - (0.5 * (m[1] * x + m[5] * y + m[9] * z + m[13])) / w) * height;
  out.x = sx;
  out.y = sy;
  out.visible = sx >= -margin && sx <= width + margin && sy >= -margin && sy <= height + margin;
  return out;
}

/**
 * Projects world (x, y, z) to CSS pixels (origin top-left) with a column-major viewProj
 * (projectionMatrix x matrixWorldInverse). Returns {x, y, depth, visible}: depth is clip w,
 * the view-space distance in front of a perspective camera; points with depth <= 1e-6 are
 * behind the camera and get x = y = NaN. visible means in front of the camera and inside
 * the viewport grown by marginPx on every side.
 */
export function projectToScreen(viewProj, x, y, z, widthCss, heightCss, marginPx = VIEW_MARGIN_PX) {
  return projectInto({ x: NaN, y: NaN, depth: 0, visible: false }, viewProj, x, y, z, widthCss, heightCss, marginPx);
}

/** Column-major projection x view (three.js projectionMatrix x matrixWorldInverse). */
export function viewProjection(projection, view, out = new Float64Array(16)) {
  const a = projection;
  for (let c = 0; c < 16; c += 4) {
    const b0 = view[c];
    const b1 = view[c + 1];
    const b2 = view[c + 2];
    const b3 = view[c + 3];
    out[c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

// Parameter interval [t0, t1] of the segment A -> B whose projection lies in front of the
// camera and inside the viewport grown by margin, or null. Exact (Liang-Barsky in clip
// space), so a close-up that sees only a few hundred blocks of an edge still finds them.
function clipSegment(m, ax, ay, az, bx, by, bz, width, height, margin) {
  const kx = 1 + (2 * margin) / width;
  const ky = 1 + (2 * margin) / height;
  const xa = m[0] * ax + m[4] * ay + m[8] * az + m[12];
  const ya = m[1] * ax + m[5] * ay + m[9] * az + m[13];
  const wa = m[3] * ax + m[7] * ay + m[11] * az + m[15];
  const xb = m[0] * bx + m[4] * by + m[8] * bz + m[12];
  const yb = m[1] * bx + m[5] * by + m[9] * bz + m[13];
  const wb = m[3] * bx + m[7] * by + m[11] * bz + m[15];
  const g = [
    wa - W_EPS, wb - W_EPS,
    kx * wa - xa, kx * wb - xb,
    kx * wa + xa, kx * wb + xb,
    ky * wa - ya, ky * wb - yb,
    ky * wa + ya, ky * wb + yb,
  ];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < g.length; i += 2) {
    const ga = g[i];
    const gb = g[i + 1];
    if (ga < 0 && gb < 0) return null;
    if (ga >= 0 && gb >= 0) continue;
    const t = ga / (ga - gb);
    if (ga < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// World x range of the ground rectangle [0, W] x [0, D] (y = 0) inside the view frustum
// (Sutherland-Hodgman against w > 0 and the four side planes), or null.
function footprintXRange(m, W, D) {
  let poly = [[0, 0], [W, 0], [W, D], [0, D]].map(([x, z]) => [
    x, m[0] * x + m[8] * z + m[12], m[1] * x + m[9] * z + m[13], m[3] * x + m[11] * z + m[15],
  ]);
  const planes = [[0, 0, 1, -W_EPS], [1, 0, 1, 0], [-1, 0, 1, 0], [0, 1, 1, 0], [0, -1, 1, 0]];
  for (const [a, b, c, d] of planes) {
    const next = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const gp = a * p[1] + b * p[2] + c * p[3] + d;
      const gq = a * q[1] + b * q[2] + c * q[3] + d;
      if (gp >= 0) next.push(p);
      if (gp >= 0 !== gq >= 0) {
        const t = gp / (gp - gq);
        next.push(p.map((v, j) => v + t * (q[j] - v)));
      }
    }
    poly = next;
    if (!poly.length) return null;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    if (p[0] < lo) lo = p[0];
    if (p[0] > hi) hi = p[0];
  }
  return [lo, hi];
}

function pickSide(previous, value, mid) {
  if (value > mid + EDGE_HYSTERESIS) return 1;
  if (value < mid - EDGE_HYSTERESIS) return 0;
  if (previous === 0 || previous === 1) return previous;
  return value > mid ? 1 : 0;
}

function tooClose(a, b, gap) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < gap * gap;
}

function boxesOverlap(a, b, pad) {
  return a.left < b.left + b.w + pad && b.left < a.left + a.w + pad
    && a.top < b.top + b.h + pad && b.top < a.top + a.h + pad;
}

function sortedUnique(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  return s.filter((v, i) => i === 0 || v !== s[i - 1]);
}

function sameValues(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pure label layout, used by createAxisLabels and the tests. update(viewProj,
 * cameraPosition, widthCss, heightCss) returns {blockStep, amountRows, blockEdgeZ,
 * amountEdgeX, blockRange, labels}. blockEdgeZ / amountEdgeX are the anchor lines used
 * (null when no label of that kind is on screen), blockRange the visible [b0, b1] along
 * the labelled long edge. Each label is {kind: 'block' | 'amount', key, text, x, y, ux,
 * uy, left, top, w, h, depth, block | row, sats}: (x, y) is the anchor in CSS px,
 * (ux, uy) the placement direction (outward offset plus edge normal, see candidate)
 * scaled so its larger component is +-1, and left/top/w/h the estimated text box placed
 * on that side of the anchor; CSS: translate(x, y) translate(50(ux-1)%, 50(uy-1)%).
 *
 * amountRows (ascending, frozen, same instance while unchanged) lists the decade rows
 * that are not crowded out: rows of labels on screen, rows whose labels are off screen
 * but uncrowded, and rows whose anchors are behind the camera, so grid lines persist
 * while the labelled edge is out of view.
 */
export function createAxisLayout({ grid, rows, blocktimes = null, maxTicks = BLOCK_TICK_TARGET, marginPx = VIEW_MARGIN_PX } = {}) {
  if (!grid || !Number.isInteger(grid.numBlocks) || grid.numBlocks < 1 || !(grid.rows > 0)) {
    throw new TypeError('createAxisLayout: grid from gridFromManifest is required');
  }
  if (!rows || !(rows.length > 0)) throw new TypeError('createAxisLayout: rows (the minAmt table) is required');
  const numBlocks = grid.numBlocks;
  const tip = numBlocks - 1;
  const W = worldX(numBlocks);
  const D = worldZ(grid.rows);
  const amounts = Object.freeze(amountTicks(rows).map((t, k) => Object.freeze({ ...t, k, key: 'a' + k, z: worldZ(t.row + 0.5) })));
  const allRows = Object.freeze(sortedUnique(amounts.map((a) => a.row)));
  const metrics = {
    block: { charW: DEFAULT_CHAR_W, lineH: DEFAULT_LINE_H },
    amount: { charW: DEFAULT_CHAR_W, lineH: DEFAULT_LINE_H },
  };
  const texts = new Map();
  const P = { x: NaN, y: NaN, depth: 0, visible: false };
  const Q = { x: NaN, y: NaN, depth: 0, visible: false };
  const T0 = { x: NaN, y: NaN, depth: 0, visible: false };
  const T1 = { x: NaN, y: NaN, depth: 0, visible: false };
  let longSide = null;  // 0: z = 0 edge (largest amounts), 1: z = D edge (1 sat)
  let shortSide = null; // 0: x = 0 edge (genesis), 1: x = W edge (tip)
  let blockStep = niceStep(numBlocks, maxTicks);
  let amountRows = allRows;

  const blockAnchorZ = (s) => (s ? D + BLOCK_EDGE_OFFSET : -BLOCK_EDGE_OFFSET);
  const amountAnchorX = (s) => (s ? W + AMOUNT_EDGE_OFFSET : -AMOUNT_EDGE_OFFSET);

  function blockText(b) {
    let s = texts.get(b);
    if (s === undefined) {
      if (texts.size >= 4096) texts.clear();
      s = formatBlockLabel(b, blocktimes);
      texts.set(b, s);
    }
    return s;
  }

  // Projects an anchor (ax, 0, az) and the edge point (ex, 0, ez) it hangs from; (dx, dz)
  // is the edge direction in world space. The text box goes on the side given by the sum
  // of two unit screen vectors: edge point -> anchor, and the edge's screen normal turned
  // to the same side. The first keeps front-on labels in line with their grid lines; the
  // second keeps a label clear of its edge where the outward offset is foreshortened
  // toward a vanishing point (edges near the horizon). Returns null when the anchor is
  // behind the camera; visible requires the anchor on screen and the whole box inside.
  function candidate(kind, key, text, m, ax, az, ex, ez, dx, dz, width, height, fallbackX, fallbackY) {
    projectInto(P, m, ax, 0, az, width, height, marginPx);
    if (!(P.depth > W_EPS)) return null;
    let ox = 0;
    let oy = 0;
    projectInto(Q, m, ex, 0, ez, width, height, marginPx);
    if (Q.depth > W_EPS) {
      const len = Math.hypot(P.x - Q.x, P.y - Q.y);
      if (len > 1e-9) {
        ox = (P.x - Q.x) / len;
        oy = (P.y - Q.y) / len;
      }
    }
    let nx = 0;
    let ny = 0;
    projectInto(T0, m, ex - dx, 0, ez - dz, width, height, marginPx);
    projectInto(T1, m, ex + dx, 0, ez + dz, width, height, marginPx);
    if (T0.depth > W_EPS && T1.depth > W_EPS && (ox !== 0 || oy !== 0)) {
      const len = Math.hypot(T1.x - T0.x, T1.y - T0.y);
      if (len > 1e-9) {
        nx = (T0.y - T1.y) / len;
        ny = (T1.x - T0.x) / len;
        if (nx * ox + ny * oy < 0) {
          nx = -nx;
          ny = -ny;
        }
      }
    }
    let ux = ox + nx;
    let uy = oy + ny;
    const n = Math.max(Math.abs(ux), Math.abs(uy));
    if (n > 1e-9) {
      ux /= n;
      uy /= n;
    } else {
      ux = fallbackX;
      uy = fallbackY;
    }
    const mt = metrics[kind];
    const w = text.length * mt.charW;
    const h = mt.lineH;
    const left = P.x + (w * (ux - 1)) / 2;
    const top = P.y + (h * (uy - 1)) / 2;
    const inside = left >= -BOX_SLACK && top >= -BOX_SLACK && left + w <= width + BOX_SLACK && top + h <= height + BOX_SLACK;
    return {
      kind, key, text, x: P.x, y: P.y, ux, uy, left, top, w, h,
      depth: P.depth, visible: P.visible && inside, rank: 0,
    };
  }

  function amountCandidates(m, s, width, height) {
    const ex = s ? W : 0;
    const ax = amountAnchorX(s);
    return amounts.map((a) => {
      const c = candidate('amount', a.key, a.label, m, ax, a.z, ex, a.z, 0, 1, width, height, s ? 1 : -1, 0);
      if (c) {
        c.row = a.row;
        c.sats = a.sats;
        c.rank = a.k & 1; // even decades (1 sat, 100 sat, ..., 10,000 BTC) win when crowded
      }
      return c;
    });
  }

  function update(viewProj, cameraPosition, widthCss, heightCss) {
    const out = { blockStep, amountRows, blockEdgeZ: null, amountEdgeX: null, blockRange: null, labels: [] };
    if (!viewProj || !(widthCss > 0) || !(heightCss > 0)) return out;
    const m = viewProj;
    longSide = pickSide(longSide, cameraPosition ? cameraPosition.z : NaN, D / 2);
    shortSide = pickSide(shortSide, cameraPosition ? cameraPosition.x : NaN, W / 2);

    // Amount labels go first so they win collisions at the corners.
    let aSide = shortSide;
    let list = amountCandidates(m, aSide, widthCss, heightCss);
    if (!list.some((c) => c && c.visible)) {
      const other = amountCandidates(m, 1 - aSide, widthCss, heightCss);
      if (other.some((c) => c && c.visible)) {
        list = other;
        aSide = 1 - aSide;
      }
    }
    // On-screen labels are placed before off-screen ones, so an unseen label never hides
    // a seen one; the off-screen ones still compete so amountRows stays stable.
    const order = list.filter(Boolean).sort((a, b) => b.visible - a.visible || a.rank - b.rank || a.depth - b.depth);
    const kept = [];
    for (const c of order) {
      let ok = true;
      for (const k of kept) {
        if (tooClose(c, k, AMOUNT_LABEL_GAP_PX) || boxesOverlap(c, k, AMOUNT_BOX_PAD)) {
          ok = false;
          break;
        }
      }
      if (ok) kept.push(c);
    }
    const rowsNow = kept.map((c) => c.row);
    for (let i = 0; i < list.length; i++) if (!list[i]) rowsNow.push(amounts[i].row);
    const sorted = sortedUnique(rowsNow);
    if (!sameValues(sorted, amountRows)) amountRows = Object.freeze(sorted);
    const shownAmounts = kept.filter((c) => c.visible).sort((a, b) => a.row - b.row);
    if (shownAmounts.length) out.amountEdgeX = amountAnchorX(aSide);

    // Block labels along the nearer long edge, or the other one when it shows nothing.
    let bSide = longSide;
    let iv = clipSegment(m, 0, 0, blockAnchorZ(bSide), W, 0, blockAnchorZ(bSide), widthCss, heightCss, marginPx);
    if (!iv) {
      const z = blockAnchorZ(1 - bSide);
      const other = clipSegment(m, 0, 0, z, W, 0, z, widthCss, heightCss, marginPx);
      if (other) {
        iv = other;
        bSide = 1 - bSide;
      }
    }
    const shownBlocks = [];
    if (iv) {
      const b0 = iv[0] * numBlocks;
      const b1 = iv[1] * numBlocks;
      blockStep = niceStep(b1 - b0, maxTicks);
      const az = blockAnchorZ(bSide);
      const ez = bSide ? D : 0;
      const cands = [];
      for (const b of blockTicks(Math.max(0, b0), Math.min(tip, b1), blockStep)) {
        const x = worldX(b);
        const c = candidate('block', 'b' + b, blockText(b), m, x, az, x, ez, 1, 0, widthCss, heightCss, 0, bSide ? 1 : -1);
        if (!c || !c.visible) continue;
        c.block = b;
        c.rank = b % (10 * blockStep) === 0 ? 0 : b % (5 * blockStep) === 0 ? 1 : b % (2 * blockStep) === 0 ? 2 : 3;
        cands.push(c);
      }
      cands.sort((a, b) => a.rank - b.rank || a.depth - b.depth);
      for (const c of cands) {
        let ok = true;
        for (const k of shownBlocks) {
          if (tooClose(c, k, BLOCK_LABEL_GAP_PX) || boxesOverlap(c, k, BLOCK_BOX_PAD)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          for (const k of shownAmounts) {
            if (boxesOverlap(c, k, AMOUNT_BOX_PAD)) {
              ok = false;
              break;
            }
          }
        }
        if (ok) shownBlocks.push(c);
      }
      shownBlocks.sort((a, b) => a.block - b.block);
      out.blockEdgeZ = az;
      out.blockRange = [b0, b1];
    } else {
      // Neither long edge is on screen (close-up, or looking along the landscape): take
      // the step from the visible part of the ground so grid lines still fit the view.
      const fx = footprintXRange(m, W, D);
      if (fx) blockStep = niceStep((fx[1] - fx[0]) * BLOCKS_PER_WORLD_UNIT, maxTicks);
    }
    out.blockStep = blockStep;
    out.amountRows = amountRows;
    out.labels = shownAmounts.concat(shownBlocks);
    return out;
  }

  /** Text metrics for the overlap estimate: advance per character and line height (px). */
  function setMetrics(kind, charW, lineH) {
    const mt = metrics[kind];
    if (!mt) throw new Error('setMetrics: unknown label kind ' + kind);
    if (charW > 0 && Number.isFinite(charW)) mt.charW = charW;
    if (lineH > 0 && Number.isFinite(lineH)) mt.lineH = lineH;
  }

  return {
    update,
    setMetrics,
    amounts,
    worldWidth: W,
    worldDepth: D,
    get metrics() { return metrics; },
  };
}

function setStyle(el, props) {
  const s = el.style;
  for (const k of Object.keys(props)) s[k] = props[k];
}

/**
 * HTML axis labels inside element (the #labels overlay). update(camera, widthCss,
 * heightCss) reads only camera.projectionMatrix.elements, camera.matrixWorldInverse.elements
 * and camera.position (assumed current) and returns {blockStep, amountRows}: the step of
 * the block labels and the ascending decade rows that are labelled, so the terrain can
 * draw grid lines at exactly those positions (see createAxisLayout for amountRows).
 *
 * Labels are pooled divs with classes "lbl lbl-block" / "lbl lbl-amount" in one zero-size
 * layer (class "lbl-layer"); a node is written only when its text, position or visibility
 * changes. The default look (11px IBM Plex Mono, rgba(235,240,255,.78), dark text shadow)
 * is set inline on the layer and inherited, so "#labels .lbl" rules restyle the labels
 * without !important. Two hidden probes, measured by ResizeObserver, keep the overlap
 * estimate in step with restyling and font loading without forcing layout.
 */
export function createAxisLabels({ element, grid, rows, blocktimes = null } = {}) {
  if (!element || typeof element.appendChild !== 'function') throw new TypeError('createAxisLabels: element is required');
  const doc = element.ownerDocument || globalThis.document;
  const win = doc.defaultView || globalThis;
  const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
  const layout = createAxisLayout({ grid, rows, blocktimes });
  const viewProj = new Float64Array(16);
  const stats = { labels: 0, blockLabels: 0, amountLabels: 0, nodes: 0, ms: 0 };
  let visible = true;
  let disposed = false;
  let last = null;
  const initial = layout.update(null);
  let result = { blockStep: initial.blockStep, amountRows: initial.amountRows };

  const layer = doc.createElement('div');
  layer.className = 'lbl-layer';
  setStyle(layer, {
    position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'visible',
    pointerEvents: 'none', font: '11px "IBM Plex Mono", monospace', color: 'rgba(235,240,255,.78)',
    textShadow: '0 1px 2px rgba(0,0,0,.8)', whiteSpace: 'nowrap',
  });
  element.appendChild(layer);

  let observer = null;
  if (typeof win.ResizeObserver === 'function') {
    const kinds = new Map();
    observer = new win.ResizeObserver((entries) => {
      for (const e of entries) {
        const kind = kinds.get(e.target);
        const box = e.borderBoxSize && e.borderBoxSize[0];
        const w = box ? box.inlineSize : e.contentRect.width;
        const h = box ? box.blockSize : e.contentRect.height;
        if (kind && w > 0 && h > 0) layout.setMetrics(kind, w / PROBE_TEXT.length, h);
      }
    });
    for (const kind of ['block', 'amount']) {
      const el = doc.createElement('div');
      el.className = 'lbl lbl-' + kind + ' lbl-probe';
      setStyle(el, { position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', visibility: 'hidden' });
      el.textContent = PROBE_TEXT;
      layer.appendChild(el);
      kinds.set(el, kind);
      observer.observe(el);
    }
  }

  let shown = new Map(); // key -> node displayed by the last applied update
  let next = new Map();
  const free = { block: [], amount: [] };
  let nodeCount = 0;

  function createNode(kind) {
    const el = doc.createElement('div');
    el.className = 'lbl lbl-' + kind;
    setStyle(el, { position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', willChange: 'transform', display: 'none' });
    layer.appendChild(el);
    nodeCount++;
    return { el, kind, text: '', transform: '', on: false };
  }

  function paint(node, l, dpr) {
    if (node.text !== l.text) {
      node.el.textContent = l.text;
      node.text = l.text;
    }
    const t = 'translate(' + Math.round(l.x * dpr) / dpr + 'px,' + Math.round(l.y * dpr) / dpr + 'px) translate('
      + Math.round(50 * (l.ux - 1)) + '%,' + Math.round(50 * (l.uy - 1)) + '%)';
    if (node.transform !== t) {
      node.el.style.transform = t;
      node.transform = t;
    }
    if (!node.on) {
      node.el.style.display = '';
      node.on = true;
    }
  }

  // Labels keep the node they had last time; nodes of labels that left are released
  // before new labels are placed, so the pool never exceeds the labels on screen at once.
  function apply(labels) {
    const dpr = win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    const pending = [];
    for (const l of labels) {
      const node = shown.get(l.key);
      if (!node) {
        pending.push(l);
        continue;
      }
      shown.delete(l.key);
      next.set(l.key, node);
      paint(node, l, dpr);
    }
    for (const node of shown.values()) free[node.kind].push(node);
    shown.clear();
    for (const l of pending) {
      const node = free[l.kind].pop() || createNode(l.kind);
      next.set(l.key, node);
      paint(node, l, dpr);
    }
    for (const kind of ['block', 'amount']) {
      for (const node of free[kind]) {
        if (node.on) {
          node.el.style.display = 'none';
          node.on = false;
        }
      }
    }
    const swap = shown;
    shown = next;
    next = swap;
  }

  function update(camera, widthCss, heightCss) {
    if (disposed) return result;
    const t0 = now();
    viewProjection(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, viewProj);
    last = layout.update(viewProj, camera.position, widthCss, heightCss);
    if (visible) apply(last.labels);
    let blocks = 0;
    for (const l of last.labels) if (l.kind === 'block') blocks++;
    stats.blockLabels = visible ? blocks : 0;
    stats.amountLabels = visible ? last.labels.length - blocks : 0;
    stats.labels = stats.blockLabels + stats.amountLabels;
    stats.nodes = nodeCount;
    result = { blockStep: last.blockStep, amountRows: last.amountRows };
    stats.ms = now() - t0;
    return result;
  }

  function setVisible(on) {
    if (disposed) return;
    visible = !!on;
    layer.style.display = visible ? '' : 'none';
    if (!visible) stats.labels = stats.blockLabels = stats.amountLabels = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (observer) observer.disconnect();
    if (layer.parentNode) layer.parentNode.removeChild(layer);
    shown.clear();
    next.clear();
    free.block.length = 0;
    free.amount.length = 0;
    stats.labels = stats.blockLabels = stats.amountLabels = stats.nodes = 0;
  }

  return {
    update,
    setVisible,
    dispose,
    stats,
    /** Full layout of the last update (label positions, edges, blockRange) for diagnostics. */
    get last() { return last; },
  };
}
