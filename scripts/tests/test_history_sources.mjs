import assert from 'node:assert/strict';
import {historySource} from '../../cloudflare/utxo-video-worker/src/history_sources.js';
const old = {numBlocks:1025,historyOldTip:511,historyFullShards:[1,2],historyPatchShards:[0],
  historyBasePrefix:'explorer/base',historyDeltaPrefix:'explorer/old'};
assert.equal(historySource(old,0).patchKey,'explorer/old/spends/00000.bin');
assert.equal(historySource(old,1).baseKey,'explorer/old/shards/00001.bin');
assert.equal(historySource(old,1).baseTip,1024);
const newer = {...old,numBlocks:1030,historyShardSources:{
  0:{baseKey:'explorer/base/shards/00000.bin',baseTip:511,patchKey:'explorer/new/spends/00000.bin'},
  1:{baseKey:'explorer/old/shards/00001.bin',baseTip:1024},
  2:{baseKey:'explorer/new/shards/00002.bin',baseTip:1029}}};
assert.deepEqual(historySource(newer,1),newer.historyShardSources[1]);
assert.equal(historySource(newer,0).baseTip,511);
assert.equal(historySource(newer,2).baseTip,1029);
assert.throws(()=>historySource(newer,3),/invalid/);
assert.throws(()=>historySource({...newer,numBlocks:500},0),/invalid/);
console.log('history source routing: 8 checks passed');
