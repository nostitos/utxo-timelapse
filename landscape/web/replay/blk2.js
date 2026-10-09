// BLK2 change-record decoder (landscape/SPEC.md §4). Mirrors buv::ChangesInBlock::decode
// exactly. Pure ES module; no DOM, no Node APIs.
//
// Record: u32 magic "BLK\x02" (0x024b4c42), u32 height, u32 payloadBytes, payload.
// Payload: 32+32+32 hash/merkle/chainwork, 8 difficulty, u32 version, u32 time,
// u32 medianTime, u32 nonce, 4 bits (124 bytes), varuint nTx, size, strippedSize,
// weight; then zigzag satoshi + varuint height for the first change, and until the end
// of the payload: satoshi += varuint; if satoshi <= 0 then height += zigzag and emit
// (satoshi, height), else emit (satoshi, record height).
//
// All values are decoded with Number arithmetic beyond 28 bits (never 32-bit bitwise ops
// on large values). Bitcoin amounts and heights stay far below 2^53, so this is exact.

export const BLK2_MAGIC = 0x024b4c42;
export const BLK2_HEADER_BYTES = 12;
export const BLK2_FIXED_PAYLOAD_BYTES = 124;

/** Reusable decode target. Arrays grow as needed. */
export class DecodedBlock {
  constructor(capacity = 16384) {
    this.height = -1;
    this.version = 0;
    this.time = 0;
    this.medianTime = 0;
    this.nonce = 0;
    this.nTx = 0;
    this.size = 0;
    this.strippedSize = 0;
    this.weight = 0;
    this.count = 0;            // number of changes (including zero amounts)
    this.created = 0;          // changes with satoshi > 0
    this.spent = 0;            // changes with satoshi < 0
    this.zero = 0;             // changes with satoshi == 0 (skipped by the state)
    this.createdSats = 0;
    this.spentSats = 0;        // positive sum of spent amounts
    this.recordBytes = 0;      // whole record including the 12-byte header
    this.sats = new Float64Array(capacity);
    this.heights = new Int32Array(capacity);
  }
  grow(min) {
    let cap = this.sats.length * 2;
    while (cap < min) cap *= 2;
    const s = new Float64Array(cap);
    s.set(this.sats.subarray(0, this.count));
    const h = new Int32Array(cap);
    h.set(this.heights.subarray(0, this.count));
    this.sats = s;
    this.heights = h;
  }
}

// Slow path for varints longer than 4 bytes; returns the value and stores the new
// position in TAIL_POS.
let TAIL_POS = 0;
function varTail(u8, p, v) {
  let mul = 268435456; // 2^28
  for (let i = 4; i < 10; i++) {
    const b = u8[p++];
    if (b === undefined) throw new RangeError('BLK2: varint runs past the buffer');
    v += (b & 127) * mul;
    if (b < 128) { TAIL_POS = p; return v; }
    mul *= 128;
  }
  throw new RangeError('BLK2: varint longer than 10 bytes');
}

let VPOS = 0;
/** Unsigned LEB128 at u8[p]; returns the value, new position in readVarUint.pos. */
export function readVarUint(u8, p) {
  let b = u8[p++];
  let v = b & 127;
  if (b >= 128) {
    b = u8[p++]; v |= (b & 127) << 7;
    if (b >= 128) {
      b = u8[p++]; v |= (b & 127) << 14;
      if (b >= 128) {
        b = u8[p++]; v |= (b & 127) << 21;
        if (b >= 128) { v = varTail(u8, p, v); p = TAIL_POS; }
      }
    }
  }
  VPOS = p;
  return v;
}
readVarUint.position = () => VPOS;

