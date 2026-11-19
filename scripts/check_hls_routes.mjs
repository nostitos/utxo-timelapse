import assert from 'node:assert/strict';
import worker from '../cloudflare/utxo-video-worker/src/index.js';
import { RELEASE } from '../cloudflare/utxo-video-worker/src/release.js';

const cache=new Map();
globalThis.caches = {default:{
  match:async req=>{const e=cache.get(req.url);return e?new Response(e.body.slice(0),{status:e.status,headers:e.headers}):undefined;},
  put:async (req,res)=>{cache.set(req.url,{status:res.status,headers:[...res.headers],body:await res.arrayBuffer()});},
}};
const seen=[];
const gets=[];
const body=new Uint8Array([1,2,3,4]);
const meta={size:4,httpEtag:'"fixture"',writeHttpMetadata:()=>{}};
const env={VIDEO_BUCKET:{
  head:async key=>{seen.push(key);return meta;},
  get:async (key,options)=>{
    gets.push(key);
    if (key === RELEASE.sitePrefix + '/info.json') return {json:async()=>({
      videoUrl:'/hls/v10/media.m3u8',
      videoRenditions:{full:{url:'/hls/v10/media.m3u8'},compat:{url:'/hls/compat6/media.m3u8'}}
    })};
    return {...meta,body:new Blob([options?.range ? body.slice(options.range.offset,options.range.offset+options.range.length):body]).stream()};
  }
}};
let pending=[];
const ctx={waitUntil:p=>pending.push(p)};
const settle=async()=>{await Promise.all(pending);pending=[];};
const hash='a'.repeat(64);
for(const path of ['/hls/v1/init.mp4','/hls/v5/segment_01611.m4s','/hls/v6/segment_01611.m4s','/hls/v7/segment_01617.m4s','/hls/v7/media.m3u8','/hls/v8/segment_01619.m4s','/hls/v8/media.m3u8','/hls/v9/segment_01621.m4s','/hls/v9/media.m3u8','/hls/v10/segment_01624.m4s','/hls/v10/media.m3u8',`/hls/compat1/${hash}.mp4`,`/hls/compat1/${hash}.m4s`,`/hls/compat2/${hash}.m4s`,'/hls/compat3/media.m3u8',`/hls/compat3/${hash}.m4s`,'/hls/compat4/media.m3u8',`/hls/compat4/${hash}.m4s`,'/hls/compat5/media.m3u8',`/hls/compat5/${hash}.m4s`,'/hls/compat6/media.m3u8',`/hls/compat6/${hash}.m4s`]) {
  const r=await worker.fetch(new Request('https://example.test'+path,{method:'HEAD'}),env,ctx);
  assert.equal(r.status,200,path);assert.equal(seen.at(-1),path.slice(1));
}
for (const prefix of ['v1','v2','v3','v4','v5','v6','compat1','compat2']) {
  for (const method of ['GET','HEAD']) {
    const path='/hls/'+prefix+'/media.m3u8';
    const headsBefore=seen.length;
    const r=await worker.fetch(new Request('https://example.test'+path,{method}),env,ctx);
    const target=prefix.startsWith('compat') ? '/hls/compat6/media.m3u8' : '/hls/v10/media.m3u8';
    assert.equal(r.status,307,path);
    assert.equal(r.headers.get('Location'),'https://example.test'+target);
    assert.equal(r.headers.get('Cache-Control'),'no-store');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*');
    assert.equal(r.headers.get('X-Worker-Version'),RELEASE.version);
    assert.equal(await r.text(),'');
    assert.equal(seen.length,headsBefore,'a retired playlist never reads its removed object');
  }
}
assert.equal(gets.filter(k=>k===RELEASE.sitePrefix+'/info.json').length,1,'reuse immutable release metadata');
const ranged=await worker.fetch(new Request(`https://example.test/hls/compat1/${hash}.m4s`,{headers:{Range:'bytes=1-2'}}),env,ctx);
assert.equal(ranged.status,206);assert.equal(ranged.headers.get('Content-Range'),'bytes 1-2/4');
assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())],[2,3]);
for(const path of ['/hls/compat1/segments.json','/hls/compat1/short.mp4','/hls/compat7/media.m3u8','/hls/v11/media.m3u8','/hls/compat1/%2e%2e/private.json']) {
  const count=seen.length;
  const r=await worker.fetch(new Request('https://example.test'+path),env,ctx);
  assert.equal(r.status,404,path);assert.equal(seen.length,count,'unallowlisted R2 read');
}
console.log('PASS: current/rollback HLS, retired-playlist redirects, shared old segments, HEAD/range, and private-object rejection');

