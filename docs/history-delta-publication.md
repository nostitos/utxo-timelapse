# Journal-based history publication

This replaces the old publisher's full-history discovery scan and repeated old
shard sorting. No rendering/geometry changes and no automatic live deployment.

## September 13 validation

- One-time setup **completed**: all 1,889 current shards validated in **377.72s**
  (6m18s), producing **14,661,476,060 bytes** of unique position-cache files.
- `history_publication_current.json` now points to
  `/Volumes/4T Data/buv_render/history_delta_setup_20260913/catalog.json`, matching
  the existing published tip 966,764. The live release and source history were
  not modified. Catalog-capable Worker code is tested locally and must be
  included with the next release; it has not been deployed in this change.
- Native: 6 cases / 2,033 assertions. Python: 88 tests. Worker routing: 8 checks.
  Eight complete pixel responses from the candidate Worker using existing R2
  objects exactly matched the previously verified production results.
- Bounded warm-cache test used 2,929,993 records/46.88 MB from real shard 1758,
  with a **synthetic** 10,000-spend transition. Old shard rebuild: **105 ms**;
  new complete journal staging: **30 ms**. Spend-patch bytes were identical;
  zero historical complete shards rebuilt. This is not a measured full next
  update or an 11-minute-to-30-millisecond speedup claim.
- Evidence: `/Volumes/4T Data/buv_render/history_delta_setup_20260913/result.json`
  and adjacent setup, benchmark, native and Worker verification logs.

## First routine journal update completed

The subsequent September 13 update through **966,827** is now publicly and locally
verified. Preparation took **357.39s**, upload **16.65s** (59.70 MB): zero old
shard discovery scans, one creation shard rebuilt, 824 patched and 1,064 reused.
The per-shard catalog Worker is now deployed. Follow
`history_publication_current.json`, now pointing to
`/Volumes/4T Data/buv_render/update_20260913_journal/history-staged/catalog.json`,
not the original setup catalog. See the [complete timed report](history/video-update-2026-09-13-journal.md)
for caveats, I/O observations and playback checks.

## Design and cost

- `utxo_history_update` with a fresh optional `historyDeltaFile` records exact
  record IDs, creation amounts/heights and spend heights while matching spends.
  New records and target time/index arrays are included in the same journal.
- A one-time local position cache maps record IDs to existing cloud row-sorted
  positions: four bytes per record plus row offsets, about **14.7 GB** currently.
  This is disposable derived data, not another full lifecycle database.
- Each update reads only affected position files/records and small prior patches.
  Old patches are merged; unchanged object URLs are reused. Only the creation
  tail (including its previously partial shard) is rebuilt. At most one patch
  per shard is queried, not an ever-growing chain of patches.
- New Worker `historyShardSources` entries select each shard's immutable base,
  base tip and optional patch independently. Legacy release arrays still work.

Setup validates the complete reconstructed base MD5 and current spend patch,
not just a sample. Position files have SHA-256 receipts bound to source range
and mapper geometry. Routine reads trust local file size/inode/mtime/ctime;
changed caches fail closed instead of rehashing all 14.7 GB every update. Protect
cache/catalog files like renderer checkpoints. Bootstrap is resumable only for
the same history filesystem identity and header. Setup/staging use shared
history locks; the native updater takes an exclusive lock.

## One-time setup (no uploads/deployment)

Run from the repository root, using the installed NumPy/boto3 environment:

```sh
PY="$HOME/.local/share/buv-r2/venv/bin/python"
D='/Volumes/4T Data/buv_render'
S="$D/history_delta_setup_20260913"
"$PY" scripts/history_delta_publish.py seed --history "$D/utxo_history.bin" \
  --run "$D/update_20260913" --output "$S/seed.json"
"$PY" scripts/history_delta_publish.py bootstrap --history "$D/utxo_history.bin" \
  --seed "$S/seed.json" --cache "$D/history_positions" \
  --objects "$D/history_delta_objects" --catalog "$S/catalog.json" --workers 4 --r2
```

The seed must describe the last verified published release. Setup reads existing
patches from R2 and verifies existing full-shard ETags without uploading anything.

## Routine update

First verify/append the BLK suffix as usual. **Do not run the un-journaled history
updater first.** Allow only one unpublished history update at a time.

```sh
RUN="$D/CHOOSE_A_FRESH_UPDATE_DIRECTORY"
CATALOG=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["catalog"])' "$D/history_publication_current.json")
"$PY" scripts/history_delta_publish.py prepare-update \
  --config configs/buv_render_full_weighted.json --history "$D/utxo_history.bin" \
  --catalog "$CATALOG" --output "$RUN"
./build_local/buv -ns -tc=utxo_history_update -cfg="$RUN/history-update.json"
"$PY" scripts/history_delta_publish.py stage \
  --history "$D/utxo_history.bin" --journal "$RUN/history.delta" \
  --catalog "$CATALOG" --cache "$D/history_positions" \
  --objects "$D/history_delta_objects" --output "$RUN/history-staged" \
  --prefix explorer/CHOOSE_A_NEW_RELEASE/history --r2
# After reviewing/validating staged data:
"$PY" scripts/history_delta_publish.py upload \
  --staged "$RUN/history-staged/staged.json" --workers 16
```

`staged.json` records elapsed time and changed/rebuilt/reused shards/bytes.
Uploads conditionally create objects, verify ETags and can resume identical
objects. A failed stage preserves its directory; retry in a fresh staging path.
No-op native updates produce no journal: stop rather than publishing again.

Merge `history-staged/release-history.json` into the **new** Worker release,
retaining video/UI fields. Deploy the new Worker source, verify pixel endpoints
against exact local history plus metadata and actual browser playback, then
advance the retained catalog pointer to `history-staged/catalog.json`.
Do not advance merely because upload succeeded. On failure keep the old release
and retry publication before another history update. The legacy publisher is a
recovery option, not the routine path after adopting the catalog.

The append planner accepts an optional `historyDeltaFile` source-manifest key
and clears inherited journal paths otherwise. Its history stage must invoke
the fresh config and retain the journal as a verified stage output.

## Durability and limits

The complete write-ahead journal is checksummed/fsynced before history mutation.
It includes all target arrays, so recovery does not depend on overwritten old
trailing arrays. Reusing its path replays idempotently after checking BLK
boundary/tail hash and exact before/after header. Target headers gain a lineage
token in reserved bytes; existing readers remain compatible. Duplicate amounts
retain LIFO identity and same-block creations/spends remain exact.

Incomplete pending journals, torn/unrecognized headers, corrupt caches and
conflicting spends stop with an error and are preserved. Recovery is not a
substitute for validated BLK prefix continuity or protection against arbitrary
disk damage. The optional flag defaults empty; the **legacy un-journaled path
does not gain these crash-recovery guarantees**. No MP4 packaging changes here.

## Tests

```sh
cmake --build build_local --parallel 4
./build_local/buv -ns '-tc=history_delta_journal,block_index,renderer_checkpoint_sha256'
"$PY" -m unittest discover -s scripts/tests -p test_history_delta_publish.py
node scripts/tests/test_history_sources.mjs
```

Tests compare bytes with the old publisher across successive updates, assert
old complete shards are never rebuilt, and cover duplicate identities,
corruption, stale/missing catalogs, partial/exact boundaries, no creations,
same-block spends and interrupted native writes.