/** Zigzag decode of a non-negative Number (exact for z < 2^53). */
export function unzigzag(z) {
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

/** Reads the 12-byte record header at pos: {magic, height, payloadBytes}. */
export function readRecordHeader(dv, pos) {
  return { magic: dv.getUint32(pos, true), height: dv.getUint32(pos + 4, true), payloadBytes: dv.getUint32(pos + 8, true) };
}

/**
 * Indexes consecutive records in a buffer (a chunk). Checks the magic, consecutive
 * heights and that the last record ends exactly at the end of the buffer.
 * @returns {{firstBlock:number, lastBlock:number, count:number, offsets:Uint32Array}}
 *   offsets[i] = start of record i, offsets[count] = buffer length.
 */
export function indexRecords(u8, expectedFirst = null) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const offsets = [];
  let pos = 0;
  let first = -1;
  let prev = -1;
  while (pos < u8.byteLength) {
    if (pos + BLK2_HEADER_BYTES > u8.byteLength) throw new Error('BLK2: truncated record header at ' + pos);
    const magic = dv.getUint32(pos, true);
    if (magic !== BLK2_MAGIC) throw new Error('BLK2: bad magic at offset ' + pos);
    const height = dv.getUint32(pos + 4, true);
    const n = dv.getUint32(pos + 8, true);
    if (first < 0) {
      first = height;
      if (expectedFirst !== null && height !== expectedFirst) throw new Error('BLK2: chunk starts at ' + height + ', expected ' + expectedFirst);
    } else if (height !== prev + 1) {
      throw new Error('BLK2: heights not consecutive at offset ' + pos + ' (' + prev + ' then ' + height + ')');
    }
    offsets.push(pos);
    prev = height;
    pos += BLK2_HEADER_BYTES + n;
  }
  if (pos !== u8.byteLength) throw new Error('BLK2: last record overruns the buffer');
  offsets.push(pos);
  return { firstBlock: first, lastBlock: prev, count: offsets.length - 1, offsets: Uint32Array.from(offsets) };
}

/**
 * Decodes the record at u8[pos] into out (DecodedBlock). Returns the offset just past
 * the record. Throws on a bad magic or a payload that does not end exactly at its size.
 */
export function decodeBlock(u8, pos, out) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(pos, true) !== BLK2_MAGIC) throw new Error('BLK2: bad magic at offset ' + pos);
  const height = dv.getUint32(pos + 4, true);
  const payloadBytes = dv.getUint32(pos + 8, true);
  let p = pos + BLK2_HEADER_BYTES;
  const end = p + payloadBytes;
  if (end > u8.byteLength) throw new Error('BLK2: record ' + height + ' overruns the buffer');
  out.height = height;
  out.recordBytes = BLK2_HEADER_BYTES + payloadBytes;
  out.version = dv.getUint32(p + 104, true);
  out.time = dv.getUint32(p + 108, true);
  out.medianTime = dv.getUint32(p + 112, true);
  out.nonce = dv.getUint32(p + 116, true);
  p += BLK2_FIXED_PAYLOAD_BYTES;
  out.nTx = readVarUint(u8, p); p = VPOS;
  out.size = readVarUint(u8, p); p = VPOS;
  out.strippedSize = readVarUint(u8, p); p = VPOS;
  out.weight = readVarUint(u8, p); p = VPOS;

  let n = 0;
  let created = 0;
  let spent = 0;
  let zero = 0;
  let createdSats = 0;
  let spentSats = 0;
  let sats = out.sats;
  let hts = out.heights;
  if (p < end) {
    // First change: zigzag satoshi, varuint height (used whatever the sign).
    let z = readVarUint(u8, p); p = VPOS;
    let satoshi = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    let bh = readVarUint(u8, p); p = VPOS;
    sats[0] = satoshi;
    hts[0] = bh;
    n = 1;
    if (satoshi > 0) { created++; createdSats += satoshi; } else if (satoshi < 0) { spent++; spentSats -= satoshi; } else zero++;
    let b;
    let v;
    while (p < end) {
      if (n === sats.length) { out.count = n; out.grow(n + 1); sats = out.sats; hts = out.heights; }
      // satoshi += varuint (inlined LEB128, 1-4 byte fast path)
      b = u8[p++]; v = b & 127;
      if (b >= 128) {
        b = u8[p++]; v |= (b & 127) << 7;
        if (b >= 128) {
          b = u8[p++]; v |= (b & 127) << 14;
          if (b >= 128) {
            b = u8[p++]; v |= (b & 127) << 21;
            if (b >= 128) { v = varTail(u8, p, v); p = TAIL_POS; }
          }
        }
      }
      satoshi += v;
      if (satoshi <= 0) {
        b = u8[p++]; v = b & 127;
        if (b >= 128) {
          b = u8[p++]; v |= (b & 127) << 7;
          if (b >= 128) {
            b = u8[p++]; v |= (b & 127) << 14;
            if (b >= 128) {
              b = u8[p++]; v |= (b & 127) << 21;
              if (b >= 128) { v = varTail(u8, p, v); p = TAIL_POS; }
            }
          }
        }
        bh += v < 2147483648 ? ((v >>> 1) ^ -(v & 1)) : (v % 2 === 0 ? v / 2 : -(v + 1) / 2);
        sats[n] = satoshi;
        hts[n] = bh;
        if (satoshi < 0) { spent++; spentSats -= satoshi; } else zero++;
      } else {
        sats[n] = satoshi;
        hts[n] = height;
        created++;
        createdSats += satoshi;
      }
      n++;
    }
  }
  if (p !== end) throw new Error('BLK2: record ' + height + ' payload decoded past its end (' + p + ' vs ' + end + ')');
  out.count = n;
  out.created = created;
  out.spent = spent;
  out.zero = zero;
  out.createdSats = createdSats;
  out.spentSats = spentSats;
  return end;
}

