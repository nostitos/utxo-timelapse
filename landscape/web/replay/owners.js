// Owner layer for the landscape replay (landscape/SPEC.md §4 owner files, §5 owners).
// Pure ES module: no three.js, no DOM. It parses owner record files and keeps, for the
// replayed block, which cells hold outputs paying known addresses of each entity.
//
// Record file (long.bin, short/NNNN.bin): "BUVOWN1\0", u32 version 1, u32 record count, then
// one record after another, sorted by creation height: varuint created delta (from the
// previous record, the first from 0), varuint life (0 = unspent at the owner tip, else
// spent - created), varuint sats, varuint entity index. Varuints are unsigned LEB128.
//
// long.bin holds the records unspent at the owner tip or alive longer than shortLife blocks;
// short/NNNN.bin the others, by creation block (chunk k: created in [k * shortLife, (k + 1) *
// shortLife)). An output in a short chunk can only be alive at block b if it was created in
// (b - shortLife, b], so a block needs long.bin and at most two chunks.
import { tileOfCell } from '../data/grid.js';
import { rowOfAmount } from '../data/axis.js';

export const OWNER_MAGIC = Object.freeze([0x42, 0x55, 0x56, 0x4f, 0x57, 0x4e, 0x31, 0x00]); // "BUVOWN1\0"
export const OWNER_HEADER_BYTES = 16;
export const UNSPENT = 0xffffffff;          // spent height of an output unspent at the owner tip
export const MAX_ENTITIES = 254;            // owner word codes 1..254; 255 marks several entities
export const OWNER_FORMAT = 'utxo-landscape-owners-1';
export const SEVERAL = 255;                 // owner word code of a cell held by several visible entities
export const OWNER_COUNT_MAX = 0xffffff;    // owned count bits of an owner word
const MAX_SATS = 2100000000000000;
const ROW_KEY = 4096;                       // cell key = col * ROW_KEY + row (rows < 4096)
const MAX_CHUNKS = 16;                      // short chunks kept loaded

/**
 * Parses one record file. Returns {count, created: Uint32Array, spent: Uint32Array (UNSPENT
 * when unspent at the owner tip), sats: Float64Array (exact integers), entity: Uint8Array},
 * in file order. Throws on any malformed byte.
 */
export function parseOwnerRecords(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < OWNER_HEADER_BYTES) throw new Error('owner records: file too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== OWNER_MAGIC[i]) throw new Error('owner records: bad magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  if (version !== 1) throw new Error('owner records: unsupported version ' + version);
  const count = view.getUint32(12, true);
  if (count > bytes.length - OWNER_HEADER_BYTES) throw new Error('owner records: count exceeds file size');
  const created = new Uint32Array(count);
  const spent = new Uint32Array(count);
  const sats = new Float64Array(count);
  const entity = new Uint8Array(count);
  let p = OWNER_HEADER_BYTES;
  // Number arithmetic, never 32-bit bitwise ops: sats exceed 2^32.
  const read = () => {
    let value = 0;
    let scale = 1;
    for (let n = 0; n < 8; n++) {
      if (p >= bytes.length) throw new Error('owner records: truncated record');
      const b = bytes[p++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 128;
    }
    throw new Error('owner records: varuint too long');
  };
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const c = prev + read();
    const life = read();
    const s = read();
    const e = read();
    if (c >= UNSPENT || (life > 0 && c + life >= UNSPENT)) throw new Error('owner records: height out of range');
    if (!(s >= 1 && s <= MAX_SATS)) throw new Error('owner records: amount out of range');
    if (e >= MAX_ENTITIES) throw new Error('owner records: entity index out of range');
    created[i] = c;
    spent[i] = life === 0 ? UNSPENT : c + life;
    sats[i] = s;
    entity[i] = e;
    prev = c;
  }
  if (p !== bytes.length) throw new Error('owner records: trailing bytes');
  return { count, created, spent, sats, entity };
}

