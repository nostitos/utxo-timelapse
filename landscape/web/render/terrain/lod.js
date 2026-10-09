// Tile selection and draw lists for the landscape terrain (landscape/SPEC.md §6).
//
// Pure module: no three.js, no DOM. Given a camera (position, frustum planes and the
// projection scale in pixels per world unit at distance 1) it chooses which tiles should be
// resident (priority order, within the tile budget) and which patches of which resident
// tiles to draw. The draw list always covers every visible region exactly once with the
// deepest resident level: a split tile is replaced by its children only where those
// children are resident; elsewhere its own patches are drawn. Top-level tiles (L6) are
// always resident, so there are no holes and no overlaps.
import { tileInfo, tileId, childTiles, LEVELS } from '../../data/grid.js';

export const PATCH_CELLS = 64; // cells per patch side
export const PATCHES_PER_SIDE = 4; // 256 / 64
export const PATCHES_PER_TILE = 16;
const CELL_X = 0.064; // world units per L0 column (64 blocks / 1000)
const CELL_Z = 0.1; // world units per row (1 / 10)

/** World size of one cell at a level: {cw, ch}. */
export function cellSize(grid, level) {
  const L = grid.levels[level];
  return { cw: CELL_X * 2 ** L.columnShift, ch: CELL_Z * 2 ** L.rowShift };
}

/** Patch columns and rows of a tile that contain grid cells. */
export function tilePatchExtent(t) {
  return { px: Math.ceil(t.cols / PATCH_CELLS), py: Math.ceil(t.rows / PATCH_CELLS) };
}

/** Bit mask (bit py*4+px) of the patches of a tile that contain grid cells. */
export function fullPatchMask(t) {
  const { px, py } = tilePatchExtent(t);
  let m = 0;
  for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) m |= 1 << (y * PATCHES_PER_SIDE + x);
  return m;
}

/** Patches of the parent tile covered by one of its child tiles. */
export function childPatchMask(grid, parent, child) {
  const p = tileInfo(grid, parent);
  const c = tileInfo(grid, child);
  const P = grid.levels[p.level];
  const C = grid.levels[c.level];
  const pc0 = (c.col0 >> 1) - p.col0;
  const x0 = pc0 / PATCH_CELLS;
  let y0;
  let h;
  if (C.rowShift < P.rowShift) {
    y0 = ((c.row0 >> 1) - p.row0) / PATCH_CELLS;
    h = 2;
  } else {
    y0 = (c.row0 - p.row0) / PATCH_CELLS;
    h = 4;
  }
  let m = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + 2; x++) m |= 1 << (y * PATCHES_PER_SIDE + x);
  return m & fullPatchMask(p);
}

/** World bounds of a tile (y from 0 to maxH). */
export function tileBounds(grid, id, maxH = 0) {
  const t = tileInfo(grid, id);
  const { cw, ch } = cellSize(grid, t.level);
  return [t.col0 * cw, 0, t.row0 * ch, (t.col0 + t.cols) * cw, maxH, (t.row0 + t.rows) * ch];
}

/** World bounds of one patch of a tile (patch px, py), with the surface reaching the next
 * cell centre on the +x/+z side (the patch's last vertex row samples the next cell). */
export function patchBounds(grid, id, px, py, maxH = 0) {
  const t = tileInfo(grid, id);
  const { cw, ch } = cellSize(grid, t.level);
  const c0 = t.col0 + px * PATCH_CELLS;
  const r0 = t.row0 + py * PATCH_CELLS;
  return [c0 * cw, 0, r0 * ch, (c0 + PATCH_CELLS + 1) * cw, maxH, (r0 + PATCH_CELLS + 1) * ch];
}

/** Axis-aligned box [x0,y0,z0,x1,y1,z1] against 6 planes (nx,ny,nz,d; inside when n.p + d >= 0). */
export function boxVisible(planes, b) {
  if (!planes) return true;
  for (let i = 0; i < 24; i += 4) {
    const nx = planes[i];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    const d = planes[i + 3];
    const x = nx >= 0 ? b[3] : b[0];
    const y = ny >= 0 ? b[4] : b[1];
    const z = nz >= 0 ? b[5] : b[2];
    if (nx * x + ny * y + nz * z + d < 0) return false;
  }
  return true;
}

/** Distance from a point to a box (0 inside). */
export function boxDistance(px, py, pz, b) {
  const dx = Math.max(b[0] - px, 0, px - b[3]);
  const dy = Math.max(b[1] - py, 0, py - b[4]);
  const dz = Math.max(b[2] - pz, 0, pz - b[5]);
  return Math.hypot(dx, dy, dz);
}

class MaxHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, value) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] >= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const topK = k[0];
    const topV = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    if (k.length) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && v[l] > v[m]) m = l;
        if (r < k.length && v[r] > v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return [topK, topV];
  }
}

/** Ids of the top-level tiles (always resident). */
export function rootTiles(grid) {
  const L = grid.levels[grid.levels.length - 1];
  const out = [];
  for (let ty = 0; ty < L.tilesY; ty++) for (let tx = 0; tx < L.tilesX; tx++) out.push(tileId(grid, L.level, tx, ty));
  return out;
}

