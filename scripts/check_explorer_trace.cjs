// The explorer's transaction contract: lines merged by pixel and weighted by value, arcs within
// one column, and a list that names every input and output with a way to follow each.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const id = pair => pair.repeat(32);
// A sweep at block 500: two inputs share a pixel, a third is undated, one output arcs back to its own column.
const tx = {
  txid: id('ab'), height: 400, block: 500, coinbase: false, mark: id('cd') + ':0',
  hub: { x: 1000, y: 100 },
  inputs: [
    { txid: id('cd'), vout: 0, satoshi: 600, height: 10, x: 200, y: 300 },
    { txid: id('ce'), vout: 3, satoshi: 200, height: 11, shared: true, x: 200, y: 300 },
    { txid: id('ef'), vout: 2, satoshi: 300, height: null },
  ],
  outputs: [
    { vout: 0, satoshi: 900, spent: { txid: id('12'), height: 450 }, x: 1000, y: 160 },
    { vout: 1, satoshi: 0, spent: null },
  ],
};
const half = (x, y) => ({ x: x / 2, y: y / 2 });

for (const file of ['cloudflare/utxo-video-worker/static/explorer.html', 'src/cpp/app/explorer_ui/explorer.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const source = html.split('// ---- transaction contract:')[1].split('\n').slice(1).join('\n').split('// ---- end transaction contract ----')[0];
  const page = vm.createContext({ fmtBtc: sat => sat + ' sat' });
  vm.runInContext(source, page);

  const svg = page.txSvg(tx, half);
  const paths = [...svg.matchAll(/<path class='(in|out|case)' d='([^']*)' stroke-width='([\d.]+)'/g)].map(m => m.slice(1));
  const width = share => 0.8 + 2.4 * Math.sqrt(share);
  // Total value is 1,100 sat in: the two inputs in one pixel carry 800 of it, the output 900.
  assert.deepEqual(paths, [
    ['case', 'M100 150L500 50', (width(800 / 1100) + 1.6).toFixed(2)],
    ['case', 'M500 50Q541 65 500 80', (width(900 / 1100) + 1.6).toFixed(2)],
    ['in', 'M100 150L500 50', width(800 / 1100).toFixed(2)],
    ['out', 'M500 50Q541 65 500 80', width(900 / 1100).toFixed(2)],
  ], 'one line per pixel, weighted by value, each over a wider casing drawn first; an undated input and a zero-value output get none');
  assert(svg.includes("<circle class='ring' cx='100' cy='150' r='7'/><circle class='mark' cx='100' cy='150' r='7'/>"), 'the marked input is ringed');
  assert(svg.endsWith("<circle class='hub' cx='500' cy='50' r='4'/>"), 'the transaction is drawn last, on top');
  assert.equal(page.txSvg({ ...tx, hub: null }, half), '', 'a transaction after the viewed block draws nothing');

  const list = page.txHtml(tx);
  assert(list.includes('3 inputs') && list.includes('2 outputs') && list.includes('fee 200 sat'));
  assert(list.includes('1 without a line (300 sat)'), 'undated inputs are counted');
  assert(list.includes('<td>200 sat</td><td>11*</td>') && list.includes('* Inputs of one amount'), 'a block known only as a group is starred and explained');
  assert(list.includes("<tr class='marked'><td>600 sat"), 'the marked coin is highlighted');
  assert(list.includes("data-tx='" + id('ef') + "' data-mark='" + id('ef') + ":2'>← tx"), 'an input opens the transaction that made it');
  assert(list.includes("data-tx='" + id('12') + "' data-mark='" + id('ab') + ":0'>tx →"), 'a spent output opens the transaction that spent it');
  assert(list.includes("<span class='unspent'>unspent</span>"));
  const many = page.txHtml({ ...tx, mark: null, inputs: Array.from({ length: 30 }, (_, i) => ({ txid: id('cd'), vout: i, satoshi: i + 1, height: 10 })) });
  assert(many.includes('<details><summary>All 30</summary>') && many.indexOf('>30 sat<') < many.indexOf('>1 sat<'), 'largest first; past a dozen the rows fold');
  const mined = page.txHtml({ ...tx, coinbase: true, inputs: [] });
  assert(mined.includes('Newly mined') && !mined.includes('fee'));

  // The drawer's main button names the coin it will trace: the largest unspent at the viewed block, else the largest spent before it.
  const pixel = { count: 2, pastCount: 1, utxos: [{ sat: 700, created: 12 }, { sat: 900, created: 34 }], pastUtxos: [{ sat: 5000, created: 5 }] };
  const lead = page.traceLeadHtml(pixel);
  assert(lead.includes("data-find='34:900' data-out='txresLead'") && lead.includes('Trace a coin from this pixel') && lead.includes('The largest: <b>900 sat</b> created in block 34'));
  const single = page.traceLeadHtml({ count: 0, pastCount: 1, utxos: [], pastUtxos: [{ sat: 5000, created: 1234 }] });
  assert(single.includes("data-find='1234:5000'") && single.includes('Trace this coin') && !single.includes('The largest'));
  assert.equal(page.traceLeadHtml({ count: 0, pastCount: 3, utxos: [] }), '', 'no listed coin, no button');

  const one = page.traceMatchesHtml([{ txid: id('ab'), vout: 1 }], '57043');
  assert(one.includes("data-tx='" + id('ab') + "' data-mark='" + id('ab') + ":1'") && !one.includes('Pick one'));
  const two = page.traceMatchesHtml([{ txid: id('ab'), vout: 1 }, { txid: id('cd'), vout: 0 }], '57043');
  assert(two.startsWith('<div>2 outputs of this amount were created in block 57,043. Pick one:</div>') && two.includes("data-tx='" + id('cd') + "'"));
  console.log('PASS', file);
}
