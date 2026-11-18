// The explorer's trace contract: straight links, arcs for hops inside one pixel column, and a
// list that names both transactions without claiming which input paid which output.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const id = pair => pair.repeat(32);
const trace = {
  txid: id('ab'), vout: 1, block: 500, coinbase: false, inputCount: 131,
  output: { height: 400, satoshi: 900, x: 1000, y: 100 },
  inputs: [
    { txid: id('cd'), vout: 0, height: 10, satoshi: 600, x: 200, y: 300 },
    { txid: id('ef'), vout: 2, height: 399, satoshi: 300, x: 998, y: 700 },
  ],
  spend: { txid: id('12'), height: 450, inputCount: 3, outputCount: 5, outputs: [{ vout: 0, satoshi: 500, x: 1000, y: 160 }] },
};
const half = (x, y) => ({ x: x / 2, y: y / 2 });

for (const file of ['cloudflare/utxo-video-worker/static/explorer.html', 'src/cpp/app/explorer_ui/explorer.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const source = html.split('// ---- trace contract:')[1].split('\n').slice(1).join('\n').split('// ---- end trace contract ----')[0];
  const page = vm.createContext({ fmtBtc: sat => sat + ' sat' });
  vm.runInContext(source, page);

  const svg = page.traceSvg(trace, half);
  assert(svg.includes("<path class='in' d='M100 150L500 50'/>"), 'a distant input is a straight line to the output');
  assert(svg.includes("<path class='in' d='M499 350Q439.5 200 500 50'/>"), 'an input in the same column arcs to the left');
  assert(svg.includes("<path class='out' d='M500 50Q541 65 500 80'/>"), 'a spend in the same column arcs to the right');
  assert(svg.endsWith("<circle class='hub' cx='500' cy='50' r='4'/>"), 'the traced output is drawn last, on top');
  assert.equal(page.traceSvg({ ...trace, output: { height: 400, satoshi: 900 } }, half), '', 'an output with no pixel draws nothing');

  const list = page.traceHtml(trace, 974310);
  assert(list.includes('Inputs of the transaction that created it') && list.includes('(131, largest 2 shown)'));
  assert(list.includes('Outputs of the transaction that spent it in block 450') && list.includes('(5, largest 1 shown; it had 2 other inputs)'));
  assert(list.includes("data-trace='" + id('cd') + ":0'") && list.includes("data-trace='" + id('12') + ":0'"), 'inputs and spend outputs can be followed');
  assert(!list.includes('data-block'));

  const early = page.traceHtml({ ...trace, block: 420 }, 974310);
  assert(early.includes("data-trace='" + id('ab') + ":1' data-block='450'"), 'a later spend offers its block');
  assert(!early.includes(id('12')), 'and does not list outputs that have no pixel yet');
  assert(page.traceHtml({ ...trace, spend: null }, 974310).includes('Unspent at block 974,310'));
  const mined = page.traceHtml({ ...trace, coinbase: true, inputs: [], inputCount: 0 }, 974310);
  assert(mined.includes('Newly mined') && !mined.includes('Inputs of'));
  console.log('PASS', file);
}
