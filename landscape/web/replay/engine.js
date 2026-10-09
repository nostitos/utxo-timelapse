// Replay engine: owns the exact state and runs seek / advance / tile-load / cell jobs
// (landscape/SPEC.md §5). Used by replay.worker.js; testable in Node with any data source.
// Pure ES module.
import { gridFromManifest, tileOfCell, levelOfTile } from '../data/grid.js';
import { parseRowsBin } from '../data/axis.js';
import {
  parseSnapshotHeader, checkSnapshotHeader, parseSnapshotDirectory, snapshotPrefixBytes,
  decodeTileBlob, crc32,
} from '../data/snapshot.js';
import { DecodedBlock, decodeBlock } from './blk2.js';
import { LandscapeState } from './state.js';
import { FrameBuilder, measureCode } from './pack.js';
import { ChunkStore } from './chunks.js';
import { planSeek, snapshotAtOrBelow } from './planner.js';

export const COARSE_LEVEL = 4;       // levels >= this load first on a snapshot seek
const SLICE_MS = 8;                  // catch-up slice while playback runs
const YIELD_MS = 12;                 // max time between yields to the message loop
const GROUP_MAX = 48;                // tiles per background load group
const MAX_PINNED = 4;
const RANGE_GAP = 256 * 1024;        // coalesce tile blobs closer than this
const RANGE_MAX = 16 * 1048576;
const FETCH_CONCURRENCY = 4;
const DIR_CACHE = 48;
export const MEMORY_BUDGET = 1400 * 1048576;   // worker total target (SPEC: <= 1.5 GB)
const MIN_CHUNK_CACHE = 64 * 1048576;

export function makeYield() {
  if (typeof setImmediate === 'function') return () => new Promise((r) => setImmediate(r));
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    const q = [];
    ch.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
    return () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); });
  }
  return () => new Promise((r) => setTimeout(r, 0));
}

const now = () => performance.now();

function ema(prev, next, k = 0.3) {
  return prev === null || !Number.isFinite(prev) ? next : prev + (next - prev) * k;
}

export class ReplayEngine {
  /**
   * @param {{source: object, post: (msg: object, transfer?: ArrayBuffer[]) => void, yieldTask?: () => Promise<void>}} o
   */
  constructor({ source, post, yieldTask }) {
    this.source = source;
    this.post = post;
    this.yieldTask = yieldTask || makeYield();
    this.disposed = false;
    this.seekReq = null;
    this.advanceReq = null;
    this.cellReqs = [];
    this.pendingCells = [];
    this.wakeResolve = null;
    this.hm = 0;
    this.cm = 0;
    this.measureDirty = false;
    this.desiredIds = [];
    this.residencyDirty = false;
    this.pinOrder = [];
    this.group = null;
    this.groupSeq = 0;
    this.meta = null;
    this.dirCache = new Map();
    this.rates = { applyBytesPerMs: null, catchUpBytesPerMs: null, loadMsPerTile: null };
    this.counters = { blocks: 0, changes: 0, applyMs: 0, workMs: 0 };
    this.lastStatus = { phase: '', t: 0 };
    this.phase = 'init';
    this.failedTiles = new Map();  // id -> retry-after time
    this.loopError = null;
  }

