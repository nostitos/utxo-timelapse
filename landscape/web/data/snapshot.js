// BUVLSN1 snapshot reader (landscape/SPEC.md §4) plus a writer used by tests and
// synthetic datasets. Pure ES module (uses crypto.subtle only in the async writer).
//
// A snapshot describes its own grid, gridFromManifest({numBlocks: block + 1}), so a
// block's file is the same in every dataset that contains it. Older files record
// their dataset's numBlocks instead; readers accept any numBlocks in
// [block + 1, dataset numBlocks] and map tiles by (level, tx, ty).
//
// Cell layout used by the replay state (4 float64 per cell, AoS):
//   [countSmall, satsSmall, countLarge, satsLarge]
// Small = 1..500000000 sat (exactly 5 BTC is small), large = above.

import { gridFromManifest, tileInfo, tileId, TILE } from './grid.js';

export const LSN_MAGIC = 'BUVLSN1\0';
export const LSN_HEADER_BYTES = 128;
export const LSN_DIR_ENTRY_BYTES = 16;
export const CELL_STRIDE = 4;
export const CS = 0;
export const SS = 1;
export const CL = 2;
export const SL = 3;
const TILE_CELLS = 65536;

function u64(dv, off) {
  const lo = dv.getUint32(off, true);
  const hi = dv.getUint32(off + 4, true);
  if (hi >= 0x200000) throw new RangeError('BUVLSN1: 64-bit value exceeds 2^53 at ' + off);
  return hi * 4294967296 + lo;
}
function i64(dv, off) {
  const v = dv.getBigInt64(off, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('BUVLSN1: i64 out of range at ' + off);
  return Number(v);
}
function viewOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

/** Bytes needed for the header plus the directory of a snapshot with 'tiles' tiles. */
export function snapshotPrefixBytes(tiles) {
  return LSN_HEADER_BYTES + tiles * LSN_DIR_ENTRY_BYTES;
}

/** Parses the 128-byte header. */
export function parseSnapshotHeader(u8) {
  if (u8.byteLength < LSN_HEADER_BYTES) throw new Error('BUVLSN1: header truncated');
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== LSN_MAGIC.charCodeAt(i)) throw new Error('BUVLSN1: bad magic');
  }
  const dv = viewOf(u8);
  const h = {
    version: dv.getUint32(8, true),
    headerBytes: dv.getUint32(12, true),
    block: dv.getUint32(16, true),
    numBlocks: dv.getUint32(20, true),
    levels: dv.getUint32(24, true),
    tileSize: dv.getUint32(28, true),
    rows: dv.getUint32(32, true),
    l0Columns: dv.getUint32(36, true),
    blocksPerColumn: dv.getUint32(40, true),
    tiles: dv.getUint32(44, true),
    blkEnd: u64(dv, 48),
    totals: { countSmall: i64(dv, 56), countLarge: i64(dv, 64), satsSmall: i64(dv, 72), satsLarge: i64(dv, 80) },
    sha256: Array.from(u8.subarray(88, 120), (b) => b.toString(16).padStart(2, '0')).join(''),
  };
  if (h.version !== 1 || h.headerBytes !== LSN_HEADER_BYTES) throw new Error('BUVLSN1: unsupported version ' + h.version + '/' + h.headerBytes);
  return h;
}

/**
 * Checks a header against the dataset grid and returns the snapshot's own grid;
 * throws on any mismatch.
 */
export function checkSnapshotHeader(h, grid, expectBlock = null) {
  const want = { levels: grid.levels.length, tileSize: grid.tileSize, rows: grid.rows, blocksPerColumn: grid.blocksPerColumn };
  for (const k of Object.keys(want)) {
    if (h[k] !== want[k]) throw new Error('BUVLSN1: header ' + k + ' ' + h[k] + ' != ' + want[k]);
  }
  if (!(h.block < h.numBlocks && h.numBlocks <= grid.numBlocks)) {
    throw new Error('BUVLSN1: snapshot block ' + h.block + ' with grid of ' + h.numBlocks + ' blocks is outside the dataset\'s ' + grid.numBlocks);
  }
  const own = gridFromManifest({ numBlocks: h.numBlocks });
  if (h.l0Columns !== own.l0Columns || h.tiles !== own.tiles) {
    throw new Error('BUVLSN1: header l0Columns/tiles ' + h.l0Columns + '/' + h.tiles + ' != ' + own.l0Columns + '/' + own.tiles + ' for ' + h.numBlocks + ' blocks');
  }
  if (expectBlock !== null && h.block !== expectBlock) throw new Error('BUVLSN1: snapshot block ' + h.block + ' != ' + expectBlock);
  return own;
}

