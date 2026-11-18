import { CONFIG, blockToX, satoshiToY } from "./mapping.js";

const UPSTREAM = "https://mempool.space/api";
const TXID = /^[0-9a-f]{64}$/;
// Inputs and outputs listed per side of a trace, largest first. Each listed input costs one upstream request.
const TRACE_LIMIT = 24;

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

export function traceQuery(url) {
  const txid = url.searchParams.get("txid") ?? "";
  const vout = url.searchParams.get("vout") ?? "";
  const block = url.searchParams.get("block");
  if (!TXID.test(txid) || !/^\d{1,5}$/.test(vout) || (block !== null && !/^\d{1,10}$/.test(block))) {
    return { error: "txid must be 64 hex characters; vout and block must be non-negative integers" };
  }
  return { txid, vout: Number(vout), block: block === null ? null : Math.min(Number(block), CONFIG.numBlocks - 1) };
}

// One hop either side of an output: the inputs of the transaction that created it and the
// outputs of the transaction that spent it. A transaction does not record which input paid
// which output, so both lists are whole sides of a transaction, largest amounts first.
// Only the film's blocks count: a spend after its latest block is reported as unspent, as in
// the history, which also keeps a cached answer true for the whole release.
export async function traceResponse({ txid, vout }) {
  const filmHeight = (status) =>
    status?.confirmed && Number.isInteger(status.block_height) && status.block_height < CONFIG.numBlocks
      ? status.block_height
      : null;
  const largest = (items) =>
    items
      .filter((item) => Number.isSafeInteger(item.satoshi) && item.satoshi > 0)
      .sort((a, b) => b.satoshi - a.satoshi)
      .slice(0, TRACE_LIMIT);
  const missing = () => json({ error: "No such output in the film's blocks" }, 404);
  try {
    const [tx, spent] = await Promise.all([
      upstream(`/tx/${txid}`, true),
      upstream(`/tx/${txid}/outspend/${vout}`, true),
    ]);
    const height = filmHeight(tx.status);
    const satoshi = tx.vout[vout]?.value;
    if (height === null || !Number.isSafeInteger(satoshi)) return missing();
    const coinbase = tx.vin[0].is_coinbase === true;
    const inputs = coinbase
      ? []
      : largest(tx.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout, satoshi: vin.prevout?.value })));
    const spendHeight = spent.spent ? filmHeight(spent.status) : null;
    if (spendHeight !== null && !TXID.test(spent.txid)) throw new Error("bad upstream spending txid");
    const [created, spender] = await Promise.all([
      Promise.all(
        [...new Set(inputs.map((input) => input.txid))].map(async (id) => {
          if (!TXID.test(id)) throw new Error("bad upstream input txid");
          return [id, filmHeight(await upstream(`/tx/${id}/status`, true))];
        }),
      ),
      spendHeight === null ? null : upstream(`/tx/${spent.txid}`, true),
    ]);
    const heights = new Map(created);
    for (const input of inputs) {
      input.height = heights.get(input.txid);
      if (input.height === null || !Number.isInteger(input.vout)) throw new Error("bad upstream input");
    }
    return json({
      txid,
      vout,
      coinbase,
      output: { height, satoshi },
      inputs,
      inputCount: coinbase ? 0 : tx.vin.length,
      spend: spender && {
        txid: spent.txid,
        height: spendHeight,
        inputCount: spender.vin.length,
        outputs: largest(spender.vout.map((out, index) => ({ vout: index, satoshi: out.value }))),
        outputCount: spender.vout.length,
      },
    });
  } catch (error) {
    if (error?.message === "upstream 404") return missing();
    console.warn("trace failed", error?.message || error);
    return json({ error: "Bitcoin lookup service is temporarily unavailable" }, 503);
  }
}

// Film pixels for a trace as seen at 'block'. A point created after that block has no pixel yet.
export function placeTrace(trace, block) {
  const place = (point, height) =>
    height <= block ? { ...point, x: blockToX(height, block), y: satoshiToY(point.satoshi) } : point;
  return {
    ...trace,
    block,
    output: place(trace.output, trace.output.height),
    inputs: trace.inputs.map((input) => place(input, input.height)),
    spend: trace.spend && {
      ...trace.spend,
      outputs: trace.spend.outputs.map((out) => place(out, trace.spend.height)),
    },
  };
}
