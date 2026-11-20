// The node itself, for the lookups its Mempool app cannot answer well (landscape/tools/serve.mjs,
// --node). Mempool in Electrum mode cannot name the transaction that spent an output, and takes
// 6 to 16 s over a transaction with hundreds of inputs, so the online Worker asks mempool.space
// for those two. Locally the node's own Bitcoin Core (REST) and Electrum server answer them:
//
//   outspends(txid)  Core says which outputs are unspent; for the others the Electrum history of
//                    the output's script lists the candidates, the change log says which of their
//                    blocks spent an output of that amount and age, and the candidate whose
//                    inputs name the output is its spender.
//   spender(txid, n) The same for one output: what a hop forward needs, in a fraction of the time.
//   bigTx(txid)      Core's block JSON carries every input's amount and creation block (its undo
//                    data), so one answer holds what Mempool gathers one prevout at a time.
//   heightOf(hash)   Core's header: the height Mempool derives from a tip that lags for a moment
//                    after each block.
//
// Both return what Mempool's /tx/<txid>/outspends and /tx/<txid> would, for
// cloudflare/utxo-video-worker/src/bitcoin.js (env.OUTSPENDS, env.BIG_TX, env.HEIGHT_OF).
import { createHash } from 'node:crypto';
import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import { spentOutpoints } from '../../cloudflare/utxo-video-worker/src/bitcoin.js';

const SPENDER_SCAN = 2000; // candidates whose inputs are read for one output's spender, after the change log's filter
const POOL = 8;            // requests to the node at a time
const RAW_KEPT = 4000;     // candidates' outpoints kept in memory

const sats = (btc) => Math.round(btc * 1e8);

/** Runs work over items, POOL at a time. */
async function pooled(items, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/** A line-delimited JSON-RPC client for an Electrum server: 'ssl://host:port' or 'tcp://host:port'. */
function electrumClient(address) {
  const m = /^(ssl|tcp):\/\/([^:/]+):(\d+)$/.exec(address);
  if (!m) throw new Error('--electrum must look like tcp://192.168.8.234:50002 (or ssl://)');
  let socket = null;
  let buffer = '';
  let id = 0;
  const waiting = new Map();
  const fail = (err) => {
    socket = null;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  function open() {
    // An Umbrel's Electrum certificate is self-signed, and the server is on the local network.
    const s = m[1] === 'ssl' ? tls({ host: m[2], port: Number(m[3]), rejectUnauthorized: false }) : tcp({ host: m[2], port: Number(m[3]) });
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buffer += d;
      for (let nl; (nl = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        const w = waiting.get(msg.id);
        if (!w) continue;
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error('electrum: ' + (msg.error.message || JSON.stringify(msg.error))));
        else w.resolve(msg.result);
      }
    });
    s.on('error', (err) => { if (socket === s) fail(err); });
    s.on('close', () => { if (socket === s) fail(new Error('electrum connection closed')); });
    socket = s;
    buffer = '';
    send('server.version', ['utxo-timelapse', ['1.4', '1.6']]).catch(() => {});
  }
  // A server may close the connection under load: one more try on a fresh one.
  const call = (method, params) => send(method, params).catch((err) => (/closed|ECONNRESET|EPIPE/.test(err.message) ? send(method, params) : Promise.reject(err)));
  function send(method, params) {
    if (!socket) open();
    return new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { waiting.delete(n); reject(new Error('electrum timed out')); }, 20000);
      waiting.set(n, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  }
  return { call, close: () => socket?.destroy() };
}

/**
 * core: Bitcoin Core's address ('http://192.168.8.234:8332'; its REST interface must be on).
 * electrum: the Electrum server ('tcp://192.168.8.234:50002', or ssl://). spendsAt(height):
 * amount -> the creation blocks of the outputs of that amount spent in that block (the change
 * log), which spares reading every later transaction of a reused script. tip: the landscape's
 * latest block; a spend after it does not count. fetchImpl: for tests.
 * Returns {outspends, spender, bigTx, heightOf, close}.
 */
