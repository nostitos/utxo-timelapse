// Seek planning (SPEC §5): cheapest of the current resident state, the nearest snapshot
// at or below the target (forward replay) and the nearest snapshot above (backward).
// Pure functions.

/** Index of the last snapshot with block <= target (-1 if none). */
export function snapshotAtOrBelow(blocks, target) {
  let lo = 0;
  let hi = blocks.length - 1;
  if (hi < 0 || blocks[0] > target) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (blocks[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * @param p.target target block
 * @param p.current current state block or null
 * @param p.snapshots [{block, blkEnd}] sorted by block
 * @param p.blkStart (block) -> source byte offset of the start of a block
 * @param p.applyBytesPerMs replay rate with the resident tile set
 * @param p.loadMsPerTile cost of fetching and decoding one tile from a snapshot
 * @param p.decodeBytesPerMs catch-up rate for newly loaded tiles (decode + filtered apply)
 * @param p.tilesToLoad tiles needed by a snapshot plan
 * @param p.missingTiles tiles the current plan still has to load
 * @returns {{kind:'current'|'below'|'above', snapshotIndex:number, from:number, bytes:number, cost:number, options:object[]}}
 */
export function planSeek(p) {
  const { target, current, snapshots, blkStart } = p;
  const apply = p.applyBytesPerMs || 10000;
  const loadTile = p.loadMsPerTile ?? 2;
  const decode = p.decodeBytesPerMs || 100000;
  const end = blkStart(target + 1);
  const blocks = snapshots.map((s) => s.block);
  const options = [];
  const below = snapshotAtOrBelow(blocks, target);
  const above = below + 1 < snapshots.length ? below + 1 : -1;
  // Catch-up distance for tiles loaded separately: nearest snapshot by bytes.
  const nearestGap = Math.min(
    below >= 0 ? end - snapshots[below].blkEnd : Infinity,
    above >= 0 ? snapshots[above].blkEnd - end : Infinity,
  );
  if (current !== null && current !== undefined) {
    const bytes = Math.abs(end - blkStart(current + 1));
    const missing = p.missingTiles || 0;
    const cost = bytes / apply + missing * loadTile + (missing > 0 && Number.isFinite(nearestGap) ? nearestGap / decode : 0);
    options.push({ kind: 'current', snapshotIndex: -1, from: current, bytes, cost });
  }
  const n = p.tilesToLoad || 1;
  if (below >= 0) {
    const bytes = end - snapshots[below].blkEnd;
    options.push({ kind: 'below', snapshotIndex: below, from: snapshots[below].block, bytes, cost: n * loadTile + bytes / apply + bytes / decode });
  }
  if (above >= 0) {
    const bytes = snapshots[above].blkEnd - end;
    options.push({ kind: 'above', snapshotIndex: above, from: snapshots[above].block, bytes, cost: n * loadTile + bytes / apply + bytes / decode });
  }
  if (!options.length) throw new Error('planSeek: no snapshot and no current state');
  let best = options[0];
  for (const o of options) if (o.cost < best.cost) best = o;
  return { ...best, options };
}
