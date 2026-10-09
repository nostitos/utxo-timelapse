// Test fixtures for the replay worker (owner: js_replay). Not a test file itself.
// - syntheticChain(): deterministic synthetic blocks with realistic change structure
// - ReferenceState: independent, obviously-correct L0 accumulator (binary-search rows,
//   Map of cells) with exact aggregation to every level
// - writeDataset(): writes a complete dataset in the SPEC §4 format
// - fileSource(): Node data source; inProcessWorker(): Worker stand-in running the engine
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gridFromManifest } from '../web/data/grid.js';
import { buildMinAmtTable, rowOfAmount, FILM_AXIS } from '../web/data/axis.js';
import { encodeBlock } from '../web/replay/blk2.js';
import { buildSnapshotFile } from '../web/data/snapshot.js';
import { ReplayEngine } from '../web/replay/engine.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The C++ rows table differs from the JS film table at one boundary (row 49); the fixture
// uses that table so tests prove the worker follows rows.bin, not the float formula.
export function cppLikeRows() {
  const t = buildMinAmtTable();
  t[49] = 779521282186;
  return t;
}

const SPECIAL = [1, 2, 99, 100, 101, 545, 546, 547, 10000, 1e8, 5e8, 5e8 + 1, 1e9, 1e9 - 1, 5e9, 779521282186, 779521282187,
  1e12, 1e13 - 1, 1e13, 2.1e15];

/** Deterministic synthetic chain: [{height, changes: [[satoshi, creationHeight]...], time}]. */
export function syntheticChain({ numBlocks, seed = 1, spendRate = 0.6, maxCreate = 5 }) {
  const r = rng(seed);
  const utxos = [];
  const blocks = [];
  const amount = () => {
    const x = r();
    if (x < 0.05) return SPECIAL[Math.floor(r() * SPECIAL.length)];
    if (x < 0.08) return 0;
    return Math.max(1, Math.floor(Math.exp(r() * Math.log(3e14))));
  };
  for (let h = 0; h < numBlocks; h++) {
    const changes = [];
    const nSpend = utxos.length ? Math.floor(r() * r() * Math.min(12, utxos.length) * spendRate * 2) : 0;
    for (let k = 0; k < nSpend && utxos.length; k++) {
      // Bias towards recent outputs, sometimes very old ones.
      const i = r() < 0.7 ? utxos.length - 1 - Math.floor(r() * Math.min(utxos.length, 64)) : Math.floor(r() * utxos.length);
      const [a, ch] = utxos[i];
      utxos[i] = utxos[utxos.length - 1];
      utxos.pop();
      changes.push([a === 0 ? 0 : -a, ch]);
    }
    const nCreate = 1 + Math.floor(r() * maxCreate);
    for (let k = 0; k < nCreate; k++) {
      const a = amount();
      if (r() < 0.06) {
        // Created and spent in the same block.
        changes.push([a, h], [a === 0 ? 0 : -a, h]);
      } else {
        changes.push([a, h]);
        utxos.push([a, h]);
      }
    }
    blocks.push({ height: h, changes, time: 1231006505 + h * 600 + Math.floor(r() * 300) });
  }
  return blocks;
}