/**
 * Chooses resident tiles and the draw list.
 *
 * view: { position: [x,y,z], planes: 24 numbers or null, projScale: pixels per world unit at
 *         distance 1 (viewportHeightPx / (2 tan(fovY/2))) }
 * opts: { threshold: refine while a cell projects larger than this many pixels,
 *         budget: maximum number of tiles in the selection (roots included),
 *         isResident(id) → bool, isEmpty(id) → bool (resident and all zero; drawn by the floor),
 *         tileMaxHeight(id) → height bound of a resident tile, or a negative number when unknown,
 *         defaultMaxHeight: bound for tiles without data,
 *         previousSplit: Set of tiles split last time (hysteresis), hysteresis: 0.8 }
 * Returns { desired: number[] (priority order), split: Set<number>, draw: [{id, mask}],
 *           selected: number }.
 */
export function selectTiles(grid, view, opts) {
  const threshold = Math.max(1e-6, opts.threshold ?? 2);
  const budget = Math.max(1, opts.budget ?? 128);
  const hysteresis = opts.hysteresis ?? 0.8;
  const prev = opts.previousSplit || null;
  const isResident = opts.isResident || (() => false);
  const isEmpty = opts.isEmpty || (() => false);
  const maxH = (id) => {
    const h = opts.tileMaxHeight ? opts.tileMaxHeight(id) : -1;
    return h >= 0 ? h : opts.defaultMaxHeight ?? 50;
  };
  const [px, py, pz] = view.position;
  const planes = view.planes || null;
  const projScale = view.projScale || 1000;
  const ortho = !!view.orthographic;

  const boundsCache = new Map();
  const bounds = (id) => {
    let b = boundsCache.get(id);
    if (!b) {
      b = tileBounds(grid, id, maxH(id));
      boundsCache.set(id, b);
    }
    return b;
  };
  const visible = (id) => boxVisible(planes, bounds(id));
  const error = (id) => {
    const t = tileInfo(grid, id);
    const { cw, ch } = cellSize(grid, t.level);
    if (ortho) return Math.max(cw, ch) * projScale;
    const d = Math.max(boxDistance(px, py, pz, bounds(id)), 1e-3);
    return (Math.max(cw, ch) * projScale) / d;
  };

  const roots = rootTiles(grid);
  const selected = new Set(roots);
  const desired = roots.slice();
  const split = new Set();
  const heap = new MaxHeap();
  for (const r of roots) if (visible(r)) heap.push(r, error(r));
  while (heap.size) {
    const [id, e] = heap.pop();
    const limit = prev && prev.has(id) ? threshold * hysteresis : threshold;
    if (e <= limit) continue;
    const kids = childTiles(grid, id).filter(visible);
    if (!kids.length) continue;
    if (selected.size + kids.length > budget) continue;
    split.add(id);
    // Nearest children first so they load first.
    kids.sort((a, b) => boxDistance(px, py, pz, bounds(a)) - boxDistance(px, py, pz, bounds(b)));
    for (const k of kids) {
      selected.add(k);
      desired.push(k);
      if (tileInfo(grid, k).level > 0) heap.push(k, error(k));
    }
  }

  const draw = [];
  const visit = (id) => {
    let mask = fullPatchMask(tileInfo(grid, id));
    if (split.has(id)) {
      for (const c of childTiles(grid, id)) {
        const cm = childPatchMask(grid, id, c);
        if (!visible(c)) {
          mask &= ~cm;
        } else if (isResident(c)) {
          mask &= ~cm;
          visit(c);
        }
      }
    }
    if (mask && !isEmpty(id)) draw.push({ id, mask });
  };
  for (const r of roots) if (isResident(r) && visible(r)) visit(r);
  return { desired, split, draw, selected: selected.size };
}

/** Frustum planes (24 numbers) from a column-major view-projection matrix (three.js layout,
 * WebGPU or WebGL clip depth; the near plane uses the matching convention). */
export function frustumPlanes(m, webgpuDepth = true) {
  const e = m;
  const me0 = e[0], me1 = e[1], me2 = e[2], me3 = e[3];
  const me4 = e[4], me5 = e[5], me6 = e[6], me7 = e[7];
  const me8 = e[8], me9 = e[9], me10 = e[10], me11 = e[11];
  const me12 = e[12], me13 = e[13], me14 = e[14], me15 = e[15];
  const raw = [
    [me3 - me0, me7 - me4, me11 - me8, me15 - me12],
    [me3 + me0, me7 + me4, me11 + me8, me15 + me12],
    [me3 + me1, me7 + me5, me11 + me9, me15 + me13],
    [me3 - me1, me7 - me5, me11 - me9, me15 - me13],
    [me3 - me2, me7 - me6, me11 - me10, me15 - me14],
    webgpuDepth ? [me2, me6, me10, me14] : [me3 + me2, me7 + me6, me11 + me10, me15 + me14],
  ];
  const out = new Float64Array(24);
  raw.forEach((p, i) => {
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    out[i * 4] = p[0] / len;
    out[i * 4 + 1] = p[1] / len;
    out[i * 4 + 2] = p[2] / len;
    out[i * 4 + 3] = p[3] / len;
  });
  return out;
}

export { LEVELS };