/**
 * Owner word of a cell: the count of outputs held by visible entities in bits 0-23 (capped),
 * and in bits 24-31 the code: 0 none, entity index + 1 for one visible entity, SEVERAL for more.
 * entry = [count per entity..., sats per entity...].
 */
export function ownerWord(entry, visible) {
  const E = visible.length;
  let owned = 0;
  let code = 0;
  for (let e = 0; e < E; e++) {
    const n = entry[e];
    if (n > 0 && visible[e]) {
      owned += n;
      code = code === 0 ? e + 1 : SEVERAL;
    }
  }
  return owned === 0 ? 0 : code * 16777216 + Math.min(owned, OWNER_COUNT_MAX);
}

/** Short chunks whose outputs can be alive at some block of [a, b] (either order): {from, to}. */
export function chunkRange(a, b, life) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { from: Math.max(0, Math.floor((lo - life + 1) / life)), to: Math.floor(hi / life) };
}

/** Validates owners.json; returns it. */
export function checkOwnerManifest(m) {
  if (!m || m.format !== OWNER_FORMAT) throw new Error('owners.json: unexpected format ' + (m && m.format));
  if (!/^o\d{1,7}-\d{8}$/.test(String(m.id))) throw new Error('owners.json: bad id ' + m.id);
  if (!Number.isInteger(m.tip) || m.tip < 0) throw new Error('owners.json: bad tip');
  if (!Number.isInteger(m.shortLife) || m.shortLife < 1) throw new Error('owners.json: bad shortLife');
  const entities = m.entities;
  if (!Array.isArray(entities) || !entities.length || entities.length > MAX_ENTITIES) throw new Error('owners.json: bad entity list');
  for (const e of entities) {
    if (!/^[a-z0-9-]{1,32}$/.test(String(e.id))) throw new Error('owners.json: bad entity id ' + e.id);
    if (!/^#[0-9a-fA-F]{6}$/.test(String(e.color))) throw new Error('owners.json: bad colour for ' + e.id);
  }
  const files = m.files;
  if (!files || !files.long || !Array.isArray(files.short)) throw new Error('owners.json: missing file list');
  return m;
}

function upperCreated(created, n, v) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (created[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperSpent(spent, order, v) {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spent[order[mid]] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Parsed records plus their L0 cells and a spend-ordered index. */
export function recordSet(buffer, grid, minAmt, entities) {
  const r = parseOwnerRecords(buffer);
  const c0 = new Uint32Array(r.count);
  const r0 = new Uint16Array(r.count);
  for (let i = 0; i < r.count; i++) {
    if (r.entity[i] >= entities) throw new Error('owner records: entity ' + r.entity[i] + ' is not in owners.json');
    c0[i] = Math.floor(r.created[i] / grid.blocksPerColumn);
    r0[i] = rowOfAmount(minAmt, r.sats[i]);
  }
  const bySpent = new Uint32Array(r.count);
  for (let i = 0; i < r.count; i++) bySpent[i] = i;
  bySpent.sort((a, b) => r.spent[a] - r.spent[b]);
  return { ...r, c0, r0, bySpent, bytes: r.count * 27 };
}

/**
 * Which cells hold outputs of each owner entity at one block, per level, exact.
 * fetchFile(entry) → Promise<ArrayBuffer> of a verified file named in owners.json.
 * The caller loads what a block needs (ensure) before moving there (moveTo).
 */
export class OwnerLedger {
  constructor({ grid, minAmt, manifest, fetchFile }) {
    checkOwnerManifest(manifest);
    this.grid = grid;
    this.minAmt = minAmt;
    this.manifest = manifest;
    this.fetchFile = fetchFile;
    this.E = manifest.entities.length;
    this.tip = manifest.tip;
    this.life = manifest.shortLife;
    this.chunkFiles = new Map(manifest.files.short.map((f) => [f.chunk, f]));
    this.long = null;
    this.chunks = new Map();     // chunk -> record set
    this.loading = new Map();    // 'long' | chunk -> Promise
    this.visible = new Uint8Array(this.E);
    this.cells = grid.levels.map(() => new Map());  // per level: cell key -> Float64Array(2E)
    this.tiles = grid.levels.map(() => new Map());  // per level: tile id -> Set of cell keys
    this.totals = new Float64Array(2 * this.E);
    this.block = null;           // block the maps describe; null before the first move
  }

  setVisible(indices) {
    this.visible.fill(0);
    for (const e of indices) if (Number.isInteger(e) && e >= 0 && e < this.E) this.visible[e] = 1;
  }

  // ------------------------------------------------------------------ files
  neededChunks(a, b = a) {
    const { from, to } = chunkRange(a, b, this.life);
    const out = [];
    for (let k = from; k <= to; k++) if (this.chunkFiles.has(k)) out.push(k);
    return out;
  }

  /** True when everything blocks a..b need is loaded. */
  ready(a, b = a) {
    return this.long !== null && this.neededChunks(a, b).every((k) => this.chunks.has(k));
  }

  #load(key) {
    let p = this.loading.get(key);
    if (p) return p;
    const entry = key === 'long' ? this.manifest.files.long : this.chunkFiles.get(key);
    p = this.fetchFile(entry).then((buf) => {
      const set = recordSet(buf, this.grid, this.minAmt, this.E);
      if (set.count !== entry.records) throw new Error(entry.file + ': ' + set.count + ' records, owners.json says ' + entry.records);
      if (key === 'long') this.long = set;
      else this.chunks.set(key, set);
      return set;
    }).finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  /** Loads what blocks a..b need. */
  async ensure(a, b = a) {
    const jobs = [];
    if (this.long === null) jobs.push(this.#load('long'));
    for (const k of this.neededChunks(a, b)) if (!this.chunks.has(k)) jobs.push(this.#load(k));
    if (jobs.length) await Promise.all(jobs);
    this.#trim(a, b);
  }

  /** Starts loading what blocks a..b need, without waiting. */
  prefetch(a, b = a) {
    this.ensure(a, b).catch(() => {});
  }

  // Drops chunks no block near the current one needs (they hold no output alive there).
  #trim(a, b) {
    if (this.chunks.size <= MAX_CHUNKS) return;
    const keep = new Set([...this.neededChunks(a, b), ...(this.block === null ? [] : this.neededChunks(this.block))]);
    const centre = this.block ?? a;
    const drop = [...this.chunks.keys()].filter((k) => !keep.has(k))
      .sort((x, y) => Math.abs(y * this.life - centre) - Math.abs(x * this.life - centre));
    for (const k of drop) {
      if (this.chunks.size <= MAX_CHUNKS) break;
      this.chunks.delete(k);
    }
  }

  // ---------------------------------------------------------------- state
  /** Moves the maps to block b; ready(previous block, b) must hold. */
  moveTo(b) {
    if (b === this.block) return;
    if (b > this.tip) {
      this.#clear();
      this.block = b;
      return;
    }
    const a = this.block;
    if (a === null || a > this.tip || Math.abs(b - a) > this.life || !this.ready(a, b)) {
      if (!this.ready(b)) throw new Error('owner data for block ' + b + ' is not loaded');
      this.#rebuild(b);
    } else {
      for (const set of this.#sets(a, b)) this.#step(set, a, b);
    }
    this.block = b;
  }

  #sets(a, b) {
    const out = [this.long];
    for (const k of this.neededChunks(a, b)) out.push(this.chunks.get(k));
    return out;
  }

  #clear() {
    for (const m of this.cells) m.clear();
    for (const m of this.tiles) m.clear();
    this.totals.fill(0);
  }

  #rebuild(b) {
    this.#clear();
    for (const set of this.#sets(b, b)) {
      const hi = upperCreated(set.created, set.count, b);
      for (let i = 0; i < hi; i++) if (set.spent[i] > b) this.#add(set, i, 1);
    }
  }

  // Applies the creations and spends of blocks a+1..b (forward) or undoes b+1..a (backward).
  #step(set, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const c0 = upperCreated(set.created, set.count, lo);
    const c1 = upperCreated(set.created, set.count, hi);
    const s0 = upperSpent(set.spent, set.bySpent, lo);
    const s1 = upperSpent(set.spent, set.bySpent, hi);
    if (b > a) {
      for (let i = c0; i < c1; i++) if (set.spent[i] > b) this.#add(set, i, 1);
      for (let j = s0; j < s1; j++) {
        const i = set.bySpent[j];
        if (set.created[i] <= a) this.#add(set, i, -1);
      }
    } else {
      for (let i = c0; i < c1; i++) if (set.spent[i] > a) this.#add(set, i, -1);
      for (let j = s0; j < s1; j++) {
        const i = set.bySpent[j];
        if (set.created[i] <= b) this.#add(set, i, 1);
      }
    }
  }

  #add(set, i, sign) {
    const E = this.E;
    const e = set.entity[i];
    const s = set.sats[i] * sign;
    this.totals[e] += sign;
    this.totals[E + e] += s;
    const levels = this.grid.levels;
    for (let l = 0; l < levels.length; l++) {
      const L = levels[l];
      const col = set.c0[i] >>> L.columnShift;
      const row = set.r0[i] >>> L.rowShift;
      const tile = tileOfCell(this.grid, l, col, row);
      if (tile < 0) continue; // created after this dataset's tip
      const key = col * ROW_KEY + row;
      const cells = this.cells[l];
      let entry = cells.get(key);
      if (entry === undefined) {
        if (sign < 0) throw new Error('owner ledger: removing an output that was never added (cell ' + l + '/' + col + '/' + row + ')');
        entry = new Float64Array(2 * E);
        cells.set(key, entry);
        let keys = this.tiles[l].get(tile);
        if (keys === undefined) this.tiles[l].set(tile, (keys = new Set()));
        keys.add(key);
      }
      entry[e] += sign;
      entry[E + e] += s;
      if (sign < 0 && entry[e] === 0) {
        let empty = true;
        for (let k = 0; k < E; k++) if (entry[k] !== 0) { empty = false; break; }
        if (empty) {
          cells.delete(key);
          const keys = this.tiles[l].get(tile);
          keys.delete(key);
          if (!keys.size) this.tiles[l].delete(tile);
        }
      }
    }
  }

  // ---------------------------------------------------------------- reads
  /** Owner word of a cell at the current block (0 when none). */
  word(level, col, row) {
    const entry = this.cells[level].get(col * ROW_KEY + row);
    return entry === undefined ? 0 : ownerWord(entry, this.visible);
  }

  /** Calls fn(col, row, word) for each cell of a tile holding visible owned outputs. */
  forEachInTile(level, tile, fn) {
    const keys = this.tiles[level].get(tile);
    if (keys === undefined) return;
    const cells = this.cells[level];
    for (const key of keys) {
      const w = ownerWord(cells.get(key), this.visible);
      if (w !== 0) fn(Math.floor(key / ROW_KEY), key % ROW_KEY, w);
    }
  }

  /** Outputs per entity in a cell at the current block: [{entity, count, sats}] (count > 0). */
  cell(level, col, row) {
    const entry = this.cells[level] && this.cells[level].get(col * ROW_KEY + row);
    const out = [];
    if (entry === undefined) return out;
    for (let e = 0; e < this.E; e++) if (entry[e] > 0) out.push({ entity: e, count: entry[e], sats: entry[this.E + e] });
    return out;
  }

  /** Summary for frame meta at the current block. */
  meta() {
    const active = this.block !== null && this.block <= this.tip;
    const entities = [];
    for (let e = 0; e < this.E; e++) entities.push({ count: this.totals[e], sats: this.totals[this.E + e] });
    return { tip: this.tip, active, block: this.block, entities };
  }

  get memoryBytes() {
    let b = this.long ? this.long.bytes : 0;
    for (const s of this.chunks.values()) b += s.bytes;
    for (const m of this.cells) b += m.size * (48 + 16 * this.E);
    return b;
  }
}
