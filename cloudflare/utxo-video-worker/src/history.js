import { RELEASE } from './release.js';
import { historySource } from './history_sources.js';
import { parseSpendPatchIndex, parseSpendPatchRecords } from './spend_patch.js';
import {
  CONFIG,
  blockToX,
  columnBlockRange,
  rowSatoshiRange,
  validatePixelParams,
} from "./mapping.js";

const BLOCK_TIMES_KEY = RELEASE.historyBlockTimesKey || `${RELEASE.historyDeltaPrefix}/block_times.bin`;
const SHARD_BLOCKS = 512;
const ROWS = CONFIG.graphRect.h;
const SHARD_HEADER_BYTES = 32;
const SHARD_INDEX_BYTES = (ROWS + 1) * 8;
const RECORD_BYTES = 16;
const UNSPENT = 0xffffffff;
const MAX_ROW_CHUNK = 4 * 1024 * 1024;
let blockTimesPromise;

function json(value, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });
}

async function objectBytes(bucket, key, offset, length) {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Error(`missing R2 object ${key}`);
  return object.arrayBuffer();
}

async function blockTimes(bucket) {
  if (!blockTimesPromise) {
    blockTimesPromise = bucket.get(BLOCK_TIMES_KEY).then(async (object) => {
      if (!object) throw new Error("block time table is unavailable");
      const buffer = await object.arrayBuffer();
      if (buffer.byteLength !== CONFIG.numBlocks * 4) {
        throw new Error("bad block time table length");
      }
      return new Uint32Array(buffer);
    }).catch((error) => {
      blockTimesPromise = undefined;
      throw error;
    });
  }
  return blockTimesPromise;
}

function dateOf(times, height) {
  return new Date(times[Math.min(height, times.length - 1)] * 1000)
    .toISOString()
    .slice(0, 10);
}

function binOf(height, firstHeight) {
  const bins = 48;
  const tip = CONFIG.numBlocks - 1;
  if (height <= firstHeight) return 0;
  if (height >= tip) return bins - 1;
  const span = tip - firstHeight + 1;
  return Math.min(bins - 1, Math.floor(((height - firstHeight) / span) * bins));
}

function insertBest(array, item, better, limit) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (better(item, array[mid])) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= limit) return;
  array.splice(lo, 0, item);
  if (array.length > limit) array.pop();
}

function liveBetter(a, b) {
  const au = a.spent === UNSPENT;
  const bu = b.spent === UNSPENT;
  if (au !== bu) return au;
  if (!au && a.spent !== b.spent) return a.spent < b.spent;
  if (a.created !== b.created) return a.created < b.created;
  return a.sat > b.sat;
}

function pastBetter(a, b) {
  if (a.spent !== b.spent) return a.spent < b.spent;
  return a.created < b.created;
}

async function scanShard(bucket, shard, row, bounds, aggregate) {
  const source = historySource(RELEASE, shard);
  const key = source.baseKey;
  const indexBuffer = await objectBytes(
    bucket,
    key,
    0,
    SHARD_HEADER_BYTES + SHARD_INDEX_BYTES,
  );
  const index = new DataView(indexBuffer);
  const magic = String.fromCharCode(...new Uint8Array(indexBuffer, 0, 7));
  if (magic !== "BUVSHD1" || index.getUint32(8, true) !== 1) {
    throw new Error(`bad shard header ${shard}`);
  }
  if (index.getUint32(12, true) !== ROWS) throw new Error(`bad row count ${shard}`);
  const firstRecord = Number(index.getBigUint64(SHARD_HEADER_BYTES + row * 8, true));
  const finalRecord = Number(index.getBigUint64(SHARD_HEADER_BYTES + (row + 1) * 8, true));
  let spendPatch = new Map();
  if (source.patchKey) {
    const patchKey = source.patchKey;
    const patchIndex = await objectBytes(bucket, patchKey, 0, SHARD_HEADER_BYTES + SHARD_INDEX_BYTES);
    const range = parseSpendPatchIndex(patchIndex, row, ROWS, shard);
    if (range.length) {
      const patchRows = await objectBytes(bucket, patchKey, range.offset, range.length);
      spendPatch = parseSpendPatchRecords(patchRows, firstRecord, finalRecord, source.baseTip, CONFIG.numBlocks - 1);
    }
  }
  let record = firstRecord;
  const recordsOffset = SHARD_HEADER_BYTES + SHARD_INDEX_BYTES;
  const [h1, h2, s1, s2, viewBlock] = bounds;
  while (record < finalRecord) {
    const count = Math.min(
      finalRecord - record,
      Math.floor(MAX_ROW_CHUNK / RECORD_BYTES),
    );
    const buffer = await objectBytes(
      bucket,
      key,
      recordsOffset + record * RECORD_BYTES,
      count * RECORD_BYTES,
    );
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      const offset = i * RECORD_BYTES;
      const created = view.getUint32(offset, true);
      if (created < h1 || created > h2 || created > viewBlock) continue;
      const originalSpent = view.getUint32(offset + 4, true);
      const overrideSpent = spendPatch.get(record + i);
      if (overrideSpent !== undefined && originalSpent !== UNSPENT) throw new Error("spend patch targets a spent output");
      const spent = overrideSpent ?? originalSpent;
      const sat = Number(view.getBigInt64(offset + 8, true));
      if (sat < s1 || sat > s2) continue;

      aggregate.binDelta[binOf(created, h1)] += 1;
      if (spent !== UNSPENT) {
        aggregate.binDelta[binOf(spent, h1)] -= 1;
        const lifespan = spent - created;
        aggregate.stayHistogram[Math.min(lifespan, CONFIG.numBlocks)] += 1;
        aggregate.stayCount += 1;
      }
      const hit = { sat, created, spent };
      if (spent !== UNSPENT && spent <= viewBlock) {
        aggregate.pastCount += 1;
        aggregate.pastSat += sat;
        insertBest(aggregate.pastHits, hit, pastBetter, 100);
      } else {
        aggregate.count += 1;
        aggregate.liveSat += sat;
        if (spent === UNSPENT) {
          aggregate.stillUnspent += 1;
          aggregate.liveUnspentSat += sat;
        }
        insertBest(aggregate.hits, hit, liveBetter, 500);
      }
    }
    record += count;
  }
}

