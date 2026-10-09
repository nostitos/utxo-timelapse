// Sparse exact multi-level state for the replay worker (landscape/SPEC.md §3, §5).
// Pure ES module. Only resident tiles hold state; each resident tile is a TileSlot
// with 4 float64 per cell [countSmall, satsSmall, countLarge, satsLarge] (exact
// integers: counts and satoshi sums stay far below 2^53).
import { tileInfo, tileId } from '../data/grid.js';

export const DIRTY_CAP = 16384;          // per-slot changed-cell list before falling back to a full resend
export const WEIGHT_THRESHOLD = 500000000; // exactly 5 BTC is small
export const HEAT_TABLE = 65536;          // exact decay factors for gaps below this many blocks

/** One resident tile (or a tile being loaded). */
export class TileSlot {
  constructor(grid, id) {
    this.cells = new Float64Array(65536 * 4);
    this.dirty = new Uint16Array(DIRTY_CAP);
    this.heat = null;                    // Float32Array(65536 * 2): [heat, heatBlock] per cell, lazy
    this.colW = new Float64Array(258);   // L0 columns covered by slot column sx (0 outside the grid)
    this.rowH = new Float64Array(258);   // L0 rows covered by slot row sy (0 outside the grid)
    this.nb = new Int32Array(9);         // same-level neighbour ids, index (dy+1)*3+(dx+1); -1 outside
    this.reset(grid, id);
  }

  reset(grid, id) {
    const t = tileInfo(grid, id);
    if (!t) throw new Error('TileSlot: bad tile id ' + id);
    const L = grid.levels[t.level];
    this.id = id;
    this.level = t.level;
    this.tx = t.tx;
    this.ty = t.ty;
    this.col0 = t.col0;
    this.row0 = t.row0;
    this.cols = t.cols;
    this.rows = t.rows;
    this.dirtyN = 0;
    this.dirtyAll = true;
    this.borderMask = 0;
    this.heatActive = false;
    this.block = -1;                     // block of this slot's state while loading
    this.lastUse = 0;
    const w = 2 ** L.columnShift;
    const h = 2 ** L.rowShift;
    for (let s = 0; s < 258; s++) {
      const col = t.col0 + s - 1;
      this.colW[s] = col < 0 || col >= L.columns ? 0 : Math.min(w, grid.l0Columns - col * w);
      const row = t.row0 + s - 1;
      this.rowH[s] = row < 0 || row >= L.rows ? 0 : Math.min(h, grid.rows - row * h);
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) this.nb[(dy + 1) * 3 + dx + 1] = tileId(grid, t.level, t.tx + dx, t.ty + dy);
    }
    return this;
  }

  clear() {
    this.cells.fill(0);
    if (this.heat) this.heat.fill(0);
    this.heatActive = false;
    this.dirtyN = 0;
    this.dirtyAll = true;
  }

  clearHeat() {
    if (this.heatActive) {
      this.heat.fill(0);
      this.heatActive = false;
      this.dirtyAll = true;
    }
  }

  get memoryBytes() {
    return this.cells.byteLength + this.dirty.byteLength + (this.heat ? this.heat.byteLength : 0) + 4200;
  }
}

/** Heat decay factors 2^(-d/H) for d = 0..HEAT_TABLE-1. */
export function heatDecayTable(halfLife) {
  const t = new Float64Array(HEAT_TABLE);
  for (let d = 0; d < HEAT_TABLE; d++) t[d] = Math.pow(2, -d / halfLife);
  return t;
}

/**
 * Builds the hot apply function for a grid and minAmt table.
 * apply(dec, sign, slotOf, heat, totals) applies (sign = +1) or undoes (sign = -1) one
 * decoded block on every slot present in slotOf (array indexed by tile id, null when
 * absent). heat = null or {block, halfLife, decay}; only forward playback passes heat.
 * totals = null or Float64Array(4) [countSmall, satsSmall, countLarge, satsLarge].
 * Returns the number of non-zero changes applied.
 */
