// Calendar context for output rows. Never treat a block height as elapsed seconds.
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function outputDate(date, height, times) {
  const seconds = times?.[height];
  const fallback = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : fallback;
  const ms = iso ? Date.parse(iso + 'T00:00:00Z') : NaN;
  return { iso: Number.isFinite(ms) ? iso : null, label: Number.isFinite(ms) ? DATE.format(ms) : 'Date unavailable' };
}

export function outputHeldFor(output, block, times) {
  const end = output.spent ?? block;
  const blocks = end - output.created;
  if (!Number.isInteger(blocks) || blocks < 0) return { label: '—', blocks: null, approximate: false };
  if (blocks === 0) return { label: output.spent == null ? 'Just created' : 'Same block', blocks, approximate: false };
  const elapsed = times?.[end] - times?.[output.created];
  const approximate = !Number.isFinite(elapsed) || elapsed < 0;
  const seconds = approximate ? blocks * 600 : elapsed;
  let label;
  if (seconds < 60) label = '<1 min';
  else if (seconds < 3600) { const n = Math.round(seconds / 60); label = n + ' min'; }
  else if (seconds < 86400) { const n = Math.round(seconds / 3600); label = n + (n === 1 ? ' hour' : ' hours'); }
  else if (seconds < 60 * 86400) { const n = Math.round(seconds / 86400); label = n + (n === 1 ? ' day' : ' days'); }
  else if (seconds < 365.25 * 86400) label = Math.round(seconds / (30.4375 * 86400)) + ' months';
  else { const n = Number((seconds / (365.25 * 86400)).toFixed(1)); label = n + (n === 1 ? ' year' : ' years'); }
  return { label: (approximate ? '≈' : '') + label, blocks, approximate };
}