  // ---------------------------------------------------------------- init
  async init({ maxResidentTiles = 225, chunkCacheMB = 512, verifyChunks = true } = {}) {
    const manifest = await this.source.json('manifest.json');
    if (manifest.format !== 'utxo-landscape-1') throw new Error('manifest.json: unexpected format ' + manifest.format);
    const grid = gridFromManifest(manifest);
    const files = manifest.files || {};
    const [chunkTable, rowsBuf, timesBuf] = await Promise.all([
      this.source.json(files.chunks || 'chunks.json'),
      this.source.bytes(files.rows || 'rows.bin'),
      this.source.bytes(files.blocktimes || 'blocktimes.bin'),
    ]);
    const rows = parseRowsBin(rowsBuf, grid.rows);
    if (timesBuf.byteLength !== grid.numBlocks * 4) throw new Error('blocktimes.bin: ' + timesBuf.byteLength + ' bytes, expected ' + grid.numBlocks * 4);
    const blocktimes = new Uint32Array(grid.numBlocks);
    const tdv = new DataView(timesBuf.buffer, timesBuf.byteOffset, timesBuf.byteLength);
    for (let i = 0; i < grid.numBlocks; i++) blocktimes[i] = tdv.getUint32(i * 4, true);
    const snaps = (manifest.snapshots || []).slice().sort((a, b) => a.block - b.block);
    if (!snaps.length || snaps[0].block !== 0) throw new Error('manifest: no snapshot at block 0');
    for (let i = 1; i < snaps.length; i++) {
      if (!(snaps[i].block > snaps[i - 1].block)) throw new Error('manifest: duplicate snapshot block ' + snaps[i].block);
      if (!(snaps[i].blkEnd > snaps[i - 1].blkEnd)) throw new Error('manifest: snapshot blkEnd not increasing at ' + snaps[i].block);
    }
    this.manifest = manifest;
    this.grid = grid;
    this.rows = rows;
    this.blocktimes = blocktimes;
    this.snapshots = snaps;
    this.snapshotBlocks = snaps.map((s) => s.block);
    this.chunks = new ChunkStore(this.source, chunkTable, grid.numBlocks, { cacheBytes: chunkCacheMB * 1048576, verify: verifyChunks });
    this.requestedCacheBytes = chunkCacheMB * 1048576;
    // blkEnd = source offset of block + 1: inside that block's chunk (exact at chunk
    // starts and at the tip). Directory headers are checked against it when loaded.
    for (const s of snaps) {
      if (s.block >= grid.tip) {
        if (s.blkEnd !== this.chunks.totalBytes) throw new Error('manifest: tip snapshot blkEnd ' + s.blkEnd + ' != ' + this.chunks.totalBytes);
        continue;
      }
      const c = this.chunks.list[this.chunks.chunkOf(s.block + 1)];
      const exactStart = c.firstBlock === s.block + 1;
      if (exactStart ? s.blkEnd !== c.blkOffset : s.blkEnd <= c.blkOffset || s.blkEnd >= c.blkOffset + c.bytes) {
        throw new Error('manifest: snapshot ' + s.block + ' blkEnd ' + s.blkEnd + ' does not fall inside block ' + (s.block + 1) + "'s chunk");
      }
    }
    this.state = new LandscapeState(grid, rows);
    this.builder = new FrameBuilder(grid);
    this.maxResident = Math.max(8, Math.min(grid.tiles, Math.floor(maxResidentTiles)));
    this.topTiles = [];
    const top = grid.levels[grid.levels.length - 1];
    for (let i = 0; i < top.tilesX * top.tilesY; i++) this.topTiles.push(top.firstTile + i);
    this.desiredIds = this.topTiles.slice();
    this.dec = new DecodedBlock();
    this.dec2 = new DecodedBlock();
    this.phase = 'idle';
    this.loopPromise = this.loop();
    return { manifest, rows, blocktimes, snapshotBlocks: this.snapshotBlocks.slice(), grid };
  }

  // ------------------------------------------------------------- commands
  command(m) {
    if (this.disposed) return;
    switch (m.type) {
      case 'seek':
        if (this.seekReq) this.post({ type: 'seekDone', id: this.seekReq.id, cancelled: true });
        this.seekReq = { id: m.id, block: m.block, t0: now() };
        break;
      case 'advance':
        if (this.advanceReq) this.post({ type: 'advanceDone', id: this.advanceReq.id, cancelled: true });
        this.advanceReq = { id: m.id, target: m.target, budgetMs: Math.max(0, Number(m.budgetMs ?? 10)), t0: now() };
        break;
      case 'cell':
        this.cellReqs.push(m);
        break;
      case 'setTiles':
        this.setDesired(m.ids || []);
        break;
      case 'setMeasures': {
        const hm = m.height !== undefined ? measureCode(m.height) : this.hm;
        const cm = m.color !== undefined ? measureCode(m.color) : this.cm;
        if (hm !== this.hm || cm !== this.cm) {
          this.hm = hm;
          this.cm = cm;
          this.measureDirty = true;
        }
        break;
      }
      case 'setHeatHalfLife':
        this.state.setHalfLife(m.blocks);
        break;
      case 'setMaxResidentTiles':
        this.maxResident = Math.max(8, Math.min(this.grid.tiles, Math.floor(Number(m.n) || 225)));
        this.setDesired(this.requestedIds || []);
        break;
      case 'setChunkCacheMB':
        this.requestedCacheBytes = Math.max(16, Number(m.mb) || 512) * 1048576;
        this.fitMemory();
        break;
      case 'dispose':
        this.disposed = true;
        break;
      default:
        this.post({ type: 'error', message: 'unknown command ' + m.type });
    }
    this.kick();
  }

