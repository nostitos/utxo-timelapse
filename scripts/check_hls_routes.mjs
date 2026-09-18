import assert from 'node:assert/strict';
import worker from '../cloudflare/utxo-video-worker/src/index.js';

globalThis.caches = {default:{match:async()=>null,put:async()=>{}}};
const seen=[];
const body=new Uint8Array([1,2,3,4]);
const meta={size:4,httpEtag:'"fixture"',writeHttpMetadata:()=>{}};
const env={VIDEO_BUCKET:{
  head:async key=>{seen.push(key);return meta;},
  get:async (_key,options)=>({...meta,body:options?.range ? body.slice(options.range.offset,options.range.offset+options.range.length):body})
}};
const ctx={waitUntil:()=>{}};
const hash='a'.repeat(64);
for(const path of ['/hls/v1/init.mp4','/hls/v5/segment_01611.m4s',`/hls/compat1/${hash}.mp4`,`/hls/compat1/${hash}.m4s`,'/hls/compat1/media.m3u8']) {
  const r=await worker.fetch(new Request('https://example.test'+path,{method:'HEAD'}),env,ctx);
  assert.equal(r.status,200,path);assert.equal(seen.at(-1),path.slice(1));
}
const ranged=await worker.fetch(new Request(`https://example.test/hls/compat1/${hash}.m4s`,{headers:{Range:'bytes=1-2'}}),env,ctx);
assert.equal(ranged.status,206);assert.equal(ranged.headers.get('Content-Range'),'bytes 1-2/4');
assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())],[2,3]);
for(const path of ['/hls/compat1/segments.json','/hls/compat1/short.mp4','/hls/compat2/media.m3u8','/hls/compat1/%2e%2e/private.json']) {
  const count=seen.length;
  const r=await worker.fetch(new Request('https://example.test'+path),env,ctx);
  assert.equal(r.status,404,path);assert.equal(seen.length,count,'unallowlisted R2 read');
}
console.log('PASS: hashed HLS media, legacy paths, HEAD/range, and private-object rejection');