/** Independent reference: exact L0 cells keyed by c0 * rows + r0. */
export class ReferenceState {
  constructor(grid, minAmt) {
    this.grid = grid;
    this.minAmt = minAmt;
    this.cells = new Map();
    this.totals = { countSmall: 0, countLarge: 0, satsSmall: 0, satsLarge: 0 };
  }
  applyBlock(changes, sign = 1) {
    const touched = [];
    for (const [s, h] of changes) {
      if (s === 0) continue;
      const a = Math.abs(s);
      const r0 = rowOfAmount(this.minAmt, a);
      const c0 = Math.floor(h / this.grid.blocksPerColumn);
      const key = c0 * this.grid.rows + r0;
      let c = this.cells.get(key);
      if (!c) this.cells.set(key, (c = [0, 0, 0, 0]));
      const dc = (s > 0 ? 1 : -1) * sign;
      if (a > 500000000) { c[2] += dc; c[3] += dc * a; this.totals.countLarge += dc; this.totals.satsLarge += dc * a; }
      else { c[0] += dc; c[1] += dc * a; this.totals.countSmall += dc; this.totals.satsSmall += dc * a; }
      touched.push(key);
    }
    // Counts may go transiently negative inside a block (create and spend in one block);
    // check and clean up only at the block boundary.
    for (const key of touched) {
      const c = this.cells.get(key);
      if (!c) continue;
      if (c[0] < 0 || c[2] < 0) throw new Error('reference: negative count at a block boundary');
      if (c[0] === 0 && c[2] === 0) {
        if (c[1] !== 0 || c[3] !== 0) throw new Error('reference: sats without count');
        this.cells.delete(key);
      }
    }
  }
  /** Map(tileId -> Float64Array(65536*4)) for every level (only non-empty tiles). */
  tiles() {
    const out = new Map();
    const g = this.grid;
    for (const [key, c] of this.cells) {
      const c0 = Math.floor(key / g.rows);
      const r0 = key - c0 * g.rows;
      for (const L of g.levels) {
        const col = Math.floor(c0 / 2 ** L.columnShift);
        const row = Math.floor(r0 / 2 ** L.rowShift);
        const id = L.firstTile + Math.floor(row / 256) * L.tilesX + Math.floor(col / 256);
        let t = out.get(id);
        if (!t) out.set(id, (t = new Float64Array(65536 * 4)));
        const o = ((row % 256) * 256 + (col % 256)) * 4;
        t[o] += c[0]; t[o + 1] += c[1]; t[o + 2] += c[2]; t[o + 3] += c[3];
      }
    }
    return out;
  }
  /** Raw cell at a level: [cs, ss, cl, sl]. */
  cellAt(level, col, row) {
    const g = this.grid;
    const L = g.levels[level];
    const w = 2 ** L.columnShift;
    const hgt = 2 ** L.rowShift;
    const sum = [0, 0, 0, 0];
    for (let c0 = col * w; c0 < Math.min(g.l0Columns, (col + 1) * w); c0++) {
      for (let r0 = row * hgt; r0 < Math.min(g.rows, (row + 1) * hgt); r0++) {
        const c = this.cells.get(c0 * g.rows + r0);
        if (c) for (let k = 0; k < 4; k++) sum[k] += c[k];
      }
    }
    return sum;
  }
}

function sha256(u8) {
  return createHash('sha256').update(u8).digest('hex');
}

/**
 * Writes a dataset directory in the SPEC §4 format from synthetic blocks.
 * @returns {{dir, manifest, blocks, records, rows, snapshots}}
 */