  setDesired(ids) {
    this.requestedIds = Array.from(ids);
    const seen = new Set();
    const list = [];
    for (const id of this.topTiles) { seen.add(id); list.push(id); }
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 0 || id >= this.grid.tiles || seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
    this.desiredIds = list.slice(0, this.maxResident);
    this.residencyDirty = true;
  }

  kick() {
    if (this.wakeResolve) {
      const r = this.wakeResolve;
      this.wakeResolve = null;
      r();
    }
  }

  idle() {
    return new Promise((r) => { this.wakeResolve = r; });
  }

  dispose() {
    this.disposed = true;
    this.kick();
  }

  // ----------------------------------------------------------------- loop
  async loop() {
    while (!this.disposed) {
      try {
        if (this.seekReq) { await this.runSeek(); continue; }
        if (this.residencyDirty) { this.applyResidency(); this.emit('tiles', { skipEmpty: true }); continue; }
        if (this.state.block === null) {
          this.rejectWithoutState();
          this.setStatus('idle');
          await this.idle();
          continue;
        }
        if (this.measureDirty) { this.runMeasures(); continue; }
        if (this.advanceReq) { await this.runAdvance(); continue; }
        if (this.cellReqs.length) { this.runCells(); continue; }
        if (await this.runTileWork()) continue;
        this.setStatus('idle');
        await this.idle();
      } catch (err) {
        this.post({ type: 'error', message: String(err && err.message || err), stack: err && err.stack });
        await this.yieldTask();
      }
    }
  }

  rejectWithoutState() {
    if (this.advanceReq) {
      const r = this.advanceReq;
      this.advanceReq = null;
      this.post({ type: 'advanceDone', id: r.id, block: null, reached: false, blocks: 0, ms: 0 });
    }
    for (const c of this.cellReqs.splice(0)) this.post({ type: 'cellResult', id: c.id, cell: null });
  }

  setStatus(phase, extra = {}, force = false) {
    const t = now();
    // Playback (advance) is not reported as busy; phase changes post immediately, progress
    // within a phase at most every 100 ms.
    if (phase === this.lastStatus.phase && (phase === 'idle' || (!force && t - this.lastStatus.t < 100))) return;
    this.phase = phase;
    this.lastStatus = { phase, t };
    const st = this.state;
    this.post({ type: 'status', status: {
      busy: phase !== 'idle',
      phase,
      block: st ? st.block : null,
      target: extra.target ?? null,
      progress: extra.progress ?? null,
      pendingTiles: this.pendingTileCount(),
      residentTiles: st ? st.residentCount : 0,
      deliveredTiles: st ? st.delivered.reduce((a, b) => a + b, 0) : 0,
      chunkCacheBytes: this.chunks ? this.chunks.usedBytes : 0,
      memoryBytes: this.memoryBytes(),
      message: extra.message ?? '',
    } });
  }

  memoryBytes() {
    let b = this.state ? this.state.memoryBytes : 0;
    if (this.chunks) b += this.chunks.usedBytes;
    if (this.group && this.group.slots) for (const s of this.group.slots.values()) b += s.memoryBytes;
    if (this.blocktimes) b += this.blocktimes.byteLength + this.rows.byteLength;
    return b;
  }

  pendingTileCount() {
    if (!this.state) return 0;
    let n = 0;
    for (const id of this.desiredIds) if (this.state.slotOf[id] === null) n++;
    return n;
  }

  // ------------------------------------------------------------ residency
  applyResidency() {
    this.residencyDirty = false;
    const st = this.state;
    const g = this.grid;
    const want = new Uint8Array(g.tiles);
    for (const id of this.desiredIds) want[id] = 1;
    let use = ++st.useCounter;
    for (let id = 0; id < g.tiles; id++) {
      st.desired[id] = want[id];
      const s = st.slotOf[id];
      if (!want[id] && st.delivered[id]) { st.delivered[id] = 0; st.evicted.push(id); }
      if (want[id] && s !== null) {
        s.lastUse = use;
        if (!st.delivered[id]) st.wantFull[id] = 1;
      }
    }
    // Evict warm (resident but not desired or pinned) tiles beyond the budget, LRU first.
    const resident = st.residentIds();
    let pinned = 0;
    for (const id of resident) if (st.pinned[id]) pinned++;
    let excess = resident.length - this.maxResident - pinned;
    if (excess > 0) {
      const warm = resident.filter((id) => !want[id] && !st.pinned[id]).sort((a, b) => st.slotOf[a].lastUse - st.slotOf[b].lastUse);
      for (const id of warm) {
        if (excess <= 0) break;
        st.detach(id);
        excess--;
      }
    }
    // A background load group for tiles nobody wants any more is dropped.
    if (this.group && !this.group.ids.some((id) => want[id] || st.pinned[id])) this.dropGroup();
    this.fitMemory();
  }