export function nodeDirect({ core, electrum, spendsAt = null, tip = Infinity, fetchImpl = fetch }) {
  const rest = String(core).replace(/\/+$/, '') + '/rest';
  const client = electrumClient(electrum);
  const get = async (path, kind = 'json') => {
    const r = await fetchImpl(rest + path, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('Bitcoin Core REST ' + r.status + ' for ' + path);
    return kind === 'json' ? r.json() : (await r.text()).trim();
  };
  const heights = new Map(); // block hash -> height
  async function heightOf(hash) {
    if (!heights.has(hash)) heights.set(hash, (await get('/headers/1/' + hash + '.json'))[0].height);
    return heights.get(hash);
  }
  const spends = new Map(); // txid -> Set of "txid:vout" it spends
  async function spendsOf(txid) {
    if (!spends.has(txid)) {
      spends.set(txid, new Set(spentOutpoints(await get('/tx/' + txid + '.hex', 'text')).map((o) => o.txid + ':' + o.vout)));
      if (spends.size > RAW_KEPT) spends.delete(spends.keys().next().value);
    }
    return spends.get(txid);
  }

  let ranged = Number.isFinite(tip); // the Electrum server takes a block range with a history (Fulcrum does)
  const txs = new Map(); // txid -> {height, vout: [{sat, script}]}, the last few
  async function txOf(txid) {
    if (!txs.has(txid)) {
      const tx = await get('/tx/' + txid + '.json');
      txs.set(txid, { height: await heightOf(tx.blockhash), vout: tx.vout.map((o) => ({ sat: sats(o.value), script: o.scriptPubKey?.hex || '' })) });
      if (txs.size > 500) txs.delete(txs.keys().next().value);
    }
    return txs.get(txid);
  }

  /** Whether each of the outputs 'indexes' of a transaction is in Core's UTXO set (15 outpoints a question). */
  async function unspentOf(txid, indexes) {
    const unspent = new Map();
    const batches = [];
    for (let i = 0; i < indexes.length; i += 15) batches.push(indexes.slice(i, i + 15));
    await pooled(batches, async (batch) => {
      const a = await get('/getutxos/' + batch.map((i) => txid + '-' + i).join('/') + '.json');
      batch.forEach((i, k) => unspent.set(i, a.bitmap[k] === '1'));
    });
    return unspent;
  }

  /** The spender of output i, {spent: true, txid, status} as Mempool gives it, or {spent: false}. histories: the script histories asked for this transaction, so outputs of one script share them. */
  async function spenderOf(txid, tx, i, histories) {
    const o = tx.vout[i];
    if (!o.script) return { spent: false };
    const scripthash = createHash('sha256').update(Buffer.from(o.script, 'hex')).digest().reverse().toString('hex');
    // An output is usually spent soon, and a reused script has thousands of later transactions:
    // its history is asked for in windows of blocks, 16 first and 8 times wider each time. A
    // server that takes no range gives it whole.
    let read = 0;
    for (let from = tx.height, span = 16; from <= tip; span *= 8) {
      const to = ranged ? Math.min(tip + 1, from + span) : Infinity;
      const key = scripthash + ':' + from;
      if (!histories.has(key)) {
        histories.set(key, ranged && Number.isFinite(to)
          ? client.call('blockchain.scripthash.get_history', [scripthash, from, to]).catch((err) => {
            if (!/electrum:/.test(err.message)) throw err;
            ranged = false; // the server refused the range, not the question
            return client.call('blockchain.scripthash.get_history', [scripthash]);
          })
          : client.call('blockchain.scripthash.get_history', [scripthash]));
      }
      // The spender is confirmed at or after this transaction's block; nearest first.
      const candidates = (await histories.get(key)).filter((h) => h.height >= from && h.height <= tip && h.tx_hash !== txid).sort((x, y) => x.height - y.height);
      for (const c of candidates) {
        if (spendsAt && !((await spendsAt(c.height)).get(o.sat) ?? []).includes(tx.height)) continue;
        if (++read > SPENDER_SCAN) throw new Error('output ' + i + ' pays a script with more than ' + SPENDER_SCAN + ' later transactions to read');
        if ((await spendsOf(c.tx_hash)).has(txid + ':' + i)) return { spent: true, txid: c.tx_hash, status: { confirmed: true, block_height: c.height } };
      }
      if (!Number.isFinite(to)) break;
      from = to;
    }
    return { spent: false };
  }

  async function spender(txid, i) {
    const tx = await txOf(txid);
    if (!tx.vout[i] || (await unspentOf(txid, [i])).get(i)) return { spent: false };
    return spenderOf(txid, tx, i, new Map());
  }

  async function outspends(txid) {
    const tx = await txOf(txid);
    const out = tx.vout.map(() => ({ spent: false }));
    const unspent = await unspentOf(txid, tx.vout.map((o, i) => i));
    const histories = new Map();
    await pooled(tx.vout.map((o, i) => i).filter((i) => !unspent.get(i)), async (i) => { out[i] = await spenderOf(txid, tx, i, histories); });
    return out;
  }

  async function bigTx(txid) {
    const hash = (await get('/tx/' + txid + '.json')).blockhash;
    const [block, height] = await Promise.all([get('/block/' + hash + '.json'), heightOf(hash)]);
    const tx = block.tx.find((t) => t.txid === txid);
    if (!tx) throw new Error('transaction not in its block');
    return {
      vin: tx.vin.map((v) => (v.coinbase ? { is_coinbase: true } : { txid: v.txid, vout: v.vout, prevout: { value: sats(v.prevout.value), height: v.prevout.height } })),
      vout: tx.vout.map((o) => ({ value: sats(o.value) })),
      status: { confirmed: true, block_height: height, block_hash: hash },
    };
  }

  return { outspends, spender, bigTx, heightOf, close: () => client.close() };
}
