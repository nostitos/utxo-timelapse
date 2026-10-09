// Formatting shared by the HUD, timeline, legend and inspector. fmtBtc and fmtAge
// mirror the native explorer (src/cpp/app/explorer_ui/explorer.html) so both tools
// print amounts and ages the same way. Pure module: no DOM, no three.js.

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DASH = '\u2014';

export function fmtInt(n) {
  return Number.isFinite(n) ? INT.format(Math.round(n)) : DASH;
}

export function fmtBtc(sat) {
  if (!Number.isFinite(sat)) return DASH;
  const btc = sat / 1e8;
  if (btc >= 1) return btc.toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' BTC';
  if (sat >= 100000) return (sat / 1e8).toFixed(8).replace(/0+$/, '') + ' BTC';
  return sat.toLocaleString('en-US') + ' sat';
}

// Large BTC totals for the HUD: 19,612,345.12 BTC.
export function fmtBtcTotal(sat) {
  if (!Number.isFinite(sat)) return DASH;
  return (sat / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' BTC';
}

export function fmtAge(blocks) {
  if (!Number.isFinite(blocks)) return DASH;
  const years = blocks / 52560; // ~10 min blocks
  if (years >= 1) return years.toFixed(1) + ' y';
  const days = blocks / 144;
  if (days >= 1) return days.toFixed(0) + ' d';
  return blocks + ' blk';
}

function trimZeros(s) {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

// Compact magnitudes for legend ticks and rates: 950, 1.2K, 34M, 1.5B.
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, s] of units) {
    if (a >= v) {
      const x = n / v;
      const ax = Math.abs(x);
      return trimZeros(ax >= 100 ? x.toFixed(0) : ax >= 10 ? x.toFixed(1) : x.toFixed(2)) + s;
    }
  }
  if (a === 0) return '0';
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return trimZeros(n.toFixed(1));
  if (a >= 1) return trimZeros(n.toFixed(2));
  return String(Number(n.toPrecision(2)));
}

// Amount labels for rows and bands: 50 BTC, 0.1 BTC, 10,000 sat, 546 sat.
export function fmtAmount(sat) {
  if (!Number.isFinite(sat)) return DASH;
  if (sat >= 1e6) return (sat / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' BTC';
  return Math.round(sat).toLocaleString('en-US') + ' sat';
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// Block timestamps are seconds since 1970 (UTC).
export function isoUtc(seconds, { time = true, withSeconds = false } = {}) {
  if (!Number.isFinite(seconds)) return DASH;
  const d = new Date(seconds * 1000);
  const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  if (!time) return date;
  const hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  return date + ' ' + hm + (withSeconds ? ':' + pad(d.getUTCSeconds()) : '') + ' UTC';
}

export function fmtRate(blocksPerSecond) {
  if (!Number.isFinite(blocksPerSecond)) return DASH;
  if (blocksPerSecond >= 10000) return fmtCompact(blocksPerSecond) + ' blocks/s';
  return fmtInt(blocksPerSecond) + ' blocks/s';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
