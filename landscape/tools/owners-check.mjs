#!/usr/bin/env node
// Checks owner highlight data (docs/landscape-owners.md) against the landscape dataset it
// highlights. Node 22, no dependencies; holds one BLK2 chunk (plus the next, prefetched) at a time.
//
//   node landscape/tools/owners-check.mjs --data "/Volumes/4T Data/buv_render/landscape_974310" \
//     --owners "/Volumes/4T Data/buv_owners/o974310-20261102" [--json]
//
// 1. owners.json and its record files: sizes, SHA-256, record counts, the file of each record
//    (long.bin: unspent at the owner tip or living more than shortLife blocks; short/k: the rest
//    created in [k, k + 1) * shortLife) and each entity's totals.
// 2. Every owner event is a change of its block, counted as a multiset keyed by (signed sats,
//    creation height): a creation (+sats, created) in block created, a spend (-sats, created)
//    in block spent. Chunks are read in order from the first event to the owner tip.
// 3. The owner tip hash is the hash of the BLK2 record at the owner tip.
// 4. At the latest snapshot at or below the owner tip, every L0 cell holding owned outputs holds
//    at least as many outputs and sats in each amount class (small <= 5 BTC < large).
// Prints a summary and exits 0, or the failures and exits 1.
import { readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gridFromManifest, tileOfCell, TILE } from '../web/data/grid.js';
import { parseRowsBin, rowOfAmount } from '../web/data/axis.js';
import { readSnapshotDirectory, snapshotPrefixBytes, decodeTileBlob, crc32 } from '../web/data/snapshot.js';
import { DecodedBlock, decodeBlock, indexRecords, BLK2_HEADER_BYTES } from '../web/replay/blk2.js';
import { parseOwnerRecords, UNSPENT } from '../web/replay/owners.js';

const REPORTED = 20; // failures listed per kind; all are counted
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * owners.json and every record file it lists, with all records merged into {count, created,
 * spent (UNSPENT when unspent at the owner tip), sats, entity}. Throws on any problem with
 * the owner files themselves.
 */
export function loadOwners(dir) {
  const meta = readJson(join(dir, 'owners.json'));
  if (meta.format !== 'utxo-landscape-owners-1') throw new Error('owners.json: format is not utxo-landscape-owners-1');
  const { tip, shortLife, entities, files } = meta;
  if (!Number.isInteger(tip) || !Number.isInteger(shortLife) || shortLife < 1 || !Array.isArray(entities) || !files?.long || !Array.isArray(files.short)) {
    throw new Error('owners.json: needs tip, shortLife, entities and files');
  }
  const read = (entry, belongs) => {
    const bytes = readFileSync(join(dir, entry.file));
    if (bytes.length !== entry.bytes) throw new Error(entry.file + ': ' + bytes.length + ' bytes, owners.json says ' + entry.bytes);
    if (sha256(bytes) !== entry.sha256) throw new Error(entry.file + ': SHA-256 differs from owners.json');
    const r = parseOwnerRecords(bytes);
    if (r.count !== entry.records) throw new Error(entry.file + ': ' + r.count + ' records, owners.json says ' + entry.records);
    for (let i = 0; i < r.count; i++) {
      if (!belongs(r.created[i], r.spent[i])) {
        throw new Error(entry.file + ': record ' + i + ' (created ' + r.created[i] + ', spent ' + (r.spent[i] === UNSPENT ? 'never' : r.spent[i]) + ') belongs in another file');
      }
    }
    return r;
  };
  // An unspent record's life, UNSPENT - created, exceeds any shortLife.
  const parts = [read(files.long, (created, spent) => spent - created > shortLife)];
  for (const s of files.short) {
    if (s.file !== 'short/' + String(s.chunk).padStart(4, '0') + '.bin') throw new Error('owners.json: short chunk ' + s.chunk + ' is named ' + s.file);
    parts.push(read(s, (created, spent) => spent - created <= shortLife && Math.floor(created / shortLife) === s.chunk));
  }
  const count = parts.reduce((n, p) => n + p.count, 0);
  const records = { count, created: new Uint32Array(count), spent: new Uint32Array(count), sats: new Float64Array(count), entity: new Uint8Array(count) };
  let at = 0;
  for (const p of parts) {
    for (const key of ['created', 'spent', 'sats', 'entity']) records[key].set(p[key], at);
    at += p.count;
  }
  const totals = entities.map(() => ({ records: 0, unspent: 0, unspentSats: 0 }));
  for (let i = 0; i < count; i++) {
    const t = totals[records.entity[i]];
    if (!t) throw new Error('a record names entity ' + records.entity[i] + ', which owners.json does not list');
    const spent = records.spent[i];
    if (records.created[i] > tip || (spent !== UNSPENT && spent > tip)) throw new Error('a record lies past the owner tip ' + tip);
    t.records++;
    if (spent === UNSPENT) {
      t.unspent++;
      t.unspentSats += records.sats[i];
    }
  }
  entities.forEach((e, k) => {
    for (const key of ['records', 'unspent', 'unspentSats']) {
      if (e[key] !== totals[k][key]) throw new Error('owners.json: ' + e.id + ' ' + key + ' is ' + e[key] + ', the record files give ' + totals[k][key]);
    }
  });
  return { meta, records };
}

