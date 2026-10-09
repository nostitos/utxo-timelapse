// Tile packing and frame deltas for the replay worker (landscape/SPEC.md §5).
// Pure ES module.
//
// Slot layout: 258 x 258 cells, row-major, tile cell (lx, ly) at (ly + 1) * 258 + (lx + 1).
// Four float32 per cell: [heightValue, heat, heatBlock, colorValue]; height and colour values
// are divided by the cell area (L0 cells), heat is the cell's raw BTC sum (so activity stays
// visible at coarse levels). The border holds the same-level neighbour's cell when that
// neighbour is resident, else a copy of the nearest interior cell; cells outside the grid are 0.
import { SLOT, SLOT_CELLS } from '../data/grid.js';

export const MEASURES = Object.freeze(['density', 'count', 'value']);
export const FULL_FRACTION = 0.3;   // a tile with more changed cells than this is resent in full

export function measureCode(name) {
  const i = MEASURES.indexOf(name);
  if (i < 0) throw new Error('unknown measure ' + name + ' (use density, count or value)');
  return i;
}

/** Raw measure of a cell (cells AoS offset o): density, count or value (BTC). */
export function measureValue(c, o, m) {
  return m === 0 ? c[o] + c[o + 3] / 5e8 : m === 1 ? c[o] + c[o + 2] : (c[o + 1] + c[o + 3]) / 1e8;
}

function zero4(out, o) {
  out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
}

/**
 * Writes the packed floats of slot coordinate (sx, sy) of 'slot' into out[o..o+3].
 * Handles interior cells, borders (resident neighbour or nearest interior copy) and cells
 * outside the grid. Returns true when any value is non-zero.
 */
export function resolveCell(slotOf, slot, sx, sy, hm, cm, out, o) {
  let lx = sx - 1;
  let ly = sy - 1;
  let src = slot;
  let ax = sx;
  let ay = sy;
  if (lx < 0 || lx > 255 || ly < 0 || ly > 255) {
    if (slot.colW[sx] === 0 || slot.rowH[sy] === 0) { zero4(out, o); return false; }
    const dx = lx < 0 ? -1 : lx > 255 ? 1 : 0;
    const dy = ly < 0 ? -1 : ly > 255 ? 1 : 0;
    const nid = slot.nb[(dy + 1) * 3 + dx + 1];
    const ns = nid >= 0 ? slotOf[nid] : null;
    if (ns !== null) {
      src = ns;
      lx &= 255;
      ly &= 255;
    } else {
      lx = lx < 0 ? 0 : lx > 255 ? 255 : lx;
      ly = ly < 0 ? 0 : ly > 255 ? 255 : ly;
      ax = lx + 1;
      ay = ly + 1;
    }
  }
  const area = slot.colW[ax] * slot.rowH[ay];
  if (area === 0) { zero4(out, o); return false; }
  const li = (ly << 8) | lx;
  const c = src.cells;
  const co = li << 2;
  let heat = 0;
  let hb = 0;
  if (src.heatActive) {
    heat = src.heat[li << 1];
    if (heat !== 0) hb = src.heat[(li << 1) + 1];
  }
  if (c[co] === 0 && c[co + 2] === 0 && heat === 0) { zero4(out, o); return false; }
  const inv = 1 / area;
  out[o] = measureValue(c, co, hm) * inv;
  out[o + 1] = heat;
  out[o + 2] = hb;
  out[o + 3] = measureValue(c, co, cm) * inv;
  return true;
}

/** Packs a whole slot (interior + border). Returns a Float32Array, or null when all zero. */
export function packFull(slotOf, slot, hm, cm) {
  const out = new Float32Array(SLOT_CELLS * 4);
  let any = false;
  const c = slot.cells;
  const colW = slot.colW;
  const rowH = slot.rowH;
  const heat = slot.heatActive ? slot.heat : null;
  for (let ly = 0; ly < slot.rows; ly++) {
    const rh = rowH[ly + 1];
    let o = ((ly + 1) * SLOT + 1) << 2;
    let li = ly << 8;
    for (let lx = 0; lx < slot.cols; lx++, o += 4, li++) {
      const co = li << 2;
      const cs = c[co];
      const cl = c[co + 2];
      let h = 0;
      if (heat !== null) h = heat[li << 1];
      if (cs === 0 && cl === 0 && h === 0) continue;
      const inv = 1 / (colW[lx + 1] * rh);
      const ss = c[co + 1];
      const sl = c[co + 3];
      out[o] = (hm === 0 ? cs + sl / 5e8 : hm === 1 ? cs + cl : (ss + sl) / 1e8) * inv;
      if (h !== 0) {
        out[o + 1] = h;
        out[o + 2] = heat[(li << 1) + 1];
      }
      out[o + 3] = (cm === 0 ? cs + sl / 5e8 : cm === 1 ? cs + cl : (ss + sl) / 1e8) * inv;
      any = true;
    }
  }
  for (let sx = 0; sx < SLOT; sx++) {
    if (resolveCell(slotOf, slot, sx, 0, hm, cm, out, sx << 2)) any = true;
    if (resolveCell(slotOf, slot, sx, SLOT - 1, hm, cm, out, ((SLOT - 1) * SLOT + sx) << 2)) any = true;
  }
  for (let sy = 1; sy < SLOT - 1; sy++) {
    if (resolveCell(slotOf, slot, 0, sy, hm, cm, out, (sy * SLOT) << 2)) any = true;
    if (resolveCell(slotOf, slot, SLOT - 1, sy, hm, cm, out, (sy * SLOT + SLOT - 1) << 2)) any = true;
  }
  return any ? out : null;
}

