// Per-patch maxima of a tile's height values (pure; no three.js). A patch (px, py) of a tile
// covers local cells [64 px, 64 px + 64] x [64 py, 64 py + 64]: its own 64 x 64 cells plus
// the first row/column of the next patch (the surface reaches the next cell centre); the
// last patch reaches the border cell 256.
import { SLOT } from '../../data/grid.js';

export const PATCH = 64;
export const PPS = 4; // patches per side

/** Patch indices (0..15) whose surface uses local cell (lx, ly) (-1..256). */
export function patchesOfCell(lx, ly) {
  const xs = [];
  const ys = [];
  if (lx >= 0 && lx <= 256) {
    if (lx < 256) xs.push(lx >> 6);
    if (lx > 0 && (lx & 63) === 0) xs.push((lx >> 6) - 1);
  }
  if (ly >= 0 && ly <= 256) {
    if (ly < 256) ys.push(ly >> 6);
    if (ly > 0 && (ly & 63) === 0) ys.push((ly >> 6) - 1);
  }
  const out = [];
  for (const y of ys) for (const x of xs) out.push(y * PPS + x);
  return out;
}

/** Raises the maxima (max[offset + p]) of the patches that use cell (lx, ly) to at least v.
 * Allocation-free: called once per delta cell. */
export function bumpPatchMax(max, offset, lx, ly, v) {
  if (!(v > 0) || lx < 0 || ly < 0 || lx > 256 || ly > 256) return;
  const x0 = lx < 256 ? lx >> 6 : -1;
  const x1 = lx > 0 && (lx & 63) === 0 ? (lx >> 6) - 1 : -1;
  const y0 = ly < 256 ? ly >> 6 : -1;
  const y1 = ly > 0 && (ly & 63) === 0 ? (ly >> 6) - 1 : -1;
  let i;
  if (y0 >= 0) {
    if (x0 >= 0 && v > max[(i = offset + y0 * PPS + x0)]) max[i] = v;
    if (x1 >= 0 && v > max[(i = offset + y0 * PPS + x1)]) max[i] = v;
  }
  if (y1 >= 0) {
    if (x0 >= 0 && v > max[(i = offset + y1 * PPS + x0)]) max[i] = v;
    if (x1 >= 0 && v > max[(i = offset + y1 * PPS + x1)]) max[i] = v;
  }
}

/** Recomputes the 16 patch maxima of a slot (channel 0 of 4-float cells starting at base);
 * returns the tile maximum. */
export function recomputePatchMax(data, base, max16) {
  max16.fill(0);
  let tmax = 0;
  for (let sy = 1; sy <= 257; sy++) {
    const ly = sy - 1;
    const rowPy = ly < 256 ? ly >> 6 : -1;
    const extraPy = ly > 0 && (ly & 63) === 0 ? (ly >> 6) - 1 : -1;
    let o = base + (sy * SLOT + 1) * 4;
    for (let sx = 1; sx <= 257; sx++, o += 4) {
      const v = data[o];
      if (!(v > 0)) continue;
      if (v > tmax) tmax = v;
      const lx = sx - 1;
      const px = lx < 256 ? lx >> 6 : -1;
      const extraPx = lx > 0 && (lx & 63) === 0 ? (lx >> 6) - 1 : -1;
      if (rowPy >= 0) {
        if (px >= 0 && v > max16[rowPy * PPS + px]) max16[rowPy * PPS + px] = v;
        if (extraPx >= 0 && v > max16[rowPy * PPS + extraPx]) max16[rowPy * PPS + extraPx] = v;
      }
      if (extraPy >= 0) {
        if (px >= 0 && v > max16[extraPy * PPS + px]) max16[extraPy * PPS + px] = v;
        if (extraPx >= 0 && v > max16[extraPy * PPS + extraPx]) max16[extraPy * PPS + extraPx] = v;
      }
    }
  }
  return tmax;
}
