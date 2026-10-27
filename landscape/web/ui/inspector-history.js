// Population samples include outputs already spent at selection, independently of
// the capped per-output lists. Each bucket is the count at the END of its interval.
export function populationTimeline(res, block) {
  const pop = res?.pop;
  if (!Array.isArray(pop) || !pop.length || !pop.every((n) => Number.isFinite(n) && n >= 0) ||
      !Array.isArray(res.blockRange)) return null;
  const first = res.blockRange[0];
  if (!Number.isInteger(first) || first < 0) return null;
  const cutoff = Number.isInteger(res.cutoffBlock) && res.cutoffBlock >= first ? res.cutoffBlock : null;
  const start = cutoff == null ? 0 : first;
  const end = cutoff ?? pop.length - 1;
  const points = pop.map((count, i) => [cutoff == null ? i :
    Math.min(cutoff, first + Math.ceil((i + 1) * (cutoff - first + 1) / pop.length) - 1), count]);
  const selected = cutoff == null ? res.viewBin : block;
  return { points, start, end, selected: Number.isFinite(selected) && selected >= start && selected <= end ? selected : null };
}

// Exact survival of the outputs alive at a selected block. A capped list cannot
// locate every spend, even though the API's aggregate endpoint counts are exact.
export function survivalTimeline(res, block) {
  const cutoff = res?.cutoffBlock;
  const list = res?.utxos;
  if (!Number.isInteger(block) || !Number.isInteger(cutoff) || cutoff < block ||
      !Array.isArray(list) || res.truncated || list.length !== res.count) return null;
  const spends = new Map();
  let remaining = res.count;
  for (const u of list) {
    if (u.created > block) return null;
    if (u.spent == null) continue;
    if (!Number.isInteger(u.spent) || u.spent <= block || u.spent > cutoff) return null;
    spends.set(u.spent, (spends.get(u.spent) || 0) + 1);
  }
  const points = [[block, remaining]];
  for (const [height, count] of [...spends].sort((a, b) => a[0] - b[0])) {
    points.push([height, remaining], [height, remaining -= count]);
  }
  if (remaining !== res.stillUnspent) return null;
  points.push([cutoff, remaining]);
  return points;
}
