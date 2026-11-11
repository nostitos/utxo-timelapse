import assert from 'node:assert/strict';
import {historySource} from '../../cloudflare/utxo-video-worker/src/history_sources.js';
const newer = {numBlocks:1030,historyShardSources:{
  0:{baseKey:'explorer/base/shards/00000.bin',baseTip:511,patchKey:'explorer/new/spends/00000.bin'},
  1:{baseKey:'explorer/old/shards/00001.bin',baseTip:1024},
  2:{baseKey:'explorer/new/shards/00002.bin',baseTip:1029}}};
assert.deepEqual(historySource(newer,1),newer.historyShardSources[1]);
assert.equal(historySource(newer,0).baseTip,511);
assert.equal(historySource(newer,2).baseTip,1029);
assert.throws(()=>historySource(newer,3),/invalid/);
assert.throws(()=>historySource({...newer,numBlocks:500},0),/invalid/);
assert.throws(()=>historySource({numBlocks:1030},0),/missing/,'a release without the per-shard catalog');
console.log('history source routing: 6 checks passed');