  /**
   * Keeps the worker under MEMORY_BUDGET: the chunk cache gives way to tile state
   * (each resident tile is about 2-2.6 MB), never below MIN_CHUNK_CACHE.
   */
  fitMemory() {
    const tiles = this.state.memoryBytes + (this.group && this.group.slots ? this.group.slots.size * 2.6e6 : 0);
    const pending = this.pendingTileCount() * 2.6e6;
    const room = MEMORY_BUDGET - tiles - pending - 64 * 1048576;
    this.chunks.setCacheBytes(Math.max(MIN_CHUNK_CACHE, Math.min(this.requestedCacheBytes, room)));
  }

  missingTiles() {
    const st = this.state;
    const out = [];
    const inGroup = this.group ? new Set(this.group.ids) : null;
    const t = now();
    const add = (id) => {
      if (st.slotOf[id] !== null || (inGroup && inGroup.has(id))) return;
      const retry = this.failedTiles.get(id);
      if (retry !== undefined && retry > t) return;
      out.push(id);
    };
    for (const id of this.desiredIds) add(id);
    for (const id of this.pinOrder) add(id);
    return out;
  }

  // ------------------------------------------------------------ snapshots
  async directory(snap) {
    const hit = this.dirCache.get(snap.block);
    if (hit) {
      this.dirCache.delete(snap.block);
      this.dirCache.set(snap.block, hit);
      return hit;
    }
    const prefix = await this.source.bytes(snap.file, 0, snapshotPrefixBytes(this.grid.tiles));
    const header = parseSnapshotHeader(prefix);
    checkSnapshotHeader(header, this.grid, snap.block);
    if (snap.blkEnd !== undefined && header.blkEnd !== snap.blkEnd) throw new Error(snap.file + ': blkEnd ' + header.blkEnd + ' != manifest ' + snap.blkEnd);
    const dir = parseSnapshotDirectory(prefix, this.grid.tiles, snap.bytes || null);
    const entry = { header, dir };
    this.dirCache.set(snap.block, entry);
    if (this.dirCache.size > DIR_CACHE) this.dirCache.delete(this.dirCache.keys().next().value);
    return entry;
  }

  nearestSnapshot(target) {
    const below = snapshotAtOrBelow(this.snapshotBlocks, target);
    const above = below + 1 < this.snapshots.length ? below + 1 : -1;
    if (above < 0) return below;
    const end = this.chunks.blkStart(target + 1);
    const db = end - this.snapshots[below].blkEnd;
    const da = this.snapshots[above].blkEnd - end;
    return da < db ? above : below;
  }