async function scanShards(bucket, firstShard, finalShard, row, bounds, aggregate) {
  let next = firstShard;
  const runner = async () => {
    while (true) {
      const shard = next++;
      if (shard > finalShard) return;
      await scanShard(bucket, shard, row, bounds, aggregate);
    }
  };
  const concurrency = Math.min(8, finalShard - firstShard + 1);
  await Promise.all(Array.from({ length: concurrency }, runner));
}

function formatHit(hit, block, times, past = false) {
  const value = {
    sat: hit.sat,
    created: hit.created,
    createdDate: dateOf(times, hit.created),
  };
  if (!past) value.age = block - hit.created;
  if (hit.spent === UNSPENT) value.spent = null;
  else {
    value.spent = hit.spent;
    value.spentDate = dateOf(times, hit.spent);
  }
  return value;
}

export async function pixelResponse(url, env) {
  const params = validatePixelParams(url);
  if (params.error) return json({ error: params.error }, 400);
  const { block, x, y } = params;
  const cursorX = blockToX(block, block);
  if (x > cursorX) {
    return json({
      blockRange: null,
      satRange: null,
      count: 0,
      utxos: [],
      pastCount: 0,
      pastUtxos: [],
      overlay: "flowline",
      cursorX,
    });
  }
  const heights = columnBlockRange(x, block);
  const sats = rowSatoshiRange(y);
  if (!heights || !sats) {
    return json({ blockRange: null, satRange: null, count: 0, utxos: [] });
  }
  const [h1, h2] = heights;
  const [s1, s2] = sats;
  const firstShard = Math.floor(h1 / SHARD_BLOCKS);
  const finalShard = Math.floor(Math.min(h2, block) / SHARD_BLOCKS);
  const aggregate = {
    count: 0,
    stillUnspent: 0,
    liveSat: 0,
    liveUnspentSat: 0,
    pastCount: 0,
    pastSat: 0,
    hits: [],
    pastHits: [],
    binDelta: new Int32Array(49),
    stayHistogram: new Uint32Array(CONFIG.numBlocks + 1),
    stayCount: 0,
  };
  await scanShards(
    env.VIDEO_BUCKET,
    firstShard,
    finalShard,
    y - CONFIG.graphRect.y,
    [h1, h2, s1, s2, block],
    aggregate,
  );
  const times = await blockTimes(env.VIDEO_BUCKET);
  let medianStay = -1;
  if (aggregate.stayCount) {
    const target = Math.floor(aggregate.stayCount / 2) + 1;
    let seen = 0;
    for (let i = 0; i < aggregate.stayHistogram.length; i++) {
      seen += aggregate.stayHistogram[i];
      if (seen >= target) { medianStay = i; break; }
    }
  }
  const population = [];
  let running = 0;
  for (let i = 0; i < 48; i++) {
    running += aggregate.binDelta[i];
    population.push(running);
  }
  return json({
    blockRange: heights,
    blockDates: [dateOf(times, h1), dateOf(times, Math.min(h2, CONFIG.numBlocks - 1))],
    satRange: sats,
    count: aggregate.count,
    stillUnspent: aggregate.stillUnspent,
    liveSat: aggregate.liveSat,
    liveUnspentSat: aggregate.liveUnspentSat,
    pastSat: aggregate.pastSat,
    medianStay,
    viewBin: binOf(block, h1),
    pop: population,
    truncated: aggregate.count > aggregate.hits.length,
    utxos: aggregate.hits.map((hit) => formatHit(hit, block, times)),
    pastCount: aggregate.pastCount,
    pastTruncated: aggregate.pastCount > aggregate.pastHits.length,
    pastUtxos: aggregate.pastHits.map((hit) => formatHit(hit, block, times, true)),
  });
}

export async function rangesResponse(url, env) {
  const params = validatePixelParams(url);
  if (params.error) return json({ error: params.error }, 400);
  const { block, x, y } = params;
  const sats = rowSatoshiRange(y);
  if (x > blockToX(block, block)) {
    return json({ blockRange: null, future: true, satRange: sats });
  }
  const heights = columnBlockRange(x, block);
  if (!heights) return json({ blockRange: null, satRange: sats });
  const times = await blockTimes(env.VIDEO_BUCKET);
  return json({
    blockRange: heights,
    blockDates: [dateOf(times, heights[0]), dateOf(times, heights[1])],
    satRange: sats,
  });
}

export async function dateResponse(url, env) {
  const day = url.searchParams.get("d");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json({ error: "d must be YYYY-MM-DD" }, 400);
  }
  const target = Date.parse(`${day}T00:00:00Z`) / 1000;
  if (!Number.isFinite(target)) return json({ error: "d must be YYYY-MM-DD" }, 400);
  const times = await blockTimes(env.VIDEO_BUCKET);
  let lo = 0;
  let hi = CONFIG.numBlocks;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  for (let h = lo; h > 0 && h + 24 > lo; h--) {
    if (times[h - 1] >= target) best = h - 1;
  }
  if (best >= CONFIG.numBlocks) {
    return json({ block: null, tipDate: dateOf(times, CONFIG.numBlocks - 1) });
  }
  return json({ block: best, date: dateOf(times, best) });
}
