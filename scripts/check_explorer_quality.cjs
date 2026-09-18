const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const files = ['cloudflare/utxo-video-worker/static/explorer.html', 'src/cpp/app/explorer_ui/explorer.html'];
let contract;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const source = html.split('// ---- quality contract:')[1].split('\n').slice(1).join('\n').split('// ---- end quality contract ----')[0];
  if (contract) assert.equal(source, contract, 'Native/cloud quality selection diverged');
  contract = source;
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  const metadata = {videoDefaultRendition:'compat', videoRenditions:{compat:{url:'/compat'}, full:{url:'/full',codecs:'hvc1.4.10.L153.9E.08'}}};
  const choose = options => ctx.chooseRendition(metadata, options);
  assert.equal(choose({canPlay4K:true}), 'compat');
  assert.equal(choose({stored:'full',canPlay4K:true}), 'full');
  assert.equal(choose({stored:'full',canPlay4K:false}), 'compat');
  assert.equal(choose({query:'1440p',stored:'full',canPlay4K:true}), 'compat');
  assert.equal(choose({query:'4k',stored:'compat',canPlay4K:true}), 'full');
  assert.equal(choose({query:'unknown',canPlay4K:true}), 'compat');
  assert.equal(ctx.chooseRendition({videoUrl:'/local.mp4'},{}), 'full');
  const video = {canPlayType:()=>''};
  assert.equal(ctx.supportsFullRendition(metadata,video,{}),false);
  assert.equal(ctx.supportsFullRendition(metadata,video,{MediaSource:{isTypeSupported:()=>true},Hls:{isSupported:()=>true}}),true);
  assert.equal(ctx.supportsFullRendition(metadata,video,{MediaSource:{isTypeSupported:()=>true},Hls:{isSupported:()=>false}}),false);
  assert.equal(ctx.supportsFullRendition(metadata,{canPlayType:()=> 'probably'},{}),true);
  console.log('PASS: '+file+' quality default, preferences, capability gating, legacy metadata');
}
