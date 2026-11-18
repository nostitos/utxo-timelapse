// Transaction view layout (ui/tx.js, docs/landscape-transactions-plan.md). Pure module: no DOM,
// no three.js.
//
// A transaction is a short bridge in the air above its block. Inputs rise from the cells of the
// coins it spent to the bridge's past end; outputs leave its future end and land on the cells of
// the coins it made. A transaction does not record which input paid which output, so this draws
// n + m ribbons, never n x m. Coins in one L0 cell share a ribbon; past MAX_RIBBONS on a side,
// the largest half keep their own cell and the rest merge by the coarser cells of the grid's own
// levels until the count fits. Inputs whose creation block the lookup left unknown are counted in
// rest and drawn as one dashed stub.
import { BLOCKS_PER_COLUMN, BLOCKS_PER_WORLD_UNIT, ROWS_PER_WORLD_UNIT, LEVELS, MAX_ROW_SHIFT } from '../data/grid.js';
import { rowOfAmount } from '../data/axis.js';

export const MAX_RIBBONS = 300;
export const VALUE_FRAMED = 0.98; // share of each side's BTC whose ribbons the camera keeps in view

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cellX = (col) => ((col + 0.5) * BLOCKS_PER_COLUMN) / BLOCKS_PER_WORLD_UNIT;
const cellZ = (row) => (row + 0.5) / ROWS_PER_WORLD_UNIT;

/** Ribbons of one side: points {col, row, sat, index} merged by cell, at most cap. */
function bundle(points, cap) {
  const byCell = (list, level) => {
    const shift = Math.min(level, MAX_ROW_SHIFT);
    const m = new Map();
    for (const p of list) {
      const key = (p.col >> level) * 4096 + (p.row >> shift);
      let b = m.get(key);
      if (!b) m.set(key, (b = { level, col: p.col >> level, row: p.row >> shift, sat: 0, x: 0, z: 0, rows: [] }));
      // Value-weighted position: a merged ribbon lands where its coins' value is.
      b.sat += p.sat;
      b.x += cellX(p.col) * p.sat;
      b.z += cellZ(p.row) * p.sat;
      b.rows.push(p.index);
    }
    return [...m.values()].map((b) => ({ ...b, x: b.x / b.sat, z: b.z / b.sat }));
  };
  const cells = byCell(points, 0).sort((a, b) => b.sat - a.sat);
  if (cells.length <= cap) return cells;
  const keep = cells.slice(0, cap >> 1);
  const byIndex = new Map(points.map((p) => [p.index, p]));
  const rest = cells.slice(cap >> 1).flatMap((c) => c.rows.map((index) => byIndex.get(index)));
  for (let level = 1; level < LEVELS; level++) {
    const merged = byCell(rest, level);
    if (keep.length + merged.length <= cap) return keep.concat(merged.sort((a, b) => b.sat - a.sat));
  }
  // Even the coarsest level has too many: the smallest of those become one ribbon.
  const coarse = byCell(rest, LEVELS - 1).sort((a, b) => b.sat - a.sat);
  const tail = coarse.slice(cap - keep.length - 1);
  const sat = tail.reduce((s, b) => s + b.sat, 0);
  const last = { level: LEVELS, col: -1, row: -1, sat, rows: tail.flatMap((b) => b.rows),
    x: tail.reduce((s, b) => s + b.x * b.sat, 0) / sat, z: tail.reduce((s, b) => s + b.z * b.sat, 0) / sat };
  return keep.concat(coarse.slice(0, cap - keep.length - 1), [last]);
}

/**
 * Ribbons of a /api/landscape/tx answer seen at block, or null when the transaction is after
 * it. minAmt: the row table (rows.bin). Returns {height, hub: {x, z}, inputs, outputs, rest,
 * inSat, outSat, inRibbon, outRibbon}: a ribbon is {x, z, col, row, level, sat, rows} (rows index
 * answer.inputs or answer.outputs); rest {count, sat, rows} holds the inputs without a creation
 * block; inRibbon[i] and outRibbon[j] name the ribbon of each input and output (-1: none, as for
 * zero-value outputs).
 */
