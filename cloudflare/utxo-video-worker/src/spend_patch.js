// Tiny immutable overlays update spends without replacing full historical shards.
const HEADER_BYTES = 32;

export function parseSpendPatchIndex(buffer, row, rows, shard) {
  const v = new DataView(buffer);
  const indexBytes = (rows + 1) * 8;
  if (buffer.byteLength !== HEADER_BYTES + indexBytes) throw new Error('bad spend-patch index length');
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== 'BUVSPN1\0' || v.getUint32(8, true) !== 1 || v.getUint32(12, true) !== rows) {
    throw new Error('bad spend-patch header');
  }
  if (v.getUint32(16, true) !== shard * 512 || v.getUint32(20, true) !== (shard + 1) * 512) {
    throw new Error('spend-patch shard mismatch');
  }
  if (!Number.isInteger(row) || row < 0 || row >= rows) throw new Error('invalid spend-patch row');
  const total = Number(v.getBigUint64(24, true));
  const first = Number(v.getBigUint64(HEADER_BYTES + row * 8, true));
  const last = Number(v.getBigUint64(HEADER_BYTES + (row + 1) * 8, true));
  if (first > last || last > total) throw new Error('bad spend-patch offsets');
  return { offset: HEADER_BYTES + indexBytes + first * 8, length: (last - first) * 8 };
}

export function parseSpendPatchRecords(buffer, firstRecord, finalRecord, oldTip, newTip) {
  if (buffer.byteLength % 8) throw new Error('truncated spend patch');
  const v = new DataView(buffer);
  const out = new Map();
  let previous = -1;
  for (let i = 0; i < buffer.byteLength; i += 8) {
    const ordinal = v.getUint32(i, true);
    const spent = v.getUint32(i + 4, true);
    if (ordinal < firstRecord || ordinal >= finalRecord || ordinal <= previous || spent <= oldTip || spent > newTip) {
      throw new Error('invalid spend-patch record');
    }
    out.set(ordinal, spent);
    previous = ordinal;
  }
  return out;
}