/** Parses the directory that follows the header: {offset: Float64Array, bytes: Uint32Array, crc: Uint32Array}. */
export function parseSnapshotDirectory(u8, tiles, fileBytes = null) {
  const need = snapshotPrefixBytes(tiles);
  if (u8.byteLength < need) throw new Error('BUVLSN1: directory truncated');
  const dv = viewOf(u8);
  const offset = new Float64Array(tiles);
  const bytes = new Uint32Array(tiles);
  const crc = new Uint32Array(tiles);
  for (let t = 0; t < tiles; t++) {
    const o = LSN_HEADER_BYTES + t * LSN_DIR_ENTRY_BYTES;
    offset[t] = u64(dv, o);
    bytes[t] = dv.getUint32(o + 8, true);
    crc[t] = dv.getUint32(o + 12, true);
    if (bytes[t] === 0) {
      if (offset[t] !== 0 || crc[t] !== 0) throw new Error('BUVLSN1: empty tile ' + t + ' has offset/crc');
    } else {
      if (offset[t] < need) throw new Error('BUVLSN1: tile ' + t + ' blob overlaps the directory');
      if (fileBytes !== null && offset[t] + bytes[t] > fileBytes) throw new Error('BUVLSN1: tile ' + t + ' blob past end of file');
    }
  }
  return { offset, bytes, crc };
}

/** Re-indexes a directory of the snapshot's own grid by dataset tile id (absent tiles are empty). */
export function datasetDirectory(dir, own, grid) {
  if (own.tiles === grid.tiles && own.l0Columns === grid.l0Columns) return dir;
  const offset = new Float64Array(grid.tiles);
  const bytes = new Uint32Array(grid.tiles);
  const crc = new Uint32Array(grid.tiles);
  for (let s = 0; s < own.tiles; s++) {
    if (dir.bytes[s] === 0) continue;
    const t = tileInfo(own, s);
    const id = tileId(grid, t.level, t.tx, t.ty);
    if (id < 0) throw new Error('BUVLSN1: tile ' + s + ' lies outside the dataset grid');
    offset[id] = dir.offset[s];
    bytes[id] = dir.bytes[s];
    crc[id] = dir.crc[s];
  }
  return { offset, bytes, crc };
}

/**
 * Header and directory from the start of a snapshot file, the directory indexed by
 * dataset tile id. 'prefix' must hold at least the snapshot's own header and
 * directory; snapshotPrefixBytes(grid.tiles) bytes (or the whole file) always do.
 * @returns {{header: object, own: object, dir: {offset: Float64Array, bytes: Uint32Array, crc: Uint32Array}}}
 */
