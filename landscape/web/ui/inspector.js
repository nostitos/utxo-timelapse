// One exact L0 cell: browser replay totals, cross-checked history, and a 2D link.
// History has its own latest block and may lag playback; never combine different blocks.
import { fmtInt, fmtBtc, fmtAge, isoUtc, escapeHtml } from './format.js';
import { rowAmountRange, blockToX, rowToImageY } from '../data/axis.js';
import { columnBlocks, worldX, worldZ } from '../data/grid.js';
import { populationTimeline, survivalTimeline } from './inspector-history.js';
import { outputDate, outputHeldFor } from './inspector-outputs.js';
import { SHARE_ICON } from './share.js';
import { Vector3 } from 'three';

const API_TIMEOUT_MS = 10000;
const API_DEBOUNCE_MS = 150;
const PREVIEW_ROWS = 3;
const satsText = (n) => fmtInt(n) + ' sats';
const btcText = (n) => Number.isFinite(n) ? (n / 1e8).toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 }) + ' BTC' : '\u2014';
const day = (times, block) => Number.isFinite(times[block]) ? isoUtc(times[block], { time: false }) : '\u2014';
const metric = (label, value) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';

function amountRange(rows, row) {
  const range = rows ? rowAmountRange(rows, row) : null;
  if (!range) return 'No integer amount maps to this row';
  if (range.max === Infinity) return '\u2265 ' + satsText(range.min);
  return fmtInt(range.min) + (range.min === range.max ? '' : '\u2013' + fmtInt(range.max)) + ' sats';
}

// Real block-height spacing and counts, with textual labels available to screen readers.
function chart(points, { start, end, label, firstLabel, lastLabel, sampled = false, selected = null, selectedCount = null }) {
  const W = 640, H = 180, left = 46, right = 620, top = 30, bottom = 146;
  const max = Math.max(1, ...points.map((p) => p[1]), selected != null && Number.isFinite(selectedCount) ? selectedCount : 0);
  const x = (b) => left + (b - start) / Math.max(1, end - start) * (right - left);
  const y = (v) => bottom - v / max * (bottom - top);
  const coords = points.map(([b, v]) => x(b).toFixed(2) + ',' + y(v).toFixed(2)).join(' ');
  const ticks = [...new Set([0, Math.floor(max / 2), max])];
  let svg = '<svg class="in-chart" data-chart="' + (sampled ? 'lifetime' : 'after-selection') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + escapeHtml(label) + '"><title>' + escapeHtml(label) + '</title>';
  for (const v of ticks) svg += '<line class="in-chart-grid" x1="' + left + '" x2="' + right + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="36" y="' + (y(v) + 4) + '" text-anchor="end">' + fmtInt(v) + '</text>';
  svg += '<polygon class="in-chart-fill" points="' + x(points[0][0]) + ',' + bottom + ' ' + coords + ' ' + x(end) + ',' + bottom + '"/>' +
    '<polyline class="in-chart-line" points="' + coords + '"/>';
  if (sampled && selected != null && selected >= start && selected <= end) svg += '<line class="in-chart-selected" x1="' + x(selected) + '" x2="' + x(selected) + '" y1="' + top + '" y2="' + bottom + '"/>';
  if (sampled) {
    if (selected != null && Number.isFinite(selectedCount)) svg += '<text class="in-chart-current" x="' + left + '" y="18">Selected · ' + fmtInt(selectedCount) + '</text>';
    svg += '<text class="in-chart-label" x="' + right + '" y="18" text-anchor="end">Latest · ' + fmtInt(points[points.length - 1][1]) + '</text>';
  } else {
    const first = points[0][1], last = points[points.length - 1][1];
    svg += '<circle cx="' + left + '" cy="' + y(first) + '" r="4"/><text class="in-chart-label" x="' + left + '" y="18">Selected \u00b7 ' + fmtInt(first) + '</text>';
    if (end !== start) svg += '<circle cx="' + right + '" cy="' + y(last) + '" r="4"/><text class="in-chart-label" x="' + right + '" y="18" text-anchor="end">Latest \u00b7 ' + fmtInt(last) + '</text>';
  }
  svg += '<text x="' + left + '" y="171">' + escapeHtml(firstLabel) + '</text>';
  if (end !== start) svg += '<text x="' + right + '" y="171" text-anchor="end">' + escapeHtml(lastLabel) + '</text>';
  return svg + '</svg>';
}

