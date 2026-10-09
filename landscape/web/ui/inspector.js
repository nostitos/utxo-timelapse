// Inspection drawer (landscape/SPEC.md §8): the exact worker state of the L0 cell, the
// native explorer's lifecycle records for the same cell (GET /api/landscape/cell), a
// cross-check of the two, and a link to the nearest pixel in the 2D explorer.
//
// The explorer's count/liveSat are the outputs alive at the block (created <= B < spent)
// and must equal the worker's countSmall+countLarge and satsSmall+satsLarge.

import { fmtInt, fmtBtc, fmtAge, isoUtc, escapeHtml } from './format.js';
import { rowAmountRange, blockToX, rowToImageY } from '../data/axis.js';
import { columnBlocks, worldX, worldZ } from '../data/grid.js';
import { Vector3 } from 'three';

const API_TIMEOUT_MS = 10000;
const API_DEBOUNCE_MS = 150; // rapid inspects send only the latest request (shared 15 req/s limit)
const LIST_LIMIT = 60;

function amountRange(rows, row) {
  const r = rows ? rowAmountRange(rows, row) : null;
  if (!r) return { text: 'no integer amount maps to this row', range: null };
  if (r.max === Infinity) return { text: '\u2265 ' + fmtBtc(r.min), range: r };
  if (r.min === r.max) return { text: fmtBtc(r.min), range: r };
  return { text: fmtBtc(r.min) + ' \u2013 ' + fmtBtc(r.max), range: r };
}

function day(blocktimes, b) {
  return Number.isFinite(blocktimes[b]) ? isoUtc(blocktimes[b], { time: false }) : '\u2014';
}

function utxoRows(list, kind) {
  const head = '<tr><th>Amount</th><th>Created</th>' + (kind === 'stay' ? '<th>Age at block</th>' : '<th>Spent</th><th>Lifespan</th>') + '</tr>';
  const body = list.slice(0, LIST_LIMIT).map((u) => {
    const created = '<td>' + fmtInt(u.created) + '<small>' + escapeHtml(u.createdDate || '') + '</small></td>';
    if (kind === 'stay') return '<tr><td>' + fmtBtc(u.sat) + '</td>' + created + '<td class="ok">' + fmtAge(u.age) + '</td></tr>';
    return '<tr><td>' + fmtBtc(u.sat) + '</td>' + created + '<td class="later">' + fmtInt(u.spent) + '<small>' + escapeHtml(u.spentDate || '') + '</small></td><td>' + fmtAge(u.spent - u.created) + '</td></tr>';
  }).join('');
  const more = list.length > LIST_LIMIT ? '<p class="in-more">' + fmtInt(list.length - LIST_LIMIT) + ' more not shown</p>' : '';
  return '<table class="in-table">' + head + body + '</table>' + more;
}

