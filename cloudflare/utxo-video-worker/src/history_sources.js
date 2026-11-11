// A journal release resolves each shard independently. Unchanged objects keep
// their immutable keys; each touched shard still has at most ONE merged patch.
export function historySource(release, shard) {
  const source = release.historyShardSources?.[String(shard)];
  if (!source || typeof source.baseKey !== 'string' ||
      !Number.isInteger(source.baseTip) || source.baseTip < 0 ||
      source.baseTip >= release.numBlocks ||
      (source.patchKey !== undefined && typeof source.patchKey !== 'string')) {
    throw new Error(`missing or invalid history source ${shard}`);
  }
  return source;
}
