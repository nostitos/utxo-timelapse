import { CONFIG, blockToX, satoshiToY } from "./mapping.js";
import { RELEASE as LANDSCAPE } from "../../utxo-landscape-worker/src/release.js";
import { DecodedBlock, decodeBlock, indexRecords } from "../../../landscape/web/replay/blk2.js";

const UPSTREAM = "https://mempool.space/api";
const TXID = /^[0-9a-f]{64}$/;
// Inputs the change log cannot date that are looked up at mempool.space, at most this many transactions per answer.
const LOOKUP_LIMIT = 24;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": status === 200 ? "public, max-age=2592000" : "no-store",
    },
  });
}

function varInt(view, state) {
  if (state.offset >= view.byteLength) throw new Error("truncated varint");
  const first = view.getUint8(state.offset++);
  if (first < 0xfd) return first;
  if (first === 0xfd) {
    const value = view.getUint16(state.offset, true);
    state.offset += 2;
    return value;
  }
  if (first === 0xfe) {
    const value = view.getUint32(state.offset, true);
    state.offset += 4;
    return value;
  }
  const value = Number(view.getBigUint64(state.offset, true));
  state.offset += 8;
  if (!Number.isSafeInteger(value)) throw new Error("oversized varint");
  return value;
}

function skip(view, state, amount) {
  state.offset += amount;
  if (state.offset > view.byteLength) throw new Error("truncated block");
}

function matchingOutputs(raw, targetSatoshi) {
  const view = new DataView(raw);
  const state = { offset: 80 };
  const transactions = varInt(view, state);
  const matches = [];
  for (let tx = 0; tx < transactions; tx++) {
    skip(view, state, 4); // version
    let segwit = false;
    if (
      state.offset + 1 < view.byteLength &&
      view.getUint8(state.offset) === 0 &&
      view.getUint8(state.offset + 1) !== 0
    ) {
      segwit = true;
      state.offset += 2;
    }
    const inputs = varInt(view, state);
    for (let input = 0; input < inputs; input++) {
      skip(view, state, 36);
      skip(view, state, varInt(view, state));
      skip(view, state, 4);
    }
    const outputs = varInt(view, state);
    for (let vout = 0; vout < outputs; vout++) {
      const value = Number(view.getBigUint64(state.offset, true));
      state.offset += 8;
      const scriptLength = varInt(view, state);
      skip(view, state, scriptLength);
      if (value === targetSatoshi) matches.push({ transactionIndex: tx, vout });
    }
    if (segwit) {
      for (let input = 0; input < inputs; input++) {
        const items = varInt(view, state);
        for (let item = 0; item < items; item++) {
          skip(view, state, varInt(view, state));
        }
      }
    }
    skip(view, state, 4); // locktime
  }
  return matches;
}

