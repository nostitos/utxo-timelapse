// Block <-> UTC time helpers for the timeline and HUD. Pure module.
//
// Block timestamps (blocktimes.bin, u32 seconds) are only roughly monotonic: miners'
// clocks drift by up to about two hours. dateToBlock mirrors the native explorer's
// /api/date (src/cpp/app/utxo_explorer.cpp): binary search for the first block whose
// timestamp is >= the target, then step back over up to 24 earlier out-of-order blocks
// that also satisfy it. Both tools therefore resolve a date to the same block.

export function blockTime(blocktimes, block) {
  if (!blocktimes || !Number.isInteger(block) || block < 0 || block >= blocktimes.length) return null;
  return blocktimes[block];
}

/** First block at or after the UTC time (seconds), or null when the time is after the tip. */
export function dateToBlock(blocktimes, target, numBlocks = blocktimes.length) {
  const n = Math.min(numBlocks, blocktimes.length);
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (blocktimes[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  for (let h = lo; h > 0 && h + 24 > lo; --h) {
    if (blocktimes[h - 1] >= target) best = h - 1;
  }
  return best >= n ? null : best;
}

/**
 * Parse a UTC date or date-time typed by the user. Accepts YYYY-MM-DD, YYYY-MM-DDTHH:MM,
 * YYYY-MM-DD HH:MM:SS, with an optional trailing Z or "UTC". Returns seconds or null.
 */
export function parseUtc(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(?:Z|UTC)?$/i);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1);
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return null;
  if (+h > 23 || +mi > 59 || +s > 59) return null;
  return Math.floor(ms / 1000);
}

/** Value for <input type="datetime-local" step="1"> interpreted as UTC. */
export function toDateTimeInput(seconds) {
  if (!Number.isFinite(seconds)) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 19);
}