export function groupTx(answer, minAmt, block, { cap = MAX_RIBBONS } = {}) {
  if (!answer || !Number.isInteger(answer.height) || !(block >= answer.height)) return null;
  const at = (height, sat, index) => ({ col: Math.floor(height / BLOCKS_PER_COLUMN), row: rowOfAmount(minAmt, sat), sat, index });
  const rest = { count: 0, sat: 0, rows: [] };
  const ins = [];
  answer.inputs.forEach((input, i) => {
    if (!(input.satoshi > 0)) return;
    if (Number.isInteger(input.height) && input.height <= answer.height) ins.push(at(input.height, input.satoshi, i));
    else {
      rest.count++;
      rest.sat += input.satoshi;
      rest.rows.push(i);
    }
  });
  const outs = [];
  answer.outputs.forEach((output, j) => {
    if (output.satoshi > 0) outs.push(at(answer.height, output.satoshi, j));
  });
  const inputs = bundle(ins, cap);
  const outputs = bundle(outs, cap);
  const index = (ribbons, n) => {
    const out = new Array(n).fill(-1);
    ribbons.forEach((r, k) => { for (const i of r.rows) out[i] = k; });
    return out;
  };
  const sum = (list) => list.reduce((s, p) => s + (p.satoshi || 0), 0);
  const outSat = sum(answer.outputs);
  return {
    height: answer.height,
    // The bridge stands on the transaction's block, at the row of the value it moved, where the
    // 2D explorer puts its point.
    hub: { x: answer.height / BLOCKS_PER_WORLD_UNIT, z: cellZ(rowOfAmount(minAmt, Math.max(1, outSat))) },
    inputs, outputs, rest, inSat: sum(answer.inputs), outSat,
    inRibbon: index(inputs, answer.inputs.length), outRibbon: index(outputs, answer.outputs.length),
  };
}

/** Width (CSS px) and opacity of a ribbon carrying sat of a side's total, among n ribbons. */
export function ribbonStyle(sat, total, n) {
  const share = Math.sqrt(total > 0 ? Math.min(1, sat / total) : 0);
  return { px: 1.6 + 9 * share, alpha: (0.4 + 0.6 * share) * clamp(14 / Math.sqrt(Math.max(1, n)), 0.45, 1) };
}

/**
 * Cubic Bézier control points of every curve of a grouped transaction. ground(x, z) is the
 * terrain height (world units). Returns {hubY, half, top, curves}: top is the highest terrain
 * around the bridge, which the bridge clears; each curve is {kind ('in', 'out', 'rest', 'bridge'
 * or 'mast'), ribbon (index on its side, or -1), p: [x0, y0, z0, ... x3, y3, z3]}; inputs run
 * from their cell to the bridge, outputs from the bridge to their cell.
 */
