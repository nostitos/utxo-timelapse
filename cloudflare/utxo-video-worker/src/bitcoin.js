import { CONFIG } from "./mapping.js";

const UPSTREAM = "https://mempool.space/api";

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
      .filter((item) => typeof txids[item.transactionIndex] === "string")
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
