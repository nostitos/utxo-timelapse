# UTXO cleanup — completed

The approved cleanup is complete. The user's final instruction superseded the
backup/migration proposal: keep each working file where it is needed, with no
extra backup pair and no fallback videos.

- **Mac external drive:** latest MP4, the current working `changes.blk1.full964k`,
  and `utxo_history.bin`.
- **Umbrel:** matching `changes.blk1.v3` and `checkpoint_v3.utxo`, plus the v3
  updater runtime.
- **Both:** necessary source, configurations, dependencies and deployment tools.
- **Cloud:** current production objects unchanged.

See [retained files and update procedure](render-files.md) and the
[completion report](cleanup-completed-2026-09-09.md).

The [artifact manifest](cleanup-audit-2026-09-09/artifact-manifest.csv) records
`kept` or `deleted` for each reviewed path. Full operation records are in
`/Volumes/4T Data/buv_render/cleanup-records-20260910/`.