export function readSnapshotDirectory(prefix, grid, expectBlock = null, fileBytes = null) {
  const header = parseSnapshotHeader(prefix);
  const own = checkSnapshotHeader(header, grid, expectBlock);
  const dir = parseSnapshotDirectory(prefix, own.tiles, fileBytes);
  return { header, own, dir: datasetDirectory(dir, own, grid) };
}

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  // Slicing-by-4 tables for IEEE CRC-32 (reflected, polynomial 0xEDB88320).
  const t = new Uint32Array(4 * 256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    t[256 + i] = (t[t[i] & 255] ^ (t[i] >>> 8)) >>> 0;
    t[512 + i] = (t[t[256 + i] & 255] ^ (t[256 + i] >>> 8)) >>> 0;
    t[768 + i] = (t[t[512 + i] & 255] ^ (t[512 + i] >>> 8)) >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** IEEE CRC-32 (zlib/PNG) of u8[start, end). */
export function crc32(u8, start = 0, end = u8.byteLength) {
  const t = crcTable();
  let c = 0xffffffff;
  let i = start;
  for (; i + 4 <= end; i += 4) {
    c ^= u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
    c = t[768 + (c & 255)] ^ t[512 + ((c >>> 8) & 255)] ^ t[256 + ((c >>> 16) & 255)] ^ t[c >>> 24];
  }
  for (; i < end; i++) c = t[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let BIG_POS = 0;
function readBig(u8, p, v) {
  let mul = 268435456;
  for (let i = 4; i < 10; i++) {
    const b = u8[p++];
    if (b === undefined) throw new RangeError('BUVLSN1: varint past end of blob');
    v += (b & 127) * mul;
    if (b < 128) { BIG_POS = p; return v; }
    mul *= 128;
  }
  throw new RangeError('BUVLSN1: varint too long');
}

/**
 * Decodes a tile blob u8[start, end) into cells (Float64Array, 4 per cell, zeroed by the
 * caller). Returns {occupied, countSmall, countLarge, satsSmall, satsLarge} for the tile.
 */
export function decodeTileBlob(u8, start, end, cells) {
  let p = start;
  let idx = -1;
  let occupied = 0;
  let tcs = 0;
  let tcl = 0;
  let tss = 0;
  let tsl = 0;
  let b;
  let v;
  // Inline LEB128 reader: value in v, position in p.
  while (p < end) {
    // gap
    b = u8[p++]; v = b & 127;
    if (b >= 128) { b = u8[p++]; v |= (b & 127) << 7; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 14; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 21; if (b >= 128) { v = readBig(u8, p, v); p = BIG_POS; } } } }
    idx += 1 + v;
    if (idx >= TILE_CELLS) throw new Error('BUVLSN1: cell index ' + idx + ' outside the tile');
    // countSmall * 2 + hasLarge
    b = u8[p++]; v = b & 127;
    if (b >= 128) { b = u8[p++]; v |= (b & 127) << 7; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 14; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 21; if (b >= 128) { v = readBig(u8, p, v); p = BIG_POS; } } } }
    if (v === 0) throw new Error('BUVLSN1: empty cell stored at index ' + idx);
    const hasLarge = v % 2;
    const cs = (v - hasLarge) / 2;
    const o = idx * 4;
    if (cs > 0) {
      b = u8[p++]; v = b & 127;
      if (b >= 128) { b = u8[p++]; v |= (b & 127) << 7; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 14; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 21; if (b >= 128) { v = readBig(u8, p, v); p = BIG_POS; } } } }
      cells[o] = cs;
      cells[o + 1] = v;
      tcs += cs;
      tss += v;
    }
    if (hasLarge) {
      b = u8[p++]; v = b & 127;
      if (b >= 128) { b = u8[p++]; v |= (b & 127) << 7; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 14; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 21; if (b >= 128) { v = readBig(u8, p, v); p = BIG_POS; } } } }
      if (v === 0) throw new Error('BUVLSN1: large flag with zero count at index ' + idx);
      cells[o + 2] = v;
      tcl += v;
      b = u8[p++]; v = b & 127;
      if (b >= 128) { b = u8[p++]; v |= (b & 127) << 7; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 14; if (b >= 128) { b = u8[p++]; v |= (b & 127) << 21; if (b >= 128) { v = readBig(u8, p, v); p = BIG_POS; } } } }
      cells[o + 3] = v;
      tsl += v;
    }
    occupied++;
  }
  if (p !== end) throw new Error('BUVLSN1: blob decoded past its end');
  return { occupied, countSmall: tcs, countLarge: tcl, satsSmall: tss, satsLarge: tsl };
}