/**
 * Owner events by block (a counting sort): block b's events are [offsets[b], offsets[b + 1]) of
 * sats (positive for a creation, negative for a spend) and height (the creation height).
 */
export function ownerEvents(records, tip) {
  const { count, created, spent } = records;
  const next = new Uint32Array(tip + 2);
  for (let i = 0; i < count; i++) {
    next[created[i] + 1]++;
    if (spent[i] !== UNSPENT) next[spent[i] + 1]++;
  }
  for (let b = 1; b < next.length; b++) next[b] += next[b - 1];
  const offsets = next.slice();
  const sats = new Float64Array(offsets[tip + 1]);
  const height = new Uint32Array(offsets[tip + 1]);
  for (let i = 0; i < count; i++) {
    let k = next[created[i]]++;
    sats[k] = records.sats[i];
    height[k] = created[i];
    if (spent[i] !== UNSPENT) {
      k = next[spent[i]]++;
      sats[k] = -records.sats[i];
      height[k] = created[i];
    }
  }
  return { count: sats.length, offsets, sats, height };
}

/**
 * Events [from, to) of one block that its decoded changes cannot account for, counted as a
 * multiset: [{sats, height, need, have}]. decodeBlock's amounts never decrease, so a binary
 * search finds the run of each amount.
 */
export function unmatchedEvents(dec, sats, height, from, to) {
  const order = [];
  for (let k = from; k < to; k++) order.push(k);
  order.sort((a, b) => sats[a] - sats[b] || height[a] - height[b]);
  const out = [];
  for (let i = 0; i < order.length;) {
    const s = sats[order[i]];
    const h = height[order[i]];
    let j = i + 1;
    while (j < order.length && sats[order[j]] === s && height[order[j]] === h) j++;
    let lo = 0;
    let hi = dec.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dec.sats[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    let have = 0;
    for (let k = lo; k < dec.count && dec.sats[k] === s; k++) if (dec.heights[k] === h) have++;
    if (have < j - i) out.push({ sats: s, height: h, need: j - i, have });
    i = j;
  }
  return out;
}

/**
 * Owned outputs alive after block 'block', per L0 cell: Map(col * rows + row ->
 * [countSmall, satsSmall, countLarge, satsLarge]), the snapshot's cell layout.
 */
export function ownedCells(records, block, grid, minAmt, threshold) {
  const cells = new Map();
  for (let i = 0; i < records.count; i++) {
    if (records.created[i] > block || records.spent[i] <= block) continue;
    const a = records.sats[i];
    const key = Math.floor(records.created[i] / grid.blocksPerColumn) * grid.rows + rowOfAmount(minAmt, a);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = [0, 0, 0, 0]));
    const o = a > threshold ? 2 : 0;
    c[o] += 1;
    c[o + 1] += a;
  }
  return cells;
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error('short read at offset ' + position);
  return new Uint8Array(buf.buffer, buf.byteOffset, length);
}