async function upstream(path, asJson = false) {
  const response = await fetch(`${UPSTREAM}${path}`, {
    headers: { Accept: asJson ? "application/json" : "application/octet-stream" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return asJson ? response.json() : response.arrayBuffer();
}

export async function txidResponse(url) {
  const heightText = url.searchParams.get("height");
  const satoshiText = url.searchParams.get("satoshi");
  if (!heightText || !/^\d{1,10}$/.test(heightText) || !satoshiText || !/^\d{1,16}$/.test(satoshiText)) {
    return json({ error: "height and satoshi must be positive integers" }, 400);
  }
  const height = Number(heightText);
  const satoshi = Number(satoshiText);
  if (height >= CONFIG.numBlocks || satoshi < 1 || satoshi > 2100000000000000) {
    return json({ error: "height or satoshi outside chain range" }, 400);
  }
  try {
    const hashResponse = await fetch(`${UPSTREAM}/block-height/${height}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!hashResponse.ok) throw new Error(`height upstream ${hashResponse.status}`);
    const blockHash = (await hashResponse.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(blockHash)) throw new Error("bad upstream block hash");
    const [raw, txids] = await Promise.all([
      upstream(`/block/${blockHash}/raw`),
      upstream(`/block/${blockHash}/txids`, true),
    ]);
    const locations = matchingOutputs(raw, satoshi);
    const matches = locations
      .filter((item) => TXID.test(txids[item.transactionIndex]))
      .map((item) => ({
        txid: txids[item.transactionIndex],
        vout: item.vout,
      }));
    return json({ height, satoshi, matches, ambiguous: matches.length > 1 });
  } catch (error) {
    console.warn("txid resolution failed", error?.message || error);
    return json({ error: "Bitcoin lookup service is temporarily unavailable" }, 503);
  }
}

export function txQuery(url) {
  const txid = url.searchParams.get("txid") ?? "";
  const block = url.searchParams.get("block");
  if (!TXID.test(txid) || (block !== null && !/^\d{1,10}$/.test(block))) {
    return { error: "txid must be 64 lowercase hex characters; block must be a non-negative integer" };
  }
  return { txid, block: block === null ? null : Math.min(Number(block), CONFIG.numBlocks - 1) };
}

// Only the film's blocks count: a transaction after its latest block is out of reach, and a spend
// after it counts as unspent, as in the history. This keeps a cached answer true for the release.
function filmHeight(status) {
  return status?.confirmed && Number.isInteger(status.block_height) && status.block_height < CONFIG.numBlocks
    ? status.block_height
    : null;
}

// The landscape dataset in the same bucket keeps the film's change log as block-aligned chunks
// (landscape/SPEC.md). A block's record lists every output spent in it with the block that created it.
let chunkList = null;
function changeChunks(env) {
  chunkList ??= env.VIDEO_BUCKET.get("landscape/" + LANDSCAPE.dataset.id + "/chunks.json")
    .then((object) => {
      if (!object) throw new Error("change chunk list unavailable");
      return object.json();
    })
    .then((list) => list.chunks)
    .catch((error) => {
      chunkList = null;
      throw error;
    });
  return chunkList;
}

// amount -> the creation block of each output of that amount spent in block 'height'.
async function spendsIn(env, height) {
  if (height > LANDSCAPE.dataset.tip) return new Map();
  const chunks = await changeChunks(env);
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid].firstBlock <= height) lo = mid;
    else hi = mid - 1;
  }
  const chunk = chunks[lo];
  if (!chunk || chunk.firstBlock > height || chunk.lastBlock < height || !TXID.test(chunk.sha256)) {
    throw new Error("no change chunk for block " + height);
  }
  const object = await env.VIDEO_BUCKET.get("landscape/blobs/" + chunk.sha256);
  if (!object) throw new Error("change chunk unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const block = new DecodedBlock();
  decodeBlock(bytes, indexRecords(bytes, chunk.firstBlock).offsets[height - chunk.firstBlock], block);
  const spends = new Map();
  for (let k = 0; k < block.count; k++) {
    const satoshi = -block.sats[k];
    if (satoshi <= 0) continue;
    if (!spends.has(satoshi)) spends.set(satoshi, []);
    spends.get(satoshi).push(block.heights[k]);
  }
  return spends;
}

// An input's amount names its creation block when every output of that amount spent in the
// same block was created in one block. When this transaction spent all of them, their blocks
// are right as a group (shared), though not which input came from which. Otherwise the input
// asks mempool.space for the transaction that created it, largest amounts first, up to
// LOOKUP_LIMIT transactions; the rest keep height null and are listed without a line.
async function dateInputs(env, height, inputs) {
  const spends = await spendsIn(env, height);
  const mine = new Map(); // amount -> this transaction's inputs of that amount
  for (const input of inputs) if (input.satoshi > 0) mine.set(input.satoshi, [...(mine.get(input.satoshi) ?? []), input]);
  const ask = new Map();
  for (const [satoshi, list] of mine) {
    const heights = spends.get(satoshi) ?? [];
    if (heights.length && heights.every((h) => h === heights[0])) for (const input of list) input.height = heights[0];
    else if (heights.length === list.length) list.forEach((input, k) => Object.assign(input, { height: heights[k], shared: true }));
    else for (const input of list) ask.set(input.txid, [...(ask.get(input.txid) ?? []), input]);
  }
  const largest = (list) => Math.max(...list.map((input) => input.satoshi));
  const asked = [...ask].sort((a, b) => largest(b[1]) - largest(a[1])).slice(0, LOOKUP_LIMIT);
  await Promise.all(asked.map(async ([id, list]) => {
    const created = filmHeight(await upstream(`/tx/${id}/status`, true));
    for (const input of list) input.height = created;
  }));
}

// One whole transaction: every input with the block that created it, every output with the
// transaction that spent it.
export async function txResponse(env, { txid }) {
  try {
    const [tx, spends] = await Promise.all([
      upstream(`/tx/${txid}`, true),
      upstream(`/tx/${txid}/outspends`, true),
    ]);
    const height = filmHeight(tx.status);
    if (height === null) {
      return json({ error: tx.status?.confirmed
        ? "This transaction is in block " + Number(tx.status.block_height).toLocaleString("en-US") + ", after the film's latest block"
        : "This transaction is not in a block yet" }, 404);
    }
    const coinbase = tx.vin[0]?.is_coinbase === true;
    const inputs = coinbase ? [] : tx.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout, satoshi: vin.prevout?.value, height: null }));
    const outputs = tx.vout.map((out, vout) => {
      const spent = spends[vout]?.spent ? filmHeight(spends[vout].status) : null;
      return { vout, satoshi: out.value, spent: spent === null ? null : { txid: spends[vout].txid, height: spent } };
    });
    if (
      [...inputs, ...outputs].some((point) => !Number.isSafeInteger(point.satoshi) || point.satoshi < 0) ||
      inputs.some((input) => !TXID.test(input.txid) || !Number.isInteger(input.vout)) ||
      outputs.some((out) => out.spent && !TXID.test(out.spent.txid))
    ) throw new Error("bad upstream transaction");
    if (!coinbase) await dateInputs(env, height, inputs);
    return json({ txid, height, coinbase, inputs, outputs });
  } catch (error) {
    if (error?.message === "upstream 404") return json({ error: "No such transaction" }, 404);
    console.warn("transaction lookup failed", error?.message || error);
    return json({ error: "Bitcoin lookup service is temporarily unavailable" }, 503);
  }
}

// Film pixels for a transaction seen at 'block'. A point created after that block has none yet.
export function placeTx(tx, block) {
  const at = (point, height) => height !== null && height <= block && point.satoshi > 0
    ? { ...point, x: blockToX(height, block), y: satoshiToY(point.satoshi) }
    : point;
  const value = tx.outputs.reduce((sum, out) => sum + out.satoshi, 0);
  return {
    ...tx,
    block,
    // The transaction itself sits on its block's column, at the row of the value it moved.
    hub: tx.height <= block ? { x: blockToX(tx.height, block), y: satoshiToY(Math.max(1, value)) } : null,
    inputs: tx.inputs.map((input) => at(input, input.height)),
    outputs: tx.outputs.map((out) => at(out, tx.height)),
  };
}