export async function writeDataset(dir, { numBlocks = 20000, seed = 1, chunkBytes = 64 * 1024, snapshotIntervalBytes = 256 * 1024, rows = cppLikeRows(), chain } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'chunks'), { recursive: true });
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  const blocks = chain || syntheticChain({ numBlocks, seed });
  const grid = gridFromManifest({ numBlocks: blocks.length });
  const records = blocks.map((b) => encodeBlock(b.height, b.changes, { time: b.time, nTx: Math.max(1, b.changes.length >> 1), size: 200 + b.changes.length * 30 }));
  // Chunks.
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  let first = 0;
  let off = 0;
  const flush = (last) => {
    if (!cur.length) return;
    const buf = new Uint8Array(curBytes);
    let p = 0;
    for (const r of cur) { buf.set(r, p); p += r.length; }
    const index = chunks.length;
    const file = 'chunks/' + String(index).padStart(5, '0') + '.bin';
    writeFileSync(join(dir, file), buf);
    chunks.push({ index, file, firstBlock: first, lastBlock: last, blkOffset: off, bytes: buf.length, sha256: sha256(buf) });
    off += buf.length;
    cur = [];
    curBytes = 0;
  };
  for (let h = 0; h < records.length; h++) {
    const r = records[h];
    if (cur.length && curBytes + r.length > chunkBytes) flush(h - 1);
    if (!cur.length) first = h;
    cur.push(r);
    curBytes += r.length;
  }
  flush(records.length - 1);
  // Snapshots from the independent reference.
  const ref = new ReferenceState(grid, rows);
  const snapshots = [];
  let blkEnd = 0;
  let sinceLast = 0;
  for (let h = 0; h < blocks.length; h++) {
    ref.applyBlock(blocks[h].changes, 1);
    blkEnd += records[h].length;
    sinceLast += records[h].length;
    if (h === 0 || sinceLast >= snapshotIntervalBytes || h === blocks.length - 1) {
      const bytes = await buildSnapshotFile(grid, h, blkEnd, ref.tiles(), ref.totals);
      const file = 'snapshots/' + String(h).padStart(7, '0') + '.bin';
      writeFileSync(join(dir, file), bytes);
      snapshots.push({ block: h, file, bytes: bytes.length, sha256: sha256(bytes), blkEnd });
      sinceLast = 0;
    }
  }
  const rowsBytes = new Uint8Array(rows.length * 8);
  const dv = new DataView(rowsBytes.buffer);
  rows.forEach((v, i) => dv.setFloat64(i * 8, v, true));
  writeFileSync(join(dir, 'rows.bin'), rowsBytes);
  const times = new Uint8Array(blocks.length * 4);
  const tv = new DataView(times.buffer);
  blocks.forEach((b, i) => tv.setUint32(i * 4, b.time, true));
  writeFileSync(join(dir, 'blocktimes.bin'), times);
  writeFileSync(join(dir, 'chunks.json'), JSON.stringify({ format: 'utxo-landscape-chunks-1', chunks }));
  const manifest = {
    format: 'utxo-landscape-1', createdUtc: new Date(0).toISOString(), numBlocks: blocks.length, tip: blocks.length - 1,
    tipTime: blocks[blocks.length - 1].time,
    grid: { blocksPerColumn: 64, rows: 2072, l0Columns: grid.l0Columns, tileSize: 256, border: 1, tiles: grid.tiles, levels: grid.levels },
    axis: { ...FILM_AXIS, graphRect: [...FILM_AXIS.graphRect] },
    weightThresholdSatoshi: 500000000,
    files: { rows: 'rows.bin', blocktimes: 'blocktimes.bin', chunks: 'chunks.json' },
    chunkBytesTarget: chunkBytes, snapshotIntervalBytes, snapshots,
    source: { blk: 'synthetic', blkBytes: off, history: 'synthetic', historyNumBlocks: blocks.length, historyNumRecords: 0 },
    build: { seconds: 0, snapshotBytes: snapshots.reduce((a, s) => a + s.bytes, 0), chunkBytes: off },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { dir, manifest, grid, blocks, records, rows, snapshots };
}

/** Data source over a local directory (Node only). */
export function fileSource(dir) {
  let requests = 0;
  return {
    async json(p) { requests++; return JSON.parse(await readFile(join(dir, p), 'utf8')); },
    async bytes(p, start, end) {
      requests++;
      if (start === undefined) {
        const b = await readFile(join(dir, p));
        return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      }
      const fh = await open(join(dir, p), 'r');
      try {
        const buf = Buffer.allocUnsafeSlow(end - start);
        const { bytesRead } = await fh.read(buf, 0, end - start, start);
        if (bytesRead !== end - start) throw new Error('short read ' + p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } finally {
        await fh.close();
      }
    },
    stats() { return { requests }; },
    describe() { return dir; },
  };
}

/** Minimal Worker stand-in that runs the engine in this thread (for client tests). */
export function inProcessWorker(source) {
  const listeners = [];
  let engine = null;
  const deliver = (msg) => setImmediate(() => { for (const l of listeners) l({ data: msg }); });
  const handle = async (m) => {
    if (m.type === 'init') {
      engine = new ReplayEngine({ source, post: (msg) => deliver(msg) });
      try {
        const r = await engine.init(m);
        deliver({ type: 'ready', manifest: r.manifest, rows: r.rows, blocktimes: r.blocktimes, snapshotBlocks: r.snapshotBlocks });
      } catch (err) {
        deliver({ type: 'initError', message: String(err.message || err) });
      }
      return;
    }
    engine.command(m);
  };
  return {
    engine: () => engine,
    postMessage(m) { const copy = structuredClone(m); setImmediate(() => handle(copy)); },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    terminate() { if (engine) engine.dispose(); },
  };
}