/**
 * Encodes one block as a BLK2 record (mirror of ChangesInBlock::encode, used by tests
 * and synthetic datasets). changes: array of [satoshi, height]; they are sorted like the
 * C++ encoder (by satoshi, then height). Header fields default to zero.
 */
export function encodeBlock(height, changes, header = {}) {
  const sorted = changes.map((c) => [c[0], c[1]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  // Real blocks always have a coinbase change. The C++ encoder would leave the payload
  // size at 0 for an empty block, which cannot be decoded, so refuse it here.
  if (!sorted.length) throw new Error('encodeBlock: a block needs at least one change');
  for (const [s, h] of sorted) {
    if (s > 0 && h !== height) throw new Error('encodeBlock: positive amount must be created at the record height');
  }
  const bytes = [];
  const u32 = (v) => { bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
  const varu = (v) => {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new RangeError('encodeBlock: bad varuint ' + v);
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v !== 0) byte |= 128;
      bytes.push(byte);
    } while (v !== 0);
  };
  const vari = (v) => varu(v >= 0 ? v * 2 : -v * 2 - 1);
  u32(BLK2_MAGIC);
  u32(height);
  u32(0); // payload size, filled below
  for (let i = 0; i < 104; i++) bytes.push((header.fill ?? 0) & 255);
  u32(header.version ?? 0);
  u32(header.time ?? 0);
  u32(header.medianTime ?? 0);
  u32(header.nonce ?? 0);
  for (let i = 0; i < 4; i++) bytes.push(0);
  varu(header.nTx ?? sorted.length);
  varu(header.size ?? 0);
  varu(header.strippedSize ?? 0);
  varu(header.weight ?? 0);
  if (sorted.length) {
    vari(sorted[0][0]);
    varu(sorted[0][1]);
    for (let i = 1; i < sorted.length; i++) {
      varu(sorted[i][0] - sorted[i - 1][0]);
      if (sorted[i][0] <= 0) vari(sorted[i][1] - sorted[i - 1][1]);
    }
  }
  const out = Uint8Array.from(bytes);
  new DataView(out.buffer).setUint32(8, out.length - BLK2_HEADER_BYTES, true);
  return out;
}
