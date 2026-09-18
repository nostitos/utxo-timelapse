// A journal release resolves each shard independently. Unchanged objects keep
// their immutable keys; each touched shard still has at most ONE merged patch.
// Legacy releases remain readable until a validated catalog is promoted.
export function historySource(release, shard) {
  if (release.historyShardSources) {
    const source = release.historyShardSources[String(shard)];
    if (!source || typeof source.baseKey !== 'string' ||
        !Number.isInteger(source.baseTip) || source.baseTip < 0 ||
        source.baseTip >= release.numBlocks ||
        (source.patchKey !== undefined && typeof source.patchKey !== 'string')) {
      throw new Error(`missing or invalid history source ${shard}`);
    }
    return source;
  }
  const full = release.historyFullShards.includes(shard);
  const prefix = full ? release.historyDeltaPrefix : release.historyBasePrefix;
  return {
    baseKey: `${prefix}/shards/${String(shard).padStart(5, '0')}.bin`,
    baseTip: full ? release.numBlocks - 1 : release.historyOldTip,
    patchKey: release.historyPatchShards.includes(shard)
      ? `${release.historyDeltaPrefix}/spends/${String(shard).padStart(5, '0')}.bin`
      : undefined,
  };
}