export function txCurves(group, ground) {
  const { hub } = group;
  const g = (x, z) => Math.max(0, Number(ground(x, z)) || 0);
  let reach = 0;
  for (const r of [...group.inputs, ...group.outputs]) reach = Math.max(reach, Math.hypot(r.x - hub.x, r.z - hub.z));
  const base = g(hub.x, hub.z);
  // The bridge clears the columns around it, then rises with the reach of its farthest ribbon,
  // so older coins arc higher.
  let top = base;
  const around = clamp(reach, 2, 12);
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) top = Math.max(top, g(hub.x + (i * around) / 4, hub.z + (j * around) / 4));
  const hubY = top + clamp(0.3 * Math.pow(reach, 0.9), 2.2, 45);
  const half = clamp(0.14 * reach, 0.8, 8) / 2;
  const curves = [];
  const end = (dir) => [hub.x + dir * half, hubY, hub.z];
  const ribbon = (r, k, dir) => {
    const y0 = g(r.x, r.z);
    const d = Math.hypot(r.x - hub.x, r.z - hub.z);
    const [ex, ey, ez] = end(dir);
    // Inputs lean toward the past as they rise and meet the bridge from its past end; outputs
    // leave its future end, swing out over the side beyond the leading edge and land.
    const lift = clamp(0.45 * d + 0.8, 0.6, hubY * 1.25);
    const nearFoot = [r.x + dir * Math.min(6, 0.12 * d + 0.3), y0 + lift, r.z];
    const nearBridge = [ex + dir * clamp(0.3 * d, 0.5, 10), hubY + Math.min(6, 0.08 * d), ez + (r.z - ez) * 0.15];
    const p = dir < 0 ? [r.x, y0, r.z, ...nearFoot, ...nearBridge, ex, ey, ez] : [ex, ey, ez, ...nearBridge, ...nearFoot, r.x, y0, r.z];
    curves.push({ kind: dir < 0 ? 'in' : 'out', ribbon: k, p });
  };
  group.inputs.forEach((r, k) => ribbon(r, k, -1));
  group.outputs.forEach((r, k) => ribbon(r, k, 1));
  const [ix, iy, iz] = end(-1);
  const [ox, oy, oz] = end(1);
  if (group.rest.count) {
    const s = Math.max(1.5, half * 2.4 + 1);
    curves.push({ kind: 'rest', ribbon: -1, p: [ix - s, iy + 0.2 * s, iz, ix - 0.6 * s, iy + 0.1 * s, iz, ix - 0.3 * s, iy, iz, ix, iy, iz] });
  }
  curves.push({ kind: 'bridge', ribbon: -1, p: [ix, iy, iz, ix + (ox - ix) / 3, iy, iz, ix + (2 * (ox - ix)) / 3, oy, oz, ox, oy, oz] });
  curves.push({ kind: 'mast', ribbon: -1, p: [hub.x, base, hub.z, hub.x, base + (hubY - base) / 3, hub.z, hub.x, base + (2 * (hubY - base)) / 3, hub.z, hub.x, hubY, hub.z] });
  return { hubY, half, top, curves };
}

/** Control points the camera must keep in view: the bridge and the ribbons carrying VALUE_FRAMED of each side. */
export function framedPoints(group, curves) {
  const pts = [];
  const add = (p) => { for (let i = 0; i < 12; i += 3) pts.push([p[i], p[i + 1], p[i + 2]]); };
  for (const [kind, ribbons, total] of [['in', group.inputs, group.inSat - group.rest.sat], ['out', group.outputs, group.outSat]]) {
    // Ribbons are sorted largest first, except a merged tail; the cut keeps the largest.
    const order = ribbons.map((r, k) => k).sort((a, b) => ribbons[b].sat - ribbons[a].sat);
    const keep = new Set();
    let acc = 0;
    for (const k of order) {
      keep.add(k);
      acc += ribbons[k].sat;
      if (acc >= VALUE_FRAMED * total) break;
    }
    for (const c of curves) if (c.kind === kind && keep.has(c.ribbon)) add(c.p);
  }
  for (const c of curves) if (c.kind !== 'in' && c.kind !== 'out') add(c.p);
  return pts;
}

/**
 * Camera that keeps every point of pts ([[x, y, z], ...]) in view, looking along yaw and pitch
 * (degrees, as ui/controls.js: yaw 0 looks toward -z, pitch < 0 looks down), with the frustum's
 * half-angles scaled by margin. A Bézier stays inside its control points, so framing those keeps
 * the curves in view. minEye keeps the camera at least that high, above the columns that would
 * hide the bridge. Returns {target, distance} for controls.poseLookingAt.
 */
export function frameTx(pts, { fovDeg, aspect, yawDeg = 0, pitchDeg = -32, margin = 0.85, minDistance = 6, minEye = -Infinity }) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const rl = Math.hypot(f[2], f[0]);
  const r = [-f[2] / rl, 0, f[0] / rl];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const target = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * margin;
  const tanH = tanV * aspect;
  let distance = minDistance;
  for (const p of pts) {
    const v = [p[0] - target.x, p[1] - target.y, p[2] - target.z];
    const dot = (a) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    distance = Math.max(distance, Math.abs(dot(r)) / tanH - dot(f), Math.abs(dot(u)) / tanV - dot(f));
  }
  // Backing away along the view keeps every point inside the frame.
  if (f[1] < 0) distance = Math.max(distance, (minEye - target.y) / -f[1]);
  return { target, distance };
}