// The edge cache answers a segment again, and its 304, without an R2 call (r2_object.js).
const segment='https://example.test/hls/v10/segment_01624.m4s';
const first=await worker.fetch(new Request(segment),env,ctx);
assert.equal(first.status,200);assert.deepEqual([...new Uint8Array(await first.arrayBuffer())],[1,2,3,4]);await settle();
const calls=seen.length+gets.length;
const again=await worker.fetch(new Request(segment),env,ctx);
assert.equal(again.status,200);assert.deepEqual([...new Uint8Array(await again.arrayBuffer())],[1,2,3,4]);
assert.equal(again.headers.get('Content-Type'),'video/iso.segment');assert.equal(again.headers.get('X-Worker-Version'),RELEASE.version);
const unchanged=await worker.fetch(new Request(segment,{headers:{'If-None-Match':'"fixture"'}}),env,ctx);
assert.equal(unchanged.status,304);
assert.equal(seen.length+gets.length,calls,'a cached segment needs no R2 call');
const two=await worker.fetch(new Request(segment,{headers:{Range:'bytes=0-0,2-3'}}),env,ctx);
assert.equal(two.status,200,'a multi-range request gets the whole object');
console.log('PASS: cached segments and 304 without R2 calls; multi-range requests get the whole object');

// API answers are cached under their validated parameters alone (index.js cachedApi).
const entries=cache.size;
for (const q of ['block=100&x=3000&y=500&a=1','y=500&x=3000&block=100&b=2']) {
  const r=await worker.fetch(new Request('https://example.test/api/pixel?'+q),env,ctx);
  assert.equal(r.status,200,q);assert.equal((await r.json()).overlay,'flowline',q);await settle();
}
assert.equal(cache.size,entries+1,'extra parameters and their order share one cache entry');
const invalid=await worker.fetch(new Request('https://example.test/api/pixel?block=1&x=1'),env,ctx);
assert.equal(invalid.status,400);await settle();
assert.equal(cache.size,entries+1,'an invalid query is not cached');
console.log('PASS: API cache keys hold only the validated parameters');