export function makeApplier(grid, minAmt) {
  const L = grid.levels;
  const standard = L.length === 7 && grid.blocksPerColumn === 64 &&
    L.every((lv, i) => lv.columnShift === i && lv.rowShift === Math.min(i, 4));
  return standard ? makeUnrolledApplier(grid, minAmt) : makeGenericApplier(grid, minAmt);
}

function touch(slot, li, off, dc, ds) {
  const cells = slot.cells;
  const o = (li << 2) + off;
  cells[o] += dc;
  cells[o + 1] += ds;
  if (!slot.dirtyAll) {
    if (slot.dirtyN < DIRTY_CAP) slot.dirty[slot.dirtyN++] = li;
    else slot.dirtyAll = true;
  }
}

function touchHeat(slot, li, add, hb, decay, hl) {
  let hv = slot.heat;
  if (hv === null) hv = slot.heat = new Float32Array(131072);
  slot.heatActive = true;
  const hi = li << 1;
  const prev = hv[hi];
  if (prev === 0) hv[hi] = add;
  else {
    const d = hb - hv[hi + 1];
    hv[hi] = prev * (d < decay.length ? decay[d] : Math.pow(2, -d / hl)) + add;
  }
  hv[hi + 1] = hb;
}

// The standard 7-level grid with the seven levels unrolled (about 1.4x faster than the
// generic loop on recent blocks). Must match makeGenericApplier exactly.
function makeUnrolledApplier(grid, minAmt) {
  const L = grid.levels;
  const F0 = L[0].firstTile, F1 = L[1].firstTile, F2 = L[2].firstTile, F3 = L[3].firstTile;
  const F4 = L[4].firstTile, F5 = L[5].firstTile, F6 = L[6].firstTile;
  const X0 = L[0].tilesX, X1 = L[1].tilesX, X2 = L[2].tilesX, X3 = L[3].tilesX;
  const X4 = L[4].tilesX, X5 = L[5].tilesX, X6 = L[6].tilesX;
  const last = minAmt.length - 1;
  if (minAmt[last] !== 1) throw new Error('minAmt must end at 1 sat');
  return function apply(dec, sign, slotOf, heat, totals) {
    const n = dec.count;
    const S = dec.sats;
    const HH = dec.heights;
    const heatOn = heat !== null;
    const hb = heatOn ? heat.block : 0;
    const decay = heatOn ? heat.decay : null;
    const hl = heatOn ? heat.halfLife : 1;
    const tot = totals !== null;
    let rSp = 0;
    let rCr = last;
    let applied = 0;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      if (s === 0) continue;
      let a;
      let r;
      let dc;
      if (s < 0) {
        a = -s;
        while (minAmt[rSp] > a) rSp++;
        r = rSp;
        dc = -sign;
      } else {
        a = s;
        while (rCr > 0 && minAmt[rCr - 1] <= a) rCr--;
        r = rCr;
        dc = sign;
      }
      const ds = dc * a;
      const off = a > WEIGHT_THRESHOLD ? 2 : 0;
      if (tot) { totals[off] += dc; totals[off + 1] += ds; }
      const c = HH[i] >>> 6;
      const spendHeat = heatOn && s < 0;
      const add = spendHeat ? a / 1e8 : 0;
      let slot;
      let col;
      let row;
      let li;
      slot = slotOf[F0 + (r >>> 8) * X0 + (c >>> 8)];
      if (slot !== null) { li = ((r & 255) << 8) | (c & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      col = c >>> 1; row = r >>> 1;
      slot = slotOf[F1 + (row >>> 8) * X1 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      col = c >>> 2; row = r >>> 2;
      slot = slotOf[F2 + (row >>> 8) * X2 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      col = c >>> 3; row = r >>> 3;
      slot = slotOf[F3 + (row >>> 8) * X3 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      row = r >>> 4;
      col = c >>> 4;
      slot = slotOf[F4 + (row >>> 8) * X4 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      col = c >>> 5;
      slot = slotOf[F5 + (row >>> 8) * X5 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      col = c >>> 6;
      slot = slotOf[F6 + (row >>> 8) * X6 + (col >>> 8)];
      if (slot !== null) { li = ((row & 255) << 8) | (col & 255); touch(slot, li, off, dc, ds); if (spendHeat) touchHeat(slot, li, add, hb, decay, hl); }
      applied++;
    }
    return applied;
  };
}

/** Generic level loop (any level layout); reference for the unrolled version. */
export function makeGenericApplier(grid, minAmt) {
  const NL = grid.levels.length;
  const FT = new Int32Array(NL);
  const TX = new Int32Array(NL);
  const RS = new Int32Array(NL);
  for (let l = 0; l < NL; l++) {
    FT[l] = grid.levels[l].firstTile;
    TX[l] = grid.levels[l].tilesX;
    RS[l] = grid.levels[l].rowShift;
  }
  const colShift = Math.log2(grid.blocksPerColumn);
  if (!Number.isInteger(colShift)) throw new Error('blocksPerColumn must be a power of two');
  const last = minAmt.length - 1;
  if (minAmt[last] !== 1) throw new Error('minAmt must end at 1 sat');

  return function apply(dec, sign, slotOf, heat, totals) {
    const n = dec.count;
    const S = dec.sats;
    const HH = dec.heights;
    const heatOn = heat !== null;
    const hb = heatOn ? heat.block : 0;
    const decay = heatOn ? heat.decay : null;
    const DT = heatOn ? decay.length : 0;
    const hl = heatOn ? heat.halfLife : 1;
    const tot = totals !== null;
    // Changes are sorted by satoshi: spends (most negative first, so falling amounts and
    // rising rows), zeros, then creations (rising amounts, falling rows). Walk the rows.
    let rSp = 0;
    let rCr = last;
    let applied = 0;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      if (s === 0) continue;
      let a;
      let r;
      let dc;
      if (s < 0) {
        a = -s;
        while (minAmt[rSp] > a) rSp++;
        r = rSp;
        dc = -sign;
      } else {
        a = s;
        while (rCr > 0 && minAmt[rCr - 1] <= a) rCr--;
        r = rCr;
        dc = sign;
      }
      const ds = dc * a;
      const off = a > WEIGHT_THRESHOLD ? 2 : 0;
      if (tot) { totals[off] += dc; totals[off + 1] += ds; }
      const c0 = HH[i] >>> colShift;
      const spendHeat = heatOn && s < 0;
      for (let l = 0; l < NL; l++) {
        const col = c0 >>> l;
        const row = r >>> RS[l];
        const slot = slotOf[FT[l] + (row >>> 8) * TX[l] + (col >>> 8)];
        if (slot === null) continue;
        const li = ((row & 255) << 8) | (col & 255);
        const cells = slot.cells;
        const o = (li << 2) + off;
        cells[o] += dc;
        cells[o + 1] += ds;
        if (!slot.dirtyAll) {
          if (slot.dirtyN < DIRTY_CAP) slot.dirty[slot.dirtyN++] = li;
          else slot.dirtyAll = true;
        }
        if (spendHeat) {
          let hv = slot.heat;
          if (hv === null) hv = slot.heat = new Float32Array(131072);
          slot.heatActive = true;
          const hi = li << 1;
          const prev = hv[hi];
          const add = a / 1e8;
          if (prev === 0) hv[hi] = add;
          else {
            const d = hb - hv[hi + 1];
            hv[hi] = prev * (d < DT ? decay[d] : Math.pow(2, -d / hl)) + add;
          }
          hv[hi + 1] = hb;
        }
      }
      applied++;
    }
    return applied;
  };
}

/**
 * Container for resident slots plus bookkeeping shared with the frame builder.
 */
export class LandscapeState {
  constructor(grid, minAmt) {
    this.grid = grid;
    this.minAmt = minAmt;
    this.slotOf = new Array(grid.tiles).fill(null);
    this.block = null;                         // exact block of every attached slot
    this.totals = new Float64Array(4);         // [countSmall, satsSmall, countLarge, satsLarge]
    this.delivered = new Uint8Array(grid.tiles);  // main thread holds this tile
    this.wantFull = new Uint8Array(grid.tiles);   // send full data in the next frame
    this.desired = new Uint8Array(grid.tiles);    // currently requested by the viewer
    this.pinned = new Uint8Array(grid.tiles);     // kept for cell inspection
    this.evicted = [];                         // delivered ids dropped since the last frame
    this.free = [];
    this.apply = makeApplier(grid, minAmt);
    this.halfLife = 64;
    this.decay = heatDecayTable(this.halfLife);
    this.useCounter = 0;
  }

  setHalfLife(blocks) {
    const h = Math.max(1e-3, Number(blocks) || 1);
    if (h !== this.halfLife) {
      this.halfLife = h;
      this.decay = heatDecayTable(h);
    }
  }

  heatFor(block) {
    return { block, halfLife: this.halfLife, decay: this.decay };
  }

  newSlot(id) {
    const s = this.free.pop();
    if (s) {
      s.reset(this.grid, id);
      s.clear();
      return s;
    }
    return new TileSlot(this.grid, id);
  }

  recycle(slot) {
    if (this.free.length < 16) this.free.push(slot);
  }

  get residentCount() {
    let n = 0;
    for (const s of this.slotOf) if (s !== null) n++;
    return n;
  }

  residentIds() {
    const out = [];
    for (let i = 0; i < this.slotOf.length; i++) if (this.slotOf[i] !== null) out.push(i);
    return out;
  }

  /** Marks delivered neighbours whose border faces tile 'slot' for recomputation. */
  touchNeighbourBorders(slot) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nid = slot.nb[(dy + 1) * 3 + dx + 1];
        if (nid < 0) continue;
        const n = this.slotOf[nid];
        if (n !== null && this.delivered[nid]) n.borderMask |= 1 << ((1 - dy) * 3 + (1 - dx));
      }
    }
  }

  /** Makes a loaded slot (already at this.block) resident. */
  attach(slot) {
    if (this.slotOf[slot.id] !== null) throw new Error('attach: tile ' + slot.id + ' already resident');
    slot.dirtyAll = true;
    slot.dirtyN = 0;
    slot.block = -1;
    this.slotOf[slot.id] = slot;
    this.wantFull[slot.id] = 1;
    this.touchNeighbourBorders(slot);
  }

  /** Drops a resident slot. */
  detach(id) {
    const slot = this.slotOf[id];
    if (slot === null) return;
    this.slotOf[id] = null;
    if (this.delivered[id]) { this.delivered[id] = 0; this.evicted.push(id); }
    this.wantFull[id] = 0;
    this.touchNeighbourBorders(slot);
    this.recycle(slot);
  }

  /** Drops every slot (snapshot seek). */
  detachAll() {
    for (let id = 0; id < this.slotOf.length; id++) if (this.slotOf[id] !== null) this.detach(id);
    this.block = null;
  }

  clearHeat() {
    for (const s of this.slotOf) if (s !== null) s.clearHeat();
  }

  /** Raw exact cell state at a level, or null when its tile is not resident. */
  cellAt(level, col, row) {
    const L = this.grid.levels[level];
    if (!L || col < 0 || row < 0 || col >= L.columns || row >= L.rows) return null;
    const id = L.firstTile + (row >>> 8) * L.tilesX + (col >>> 8);
    const slot = this.slotOf[id];
    if (slot === null) return null;
    const li = ((row & 255) << 8) | (col & 255);
    const c = slot.cells;
    const o = li << 2;
    let heat = 0;
    let heatBlock = 0;
    if (slot.heatActive) {
      heat = slot.heat[li << 1];
      heatBlock = slot.heat[(li << 1) + 1];
      if (heat !== 0 && this.block !== null) heat *= Math.pow(2, -(this.block - heatBlock) / this.halfLife);
    }
    return { level, col, row, tile: id, countSmall: c[o], satsSmall: c[o + 1], countLarge: c[o + 2], satsLarge: c[o + 3], heat, heatBlock };
  }

  get memoryBytes() {
    let b = 0;
    for (const s of this.slotOf) if (s !== null) b += s.memoryBytes;
    for (const s of this.free) b += s.memoryBytes;
    return b;
  }
}
