// Guard against a teaching diagram silently drifting from production coordinates.
import assert from 'node:assert/strict';
import {blockX} from '../site/axis-mapping.mjs';
import {blockToX, columnBlockRange} from '../cloudflare/utxo-video-worker/src/mapping.js';
let checks=0;
for(let context=0;context<=966360;context+=997){
  for(let h=0;h<=context;h+=Math.max(1,Math.floor(context/47))){
    assert.equal(blockX(h,context),blockToX(h,context),`height ${h}, context ${context}`);checks++;
  }
}
for(let epoch=1;epoch<=9;epoch++){
 for(let offset=-1;offset<=121;offset++){
  const context=epoch*105000+offset;
  for(const h of [0,1,104999,105000,209999,Math.max(0,context-1),context]){
   if(h>context)continue;
   assert.equal(blockX(h,context),blockToX(h,context),`boundary ${epoch}, offset ${offset}, height ${h}`);checks++;
  }
  for(const h of [0,Math.floor(context/2),context]){
   const range=columnBlockRange(blockX(h,context),context);
   assert.ok(range&&h>=range[0]&&h<=range[1]);checks++;
  }
 }
}
console.log(`Guide/production mapping: ${checks.toLocaleString()} coordinate and inverse checks passed.`);
