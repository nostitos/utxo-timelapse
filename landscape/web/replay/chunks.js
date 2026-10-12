// Chunk table, LRU cache of chunk bytes and per-block record access (SPEC §4, §5).
// It also meters delivery (bytes per second of wall time with a fetch in flight, including
// verification and indexing) and reports how far ahead of a block the cached run of chunks
// reaches, which playback uses to pace itself to the download (ui/playback.js).
// Pure ES module.
import { indexRecords } from './blk2.js';

export const MAX_PARALLEL = 3;        // background read-ahead fetches in flight
const RATE_WINDOW_MS = 3000;          // delivery rate over about this much busy time

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ChunkStore {
  /**
   * @param source data source ({bytes(path)})
   * @param table parsed chunks.json
   * @param numBlocks manifest.numBlocks
   * @param opts {cacheBytes, verify} verify = check each chunk's SHA-256 on load
   */
  constructor(source, table, numBlocks, { cacheBytes = 512 * 1048576, verify = true } = {}) {
    if (!table || table.format !== 'utxo-landscape-chunks-1' || !Array.isArray(table.chunks)) {
      throw new Error('chunks.json: unexpected format');
    }
    const list = table.chunks;
    let block = 0;
    let off = 0;
    list.forEach((c, i) => {
      if (c.index !== i) throw new Error('chunks.json: chunk ' + i + ' has index ' + c.index);
      if (c.firstBlock !== block) throw new Error('chunks.json: chunk ' + i + ' starts at block ' + c.firstBlock + ', expected ' + block);
      if (c.lastBlock < c.firstBlock) throw new Error('chunks.json: chunk ' + i + ' is empty');
      if (c.blkOffset !== off) throw new Error('chunks.json: chunk ' + i + ' blkOffset ' + c.blkOffset + ', expected ' + off);
      block = c.lastBlock + 1;
      off += c.bytes;
    });
    if (block !== numBlocks) throw new Error('chunks.json covers ' + block + ' blocks, manifest has ' + numBlocks);
    this.source = source;
    this.list = list;
    this.firstBlocks = Int32Array.from(list, (c) => c.firstBlock);
    this.totalBytes = off;
    this.numBlocks = numBlocks;
    this.cacheBytes = cacheBytes;
    this.verify = verify;
    this.cache = new Map();      // index -> {u8, offsets, firstBlock, lastBlock, lastUse}
    this.inflight = new Map();   // index -> Promise
    this.usedBytes = 0;
    this.useCounter = 0;
    this.loads = 0;
    this.loadMs = 0;
    this.loadedBytes = 0;
    this.ahead = null;           // read-ahead window {index, direction, count}
    this.busyMs = 0;             // wall time with at least one fetch in flight
    this.busyStart = null;
    this.rateSamples = [[0, 0]]; // [busy ms, loaded bytes] at each completed fetch
    this.bytesPerSec = null;     // delivery rate while fetching
    this.onLoad = null;          // called after each chunk is cached
  }

  /** Chunk index holding a block. */
  chunkOf(block) {
    const f = this.firstBlocks;
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (f[mid] <= block) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  has(index) { return this.cache.has(index); }
  hasBlock(block) { return this.cache.has(this.chunkOf(block)); }

  /** Source BLK offset of the start of 'block' (block = numBlocks gives the end). Exact when cached. */
  blkStart(block) {
    if (block >= this.numBlocks) return this.totalBytes;
    if (block <= 0) return 0;
    const i = this.chunkOf(block);
    const c = this.list[i];
    const e = this.cache.get(i);
    if (e) return c.blkOffset + e.offsets[block - c.firstBlock];
    const span = c.lastBlock - c.firstBlock + 1;
    return c.blkOffset + Math.round((c.bytes * (block - c.firstBlock)) / span);
  }

  /** Loads (or returns the cached) chunk entry; concurrent calls share one fetch. */
  load(index, { signal } = {}) {
    const hit = this.cache.get(index);
    if (hit) { hit.lastUse = ++this.useCounter; return Promise.resolve(hit); }
    let p = this.inflight.get(index);
    if (p) return p;
    p = this.fetchChunk(index, signal).finally(() => {
      this.inflight.delete(index);
      if (!this.inflight.size && this.busyStart !== null) {
        this.busyMs += performance.now() - this.busyStart;
        this.busyStart = null;
      }
      this.pump();
    });
    this.inflight.set(index, p);
    if (this.inflight.size === 1) this.busyStart = performance.now();
    return p;
  }

  loadBlock(block, opts) { return this.load(this.chunkOf(block), opts); }

  async fetchChunk(index, signal) {
    const c = this.list[index];
    const t0 = performance.now();
    const u8 = await this.source.bytes(c.file, undefined, undefined, { signal });
    if (u8.byteLength !== c.bytes) throw new Error(c.file + ': ' + u8.byteLength + ' bytes, chunks.json says ' + c.bytes);
    if (this.verify && c.sha256 && globalThis.crypto && crypto.subtle) {
      const digest = hex(await crypto.subtle.digest('SHA-256', u8));
      if (digest !== c.sha256) throw new Error(c.file + ': SHA-256 mismatch');
    }
    const idx = indexRecords(u8, c.firstBlock);
    if (idx.lastBlock !== c.lastBlock) throw new Error(c.file + ': ends at block ' + idx.lastBlock + ', expected ' + c.lastBlock);
    const entry = { index, u8, offsets: idx.offsets, firstBlock: c.firstBlock, lastBlock: c.lastBlock, lastUse: ++this.useCounter };
    this.cache.set(index, entry);
    this.usedBytes += u8.byteLength;
    this.loads++;
    this.loadedBytes += u8.byteLength;
    this.loadMs += performance.now() - t0;
    this.trim(index);
    this.sampleRate();
    if (this.onLoad) this.onLoad(entry);
    return entry;
  }

  /** Busy time so far, including the current stretch with fetches in flight. */
  busyClock() {
    return this.busyMs + (this.busyStart !== null ? performance.now() - this.busyStart : 0);
  }

  sampleRate() {
    const t = this.busyClock();
    const s = this.rateSamples;
    s.push([t, this.loadedBytes]);
    while (s.length > 2 && t - s[1][0] >= RATE_WINDOW_MS) s.shift();
    const [t0, b0] = s[0];
    if (t - t0 > 20) this.bytesPerSec = ((this.loadedBytes - b0) * 1000) / (t - t0);
  }

  /**
   * Last block of the run of cached chunks that follows 'block' (forward), or 'block' itself
   * when the next block's chunk is not cached.
   */
  frontier(block) {
    if (block >= this.numBlocks - 1) return this.numBlocks - 1;
    let i = this.chunkOf(Math.max(0, block + 1));
    if (!this.cache.has(i)) return block;
    while (i + 1 < this.list.length && this.cache.has(i + 1)) i++;
    return this.list[i].lastBlock;
  }

  /**
   * Blocks a second the download delivers for the chunks after 'block', from the metered
   * bytes a second and those chunks' sizes. null before the first fetch; Infinity at the end.
   */
  deliveryRate(block, count = 4) {
    if (block >= this.numBlocks - 1) return Infinity;
    if (!(this.bytesPerSec > 0)) return null;
    const start = this.chunkOf(block + 1);
    let bytes = 0;
    let blocks = 0;
    for (let i = start; i < Math.min(this.list.length, start + count); i++) {
      bytes += this.list[i].bytes;
      blocks += this.list[i].lastBlock - this.list[i].firstBlock + 1;
    }
    return bytes > 0 ? (this.bytesPerSec * blocks) / bytes : Infinity;
  }

  /** Evicts least recently used chunks above the budget, never 'keep'. */
  trim(keep = -1) {
    if (this.usedBytes <= this.cacheBytes) return;
    const entries = [...this.cache.values()].sort((a, b) => a.lastUse - b.lastUse);
    for (const e of entries) {
      if (this.usedBytes <= this.cacheBytes) break;
      if (e.index === keep) continue;
      this.cache.delete(e.index);
      this.usedBytes -= e.u8.byteLength;
    }
  }

  setCacheBytes(n) { this.cacheBytes = n; this.trim(); }

  /** Synchronous record access: {u8, pos} for a cached block, else null. */
  record(block) {
    const i = this.chunkOf(block);
    const e = this.cache.get(i);
    if (!e) return null;
    e.lastUse = ++this.useCounter;
    return { u8: e.u8, pos: e.offsets[block - e.firstBlock], entry: e };
  }

  /** Starts loading a chunk in the background (errors are ignored; a later load retries). */
  prefetch(index) {
    if (index < 0 || index >= this.list.length || this.cache.has(index) || this.inflight.has(index)) return;
    this.load(index).catch(() => {});
  }

  /**
   * Read-ahead: keeps the 'count' chunks after the block's chunk loading in the playback
   * direction, at most MAX_PARALLEL at a time; each completed fetch starts the next.
   */
  readAhead(block, direction, count = 2) {
    const i = this.chunkOf(Math.max(0, Math.min(this.numBlocks - 1, block)));
    this.ahead = { index: i, direction, count };
    this.pump();
  }

  pump() {
    const a = this.ahead;
    if (!a) return;
    for (let k = 1; k <= a.count && this.inflight.size < MAX_PARALLEL; k++) this.prefetch(a.index + a.direction * k);
  }
}