// /api/tx: one whole transaction, from a stubbed mempool.space and a stubbed change chunk.
{
  const { blockToX, columnBlockRange, rowSatoshiRange, satoshiToY } = await import('../cloudflare/utxo-video-worker/src/mapping.js');
  const { encodeBlock } = await import('../landscape/web/replay/blk2.js');
  const { RELEASE: LANDSCAPE } = await import('../cloudflare/utxo-landscape-worker/src/release.js');
  const id = n => n.toString(16).padStart(64, '0');
  const confirmed = height => ({ confirmed: true, block_height: height });
  const [S, A, P, Q, T, U, M, C, late, pending] = [0x5, 0xa, 0xb, 0xd, 0xe, 0xf, 0x6, 0xc, 0x7, 0x8].map(id);
  // Block 2000 spends 5000 sat created in 1000 and 900 sat created in 1700, so those amounts name
  // their blocks. Two 700 sat outputs of different ages are spent too, so 700 needs a lookup.
  // Block 3000 spends thirty amounts twice each, from outputs created in blocks 100 and 200, and
  // a sweep spends one of each. It also spends three more amounts twice each, both times by the sweep.
  const chunks = {
    ['landscape/' + LANDSCAPE.dataset.id + '/chunks.json']: { chunks: [
      { firstBlock: 1999, lastBlock: 2000, sha256: 'a'.repeat(64) },
      { firstBlock: 3000, lastBlock: 3000, sha256: 'b'.repeat(64) },
    ] },
    ['landscape/blobs/' + 'a'.repeat(64)]: new Uint8Array([
      ...encodeBlock(1999, [[50, 1999]]),
      ...encodeBlock(2000, [[-5000, 1000], [-700, 1500], [-700, 1600], [-900, 1700], [3000, 2000], [2500, 2000]]),
    ]),
    ['landscape/blobs/' + 'b'.repeat(64)]: encodeBlock(3000, [[1, 3000], ...[...Array(30).keys(), 100, 101, 102].map(i => [[-(400 + i), 100], [-(400 + i), 200]]).flat()]),
  };
  const realGet = env.VIDEO_BUCKET.get;
  env.VIDEO_BUCKET.get = async (key, options) => key in chunks
    ? { json: async () => chunks[key], arrayBuffer: async () => chunks[key].buffer.slice(0) }
    : realGet(key, options);
  const upstreamJson = {
    ['/tx/' + S]: { status: confirmed(2000), vout: [{ value: 0 }, { value: 3000 }, { value: 2500 }],
      vin: [{ txid: A, vout: 0, prevout: { value: 5000 } }, { txid: P, vout: 1, prevout: { value: 700 } }, { txid: Q, vout: 0, prevout: { value: 900 } }] },
    ['/tx/' + S + '/outspends']: [{ spent: false }, { spent: true, txid: T, status: confirmed(2100) }, { spent: true, txid: U, status: confirmed(RELEASE.numBlocks) }],
    ['/tx/' + P + '/status']: confirmed(1500),
    ['/tx/' + M]: { status: confirmed(3000), vout: [{ value: 12000 }],
      vin: [...Array.from({ length: 30 }, (_, i) => ({ txid: id(200 + i), vout: 0, prevout: { value: 400 + i } })),
        ...[0, 1, 2].map(i => [{ txid: id(300 + i), vout: 0, prevout: { value: 500 + i } }, { txid: id(310 + i), vout: 1, prevout: { value: 500 + i } }]).flat()] },
    ['/tx/' + M + '/outspends']: [{ spent: false }],
    ['/tx/' + C]: { status: confirmed(10), vin: [{ is_coinbase: true }], vout: [{ value: 5000000000 }] },
    ['/tx/' + C + '/outspends']: [{ spent: false }],
    ['/tx/' + late]: { status: confirmed(RELEASE.numBlocks), vin: [], vout: [] },
    ['/tx/' + late + '/outspends']: [],
    ['/tx/' + pending]: { status: { confirmed: false }, vin: [], vout: [] },
    ['/tx/' + pending + '/outspends']: [],
  };
  for (let i = 0; i < 30; i++) upstreamJson['/tx/' + id(200 + i) + '/status'] = confirmed(100);
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = String(url).replace('https://mempool.space/api', '');
    asked.push(path);
    return path in upstreamJson ? Response.json(upstreamJson[path]) : new Response('not found', { status: 404 });
  };
  let client = 0;
  const tx = async query => {
    const r = await worker.fetch(new Request('https://example.test/api/tx?' + query, { headers: { 'CF-Connecting-IP': '10.0.0.' + client++ } }), env, ctx);
    await settle();
    return { status: r.status, body: await r.json() };
  };

  const seen = (await tx('txid=' + S + '&block=2500')).body;
  assert.deepEqual(seen.inputs.map(i => i.height), [1000, 1500, 1700], 'amounts name their blocks; the ambiguous 700 is looked up');
  assert.equal(asked.length, 3, 'the transaction, its spends and one lookup for the ambiguous input');
  for (const point of seen.inputs) {
    const [h1, h2] = columnBlockRange(point.x, 2500), [s1, s2] = rowSatoshiRange(point.y);
    assert(h1 <= point.height && point.height <= h2 && s1 <= point.satoshi && point.satoshi <= s2, 'a point lies in the pixel the explorer would query');
  }
  assert.deepEqual(seen.hub, { x: blockToX(2000, 2500), y: satoshiToY(5500) }, 'the transaction sits on its column at the row of the value it moved');
  assert.equal(seen.outputs[0].x, undefined, 'a zero-value output has no row');
  assert.deepEqual(seen.outputs.map(o => o.spent), [null, { txid: T, height: 2100 }, null], 'a spend after the film counts as unspent');

  const before = (await tx('block=1500&txid=' + S)).body;
  assert.equal(asked.length, 3, 'another viewed block reuses the cached lookup');
  assert.equal(before.hub, null, 'nothing of a later transaction is drawn');
  assert.deepEqual(before.inputs.map(i => i.x !== undefined), [true, true, false]);
  assert.equal((await tx('txid=' + S)).body.hub, undefined, 'no block, no pixels');

  const sweep = (await tx('txid=' + M + '&block=3000')).body;
  assert.equal(asked.length, 3 + 2 + 24, 'ambiguous inputs are looked up for at most 24 transactions');
  assert.deepEqual(sweep.inputs.filter(i => i.height === null).map(i => i.satoshi), [400, 401, 402, 403, 404, 405], 'the smallest stay undated');
  assert(sweep.inputs.filter(i => i.satoshi >= 406 && i.satoshi < 500).every(i => i.height === 100 && !i.shared), 'the looked-up ones are exact');
  const grouped = sweep.inputs.filter(i => i.satoshi >= 500);
  assert(grouped.length === 6 && grouped.every(i => i.shared), 'amounts the sweep spent entirely get their blocks as a group, without lookups');
  for (const v of [500, 501, 502]) assert.deepEqual(grouped.filter(i => i.satoshi === v).map(i => i.height).sort(), [100, 200], v + ' sat: both blocks, once each');

  const mined = (await tx('txid=' + C + '&block=1500')).body;
  assert.deepEqual([mined.coinbase, mined.inputs], [true, []]);
  assert.match((await tx('txid=' + late)).body.error, /after the film's latest block/);
  assert.match((await tx('txid=' + pending)).body.error, /not in a block yet/);
  assert.equal((await tx('txid=' + id(0xdead))).status, 404);
  for (const bad of ['txid=' + A.toUpperCase(), 'block=5', 'txid=' + S + '&block=x']) assert.equal((await tx(bad)).status, 400, bad);

  // Only lookups that reach mempool.space are rate limited, per client.
  const from = (ip, query) => worker.fetch(new Request('https://example.test/api/tx?' + query, { headers: { 'CF-Connecting-IP': ip } }), env, ctx);
  const fresh = [];
  for (let i = 0; i < 5; i++) fresh.push((await from('10.9.9.9', 'txid=' + id(0xbeef00 + i))).status);
  assert.deepEqual(fresh, [404, 404, 404, 404, 429], 'a burst of four uncached lookups, then a wait');
  assert.equal((await from('10.9.9.9', 'txid=' + S + '&block=2500')).status, 200, 'a cached transaction is still served to a client that is out of tokens');

  // A node's Mempool (env.MEMPOOL_API) answers first, through its VPC binding. It cannot name
  // spenders, so outspends come from mempool.space; a height that does not name the block its
  // hash does (the node's tip lags) sends the whole answer to mempool.space; a looked-up height
  // outside the change log's list leaves that input undated; and a node that fails is skipped.
  {
    const NODE = 'https://node.test/api';
    const [R, W, D] = [0x51, 0x52, 0x53].map(id);
    const withHash = (h) => ({ confirmed: true, block_height: h, block_hash: 'h' + h });
    upstreamJson['/block-height/2000'] = 'h2000';
    for (const t of [R, W, D]) {
      upstreamJson['/tx/' + t] = { ...upstreamJson['/tx/' + S], status: withHash(2000) };
      upstreamJson['/tx/' + t + '/outspends'] = upstreamJson['/tx/' + S + '/outspends'];
    }
    const node = {
      ['/tx/' + R]: upstreamJson['/tx/' + R],
      ['/tx/' + W]: { ...upstreamJson['/tx/' + W], status: { ...withHash(1999), block_hash: 'h2000' } },
      ['/block-height/2000']: 'h2000',
      ['/block-height/1999']: 'h1999',
      ['/tx/' + P + '/status']: confirmed(1499),
    };
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      const path = u.replace('https://mempool.space/api', '');
      calls.push(u.startsWith(NODE) ? 'node bypassed its binding' : 'public ' + path);
      const a = upstreamJson[path];
      return a === undefined ? new Response('not found', { status: 404 }) : typeof a === 'string' ? new Response(a) : Response.json(a);
    };
    const binding = { fetch: async (url) => {
      const path = String(url).slice(NODE.length);
      calls.push('node ' + path);
      if (path.startsWith('/tx/' + D)) throw new TypeError('node unreachable');
      const a = node[path];
      return a === undefined ? new Response('not found', { status: 404 }) : typeof a === 'string' ? new Response(a + '\n') : Response.json(a);
    } };
    Object.assign(env, { MEMPOOL_API: NODE + '/', MEMPOOL_NODE: binding });
    const good = (await tx('txid=' + R)).body;
    assert.deepEqual(calls.sort(), ['node /block-height/2000', 'node /tx/' + P + '/status', 'node /tx/' + R, 'public /tx/' + R + '/outspends'],
      'the node answers through its binding, except for outspends');
    assert.deepEqual(good.inputs.map((i) => i.height), [1000, null, 1700], 'a looked-up height the change log does not list leaves the input undated');
    assert.deepEqual(good.outputs[1].spent, { txid: T, height: 2100 }, 'spenders come from mempool.space');
    calls.length = 0;
    const lagging = (await tx('txid=' + W)).body;
    assert.equal(lagging.height, 2000, 'a lagging node height is not used');
    assert(calls.includes('public /tx/' + W) && calls.includes('public /tx/' + P + '/status'), 'mempool.space answers it all');
    assert.deepEqual(lagging.inputs.map((i) => i.height), [1000, 1500, 1700]);
    calls.length = 0;
    const down = await tx('txid=' + D);
    assert.equal(down.status, 200, 'a node that fails is skipped');
    assert.equal(down.body.height, 2000);
    assert(calls.includes('public /tx/' + D));
    for (const k of ['MEMPOOL_API', 'MEMPOOL_NODE']) delete env[k];
  }
  globalThis.fetch = realFetch;
  env.VIDEO_BUCKET.get = realGet;
  console.log('PASS: /api/tx dates every input from the change log, looks up ambiguous ones, places the transaction and caches it, from a node first when one is set');
}
