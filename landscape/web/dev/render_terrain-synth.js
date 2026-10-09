// Synthetic worker frames for render_terrain dev pages (not used by the app).
//
// Generates tiles from an analytic density field and mimics the replay client's frame
// format (SPEC §5): full 258 x 258 x 4 tiles with borders, deltas with border copies,
// evictions, heat and heatBlock.
import { tileInfo, tileOfCell, SLOT, SLOT_CELLS, cellArea } from '../data/grid.js';
import { buildMinAmtTable, rowOfAmount } from '../data/axis.js';

function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function createSynthSource({ grid, block, budget = 225, seed = 1 }) {
  const minAmt = buildMinAmtTable();
  const r = (sats) => rowOfAmount(minAmt, sats);
  const bands = [
    [r(50e8), 2.5, 9, 3300],  // coinbase 50 BTC (early eras)
    [r(25e8), 2.5, 5, 6600],
    [r(1e8), 8, 2.0, 1e9],
    [r(1e7), 30, 1.2, 1e9],
    [r(1e6), 50, 1.6, 1e9],
    [r(1e5), 60, 2.2, 1e9],
    [r(1e4), 60, 2.6, 1e9],
    [r(546), 6, 4, 1e9],
    [r(330), 5, 3, 1e9],
  ];
  const state = { block, seq: 0 };
  const resident = new Map(); // id -> Float32Array slot data
  let desired = [];
  const queue = [];
  const evictedPending = [];

  function density(c0, r0) {
    const maxCol = state.block / grid.blocksPerColumn;
    if (c0 > maxCol || c0 < 0 || r0 < 0 || r0 >= grid.rows) return 0;
    const frac = c0 / grid.l0Columns;
    const era = 0.15 + 3.0 * frac ** 1.6;
    let band = 0.06;
    for (const [rc, w, a, maxC] of bands) {
      if (c0 > maxC) continue;
      const z = (r0 - rc) / w;
      band += a * Math.exp(-z * z);
    }
    const n = hash(Math.floor(c0) * 7 + seed, Math.floor(r0) * 13);
    const spike = n > 0.995 ? 12 : n > 0.98 ? 3 : 1;
    const ridge = 1 + 0.6 * Math.sin(c0 / 37) * Math.sin(r0 / 23);
    const age = (maxCol - c0) / Math.max(1, maxCol);
    const survive = 0.35 + 0.65 * Math.exp(-age * 2.2);
    const v = 40 * era * band * (0.35 + 1.3 * n) * spike * ridge * survive;
    return v < 0.5 ? 0 : v;
  }

  function cellValue(level, col, row) {
    const L = grid.levels[level];
    if (col < 0 || row < 0 || col >= L.columns || row >= L.rows) return 0;
    const c0 = (col + 0.5) * 2 ** L.columnShift - 0.5;
    const r0 = (row + 0.5) * 2 ** L.rowShift - 0.5;
    return density(c0, r0);
  }

  function makeTile(id) {
    const t = tileInfo(grid, id);
    const data = new Float32Array(SLOT_CELLS * 4);
    let any = false;
    const nowCol = state.block / grid.blocksPerColumn / 2 ** grid.levels[t.level].columnShift;
    for (let sy = 0; sy < SLOT; sy++) {
      for (let sx = 0; sx < SLOT; sx++) {
        const col = t.col0 + sx - 1;
        const row = t.row0 + sy - 1;
        const v = cellValue(t.level, col, row);
        if (!(v > 0)) continue;
        any = true;
        const o = (sy * SLOT + sx) * 4;
        data[o] = v;
        data[o + 3] = v;
        // A little heat near the creation edge.
        const dist = nowCol - col;
        if (dist >= 0 && dist < 40 && hash(col * 3 + 1, row * 5 + 2) > 0.85) {
          data[o + 1] = 0.5 + 40 * hash(col, row) ** 3;
          data[o + 2] = state.block - Math.floor(hash(row, col) * 200);
        }
      }
    }
    return { id, level: t.level, tx: t.tx, ty: t.ty, empty: !any, data: any ? data : null };
  }

  function setTiles(ids) {
    desired = ids.slice();
    const want = new Set(desired);
    queue.length = 0;
    for (const id of desired) if (!resident.has(id)) queue.push(id);
    // Evict non-desired tiles beyond the budget (L6 kept).
    if (resident.size + queue.length > budget) {
      for (const id of [...resident.keys()]) {
        if (resident.size + queue.length <= budget) break;
        if (!want.has(id) && tileInfo(grid, id).level < grid.levels.length - 1) {
          resident.delete(id);
          evictedPending.push(id);
        }
      }
    }
  }

  function poll(maxTiles = 6, maxMs = 12) {
    const t0 = performance.now();
    const full = [];
    while (queue.length && full.length < maxTiles && performance.now() - t0 < maxMs) {
      const id = queue.shift();
      const tile = makeTile(id);
      resident.set(id, tile.data || new Float32Array(SLOT_CELLS * 4));
      full.push(tile.data ? { ...tile, data: tile.data.slice() } : tile);
    }
    if (!full.length && !evictedPending.length) return null;
    const evicted = evictedPending.splice(0);
    return { seq: ++state.seq, block: state.block, reason: 'tiles', partial: false, full, deltas: null, evicted,
      stats: { residentTiles: resident.size, pendingTiles: queue.length } };
  }

  // Applies one synthetic block: creations in the newest column and spends elsewhere.
  function advance(nBlocks = 1, changesPerBlock = 300) {
    const changed = new Map(); // id -> Map(localIndex -> true)
    const mark = (id, li) => {
      let m = changed.get(id);
      if (!m) changed.set(id, (m = new Set()));
      m.add(li);
    };
    function applyL0(c0, r0, dv, heatAdd) {
      for (let l = 0; l < grid.levels.length; l++) {
        const L = grid.levels[l];
        const col = c0 >> L.columnShift;
        const row = r0 >> L.rowShift;
        const id = tileOfCell(grid, l, col, row);
        const data = resident.get(id);
        if (!data) continue;
        const t = tileInfo(grid, id);
        const area = cellArea(grid, l, col, row) || 1;
        // interior cell plus any resident same-level neighbour border copies
        const targets = [[id, data, col - t.col0, row - t.row0]];
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const nid = tileOfCell(grid, l, col + dx * 256, row + dy * 256);
          if (nid < 0 || nid === id) continue;
          const nd = resident.get(nid);
          if (!nd) continue;
          const nt = tileInfo(grid, nid);
          const lx = col - nt.col0;
          const ly = row - nt.row0;
          if (lx >= -1 && lx <= 256 && ly >= -1 && ly <= 256) targets.push([nid, nd, lx, ly]);
        }
        for (const [tid, d, lx, ly] of targets) {
          const li = (ly + 1) * SLOT + (lx + 1);
          const o = li * 4;
          d[o] = Math.max(0, d[o] + dv / area);
          d[o + 3] = d[o];
          if (heatAdd > 0) {
            const H = 144;
            d[o + 1] = d[o + 1] * 2 ** (-(state.block - d[o + 2]) / H) + heatAdd / area;
            d[o + 2] = state.block;
          }
          mark(tid, li);
        }
      }
    }
    for (let b = 0; b < nBlocks; b++) {
      state.block++;
      const nowC0 = Math.floor(state.block / grid.blocksPerColumn);
      for (let k = 0; k < changesPerBlock; k++) {
        const u = hash(state.block * 977 + k, 17);
        const rr = Math.floor(1100 + 900 * hash(k, state.block));
        if (u < 0.5) applyL0(nowC0, rr, 1, 0);
        else {
          const c = Math.floor(hash(k * 31, state.block * 7) * nowC0);
          const amount = 0.001 + 60 * hash(state.block, k * 5) ** 6;
          applyL0(c, rr, -1, amount);
        }
      }
    }
    const ids = [];
    const offsets = [0];
    const index = [];
    const vals = [];
    for (const [id, set] of changed) {
      const d = resident.get(id);
      ids.push(id);
      for (const li of set) {
        index.push(li);
        vals.push(d[li * 4], d[li * 4 + 1], d[li * 4 + 2], d[li * 4 + 3]);
      }
      offsets.push(index.length);
    }
    return {
      seq: ++state.seq, block: state.block, reason: 'advance', partial: false, full: [],
      deltas: { ids: Uint32Array.from(ids), offsets: Uint32Array.from(offsets), index: Uint32Array.from(index), data: Float32Array.from(vals) },
      evicted: [], stats: { residentTiles: resident.size },
    };
  }

  return { setTiles, poll, advance, get block() { return state.block; }, get pending() { return queue.length; }, resident };
}

