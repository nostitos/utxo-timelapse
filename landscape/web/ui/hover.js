// Hover readout (landscape/SPEC.md §8): a card docked under the HUD that says what the mouse
// pointer is aimed at (the crosshair in flight mode): the amount band (UTXO size), the blocks
// and the days they were mined, and how many outputs there are still unspent at the replayed
// block, with their value. The card describes the cell as drawn, so zoomed out it covers the
// merged cells of that level and its count matches the height you see. Everything comes from
// data the page already holds (rows.bin, the block times and the replay worker's resident
// tiles, asked with load: false); hovering never sends a request. Plane mode has its own
// readout (ui/plane-hud.js), and touch-only devices have no hover.

import { fmtInt, fmtBtc, fmtAmount, isoUtc } from './format.js';
import { rowAmountRange } from '../data/axis.js';

const PICK_MS = 100; // a still pointer is picked again this often: the camera or the ground may move
const CELL_MS = 250; // while blocks change, the count refreshes at most 4 times a second
const DOCK_GAP = 10; // space between the HUD and the card

/**
 * Blocks, rows and amounts covered by cell (col, row) of a level: {level, col, row, columns, rows,
 * first, last, rowMin, rowMax, amount: {min, max} | null}, or null outside the grid. Rows no
 * whole amount maps to are skipped at either end; amount.max is Infinity on row 0.
 */
export function cellSpan(grid, rows, level, col, row) {
  const L = grid && grid.levels[level];
  if (!L || !(col >= 0) || !(row >= 0) || col >= L.columns || row >= L.rows) return null;
  const c0 = col * 2 ** L.columnShift;
  const c1 = Math.min((col + 1) * 2 ** L.columnShift, grid.l0Columns) - 1;
  const r0 = row * 2 ** L.rowShift;
  const r1 = Math.min((row + 1) * 2 ** L.rowShift, grid.rows) - 1;
  const first = c0 * grid.blocksPerColumn;
  const last = Math.min((c1 + 1) * grid.blocksPerColumn, grid.numBlocks) - 1;
  // The last row holds the smallest amounts, the first row the largest.
  let lo = null;
  let hi = null;
  if (rows) {
    for (let r = r1; r >= r0 && !lo; r--) lo = rowAmountRange(rows, r);
    for (let r = r0; r <= r1 && !hi; r++) hi = rowAmountRange(rows, r);
  }
  return {
    level, col, row, columns: c1 - c0 + 1, rows: r1 - r0 + 1, first, last, rowMin: r0, rowMax: r1,
    amount: lo && hi ? { min: lo.min, max: hi.max } : null,
  };
}

/**
 * An amount for the card: satoshi amounts below 0.01 BTC exactly, BTC to 4 significant figures,
 * rounded down for the low end of a band (dir < 0) and up for the high end, so the band shown
 * always contains the exact one (the inspector has the exact bounds). inBtc forces BTC, so a
 * band that crosses 0.01 BTC prints both ends in one unit.
 */
export function cardAmount(sat, dir = 0, inBtc = sat >= 1e6) {
  if (!Number.isFinite(sat) || !(sat > 0) || !inBtc) return fmtAmount(sat);
  const btc = sat / 1e8;
  const digits = Math.max(0, 3 - Math.floor(Math.log10(btc)));
  const f = 10 ** digits;
  const x = btc * f;
  const v = (dir < 0 ? Math.floor(x + 1e-9) : dir > 0 ? Math.ceil(x - 1e-9) : Math.round(x)) / f;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits }) + ' BTC';
}

/** "0.01 to 0.01012 BTC", "546 to 600 sat", "100,000 BTC or more"; one unit when both ends share it. */
export function amountText(a) {
  if (!a) return 'No whole amount';
  if (a.max === Infinity) return cardAmount(a.min, -1) + ' or more';
  if (a.min === a.max) return fmtAmount(a.min);
  const lo = cardAmount(a.min, -1, a.max >= 1e6);
  const hi = cardAmount(a.max, 1);
  const unit = (s) => s.slice(s.lastIndexOf(' '));
  return (unit(lo) === unit(hi) ? lo.slice(0, lo.lastIndexOf(' ')) : lo) + ' to ' + hi;
}

/** {blocks: "812,544 to 812,607", dates: "2023-10-12" or "2023-10-12 to 2023-10-19" (UTC)}. */
export function blocksText(span, blocktimes) {
  const blocks = fmtInt(span.first) + ' to ' + fmtInt(span.last);
  const day = (b) => (blocktimes && Number.isFinite(blocktimes[b]) ? isoUtc(blocktimes[b], { time: false }) : null);
  const a = day(span.first);
  const b = day(span.last);
  return { blocks, dates: a ? (b && b !== a ? a + ' to ' + b : a) : '' };
}

/**
 * The live rows for a worker cell at a block: {outputs, value}, or null while the count is
 * unknown (no replayed block yet, or the worker has not answered).
 */