  /**
   * Fetches and decodes tiles from a snapshot into fresh slots.
   * @returns {Promise<Map<number, TileSlot>|null>} null when cancelled
   */
  async loadTilesFromSnapshot(snap, ids, isCancelled) {
    const t0 = now();
    const { dir } = await this.directory(snap);
    if (isCancelled()) return null;
    const slots = new Map();
    const wanted = [];
    for (const id of ids) {
      const slot = this.state.newSlot(id);
      slots.set(id, slot);
      if (dir.bytes[id] > 0) wanted.push(id);
    }
    wanted.sort((a, b) => dir.offset[a] - dir.offset[b]);
    // Coalesce nearby blobs into ranges.
    const ranges = [];
    for (const id of wanted) {
      const start = dir.offset[id];
      const end = start + dir.bytes[id];
      const last = ranges[ranges.length - 1];
      if (last && start - last.end <= RANGE_GAP && end - last.start <= RANGE_MAX) {
        last.end = Math.max(last.end, end);
        last.ids.push(id);
      } else {
        ranges.push({ start, end, ids: [id] });
      }
    }
    let next = 0;
    let lastYield = now();
    const work = async () => {
      while (next < ranges.length) {
        const r = ranges[next++];
        if (isCancelled()) return;
        const buf = await this.source.bytes(snap.file, r.start, r.end);
        for (const id of r.ids) {
          if (isCancelled()) return;
          const a = dir.offset[id] - r.start;
          const b = a + dir.bytes[id];
          const crc = crc32(buf, a, b);
          if (crc !== dir.crc[id]) throw new Error(snap.file + ': CRC mismatch for tile ' + id);
          decodeTileBlob(buf, a, b, slots.get(id).cells);
          if (now() - lastYield > YIELD_MS) { await this.yieldTask(); lastYield = now(); }
        }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(FETCH_CONCURRENCY, ranges.length); i++) workers.push(work());
    try {
      await Promise.all(workers);
    } catch (err) {
      for (const s of slots.values()) this.state.recycle(s);
      throw err;
    }
    if (isCancelled()) {
      for (const s of slots.values()) this.state.recycle(s);
      return null;
    }
    for (const s of slots.values()) { s.block = snap.block; s.dirtyAll = true; }
    if (ids.length) this.rates.loadMsPerTile = ema(this.rates.loadMsPerTile, (now() - t0) / ids.length);
    return slots;
  }

  /** Array indexed by tile id holding only the given slots. */
  slotArray(slots) {
    const arr = new Array(this.grid.tiles).fill(null);
    for (const [id, s] of slots) arr[id] = s;
    return arr;
  }

  // --------------------------------------------------------------- replay
  /**
   * Replays from block 'from' to block 'to' on the slots in slotOf (forward applies
   * blocks from+1..to, backward undoes from..to+1). Returns the block reached.
   * opts: {totals, heat (forward only), deadline, isCancelled, onProgress, counters}
   */
  async replayRange(slotOf, from, to, opts = {}) {
    const { totals = null, heat = false, deadline = Infinity, isCancelled = () => false, onProgress = null } = opts;
    const st = this.state;
    const dec = this.dec;
    let b = from;
    let lastYield = now();
    let bytes = 0;
    let blocks = 0;
    let changes = 0;
    const t0 = now();
    let lastChunk = -1;
    const total = Math.abs(to - from);
    while (b !== to) {
      const forward = to > b;
      const blk = forward ? b + 1 : b;
      let rec = this.chunks.record(blk);
      if (rec === null) {
        await this.chunks.loadBlock(blk);
        if (isCancelled()) break;
        continue;
      }
      if (rec.entry.index !== lastChunk) {
        lastChunk = rec.entry.index;
        this.chunks.readAhead(blk, forward ? 1 : -1, 2);
      }
      decodeBlock(rec.u8, rec.pos, dec);
      if (forward) {
        changes += st.apply(dec, 1, slotOf, heat ? st.heatFor(blk) : null, totals);
        b = blk;
      } else {
        changes += st.apply(dec, -1, slotOf, null, totals);
        b = blk - 1;
      }
      bytes += dec.recordBytes;
      blocks++;
      if ((blocks & 7) === 0 || dec.count > 4000) {
        const t = now();
        if (t >= deadline) break;
        if (t - lastYield >= YIELD_MS) {
          if (onProgress) onProgress(b, total ? blocks / total : 1);
          await this.yieldTask();
          lastYield = now();
          if (isCancelled()) break;
        }
      }
    }
    const ms = now() - t0;
    if (opts.counters) {
      opts.counters.blocks += blocks;
      opts.counters.changes += changes;
      opts.counters.applyMs += ms;
    }
    if (opts.rate && bytes > 262144 && ms > 1) this.rates[opts.rate] = ema(this.rates[opts.rate], bytes / ms);
    this.lastReplay = { blocks, bytes, changes, ms };
    return b;
  }

  async ensureChunk(block) {
    if (!this.chunks.hasBlock(block)) await this.chunks.loadBlock(block);
  }

  /** Updates replay meta for the state block, decoding its record if needed. */
  async updateMeta(block, decoded = null) {
    let d = decoded;
    if (!d || d.height !== block) {
      await this.ensureChunk(block);
      const rec = this.chunks.record(block);
      decodeBlock(rec.u8, rec.pos, this.dec2);
      d = this.dec2;
    }
    const t = this.state.totals;
    this.meta = {
      block,
      time: this.blocktimes[block],
      nTx: d.nTx,
      size: d.size,
      weight: d.weight,
      created: d.created,
      spent: d.spent,
      zero: d.zero,
      createdBTC: d.createdSats / 1e8,
      spentBTC: d.spentSats / 1e8,
      totals: { countSmall: t[0], countLarge: t[2], satsSmall: t[1], satsLarge: t[3] },
    };
  }

  // ----------------------------------------------------------------- seek
  async runSeek() {
    const req = this.seekReq;
    this.seekReq = null;
    const t0 = now();
    const st = this.state;
    const T = Math.max(0, Math.min(this.grid.tip, Math.floor(Number(req.block) || 0)));
    const cancelled = () => this.seekReq !== null || this.disposed;
    this.dropGroup();
    if (this.advanceReq) {
      this.post({ type: 'advanceDone', id: this.advanceReq.id, cancelled: true });
      this.advanceReq = null;
    }
    if (this.residencyDirty) this.applyResidency();
    const desired = this.desiredIds.slice();
    for (const id of this.pinOrder) if (!desired.includes(id)) desired.push(id);
    const missing = desired.filter((id) => st.slotOf[id] === null);
    let plan;
    try {
      plan = planSeek({
        target: T,
        current: st.block,
        snapshots: this.snapshots,
        blkStart: (b) => this.chunks.blkStart(b),
        applyBytesPerMs: this.rates.applyBytesPerMs ?? 15000,
        decodeBytesPerMs: this.rates.catchUpBytesPerMs ?? 60000,
        loadMsPerTile: this.rates.loadMsPerTile ?? 3,
        tilesToLoad: desired.length,
        missingTiles: missing.length,
      });
      this.setStatus('seek', { target: T, progress: 0, message: plan.kind }, true);
      const ok = plan.kind === 'current'
        ? await this.seekFromCurrent(T, missing, cancelled)
        : await this.seekFromSnapshot(T, plan, desired, cancelled);
      if (!ok) {
        this.post({ type: 'seekDone', id: req.id, cancelled: true });
        return;
      }
      await this.updateMeta(T);
      this.emit('seek');
      this.answerPendingCells();
      this.post({ type: 'seekDone', id: req.id, block: T, ms: now() - t0,
        plan: { kind: plan.kind, from: plan.from, bytes: plan.bytes } });
    } catch (err) {
      this.post({ type: 'seekDone', id: req.id, error: String(err && err.message || err) });
      this.post({ type: 'error', message: 'seek ' + T + ': ' + (err && err.message || err), stack: err && err.stack });
    }
    this.setStatus('idle', {}, true);
  }

  async seekFromCurrent(T, missing, cancelled) {
    const st = this.state;
    st.clearHeat();
    const from = st.block;
    const reached = await this.replayRange(st.slotOf, from, T, {
      totals: st.totals, isCancelled: cancelled, counters: this.counters, rate: 'applyBytesPerMs',
      onProgress: (b, p) => this.setStatus('seek', { target: T, progress: p * 0.8 }),
    });
    st.block = reached;
    if (reached !== T) return false;
    if (missing.length) {
      const ok = await this.loadAndAttach(missing, this.nearestSnapshot(T), T, cancelled, (p) => this.setStatus('seek', { target: T, progress: 0.8 + 0.2 * p }));
      if (!ok) return false;
    }
    return true;
  }

  async seekFromSnapshot(T, plan, desired, cancelled) {
    const st = this.state;
    const snap = this.snapshots[plan.snapshotIndex];
    const { header } = await this.directory(snap);
    if (cancelled()) return false;
    st.detachAll();
    const tt = header.totals;
    st.totals[0] = tt.countSmall;
    st.totals[1] = tt.satsSmall;
    st.totals[2] = tt.countLarge;
    st.totals[3] = tt.satsLarge;
    const coarse = desired.filter((id) => levelOfTile(this.grid, id) >= COARSE_LEVEL);
    const fine = desired.filter((id) => levelOfTile(this.grid, id) < COARSE_LEVEL);
    // Coarse tiles + totals.
    const slots = await this.loadTilesFromSnapshot(snap, coarse, cancelled);
    if (!slots) return false;
    const coarseSlotOf = this.slotArray(slots);
    this.setStatus('seek', { target: T, progress: 0.2 });
    const reached = await this.replayRange(coarseSlotOf, snap.block, T, {
      totals: st.totals, isCancelled: cancelled, rate: 'catchUpBytesPerMs',
      onProgress: (b, p) => this.setStatus('seek', { target: T, progress: 0.2 + 0.3 * p }),
    });
    if (reached !== T) {
      for (const s of slots.values()) st.recycle(s);
      return false;
    }
    st.block = T;
    for (const s of slots.values()) st.attach(s);
    if (!fine.length) return true;
    await this.updateMeta(T);
    this.emit('seek', { partial: true });
    return this.loadAndAttach(fine, plan.snapshotIndex, T, cancelled, (p) => this.setStatus('seek', { target: T, progress: 0.5 + 0.5 * p }));
  }

  /** Loads tiles from a snapshot, catches them up to T and attaches them (seek path). */
  async loadAndAttach(ids, snapIndex, T, cancelled, progress) {
    const st = this.state;
    const snap = this.snapshots[snapIndex];
    const slots = await this.loadTilesFromSnapshot(snap, ids, cancelled);
    if (!slots) return false;
    const reached = await this.replayRange(this.slotArray(slots), snap.block, T, {
      isCancelled: cancelled, rate: 'catchUpBytesPerMs', onProgress: (b, p) => progress && progress(p),
    });
    if (reached !== T || st.block !== T) {
      for (const s of slots.values()) st.recycle(s);
      return false;
    }
    for (const s of slots.values()) if (st.slotOf[s.id] === null) st.attach(s);
    return true;
  }

  // -------------------------------------------------------------- advance
  async runAdvance() {
    const req = this.advanceReq;
    this.advanceReq = null;
    const st = this.state;
    const t0 = now();
    const target = Math.max(0, Math.min(this.grid.tip, Math.floor(Number(req.target))));
    if (!Number.isFinite(target)) {
      this.post({ type: 'advanceDone', id: req.id, error: 'bad target ' + req.target });
      return;
    }
    const from = st.block;
    if (target === from) {
      this.post({ type: 'advanceDone', id: req.id, block: from, reached: true, blocks: 0, ms: now() - t0 });
      return;
    }
    const forward = target > from;
    if (!forward) st.clearHeat();
    let reached = from;
    try {
      // At least one block per call; then as many as fit in the budget.
      const deadline = t0 + Math.max(0, req.budgetMs);
      reached = await this.replayRange(st.slotOf, from, target, {
        totals: st.totals, heat: forward, deadline, counters: this.counters, rate: 'applyBytesPerMs',
        isCancelled: () => this.seekReq !== null || this.disposed,
      });
      if (reached === from && !this.seekReq) {
        reached = await this.replayRange(st.slotOf, from, forward ? from + 1 : from - 1, {
          totals: st.totals, heat: forward, counters: this.counters,
        });
      }
    } catch (err) {
      this.post({ type: 'advanceDone', id: req.id, error: String(err && err.message || err) });
      throw err;
    }
    st.block = reached;
    if (reached !== from) {
      await this.updateMeta(reached, forward ? this.dec : null);
      this.chunks.readAhead(reached, forward ? 1 : -1, 2);
      this.emit('advance');
    }
    this.post({ type: 'advanceDone', id: req.id, block: reached, reached: reached === target, blocks: Math.abs(reached - from), ms: now() - t0 });
  }

  // ------------------------------------------------------- tiles & cells
  async runTileWork() {
    const st = this.state;
    const g = this.group;
    if (g === null) {
      const missing = this.missingTiles();
      if (!missing.length) return false;
      // Prefer coarse tiles so holes fill quickly, then the requested priority order.
      const ids = missing.slice(0, GROUP_MAX);
      const target = st.block;
      const snapIndex = this.nearestSnapshot(target);
      const group = { seq: ++this.groupSeq, ids, snapIndex, slots: null, slotOf: null, block: -1, ready: false, error: null, cancelled: false };
      this.group = group;
      this.setStatus('tiles', { message: ids.length + ' tiles' }, true);
      const snap = this.snapshots[snapIndex];
      this.loadTilesFromSnapshot(snap, ids, () => group.cancelled || this.disposed).then((slots) => {
        if (group.cancelled || !slots) { if (slots) for (const s of slots.values()) st.recycle(s); return; }
        group.slots = slots;
        group.slotOf = this.slotArray(slots);
        group.block = snap.block;
        group.ready = true;
        this.kick();
      }, (err) => {
        group.error = err;
        this.kick();
      });
      return true;
    }
    if (g.error) {
      const t = now();
      for (const id of g.ids) this.failedTiles.set(id, t + 5000);
      this.group = null;
      this.post({ type: 'error', message: 'tile load failed: ' + (g.error.message || g.error) });
      return true;
    }
    if (!g.ready) return false; // fetch in flight; wait for a kick
    const reached = await this.replayRange(g.slotOf, g.block, st.block, {
      deadline: now() + SLICE_MS, rate: 'catchUpBytesPerMs',
      isCancelled: () => this.seekReq !== null || this.advanceReq !== null || this.disposed || g.cancelled,
    });
    g.block = reached;
    if (g.cancelled) return true;
    if (reached === st.block) {
      this.group = null;
      for (const s of g.slots.values()) {
        if (st.slotOf[s.id] === null) st.attach(s);
        else st.recycle(s);
      }
      this.applyResidency();
      this.answerPendingCells();
      this.emit('tiles', { skipEmpty: true });
    }
    return true;
  }

  dropGroup() {
    const g = this.group;
    if (!g) return;
    g.cancelled = true;
    if (g.slots) for (const s of g.slots.values()) this.state.recycle(s);
    this.group = null;
  }

  runCells() {
    const st = this.state;
    for (const req of this.cellReqs.splice(0)) {
      const level = Number(req.level);
      const col = Number(req.col);
      const row = Number(req.row);
      const tile = Number.isInteger(level) && level >= 0 && level < this.grid.levels.length ? tileOfCell(this.grid, level, col, row) : -1;
      if (tile < 0) { this.post({ type: 'cellResult', id: req.id, cell: null }); continue; }
      if (st.slotOf[tile] !== null) {
        this.post({ type: 'cellResult', id: req.id, cell: { ...st.cellAt(level, col, row), block: st.block } });
        continue;
      }
      if (req.load === false) { this.post({ type: 'cellResult', id: req.id, cell: null }); continue; }
      if (!st.pinned[tile]) {
        st.pinned[tile] = 1;
        this.pinOrder.push(tile);
        while (this.pinOrder.length > MAX_PINNED) {
          const old = this.pinOrder.shift();
          st.pinned[old] = 0;
        }
      }
      this.pendingCells.push({ id: req.id, level, col, row, tile });
    }
  }

  answerPendingCells() {
    const st = this.state;
    const keep = [];
    for (const c of this.pendingCells) {
      if (st.slotOf[c.tile] !== null && st.block !== null) {
        this.post({ type: 'cellResult', id: c.id, cell: { ...st.cellAt(c.level, c.col, c.row), block: st.block } });
      } else if (!st.pinned[c.tile]) {
        this.post({ type: 'cellResult', id: c.id, cell: null });
      } else {
        keep.push(c);
      }
    }
    this.pendingCells = keep;
  }

  runMeasures() {
    this.measureDirty = false;
    const st = this.state;
    for (let id = 0; id < this.grid.tiles; id++) if (st.delivered[id] && st.slotOf[id] !== null) st.wantFull[id] = 1;
    this.emit('measure', { skipEmpty: true });
  }

  // ---------------------------------------------------------------- frames
  emit(reason, { partial = false, skipEmpty = false } = {}) {
    const st = this.state;
    const t0 = now();
    const { frame, transfer, deltaCells } = this.builder.build(st, this.hm, this.cm, reason, st.block, partial);
    if (skipEmpty && !frame.full.length && !frame.evicted.length && deltaCells === 0) {
      this.builder.seq--;
      return null;
    }
    const c = this.counters;
    const packMs = now() - t0;
    frame.stats = {
      blocksApplied: c.blocks,
      changesApplied: c.changes,
      ms: c.applyMs + packMs,
      applyMs: c.applyMs,
      packMs,
      blocksPerSecond: c.applyMs > 0 ? (c.blocks * 1000) / c.applyMs : 0,
      residentTiles: st.residentCount,
      deliveredTiles: st.delivered.reduce((a, b) => a + b, 0),
      pendingTiles: this.pendingTileCount(),
      deltaCells,
      fullTiles: frame.full.length,
      chunkCacheBytes: this.chunks.usedBytes,
      memoryBytes: this.memoryBytes(),
    };
    frame.meta = this.meta;
    this.counters = { blocks: 0, changes: 0, applyMs: 0, workMs: 0 };
    this.post({ type: 'frame', frame }, transfer);
    return frame;
  }
}
