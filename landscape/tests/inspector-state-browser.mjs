// Controlled responses exercise states that a healthy live index cannot reproduce.
async function checkInspectorStates(L) {
  const { createInspector } = await import('/ui/inspector.js');
  const { FILM_AXIS } = await import('/data/axis.js');
  const container = document.createElement('div');
  document.body.append(container);
  const cell = { countSmall: 2, countLarge: 0, satsSmall: 100, satsLarge: 0, heat: 0 };
  const initial = { block: 1000, cutoffBlock: 1100, cutoffDate: '2009-01-15', blockRange: [960, 1023],
    blockDates: ['2009-01-14', '2009-01-14'], count: 2, liveSat: 100, stillUnspent: 1,
    liveUnspentSat: 50, pastCount: 0, pastSat: 0, medianStay: 100, pop: [2, 1], viewBin: 0,
    utxos: [{ sat: 50, created: 960, spent: null }, { sat: 50, created: 961, spent: 1050 }] };
  let response = initial, offline = false, error = false, deferred = null;
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (!String(url).includes('/__inspector-test__/')) return realFetch(url, opts);
    if (offline) throw new TypeError('Network unavailable');
    if (deferred) return deferred;
    return new Response(JSON.stringify(error ? { error: 'Test unavailable' } : response), { status: error ? 503 : 200 });
  };
  const replay = { block: 1000, cell: async () => ({ ...cell, block: replay.block }) };
  const inspector = createInspector({ container, replay, grid: L.grid, rows: L.replay.rows,
    blocktimes: L.replay.blocktimes, axis: FILM_AXIS, explorerBase: '/__inspector-test__', local: false });
  const hit = { l0Col: 15, l0Row: 1400, level: 0 };
  const checks = [], check = (name, ok) => checks.push([name, !!ok]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await inspector.open(hit);
    check('matching selected block verifies', container.querySelector('.in-verified'));
    const lifetime = container.querySelector('[data-chart="lifetime"]');
    check('full lifetime chart is visible without opening a disclosure', lifetime && !lifetime.closest('details'));
    check('later-spend chart is secondary and collapsed', container.querySelector('[data-chart="after-selection"]')?.closest('details')?.open === false);
    check('lifetime chart marks the selected block', lifetime?.querySelector('.in-chart-selected'));
    const tab = container.querySelector('[data-tab="live"]');
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    check('arrow key selects and focuses next tab', document.activeElement?.dataset.tab === 'past' && document.activeElement.getAttribute('aria-selected') === 'true');
    let bubbled = false;
    const onSpace = () => { bubbled = true; };
    window.addEventListener('keydown', onSpace);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    window.removeEventListener('keydown', onSpace);
    check('space activation stays out of app playback shortcut', !bubbled);
    container.querySelector('[data-tab="live"]').click();
    container.querySelector('[data-disclosure="details"]').open = true;
    container.querySelector('[data-tab="past"]').click();
    check('disclosure survives a same-turn tab change', container.querySelector('[data-disclosure="details"]').open);
    await sleep(20);
    replay.block = 1001;
    inspector.onBlock(1001, { playing: true });
    await sleep(20);
    check('stale history cannot verify the new block', !container.querySelector('.in-verified') && container.textContent.includes('History shown at block 1,000'));
    check('disclosure survives replay refresh', container.querySelector('[data-disclosure="details"]').open);
    replay.block = 1000;
    response = { ...initial, liveSat: 99 };
    await inspector.open(hit);
    check('count or value mismatch stays prominent', container.querySelector('.in-check.bad') && !container.querySelector('.in-verified'));
    response = { ...initial, count: 501, truncated: true };
    await inspector.open(hit);
    check('capped lists keep full history without drawing an incomplete later-spend curve', container.querySelector('[data-chart="lifetime"]') && !container.querySelector('[data-chart="after-selection"]') && container.textContent.includes('capped output list') && container.textContent.includes('2 of 501'));
    response = { ...initial, cutoffBlock: undefined, cutoffDate: undefined };
    await inspector.open(hit);
    check('legacy index keeps lifetime samples without inventing a cutoff', container.textContent.includes('not supplied by this index') && container.querySelector('[data-chart="lifetime"]') && !container.querySelector('[data-chart="after-selection"]'));
    response = { ...initial, count: 0, stillUnspent: 0, liveSat: 0, utxos: [], pop: [0, 0] };
    cell.countSmall = 0; cell.satsSmall = 0;
    await inspector.open(hit);
    check('empty cohort remains readable', container.textContent.includes('No unspent outputs') && container.querySelector('.in-history > svg'));
    offline = true;
    await inspector.open(hit);
    check('network failure preserves replay totals', container.textContent.includes('History is unavailable') && container.querySelector('.in-primary'));
    offline = false; error = true;
    await inspector.open(hit);
    check('server errors are visible', container.textContent.includes('Explorer error 503'));
    error = false;
    let resolveRequest;
    deferred = new Promise(r => { resolveRequest = r; });
    const opening = inspector.open(hit);
    await sleep(200);
    check('history loading state is visible', container.textContent.includes('Loading output history'));
    inspector.close();
    resolveRequest(new Response(JSON.stringify(initial)));
    await opening;
    check('late response cannot reopen a closed inspector', container.hidden);
  } finally {
    window.fetch = realFetch;
    inspector.close();
    container.remove();
  }
  return checks;
}