/** Encodes the occupied cells of a tile (Float64Array, 4 per cell) as a blob; null if empty. */
export function encodeTileBlob(cells) {
  const out = [];
  const varu = (v) => {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new RangeError('encodeTileBlob: bad value ' + v);
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v !== 0) byte |= 128;
      out.push(byte);
    } while (v !== 0);
  };
  let prev = -1;
  for (let i = 0; i < TILE_CELLS; i++) {
    const o = i * 4;
    const cs = cells[o];
    const cl = cells[o + 2];
    if (cs < 0 || cl < 0) throw new Error('encodeTileBlob: negative count at ' + i);
    if (cs === 0 && cl === 0) {
      if (cells[o + 1] !== 0 || cells[o + 3] !== 0) throw new Error('encodeTileBlob: sats without count at ' + i);
      continue;
    }
    varu(i - (prev + 1));
    prev = i;
    varu(cs * 2 + (cl > 0 ? 1 : 0));
    if (cs > 0) varu(cells[o + 1]);
    if (cl > 0) { varu(cl); varu(cells[o + 3]); }
  }
  return out.length ? Uint8Array.from(out) : null;
}

/**
 * Builds a complete BUVLSN1 file (async because of SHA-256). tileCells: Map(tileId ->
 * Float64Array(65536 * 4)); missing tiles are empty. totals: {countSmall, countLarge,
 * satsSmall, satsLarge}. tileCells uses the tile ids of 'grid'; the file itself uses
 * the snapshot's own grid (block + 1 blocks), whose tiles hold every occupied cell.
 * Blobs are stored in ascending tile id.
 */
export async function buildSnapshotFile(grid, block, blkEnd, tileCells, totals) {
  if (!(Number.isInteger(block) && block >= 0 && block < grid.numBlocks)) throw new RangeError('buildSnapshotFile: block ' + block + ' outside the grid');
  const own = gridFromManifest({ numBlocks: block + 1 });
  const used = new Set();
  const blobs = [];
  for (let s = 0; s < own.tiles; s++) {
    const t = tileInfo(own, s);
    const id = tileId(grid, t.level, t.tx, t.ty);
    const cells = tileCells.get(id);
    used.add(id);
    if (cells && (t.cols < TILE || t.rows < TILE)) {
      for (let i = 0; i < TILE_CELLS; i++) {
        if ((i % TILE >= t.cols || Math.floor(i / TILE) >= t.rows) && (cells[i * 4] || cells[i * 4 + 2])) {
          throw new Error('buildSnapshotFile: block ' + block + ' has an occupied cell beyond its columns in tile ' + id);
        }
      }
    }
    blobs.push(cells ? encodeTileBlob(cells) : null);
  }
  for (const [id, cells] of tileCells) {
    if (!used.has(id) && encodeTileBlob(cells)) throw new Error('buildSnapshotFile: block ' + block + ' has occupied tile ' + id + ' beyond its columns');
  }
  let size = snapshotPrefixBytes(own.tiles);
  for (const b of blobs) if (b) size += b.byteLength;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = LSN_MAGIC.charCodeAt(i);
  const put64 = (off, v) => dv.setBigUint64(off, BigInt(v), true);
  dv.setUint32(8, 1, true);
  dv.setUint32(12, LSN_HEADER_BYTES, true);
  dv.setUint32(16, block, true);
  dv.setUint32(20, own.numBlocks, true);
  dv.setUint32(24, own.levels.length, true);
  dv.setUint32(28, own.tileSize, true);
  dv.setUint32(32, own.rows, true);
  dv.setUint32(36, own.l0Columns, true);
  dv.setUint32(40, own.blocksPerColumn, true);
  dv.setUint32(44, own.tiles, true);
  put64(48, blkEnd);
  dv.setBigInt64(56, BigInt(totals.countSmall), true);
  dv.setBigInt64(64, BigInt(totals.countLarge), true);
  dv.setBigInt64(72, BigInt(totals.satsSmall), true);
  dv.setBigInt64(80, BigInt(totals.satsLarge), true);
  let pos = snapshotPrefixBytes(own.tiles);
  for (let t = 0; t < own.tiles; t++) {
    const b = blobs[t];
    const o = LSN_HEADER_BYTES + t * LSN_DIR_ENTRY_BYTES;
    if (!b) continue;
    put64(o, pos);
    dv.setUint32(o + 8, b.byteLength, true);
    dv.setUint32(o + 12, crc32(b), true);
    out.set(b, pos);
    pos += b.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(LSN_HEADER_BYTES)));
  out.set(digest, 88);
  return out;
}