/** Slot indices of the border of a slot facing direction bit k = (dy+1)*3+(dx+1). */
function borderIndices(k, push) {
  const dx = (k % 3) - 1;
  const dy = Math.floor(k / 3) - 1;
  if (dx !== 0 && dy !== 0) {
    push((dy < 0 ? 0 : SLOT - 1) * SLOT + (dx < 0 ? 0 : SLOT - 1));
  } else if (dx !== 0) {
    const sx = dx < 0 ? 0 : SLOT - 1;
    for (let sy = 1; sy < SLOT - 1; sy++) push(sy * SLOT + sx);
  } else if (dy !== 0) {
    const sy = dy < 0 ? 0 : SLOT - 1;
    for (let sx = 1; sx < SLOT - 1; sx++) push(sy * SLOT + sx);
  }
}

/**
 * Builds frames from the state: full tiles for newly delivered or heavily changed tiles,
 * deduplicated deltas (including border copies in neighbours) for the rest.
 */
export class FrameBuilder {
  constructor(grid) {
    this.grid = grid;
    this.pairTile = new Int32Array(1 << 16);
    this.pairIdx = new Int32Array(1 << 16);
    this.np = 0;
    this.stamp = new Uint32Array(SLOT_CELLS);
    this.stampN = 0;
    this.counts = new Int32Array(grid.tiles + 1);
    this.fullSet = new Uint8Array(grid.tiles);
    this.seq = 0;
    this.tmp4 = new Float32Array(4);
  }

  push(tile, idx) {
    if (this.np === this.pairTile.length) {
      const t = new Int32Array(this.np * 2);
      t.set(this.pairTile);
      const i = new Int32Array(this.np * 2);
      i.set(this.pairIdx);
      this.pairTile = t;
      this.pairIdx = i;
    }
    this.pairTile[this.np] = tile;
    this.pairIdx[this.np] = idx;
    this.np++;
  }

