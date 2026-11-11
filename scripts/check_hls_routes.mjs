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