export function liveText(span, cell, block) {
  if (!Number.isInteger(block)) return null;
  if (span.first > block) return { outputs: 'Not created yet', value: '\u2014' };
  if (!cell) return null;
  const count = cell.countSmall + cell.countLarge;
  const sats = cell.satsSmall + cell.satsLarge;
  return { outputs: fmtInt(count), value: count === 0 ? '0 BTC' : fmtBtc(sats) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const row = (label, value, cls = '') => '<div' + (cls ? ' class="' + cls + '"' : '') + '><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>';

/**
 * container: #hover; canvas: the view canvas; pick(clientX, clientY) → terrain hit (render/index.js);
 * replay: the replay client (block, cell()); mode() → 'map' | 'flight' | 'plane';
 * anchor: the element the card docks under, at the same left edge and width (the HUD).
 */
export function createHover({
  container, canvas, pick, replay, grid, rows, blocktimes, mode = () => 'map', anchor = null, enabled = true,
}) {
  const off = { update() {}, hide() {}, get current() { return null; } };
  if (!container || !canvas || !enabled) return off;
  container.hidden = true;
  let pointer = null; // client point of a hovering mouse or pen over the canvas
  let moved = false;
  let lastPick = -Infinity;
  let span = null;
  let key = '';
  let cell = null; // {key, value} from the replay worker; value null when it has no state there
  let waiting = false; // aimed at a new cell whose count has not arrived yet
  let lastLive = null; // the previous rows, shown dimmed while waiting
  let seq = 0;
  let askedAt = -Infinity;
  let askedBlock = null;
  let html = '';
  let dock = '';
  let current = null;

  const forget = () => {
    pointer = null;
    moved = true;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return forget();
    pointer = { x: e.clientX, y: e.clientY };
    moved = true;
  });
  canvas.addEventListener('pointerleave', forget);
  canvas.addEventListener('pointercancel', forget);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') forget();
  });
  addEventListener('blur', forget);

  function aim(m) {
    if (m === 'plane') return null;
    if (m === 'flight') {
      const r = canvas.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (!pointer || canvas.classList.contains('dragging')) return null;
    return pointer;
  }

  function hide() {
    if (!container.hidden) container.hidden = true;
    span = null;
    key = '';
    current = null;
  }

  function ask(now) {
    const my = ++seq;
    const k = key;
    const s = span;
    askedAt = now;
    askedBlock = replay.block;
    Promise.resolve(replay.cell(s.level, s.col, s.row, { load: false })).then((c) => {
      if (my !== seq || k !== key) return;
      cell = { key: k, value: c && !c.cancelled ? c : null };
      waiting = false;
    }, () => {});
  }

  function render(block, m) {
    const s = span;
    const { blocks, dates } = blocksText(s, blocktimes);
    const mine = cell && cell.key === key ? cell.value : null;
    let live = liveText(s, mine, block);
    let dim = false;
    if (live) lastLive = live;
    else if (waiting) {
      // The previous cell's rows stay, dimmed, until the worker answers (usually next frame).
      live = lastLive || { outputs: '\u2026', value: '\u2026' };
      dim = true;
    } else {
      live = { outputs: '\u2014', value: '\u2014' }; // the worker holds no state for this cell
      dim = true;
    }
    let out = '<span class="eyebrow">' + (m === 'flight' ? 'At the crosshair' : 'Under the cursor') + '</span><dl>' +
      row('Size', amountText(s.amount)) + row('Blocks', blocks) + (dates ? row('Mined', dates) : '');
    if (Number.isInteger(block)) {
      const cls = 'hv-live' + (dim ? ' stale' : '');
      out += row('Unspent outputs', live.outputs, cls) + row('Value', live.value, cls);
    }
    out += '</dl>';
    if (s.level > 0) out += '<p>Zoomed out: ' + fmtInt(s.columns) + ' \u00d7 ' + fmtInt(s.rows) + ' cells drawn as one</p>';
    if (out !== html) {
      html = out;
      container.innerHTML = out;
    }
    current = { mode: m, level: s.level, col: s.col, row: s.row, first: s.first, last: s.last, rowMin: s.rowMin, rowMax: s.rowMax,
      amount: s.amount, block, cell: mine };
  }

  // Same left edge and width as the anchor, just below it (its height changes with its content).
  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    if (!(r.width > 0)) return;
    const d = Math.round(r.left) + ',' + Math.round(r.bottom + DOCK_GAP) + ',' + Math.round(r.width);
    if (d === dock) return;
    dock = d;
    container.style.left = Math.round(r.left) + 'px';
    container.style.top = Math.round(r.bottom + DOCK_GAP) + 'px';
    container.style.width = Math.round(r.width) + 'px';
  }

  return {
    /** Once per frame: pick what the pointer (or the crosshair) is aimed at and refresh the card. */
    update(now = performance.now()) {
      const m = mode();
      const a = aim(m);
      if (!a) return hide();
      if (moved || now - lastPick >= PICK_MS) {
        moved = false;
        lastPick = now;
        let hit = null;
        try {
          hit = pick(a.x, a.y);
        } catch {
          hit = null;
        }
        const level = hit && Number.isInteger(hit.level) ? hit.level : 0;
        span = hit ? cellSpan(grid, rows, level, hit.col, hit.row) : null;
      }
      if (!span) return hide();
      const block = replay.block;
      const k = span.level + ':' + span.col + ':' + span.row;
      if (k !== key) {
        key = k;
        waiting = true;
        ask(now);
      } else if (block !== askedBlock && now - askedAt >= CELL_MS) {
        ask(now);
      }
      render(block, m);
      place();
      container.hidden = false;
    },
    hide,
    /** What the card shows (for checks): the cell, its ranges, the worker's counts and the text. */
    get current() {
      return container.hidden || !current ? null : { ...current, text: container.innerText };
    },
  };
}