  /**
   * Builds one frame and resets the dirty bookkeeping of every resident slot.
   * @returns {{frame:object, transfer:ArrayBuffer[]}} frame without stats/meta.
   */
  build(state, hm, cm, reason, block, partial = false) {
    const slotOf = state.slotOf;
    const delivered = state.delivered;
    const desired = state.desired;
    const tiles = this.grid.tiles;
    const fullSet = this.fullSet;
    fullSet.fill(0);
    this.np = 0;
    const fullIds = [];

    // 1. Tiles that need full data; full-changed tiles also refresh neighbour borders.
    for (let id = 0; id < tiles; id++) {
      const s = slotOf[id];
      if (s === null) continue;
      if (desired[id] && (state.wantFull[id] || !delivered[id] || s.dirtyAll)) {
        fullSet[id] = 1;
        fullIds.push(id);
      }
      if (s.dirtyAll) state.touchNeighbourBorders(s);
    }

    // 2. Changed cells (and the border copies they feed).
    for (let id = 0; id < tiles; id++) {
      const s = slotOf[id];
      if (s === null || s.dirtyAll || s.dirtyN === 0) continue;
      const own = delivered[id] === 1 && fullSet[id] === 0;
      const list = s.dirty;
      for (let k = 0; k < s.dirtyN; k++) {
        const li = list[k];
        const lx = li & 255;
        const ly = li >>> 8;
        if (own) this.push(id, (ly + 1) * SLOT + lx + 1);
        if (lx === 0 || lx === 255 || ly === 0 || ly === 255) {
          const ex = lx === 0 ? -1 : lx === 255 ? 1 : 0;
          const ey = ly === 0 ? -1 : ly === 255 ? 1 : 0;
          for (let dy = ey < 0 ? -1 : 0; dy <= (ey > 0 ? 1 : 0); dy++) {
            for (let dx = ex < 0 ? -1 : 0; dx <= (ex > 0 ? 1 : 0); dx++) {
              if (dx === 0 && dy === 0) continue;
              if ((dx !== 0 && dx !== ex) || (dy !== 0 && dy !== ey)) continue;
              const nid = s.nb[(dy + 1) * 3 + dx + 1];
              if (nid < 0) continue;
              if (slotOf[nid] !== null) {
                if (delivered[nid] === 1) this.push(nid, (ly - dy * 256 + 1) * SLOT + (lx - dx * 256 + 1));
              } else if (own) {
                const sx = dx < 0 ? 0 : dx > 0 ? SLOT - 1 : lx + 1;
                const sy = dy < 0 ? 0 : dy > 0 ? SLOT - 1 : ly + 1;
                this.push(id, sy * SLOT + sx);
              }
            }
          }
        }
      }
    }

    // 3. Whole border sides whose neighbour residency or content changed.
    for (let id = 0; id < tiles; id++) {
      const s = slotOf[id];
      if (s === null || s.borderMask === 0) continue;
      if (delivered[id] === 1 && fullSet[id] === 0) {
        for (let k = 0; k < 9; k++) {
          if (k !== 4 && (s.borderMask & (1 << k))) borderIndices(k, (idx) => this.push(id, idx));
        }
      }
    }

    // 4. Group by tile, dedupe, promote heavy tiles to full.
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < this.np; i++) counts[this.pairTile[i] + 1]++;
    for (let t = 0; t < tiles; t++) counts[t + 1] += counts[t];
    const sorted = new Int32Array(this.np);
    const cursor = counts.slice(0, tiles);
    for (let i = 0; i < this.np; i++) sorted[cursor[this.pairTile[i]]++] = this.pairIdx[i];
    const dIds = [];
    const dOffsets = [0];
    let dIndex = new Uint32Array(Math.max(16, this.np));
    let n = 0;
    const limit = Math.floor(FULL_FRACTION * SLOT_CELLS);
    for (let t = 0; t < tiles; t++) {
      const a = counts[t];
      const b = counts[t + 1];
      if (a === b || fullSet[t] === 1 || delivered[t] !== 1 || slotOf[t] === null) continue;
      this.stampN = (this.stampN + 1) >>> 0;
      if (this.stampN === 0) { this.stamp.fill(0); this.stampN = 1; }
      const st = this.stampN;
      const start = n;
      for (let i = a; i < b; i++) {
        const idx = sorted[i];
        if (this.stamp[idx] === st) continue;
        this.stamp[idx] = st;
        dIndex[n++] = idx;
      }
      if (n - start > limit) {
        n = start;
        fullSet[t] = 1;
        fullIds.push(t);
        continue;
      }
      dIds.push(t);
      dOffsets.push(n);
    }
    dIndex = dIndex.slice(0, n);
    const dData = new Float32Array(n * 4);
    for (let k = 0; k < dIds.length; k++) {
      const s = slotOf[dIds[k]];
      for (let i = dOffsets[k]; i < dOffsets[k + 1]; i++) {
        const idx = dIndex[i];
        const sy = (idx / SLOT) | 0;
        resolveCell(slotOf, s, idx - sy * SLOT, sy, hm, cm, dData, i * 4);
      }
    }

    // 5. Full tiles.
    const full = [];
    const transfer = [];
    for (const id of fullIds) {
      const s = slotOf[id];
      const data = packFull(slotOf, s, hm, cm);
      full.push({ id, level: s.level, tx: s.tx, ty: s.ty, empty: data === null, data });
      if (data !== null) transfer.push(data.buffer);
      delivered[id] = 1;
      state.wantFull[id] = 0;
    }

    // 6. Reset bookkeeping.
    for (let id = 0; id < tiles; id++) {
      const s = slotOf[id];
      if (s === null) continue;
      s.dirtyN = 0;
      s.dirtyAll = false;
      s.borderMask = 0;
    }
    const deltas = { ids: Uint32Array.from(dIds), offsets: Uint32Array.from(dOffsets), index: dIndex, data: dData };
    transfer.push(deltas.ids.buffer, deltas.offsets.buffer, deltas.index.buffer, deltas.data.buffer);
    const evicted = state.evicted;
    state.evicted = [];
    const frame = { seq: ++this.seq, block, reason, partial, full, deltas, evicted };
    return { frame, transfer, deltaCells: n };
  }
}