export function createInspector({
  container, marker, replay, grid, rows, blocktimes, axis, explorerBase, camera, canvas, heightAt, onClose, onSelect, onShare,
  link2d = (block, x, y) => explorerBase + '/?block=' + block + '&x=' + x + '&y=' + y, local = true,
}) {
  let sel = null;
  let seq = 0;
  let workerAt = null;
  let workerRequest = 0;
  let apiAt = null;
  let apiCtl = null;
  let lastWorkerRefresh = 0;
  let apiTimer = 0;
  let current = null;
  let tab = 'live';
  let showAll = false;
  const opened = new Set();
  const v3 = new Vector3();
  container.hidden = true;
  container.innerHTML = '';

  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return api.close();
    if (e.target.closest('[data-share-cell]')) return onShare?.();
    const t = e.target.closest('[data-tab]');
    const more = e.target.closest('[data-show-all]');
    if (t) { tab = t.dataset.tab; showAll = false; render(); }
    if (more) { showAll = !showAll; render(); }
  });
  container.addEventListener('keydown', (e) => {
    // Keep native control activation and panel scrolling out of the map shortcuts.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key) ||
        ([' ', 'Enter'].includes(e.key) && e.target.closest('button, summary, a'))) e.stopPropagation();
    if (!e.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    tab = e.key === 'Home' ? 'live' : e.key === 'End' ? 'past' : tab === 'live' ? 'past' : 'live';
    showAll = false;
    render();
    container.querySelector('[data-tab="' + tab + '"]')?.focus({ preventScroll: true });
  });
  container.addEventListener('toggle', (e) => {
    const key = e.target.dataset?.disclosure;
    if (!key || !container.contains(e.target)) return;
    if (e.target.open) opened.add(key); else opened.delete(key);
  }, true);

  const body = typeof document !== 'undefined' ? document.body : null;
  if (body && typeof MutationObserver === 'function') {
    let panelWasOpen = body.classList.contains('panel-open');
    new MutationObserver(() => {
      const panelOpen = body.classList.contains('panel-open');
      if (panelOpen && !panelWasOpen) body.classList.remove('inspector-front');
      panelWasOpen = panelOpen;
    }).observe(body, { attributes: true, attributeFilter: ['class'] });
  }
  const disclosure = (key, title, content, cls = '') => '<details class="in-disclosure ' + cls + '" data-disclosure="' + key + '"' + (opened.has(key) ? ' open' : '') + '><summary data-focus="' + key + '">' + title + '</summary>' + content + '</details>';

  function head(col, row, hit) {
    const [first, last] = columnBlocks(grid, col);
    const firstDate = day(blocktimes, first), lastDate = day(blocktimes, last);
    const level = Number.isInteger(hit?.level) ? hit.level : 0;
    const lod = grid.levels[level];
    const cells = lod ? (1 << lod.columnShift) * (1 << lod.rowShift) : 1;
    const scope = hit?.shared ? 'This link identifies one exact L0 cell. Terrain detail depends on zoom and rendering settings.' : level > 0 ? 'The terrain shows an average of ' + fmtInt(cells) + ' cells at L' + level + '. These figures describe the one exact L0 cell under the cursor.' : 'These figures describe the one exact L0 cell under the cursor.';
    return '<div class="in-head"><div><span class="eyebrow">Cell details</span>' +
      '<h2>Blocks ' + fmtInt(first) + '\u2013' + fmtInt(last) + '</h2>' +
      '<p class="in-sub">Created ' + firstDate + (firstDate !== lastDate ? ' \u2013 ' + lastDate : '') + '</p>' +
      '<p class="in-sub">Output size ' + amountRange(rows, row) + '</p></div>' +
      '<div class="in-head-actions">' + (onShare ? '<button type="button" class="in-share" data-share-cell aria-haspopup="dialog" title="Share this cell">' + SHARE_ICON + '<span>Share cell</span></button>' : '') + '<button type="button" class="icon-btn" data-close aria-label="Close inspector">\u00d7</button></div></div>' +
      disclosure('scope', '<span aria-hidden="true">\u24d8</span> Inspecting one exact cell', '<p>' + scope + '</p>', 'in-scope');
  }

  function check(cell, cellBlock, res, resBlock) {
    if (!cell || cell.error || !res?.blockRange || res.error || res.offline || cellBlock !== resBlock) return null;
    const count = cell.countSmall + cell.countLarge, sats = cell.satsSmall + cell.satsLarge;
    return { ok: count === res.count && sats === res.liveSat, count, sats, apiCount: res.count, apiSats: res.liveSat };
  }

  function workerHtml(cell, block, match) {
    const badge = match?.ok && block === replay.block ? '<span class="in-verified" title="Output count and value agree with the history index">\u2713 History verified</span>' : '';
    let html = '<section class="in-sec in-state"><div class="in-section-head"><h3>At selected block ' + fmtInt(block) + '</h3>' + badge + '</div>';
    if (!cell || cell.error) return html + '<p class="in-warn">' + (cell?.error ? escapeHtml(cell.error) : 'Loading the cell\u2026') + '</p></section>';
    const count = cell.countSmall + cell.countLarge, sats = cell.satsSmall + cell.satsLarge;
    html += '<dl class="in-primary">' + metric('Unspent outputs', fmtInt(count)) +
      '<div><dt>Total value</dt><dd><span class="in-value' + (fmtInt(sats).length > 12 ? ' in-value-long' : '') + '">' + satsText(sats) + '</span></dd><dd class="in-btc">' + btcText(sats) + '</dd></div></dl>';
    if (block !== replay.block) html += '<p class="in-more">Refreshing for selected block ' + fmtInt(replay.block) + '\u2026</p>';
    if (match && !match.ok) html += '<p class="in-check bad" role="status">History differs: index ' + fmtInt(match.apiCount) + ' outputs / ' + satsText(match.apiSats) + '; replay ' + fmtInt(match.count) + ' / ' + satsText(match.sats) + '.</p>';
    return html + '</section>';
  }

  function outputRows(res, block) {
    const past = tab === 'past';
    const list = [...(past ? res.pastUtxos || [] : res.utxos || [])].sort((a, b) => past ? a.spent - b.spent || a.created - b.created : a.created - b.created);
    const total = past ? res.pastCount : res.count;
    const shown = showAll ? list : list.slice(0, PREVIEW_ROWS);
    let html = '<section class="in-sec in-outputs"><h3>Outputs</h3><div class="in-tabs" role="tablist" aria-label="Outputs at history block ' + fmtInt(block) + '">';
    for (const [id, label, n] of [['live', 'Unspent at selection', res.count], ['past', 'Spent earlier', res.pastCount]]) html += '<button type="button" role="tab" id="in-tab-' + id + '" aria-controls="in-output-list" aria-selected="' + (tab === id) + '" tabindex="' + (tab === id ? '0' : '-1') + '" data-tab="' + id + '" data-focus="tab-' + id + '">' + label + ' <span>' + fmtInt(n) + '</span></button>';
    html += '</div><div id="in-output-list" role="tabpanel" aria-labelledby="in-tab-' + tab + '">';
    if (!list.length) html += '<p class="in-muted">' + (past ? 'No outputs spent by this block.' : 'No unspent outputs at this block.') + '</p>';
    else {
      html += '<p class="in-table-note">Dates in UTC. ' + (past ? 'Time held runs from creation to spending.' : 'Unspent ages are measured at the selected block.') + '</p>' +
        '<table class="in-table"><colgroup><col class="in-col-amount"><col class="in-col-date"><col class="in-col-date"><col class="in-col-held"></colgroup><thead><tr><th scope="col">Amount</th><th scope="col">Created</th><th scope="col">Spent / status</th><th scope="col">Held for</th></tr></thead><tbody>';
      shown.forEach((u) => {
        const spent = u.spent != null;
        const created = outputDate(u.createdDate, u.created, blocktimes);
        const ended = spent ? outputDate(u.spentDate, u.spent, blocktimes) : null;
        const held = outputHeldFor(u, block, blocktimes);
        const dateCell = (date, height) => '<span class="in-cell-main">' + (date.iso ? '<time datetime="' + date.iso + '">' + escapeHtml(date.label) + '</time>' : escapeHtml(date.label)) + '</span><small title="Block ' + fmtInt(height) + '">#' + fmtInt(height) + '</small>';
        const heldHint = (spent ? 'Lifespan' : 'Age at selected block ' + fmtInt(block)) + ': ' + fmtInt(held.blocks) + ' blocks' + (held.approximate ? ' (time estimated at 10 minutes per block)' : ' (elapsed block timestamps)');
        // One amount band per table: share a unit and retain exact satoshi precision.
        const big = u.sat >= 1e8;
        const amount = big ? (u.sat / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 }) : fmtInt(u.sat);
        html += '<tr class="in-output-row"><td class="in-amount" title="' + satsText(u.sat) + ' · ' + btcText(u.sat) + '"><span class="in-cell-main">' + amount + '</span><small>' + (big ? 'BTC' : 'sats') + '</small></td>' +
          '<td class="in-created">' + dateCell(created, u.created) + '</td>' +
          '<td class="in-spent ' + (spent ? 'later' : 'ok') + '">' + (spent ? dateCell(ended, u.spent) : '<span class="in-cell-main">Unspent</span><small title="No spend through block ' + fmtInt(res.cutoffBlock) + ' · ' + escapeHtml(res.cutoffDate || '') + '">to date</small>') + '</td>' +
          '<td class="in-held" title="' + escapeHtml(heldHint) + '"><span class="in-cell-main">' + escapeHtml(held.label) + '</span><small>' + (spent ? fmtInt(held.blocks) + ' blk' : 'at selection') + '</small></td></tr>';
      });
      html += '</tbody></table>';
      if (list.length > PREVIEW_ROWS) html += '<button type="button" class="in-more-button" data-show-all data-focus="show-all" aria-expanded="' + showAll + '">' + (showAll ? 'Show fewer outputs \u2191' : 'Show ' + (list.length === total ? 'all ' : '') + fmtInt(list.length) + ' outputs \u2193') + '</button>';
      if (total > list.length || (past ? res.pastTruncated : res.truncated)) html += '<p class="in-more">' + fmtInt(list.length) + ' of ' + fmtInt(total) + ' records available' + (past ? ' (earliest spends; index limit 100).' : ' (index limit 500).') + ' Totals include every output.</p>';
    }
    return html + '</div></section>';
  }

  function historyHtml(res, block) {
    if (!res) return '<section class="in-sec"><p class="in-muted">Loading output history\u2026</p></section>';
    if (res.error || res.offline) return '<section class="in-sec"><p class="in-warn">' + (res.offline ? 'History is unavailable. Replay totals remain available.' : escapeHtml(res.error)) + '</p></section>';
    if (!res.blockRange) return '<section class="in-sec"><p class="in-muted">No integer amount maps to this row, so it never holds outputs.</p></section>';
    const count = res.count, still = res.stillUnspent, later = count - still;
    const cutoff = Number.isInteger(res.cutoffBlock) ? res.cutoffBlock : null;
    const timeline = survivalTimeline(res, block);
    let html = '<section class="in-sec in-history">';
    if (block !== (workerAt?.block ?? replay.block) || block !== replay.block) html += '<p class="in-warn" role="status">History shown at block ' + fmtInt(block) + '. Pause playback to refresh.</p>';
    html += '<div class="in-flow" aria-label="' + fmtInt(count) + ' unspent at block ' + fmtInt(block) + ', ' + fmtInt(later) + ' spent later, ' + fmtInt(still) + ' still unspent in the latest history"><span><strong>' + fmtInt(count) + '</strong> at selection</span><span aria-hidden="true">\u2192</span><span><strong>' + fmtInt(later) + '</strong> spent later</span><span aria-hidden="true">\u2192</span><span><strong>' + fmtInt(still) + '</strong> remain</span></div>';
    html += '<p class="in-cutoff">' + (cutoff == null ? 'Latest history block not supplied by this index' : 'History through block ' + fmtInt(cutoff) + ' \u00b7 ' + escapeHtml(res.cutoffDate || day(blocktimes, cutoff))) + '</p>';
    const lifetime = populationTimeline(res, block);
    if (lifetime) {
      html += '<h3>Cell history <span>Unspent outputs over time</span></h3>' + chart(lifetime.points, {
        ...lifetime, sampled: true, selectedCount: count,
        label: 'Full cell history from creation to the latest data: ' + res.pop.length + ' population samples, including outputs spent before selection',
        firstLabel: res.blockDates?.[0] || fmtInt(res.blockRange[0]), lastLabel: res.cutoffDate || 'Latest',
      }) + '<p class="in-more">' + res.pop.length + ' time samples · ' + (lifetime.selected == null ? 'Selected block precedes this creation range.' : 'Amber marker: selected block ' + fmtInt(block) + '.') + '</p>';
    } else html += '<p class="in-more">Lifetime population samples are unavailable from this index.</p>';
    html += '<p class="in-summary"><strong>' + fmtInt(count + res.pastCount) + '</strong> created by selection · Median lifespan ' + (res.medianStay >= 0 ? fmtInt(res.medianStay) + ' blocks' : '—') + '</p>';
    let after = '';
    if (timeline) {
      after += chart(timeline, { start: block, end: cutoff, label: count + ' outputs at block ' + block + ', ' + still + ' still unspent at block ' + cutoff, firstLabel: fmtInt(block), lastLabel: fmtInt(cutoff) });
      const spendBlocks = [...new Set((res.utxos || []).filter((u) => u.spent != null).map((u) => u.spent))].sort((a, b) => a - b);
      if (spendBlocks.length) after += '<p class="in-more">' + (spendBlocks.length === 1 ? 'Later spend' : 'First later spend') + ': block ' + fmtInt(spendBlocks[0]) + ' · ' + escapeHtml(res.utxos.find((u) => u.spent === spendBlocks[0]).spentDate || day(blocktimes, spendBlocks[0])) + '</p>';
    } else if (res.truncated) after += '<p class="in-more">Exact totals shown above; the capped output list cannot locate every later spend on a chart.</p>';
    if (after) html += disclosure('after-selection', 'After the selected block', after);
    return html + '</section>' + outputRows(res, block);
  }

  function pixel(col, row, block) {
    const [first, last] = columnBlocks(grid, col);
    if (block == null || first > block) return null;
    return { x: blockToX(Math.min(block, Math.floor((first + last) / 2)), block, axis), y: rowToImageY(row, axis) };
  }

  function detailsHtml(cell, res, block) {
    const p = pixel(sel.col, sel.row, block);
    let html = '<dl class="in-grid">' + metric('Cell coordinates', 'Column ' + fmtInt(sel.col) + ' \u00b7 row ' + fmtInt(sel.row)) +
      metric('Rendering level', sel.hit?.shared ? 'View-dependent terrain · L0 inspection' : 'L' + (sel.hit?.level || 0) + ' terrain \u00b7 L0 inspection') + (p ? metric('2D pixel', fmtInt(p.x) + ', ' + fmtInt(p.y)) : '') +
      metric('Replay source', 'Exact replay in this browser') + metric('History source', escapeHtml(explorerBase.replace(/^https?:\/\//, '') || location.host));
    if (cell && !cell.error) {
      const density = cell.countSmall + cell.satsLarge / 5e8;
      html += metric('Weighted density', Number.isInteger(density) ? fmtInt(density) : density.toFixed(4)) + metric('Recent spending', cell.heat > 0 ? cell.heat.toFixed(cell.heat >= 100 ? 1 : 4) + ' BTC' : '0 BTC') +
        metric('Up to 5 BTC', fmtInt(cell.countSmall) + ' outputs \u00b7 ' + fmtBtc(cell.satsSmall)) + metric('Above 5 BTC', fmtInt(cell.countLarge) + ' outputs \u00b7 ' + fmtBtc(cell.satsLarge));
    }
    if (res?.blockRange && !res.error) html += metric('Value still unspent', btcText(res.liveUnspentSat)) + metric('Total created value', btcText(res.liveSat + res.pastSat)) + metric('Median lifespan', res.medianStay >= 0 ? fmtInt(res.medianStay) + ' blocks \u00b7 approximately ' + fmtAge(res.medianStay) : '\u2014');
    html += '</dl>';
    if (res?.offline && local) html += '<p class="in-muted">Start the native explorer from the repository root:</p><pre>./build_local/buv -ns -tc=utxo_explorer \\\n  -cfg=configs/buv_explorer.json -port=12989</pre>';
    return disclosure('details', 'Rendering &amp; data details', html, 'in-sec');
  }

  function linkHtml(col, row, block) {
    const p = pixel(col, row, block);
    if (!p) return '<div class="in-links"><span class="in-muted">This column is created after block ' + fmtInt(block ?? 0) + '; the 2D film has no pixel for it yet.</span></div>';
    return '<div class="in-links"><a href="' + escapeHtml(link2d(block, p.x, p.y)) + '" target="_blank" rel="noopener">Open this cell in 2D explorer \u2197</a></div>';
  }

  function render() {
    if (!sel) return;
    // Native toggle events are asynchronous: snapshot the DOM before replacing it,
    // including a disclosure opened in the same event turn as another action.
    for (const el of container.querySelectorAll('[data-disclosure]')) {
      if (el.open) opened.add(el.dataset.disclosure); else opened.delete(el.dataset.disclosure);
    }
    const scroll = container.scrollTop;
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    const block = workerAt ? workerAt.block : replay.block;
    const match = check(workerAt?.cell, workerAt?.block, apiAt?.res, apiAt?.block);
    container.innerHTML = head(sel.col, sel.row, sel.hit) + workerHtml(workerAt?.cell, block, match) +
      historyHtml(apiAt?.res, apiAt ? apiAt.block : block) + detailsHtml(workerAt?.cell, apiAt?.res, block) + linkHtml(sel.col, sel.row, block);
    if (focused) [...container.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focused)?.focus({ preventScroll: true });
    container.scrollTop = scroll;
    current = { hit: sel.hit, col: sel.col, row: sel.row, block, cell: workerAt?.cell, api: apiAt?.res, apiBlock: apiAt?.block, match };
  }

  async function loadWorker(my) {
    const request = ++workerRequest;
    const block = replay.block;
    let cell;
    try {
      cell = await replay.cell(0, sel.col, sel.row);
      if (cell == null) cell = { error: 'The replay has no state for this cell yet.' };
    } catch (err) {
      cell = { error: 'Replay error: ' + (err && err.message ? err.message : String(err)) };
    }
    if (my !== seq || request !== workerRequest) return null;
    workerAt = { cell, block: cell && cell.block != null ? cell.block : block };
    render();
    return workerAt;
  }

  async function loadApi(my, retry = true) {
    const block = replay.block;
    if (apiCtl) apiCtl.abort();
    const ctl = new AbortController();
    apiCtl = ctl;
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    const url = explorerBase + '/api/landscape/cell?block=' + block + '&col=' + sel.col + '&row=' + sel.row;
    let res;
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.status === 429 && retry) {
        clearTimeout(timer);
        await new Promise((ok) => setTimeout(ok, 1100));
        if (my !== seq || ctl !== apiCtl) return null;
        return loadApi(my, false);
      }
      const body = await r.json();
      res = r.ok ? body : { error: 'Explorer error ' + r.status + ': ' + (body && body.error ? body.error : r.statusText) };
    } catch (err) {
      if (my !== seq) return null;
      res = err && err.name === 'AbortError' ? { error: 'The explorer did not answer within ' + API_TIMEOUT_MS / 1000 + ' s.' } : { offline: true, error: String(err && err.message ? err.message : err) };
    } finally {
      clearTimeout(timer);
    }
    if (my !== seq || ctl !== apiCtl) return null;
    apiAt = { res, block: Number.isInteger(res.block) ? res.block : block };
    render();
    return apiAt;
  }

  const api = {
    get isOpen() {
      return !container.hidden;
    },
    get current() {
      return current;
    },
    get selection() {
      return sel ? { col: sel.col, row: sel.row } : null;
    },
    /** Inspect the L0 cell of a pick hit; resolves when the replay and the explorer answered. */
    async open(hit) {
      const col = Number.isInteger(hit.l0Col) ? hit.l0Col : Math.floor((hit.x * 1000) / grid.blocksPerColumn);
      const row = Number.isInteger(hit.l0Row) ? hit.l0Row : Math.floor(hit.z * 10);
      if (!(col >= 0 && col < grid.l0Columns && row >= 0 && row < grid.rows)) return null;
      const my = ++seq;
      sel = { col, row, hit, x: worldX(col * grid.blocksPerColumn + grid.blocksPerColumn / 2), z: worldZ(row + 0.5) };
      workerAt = null;
      apiAt = null;
      tab = 'live';
      showAll = false;
      opened.clear();
      container.innerHTML = '';
      container.scrollTop = 0;
      container.hidden = false;
      document.body.classList.add('inspector-open');
      document.body.classList.add('inspector-front');
      onSelect?.({ col, row });
      render();
      const apiLater = new Promise((resolve) => {
        clearTimeout(apiTimer);
        apiTimer = setTimeout(() => resolve(my === seq ? loadApi(my) : null), API_DEBOUNCE_MS);
      });
      await Promise.all([loadWorker(my), apiLater]);
      if (my !== seq) return null;
      render();
      return current;
    },
    close() {
      seq++;
      sel = null;
      if (apiCtl) apiCtl.abort();
      clearTimeout(apiTimer);
      container.hidden = true;
      document.body.classList.remove('inspector-open');
      document.body.classList.remove('inspector-front');
      if (marker) marker.hidden = true;
      if (onClose) onClose();
    },
    /** Called when the delivered block changes: replay values refresh at 4 Hz, the explorer when paused. */
    onBlock(block, { playing }) {
      if (!sel) return;
      const now = performance.now();
      if (now - lastWorkerRefresh > 250 && (!workerAt || workerAt.block !== block)) {
        lastWorkerRefresh = now;
        loadWorker(seq);
      }
      clearTimeout(apiTimer);
      if (!playing && (!apiAt || apiAt.block !== block)) {
        const my = seq;
        apiTimer = setTimeout(() => {
          if (my === seq && replay.block === block) loadApi(my);
        }, 450);
      }
    },
    /** Keep the selection marker on the cell top. */
    updateMarker() {
      if (!marker) return;
      if (!sel) {
        marker.hidden = true;
        return;
      }
      let y = 0;
      try {
        y = heightAt(sel.x, sel.z);
      } catch {
        y = 0;
      }
      v3.set(sel.x, Number.isFinite(y) ? y : 0, sel.z).project(camera);
      const visible = v3.z > -1 && v3.z < 1 && Math.abs(v3.x) <= 1.05 && Math.abs(v3.y) <= 1.05;
      marker.hidden = !visible;
      if (!visible) return;
      const r = canvas.getBoundingClientRect();
      const px = r.left + ((v3.x + 1) / 2) * r.width;
      const py = r.top + ((1 - v3.y) / 2) * r.height;
      marker.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px)';
    },
  };
  return api;
}
