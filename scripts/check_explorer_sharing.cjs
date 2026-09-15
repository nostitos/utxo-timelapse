const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const files = ['cloudflare/utxo-video-worker/static/explorer.html', 'src/cpp/app/explorer_ui/explorer.html'];
const metadata = { videoStartBlock: 0, videoEndBlock: 966827, imageWidth: 3840, imageHeight: 2160 };
let contract;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const source = html.split('// ---- share contract:')[1].split('\n').slice(1).join('\n').split('// ---- end share contract ----')[0];
  if (contract) assert.equal(source, contract, 'Native and cloud share contracts diverged');
  contract = source;
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(source, context);
  const read = query => JSON.parse(JSON.stringify(context.readSharedView(query, metadata)));
  const build = view => new URL(context.buildShareUrl('https://bitcointimelapse.com/explorer?block=300000&x=111&y=222#old', view));

  assert.equal(read('').autoplay, true);
  assert.equal(read('').block, 313800);
  assert.equal(read('?block=314000').autoplay, false, 'Legacy block links remain paused');
  assert.equal(read('?block=314000&autoplay=1').autoplay, true);
  assert.equal(read('?block=314000&autoplay=0').autoplay, false);
  assert.equal(read('?block=314000&x=3000&y=1525&autoplay=1').autoplay, false, 'Pixel overrides autoplay');
  assert.deepEqual(read('?block=314000&x=3000&y=1525').pixel, { nx: 3000, ny: 1525 });
  assert.equal(read('?block=314000&x=3000').pixel, null);
  assert.equal(read('?block=314000&x=9999&y=1525').pixel, null);
  assert.equal(read('?block=-10').block, 0);
  assert.equal(read('?block=9999999').block, 966827);
  assert.equal(read('?block=12oops').block, 313800);
  for (const autoplay of [false, true]) {
    const url = build({ block: 314000, pixel: null, autoplay });
    assert.equal(url.searchParams.has('x'), false, 'Block share inherited an old x');
    assert.equal(url.searchParams.has('y'), false, 'Block share inherited an old y');
    assert.equal(url.hash, '');
    assert.equal(read(url.search).autoplay, autoplay);
  }
  const pixelUrl = build({ block: 314000, pixel: { nx: 3000, ny: 1525 }, autoplay: true });
  assert.equal(pixelUrl.searchParams.get('autoplay'), '0');
  assert.deepEqual(read(pixelUrl.search), { block: 314000, pixel: { nx: 3000, ny: 1525 }, autoplay: false });
  assert.equal(new URL(context.buildShareUrl('http://localhost:12988/', { block: 10, pixel: null, autoplay: false })).origin, 'http://localhost:12988');
  const pixel = { nx: 3000, ny: 1525, block: 314000 };
  assert(context.activeSharePixel(pixel, 314000, true, true, false, false));
  for (const args of [
    [null, 314000, true, true, false, false],
    [pixel, 314001, true, true, false, false],
    [pixel, 314000, false, true, false, false],
    [pixel, 314000, true, false, false, false],
    [pixel, 314000, true, true, true, false],
    [pixel, 314000, true, true, false, true],
  ]) assert.equal(context.activeSharePixel(...args), null, 'Stale/hidden selection was shareable');
  assert(html.includes('shareBlockMode.checked = true;'), 'Share must default to block mode');
  assert(html.includes('https://x.com/intent/tweet?text='));
  console.log('PASS:', file, '— share modes, autoplay round trips, stale selection, URL cleanup and legacy links');
}