/**
 * Owned cells that hold more outputs or sats in an amount class than the snapshot's L0 cell:
 * [{col, row, owned, cell}]. Reads the snapshot's directory and only the tiles it needs.
 */
export async function cellBoundFailures(file, grid, block, owned) {
  const byTile = new Map();
  for (const [key, c] of owned) {
    const col = Math.floor(key / grid.rows);
    const row = key - col * grid.rows;
    const id = tileOfCell(grid, 0, col, row);
    if (!byTile.has(id)) byTile.set(id, []);
    byTile.get(id).push({ col, row, owned: c });
  }
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const { dir } = readSnapshotDirectory(await readAt(fh, 0, Math.min(size, snapshotPrefixBytes(grid.tiles))), grid, block, size);
    const cells = new Float64Array(TILE * TILE * 4);
    const out = [];
    for (const [id, list] of byTile) {
      cells.fill(0);
      if (id >= 0 && dir.bytes[id]) {
        const blob = await readAt(fh, dir.offset[id], dir.bytes[id]);
        if (crc32(blob) !== dir.crc[id]) throw new Error(file + ': tile ' + id + ' fails its CRC');
        decodeTileBlob(blob, 0, blob.length, cells);
      }
      for (const { col, row, owned: c } of list) {
        const o = ((row % TILE) * TILE + (col % TILE)) * 4;
        const cell = Array.from(cells.subarray(o, o + 4));
        if (c.some((v, k) => v > cell[k])) out.push({ col, row, owned: c, cell });
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * Runs every check: {ok, counts, failures: {event, tipHash, cell}, problems (the first few of
 * each kind), seconds}. Throws when the files cannot be checked at all.
 */
export async function checkOwners({ data, owners }) {
  const started = performance.now();
  const manifest = readJson(join(data, 'manifest.json'));
  const grid = gridFromManifest(manifest);
  const threshold = manifest.weightThresholdSatoshi;
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error('manifest.json: no weightThresholdSatoshi');
  const { meta, records } = loadOwners(owners);
  const tip = meta.tip;
  if (tip > manifest.tip) throw new Error('the owner tip ' + tip + ' is past the landscape tip ' + manifest.tip);
  const failures = { event: 0, tipHash: 0, cell: 0 };
  const problems = [];
  const fail = (kind, text) => {
    if (failures[kind]++ < REPORTED) problems.push(text);
  };

  // 2 and 3: each block's owner events against its changes, and the hash of the tip record.
  const ev = ownerEvents(records, tip);
  let first = tip;
  for (let i = 0; i < records.count; i++) if (records.created[i] < first) first = records.created[i];
  const chunks = readJson(join(data, manifest.files.chunks)).chunks.filter((c) => c.lastBlock >= first && c.firstBlock <= tip);
  let expect = first;
  for (const c of chunks) {
    if (c.firstBlock > expect) break;
    expect = c.lastBlock + 1;
  }
  if (expect <= tip) throw new Error('chunks.json has no chunk holding block ' + expect);
  const dec = new DecodedBlock();
  let tipHash = null;
  let blocksWithEvents = 0;
  let next = readFile(join(data, chunks[0].file));
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const u8 = await next;
    if (k + 1 < chunks.length) next = readFile(join(data, chunks[k + 1].file));
    const index = indexRecords(u8, c.firstBlock);
    if (index.lastBlock !== c.lastBlock) throw new Error(c.file + ' ends at block ' + index.lastBlock + ', chunks.json says ' + c.lastBlock);
    for (let b = Math.max(first, c.firstBlock); b <= Math.min(tip, c.lastBlock); b++) {
      const pos = index.offsets[b - c.firstBlock];
      // BLK2 keeps the block hash in RPC (display) byte order: block 0's begins 000000000019d668.
      if (b === tip) tipHash = Buffer.from(u8.subarray(pos + BLK2_HEADER_BYTES, pos + BLK2_HEADER_BYTES + 32)).toString('hex');
      const from = ev.offsets[b];
      const to = ev.offsets[b + 1];
      if (from === to) continue;
      blocksWithEvents++;
      decodeBlock(u8, pos, dec);
      for (const m of unmatchedEvents(dec, ev.sats, ev.height, from, to)) {
        fail('event', 'block ' + b + ': ' + m.need + ' ' + (m.sats > 0 ? 'creation' : 'spend') + (m.need > 1 ? 's' : '') + ' of ' + Math.abs(m.sats) +
          ' sat created at ' + m.height + ', the block has ' + m.have);
      }
    }
  }
  if (tipHash !== String(meta.tipHash).toLowerCase()) fail('tipHash', 'tip hash ' + meta.tipHash + ' is not the hash of block ' + tip + ', ' + tipHash);

  // 4: owned cells against the latest snapshot at or below the owner tip.
  const snap = manifest.snapshots.reduce((best, s) => (s.block <= tip && (!best || s.block > best.block) ? s : best), null);
  if (!snap) throw new Error('manifest.json has no snapshot at or below block ' + tip);
  const minAmt = parseRowsBin(readFileSync(join(data, manifest.files.rows)), grid.rows);
  const owned = ownedCells(records, snap.block, grid, minAmt, threshold);
  for (const f of await cellBoundFailures(join(data, snap.file), grid, snap.block, owned)) {
    fail('cell', 'cell (col ' + f.col + ', row ' + f.row + ') at block ' + snap.block + ': owned [' + f.owned.join(', ') + '] exceeds the landscape [' +
      f.cell.join(', ') + '] (small count, sats; large count, sats)');
  }

  return {
    ok: !failures.event && !failures.tipHash && !failures.cell,
    owners: meta.id, data: resolve(data), tip, tipHash: meta.tipHash, records: records.count, events: ev.count,
    firstBlock: first, blocks: tip - first + 1, blocksWithEvents, chunks: chunks.length, snapshot: snap.block, cells: owned.size,
    failures, problems, seconds: Math.round(performance.now() - started) / 1000,
  };
}

function summary(r) {
  const n = (v) => v.toLocaleString('en-US');
  return (r.ok ? 'OK ' : 'FAILED ') + r.owners + ': ' + n(r.records) + ' records; ' + n(r.events) + ' events checked in ' + n(r.blocksWithEvents) +
    ' of the ' + n(r.blocks) + ' blocks ' + n(r.firstBlock) + '-' + n(r.tip) + ' (' + n(r.chunks) + ' chunks); tip hash ' +
    (r.failures.tipHash ? 'differs' : 'matches') + '; ' + n(r.cells) + ' owned cells checked at snapshot ' + n(r.snapshot) + '; ' + r.seconds + ' s' +
    (r.ok ? '' : '; ' + n(r.failures.event) + ' unmatched events, ' + n(r.failures.cell) + ' cells over their bound');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!opt('data') || !opt('owners')) {
    console.error('usage: node landscape/tools/owners-check.mjs --data LANDSCAPE_DIR --owners OWNERS_DIR [--json]');
    process.exit(2);
  }
  try {
    const report = await checkOwners({ data: opt('data'), owners: opt('owners') });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 1));
    else {
      for (const p of report.problems) console.log('FAIL ' + p);
      console.log(summary(report));
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error('owners-check: ' + err.message);
    process.exit(1);
  }
}
