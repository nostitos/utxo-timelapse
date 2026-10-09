const fs=require('fs'),vm=require('vm'),assert=require('assert');
(async()=>{for(const f of ['cloudflare/utxo-video-worker/static/explorer.html','src/cpp/app/explorer_ui/explorer.html']){
const s=fs.readFileSync(f,'utf8');const code=s.slice(s.indexOf('let hoverLast ='),s.indexOf('loupe.addEventListener("mouseleave"',s.indexOf('let hoverLast =')));
let calls=[];let block=900000;let respond;let timers=new Map(), id=0;
const c={info:{graphRect:[0,10,3720,2072],videoVersion:'test'},hoverBar:{style:{}},displayToNative:(x,y)=>({nx:x,ny:y}),curBlock:()=>block,fmtBtc:String,fetch:url=>{calls.push(url);return new Promise(r=>respond=()=>r({ok:true,json:async()=>({future:true})}));},setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:i=>timers.delete(i)};
vm.createContext(c);vm.runInContext(code,c);const move=(x,y)=>c.updateHover({clientX:x,clientY:y});const flush=()=>{const ts=[...timers.values()];timers.clear();ts.forEach(f=>f());};
for(const [x,y] of [[2962,2124],[2624,1],[3823,610],[10,2082]])move(x,y);flush();assert.equal(calls.length,0);
for(let x=1;x<50;x++)move(x,20);flush();assert.equal(calls.length,1);assert(calls[0].includes('x=49'));
move(60,20);move(60,2124);flush();respond();await new Promise(r=>setImmediate(r));flush();assert.equal(calls.length,1);assert.equal(c.hoverBar.style.display,'none');
move(100,20);flush();assert.equal(calls.length,2);block++;respond();await new Promise(r=>setImmediate(r));assert.equal(c.hoverBar.style.display,'none');console.log('PASS',f);
}})();
