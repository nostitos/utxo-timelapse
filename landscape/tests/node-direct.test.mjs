// Tests for landscape/tools/node-direct.mjs: spenders and large transactions from the node's own
// Bitcoin Core (REST) and Electrum server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { nodeDirect } from '../tools/node-direct.mjs';

const id = (n) => n.toString(16).padStart(64, '0');
// A raw transaction spending the given outpoints, with no outputs.
const raw = (outpoints) => '0200000001'.slice(0, 8) + outpoints.length.toString(16).padStart(2, '0') +
  outpoints.map(([txid, vout]) => txid.match(/../g).reverse().join('') + Buffer.from(Uint32Array.of(vout).buffer).toString('hex') + '00ffffffff').join('') + '0000000000';
const scripthash = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest().reverse().toString('hex');

test('outspends: Core names the unspent, Electrum the candidates, the change log and the inputs the spender', async () => {
  const [T, X, Y] = [1, 2, 3].map(id);
  const asked = [];
  const rest = {
    ['/rest/tx/' + T + '.json']: { blockhash: 'bh', vout: [{ value: 0.5, scriptPubKey: { hex: '51' } }, { value: 0.25, scriptPubKey: { hex: '52' } }, { value: 0, scriptPubKey: { hex: '6a' } }] },
    '/rest/headers/1/bh.json': [{ height: 10 }],
    ['/rest/getutxos/' + T + '-0/' + T + '-1/' + T + '-2.json']: { bitmap: '100' },
    ['/rest/tx/' + X + '.hex']: raw([[id(9), 0], [T, 1]]),
    ['/rest/tx/' + Y + '.hex']: raw([[T, 7]]),
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const a = rest[path];
    return a === undefined ? new Response('not found', { status: 404 }) : new Response(typeof a === 'string' ? a : JSON.stringify(a));
  };
  // An Electrum server that knows the two scripts' histories.
  const histories = {
    [scripthash('52')]: [{ tx_hash: T, height: 10 }, { tx_hash: Y, height: 11 }, { tx_hash: X, height: 12 }, { tx_hash: id(8), height: 99 }],
    [scripthash('6a')]: [{ tx_hash: T, height: 10 }],
  };
  const electrum = createServer((socket) => {
    let buffer = '';
    socket.on('data', (d) => {
      buffer += d;
      for (let nl; (nl = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(nl + 1)) {
        const m = JSON.parse(buffer.slice(0, nl));
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'server.version' ? ['stub', '1.4'] : histories[m.params[0]] }) + '\n');
      }
    });
  });
  await new Promise((r) => electrum.listen(0, '127.0.0.1', r));
  // Block 11 spent nothing of 0.25 BTC made in block 10; block 12 did.
  const spendsAt = async (height) => new Map(height === 12 ? [[25000000, [10]]] : []);
  const direct = nodeDirect({ core: 'http://core.test:8332/', electrum: 'tcp://127.0.0.1:' + electrum.address().port, spendsAt, tip: 50, fetchImpl });
  try {
    assert.deepEqual(await direct.outspends(T), [{ spent: false }, { spent: true, txid: X, status: { confirmed: true, block_height: 12 } }, { spent: false }]);
    assert.ok(!asked.includes('/rest/tx/' + Y + '.hex'), 'a candidate in a block that spent no such output is not read');
    assert.ok(!asked.includes('/rest/tx/' + id(8) + '.hex'), 'nor one after the landscape\u2019s latest block');
  } finally {
    direct.close();
    electrum.close();
  }
});

test('bigTx: one block answer gives every input its amount and creation block', async () => {
  const [T, P] = [1, 2].map(id);
  const rest = {
    ['/rest/tx/' + T + '.json']: { blockhash: 'bh' },
    '/rest/headers/1/bh.json': [{ height: 20 }],
    '/rest/block/bh.json': { tx: [{ txid: id(5), vin: [{ coinbase: '00' }], vout: [] },
      { txid: T, vin: [{ txid: P, vout: 3, prevout: { value: 0.1, height: 7 } }], vout: [{ value: 0.09999 }] }] },
  };
  const fetchImpl = async (url) => new Response(JSON.stringify(rest[new URL(url).pathname]));
  const direct = nodeDirect({ core: 'http://core.test:8332', electrum: 'tcp://127.0.0.1:1', fetchImpl });
  assert.deepEqual(await direct.bigTx(T), { vin: [{ txid: P, vout: 3, prevout: { value: 10000000, height: 7 } }], vout: [{ value: 9999000 }],
    status: { confirmed: true, block_height: 20, block_hash: 'bh' } });
  assert.equal(await direct.heightOf('bh'), 20);
});