export function createInspector({
  container, marker, replay, grid, rows, blocktimes, axis, explorerBase, camera, canvas, heightAt, onClose,
  link2d = (block, x, y) => explorerBase + '/?block=' + block + '&x=' + x + '&y=' + y, local = true,
}) {
  let sel = null; // {col, row, hit, x, z}
  let seq = 0;
  let workerAt = null;
  let apiAt = null;
  let apiCtl = null;
  let lastWorkerRefresh = 0;
  let apiTimer = 0;
  let current = null;
  const v3 = new Vector3();
  container.hidden = true;
  container.innerHTML = '';

  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) api.close();
  });

  function head(col, row, hit) {
    const [first, last] = columnBlocks(grid, col);
    const amt = amountRange(rows, row);
    const level = hit && Number.isInteger(hit.level) ? hit.level : 0;
    const lod = level > 0
      ? '<p class="in-lod">Drawn at level L' + level + ' (mean of ' + fmtInt(grid.levels[level] ? (1 << grid.levels[level].columnShift) * (1 << grid.levels[level].rowShift) : 1) + ' cells). The figures below are the single L0 cell under the cursor.</p>'
      : '';
    return '<div class="in-head"><div><span class="eyebrow">Cell \u00b7 column ' + fmtInt(col) + ' \u00b7 row ' + fmtInt(row) + '</span>' +
      '<h2>Blocks ' + fmtInt(first) + '\u2013' + fmtInt(last) + '</h2>' +
      '<p class="in-sub">' + day(blocktimes, first) + ' \u2192 ' + day(blocktimes, last) + ' \u00b7 ' + amt.text + '</p></div>' +
      '<button type="button" class="icon-btn" data-close aria-label="Close inspector">\u00d7</button></div>' + lod;
  }

  function workerHtml(cell, block) {
    if (!cell) return '<section class="in-sec"><h3>Exact state <span>browser replay</span></h3><p class="in-muted">Loading the cell\u2026</p></section>';
    if (cell.error) return '<section class="in-sec"><h3>Exact state <span>browser replay</span></h3><p class="in-warn">' + escapeHtml(cell.error) + '</p></section>';
    const count = cell.countSmall + cell.countLarge;
    const sats = cell.satsSmall + cell.satsLarge;
    const density = cell.countSmall + cell.satsLarge / 5e8;
    return '<section class="in-sec"><h3>At block ' + fmtInt(block) + ' <span>exact replay in this browser</span></h3>' +
      '<dl class="in-grid">' +
      '<div><dt>Unspent outputs</dt><dd>' + fmtInt(count) + '</dd></div>' +
      '<div><dt>Value</dt><dd>' + (sats ? fmtBtc(sats) : '0') + '</dd></div>' +
      '<div><dt>Weighted density</dt><dd>' + (Number.isInteger(density) ? fmtInt(density) : density.toFixed(4)) + '</dd></div>' +
      '<div><dt>Recent spending</dt><dd>' + (cell.heat > 0 ? cell.heat.toFixed(cell.heat >= 100 ? 1 : 4) + ' BTC' : '0') + '</dd></div>' +
      '<div><dt>Up to 5 BTC</dt><dd>' + fmtInt(cell.countSmall) + ' \u00b7 ' + (cell.satsSmall ? fmtBtc(cell.satsSmall) : '0') + '</dd></div>' +
      '<div><dt>Above 5 BTC</dt><dd>' + fmtInt(cell.countLarge) + ' \u00b7 ' + (cell.satsLarge ? fmtBtc(cell.satsLarge) : '0') + '</dd></div>' +
      '</dl></section>';
  }

  function check(cell, cellBlock, res, resBlock) {
    if (!cell || cell.error || !res || res.error || res.offline || cellBlock !== resBlock) return null;
    const count = cell.countSmall + cell.countLarge;
    const sats = cell.satsSmall + cell.satsLarge;
    const ok = count === (res.count || 0) && sats === (res.liveSat || 0);
    return { ok, count, sats, apiCount: res.count || 0, apiSats: res.liveSat || 0 };
  }

  function apiHtml(res, block, match) {
    const title = '<h3>History index <span>' + escapeHtml(explorerBase.replace(/^https?:\/\//, '')) + '</span></h3>';
    if (!res) return '<section class="in-sec">' + title + '<p class="in-muted">Asking the explorer\u2026</p></section>';
    if (res.offline) {
      if (!local) return '<section class="in-sec">' + title + '<p class="in-warn">The history index is temporarily unavailable. The replay figures above are still exact.</p></section>';
      return '<section class="in-sec">' + title + '<p class="in-warn">The native explorer is not reachable, so lifecycle records are unavailable. The replay figures above are still exact.</p>' +
        '<p class="in-muted">Start it from the repository root:</p><pre>./build_local/buv -ns -tc=utxo_explorer \\\n  -cfg=configs/buv_explorer.json -port=12989</pre></section>';
    }
    if (res.error) return '<section class="in-sec">' + title + '<p class="in-warn">' + escapeHtml(res.error) + '</p></section>';
    if (!res.blockRange) return '<section class="in-sec">' + title + '<p class="in-muted">No integer amount maps to this row, so it never holds outputs.</p></section>';
    let html = '<section class="in-sec">' + title;
    if (match) {
      html += match.ok
        ? '<p class="in-check ok">\u2713 Matches the replay: ' + fmtInt(match.apiCount) + ' outputs, ' + (match.apiSats ? fmtBtc(match.apiSats) : '0 sat') + '</p>'
        : '<p class="in-check bad">\u2717 Differs from the replay: index ' + fmtInt(match.apiCount) + ' outputs / ' + fmtBtc(match.apiSats) + ', replay ' + fmtInt(match.count) + ' / ' + fmtBtc(match.sats) + '</p>';
    }
    const ever = (res.count || 0) + (res.pastCount || 0);
    const still = res.stillUnspent || 0;
    html += '<dl class="in-grid">' +
      '<div><dt>Alive at ' + fmtInt(block) + '</dt><dd>' + fmtInt(res.count) + '</dd></div>' +
      '<div><dt>Unspent at cutoff</dt><dd>' + fmtInt(still) + (still ? ' \u00b7 ' + fmtBtc(res.liveUnspentSat) : '') + '</dd></div>' +
      '<div><dt>Ever created</dt><dd>' + fmtInt(ever) + ' \u00b7 ' + fmtBtc((res.liveSat || 0) + (res.pastSat || 0)) + '</dd></div>' +
      '<div><dt>Median lifespan</dt><dd>' + (res.medianStay >= 0 ? fmtInt(res.medianStay) + ' blocks (' + fmtAge(res.medianStay) + ')' : '\u2014') + '</dd></div>' +
      '</dl>';
    if (Array.isArray(res.pop) && res.pop.some((v) => v > 0)) {
      html += '<div class="in-pop"><canvas width="720" height="112" aria-label="Unspent outputs in this cell over time"></canvas>' +
        '<div class="in-popcap"><span>' + escapeHtml(res.blockDates ? res.blockDates[0] : '') + '</span><span>unspent count over time</span><span>cutoff</span></div></div>';
    }
    const stay = (res.utxos || []).filter((u) => u.spent == null);
    const later = (res.utxos || []).filter((u) => u.spent != null);
    if (stay.length) html += '<h4 class="ok">Unspent at cutoff <span>' + fmtInt(stay.length) + '</span></h4>' + utxoRows(stay, 'stay');
    if (later.length) html += '<h4 class="later">Spent after this block <span>' + fmtInt(later.length) + ', earliest first</span></h4>' + utxoRows(later, 'leave');
    if (res.truncated) html += '<p class="in-more">The explorer lists at most 500 live outputs.</p>';
    if (res.pastUtxos && res.pastUtxos.length) {
      html += '<details class="in-past"' + (stay.length || later.length ? '' : ' open') + '><summary>Spent before this block <span>' + fmtInt(res.pastCount) + (res.pastTruncated ? ', earliest 100' : '') + '</span></summary>' + utxoRows(res.pastUtxos, 'leave') + '</details>';
    }
    if (!stay.length && !later.length && !(res.pastUtxos && res.pastUtxos.length)) html += '<p class="in-muted">No outputs were created in this cell by this block.</p>';
    return html + '</section>';
  }

  function linkHtml(col, row, block) {
    const [first, last] = columnBlocks(grid, col);
    if (block == null || first > block) {
      return '<div class="in-links"><span class="in-muted">This column is created after block ' + fmtInt(block ?? 0) + '; the 2D film has no pixel for it yet.</span></div>';
    }
    const mid = Math.min(block, Math.floor((first + last) / 2));
    const x = blockToX(mid, block, axis);
    const y = rowToImageY(row, axis);
    const href = link2d(block, x, y);
    return '<div class="in-links"><a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">Open pixel (' + fmtInt(x) + ', ' + fmtInt(y) + ') in the 2D explorer \u2197</a></div>';
  }

  function drawPop(res) {
    const c = container.querySelector('.in-pop canvas');
    if (!c || !res || !Array.isArray(res.pop)) return;
    const ctx = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const n = res.pop.length;
    const maxV = Math.max(...res.pop, 1);
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * (W - 1), H - 3 - (res.pop[i] / maxV) * (H - 10));
    ctx.lineTo(W - 1, H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(168,214,179,0.18)';
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 1);
      const y = H - 3 - (res.pop[i] / maxV) * (H - 10);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#a8d6b3';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    if (Number.isInteger(res.viewBin)) {
      const x = (res.viewBin / (n - 1)) * (W - 1);
      ctx.fillStyle = '#edbf76';
      ctx.fillRect(x - 1.5, 0, 3, H);
    }
  }

  function render() {
    if (!sel) return;
    const block = workerAt ? workerAt.block : replay.block;
    const match = check(workerAt && workerAt.cell, workerAt && workerAt.block, apiAt && apiAt.res, apiAt && apiAt.block);
    container.innerHTML = head(sel.col, sel.row, sel.hit) +
      workerHtml(workerAt && workerAt.cell, block) +
      apiHtml(apiAt && apiAt.res, apiAt ? apiAt.block : block, match) +
      linkHtml(sel.col, sel.row, replay.block);
    if (apiAt && apiAt.res) drawPop(apiAt.res);
    current = { hit: sel.hit, col: sel.col, row: sel.row, block, cell: workerAt && workerAt.cell, api: apiAt && apiAt.res, apiBlock: apiAt && apiAt.block, match };
  }

  async function loadWorker(my) {
    const block = replay.block;
    let cell;
    try {
      cell = await replay.cell(0, sel.col, sel.row);
      if (cell == null) cell = { error: 'The replay has no state for this cell yet.' };
    } catch (err) {
      cell = { error: 'Replay error: ' + (err && err.message ? err.message : String(err)) };
    }
    if (my !== seq) return null;
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
        if (my !== seq) return null;
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
    if (my !== seq) return null;
    apiAt = { res, block };
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
      container.hidden = false;
      document.body.classList.add('inspector-open');
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
