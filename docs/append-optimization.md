# Faster append updates

For the next history-publishing optimization, use the [journal-based history
workflow](history-delta-publication.md), not the cumulative full-scan publisher.

Implementation work began with hidden epoch slides, the largest isolated and
measured replay cost. The September 10 update encoded only its tail, but spent
1,989 seconds rebuilding invisible historical slide frames. The optimized
renderer settles a completely hidden slide once and rebuilds the exact ledger
at the first visible block. A range beginning inside a slide keeps that slide.

## Implemented paths

| Part | Behavior |
|---|---|
| Hidden replay | One rebuild instead of 120 for a completely invisible epoch slide. No output-range/config change required. |
| BLK offset index | Adjacent `changes.blk1.full964k.idx`; block count, HUD date samples and history-update start no longer scan old BLK pages. Extends over new records. |
| Renderer checkpoint | Save/load exact ledger weights before a stable block boundary. Resume with the same rendering configuration and an append-compatible BLK prefix. |
| Chunk verification | 256 MiB SHA-256 manifests and exact partial-chunk prefix contracts on both hosts. Cache reuse requires unchanged protected input or a trusted append attestation; otherwise hash again. |
| Data sync | Manifest-driven, bounded suffix download/verification/apply with writer locks. Existing v3 updater remains responsible for extraction. |
| Node schedule | Daily processed-data update; never starts a running or failed container. On the current Umbrel host, a systemd timer supplies the schedule because cron is absent. |
| History upload | `--workers` controls parallel shard publication and HTTP pool size; the default is 16. The old September 10 publisher still needs fresh release/routing inputs before reuse. |
| Media packaging | Packet-copy only the short old segment prefix plus new encoded tail, then rebase fragment timestamps. Immutable segment manifests retain previous objects and replace the old ending transactionally. |
| Publication | Stage new objects, upload at most five concurrently, verify explicit public expectations, deploy with explicit argv, and roll back on failed post-deployment checks. |
| Orchestration | Fresh source/run manifests, measured IDR join, epoch-aware warm-up, parallel dependency stages, rolling checkpoint, per-step logs and validated resume. |

The current production video is not replaced merely by installing these tools.
No full-chain encoding is needed for their bootstrap or validation. Native MP4
export remains an optional packet-copy operation; routinely rewriting the full
84 GB master would give back part of the time saved by fragment publication.

## Renderer checkpoint contract

New optional configuration:

| Key | Meaning |
|---|---|
| `rendererCheckpointSave` | New output file. The visualizer refuses to overwrite an existing checkpoint. |
| `rendererCheckpointLoad` | Existing input file; mismatch/corruption fails rather than silently replaying with incomplete state. |
| `rendererCheckpointSaveAtBlock` | Save immediately before processing this height. Missing/0 uses `startShowAtBlockHeight`. A later value advances the checkpoint for the next append during the current run. |
| `dumpFramesAtBlocks` | Array of visible block heights to save as exact `frame_XXXXXXX.ppm` files in the renderer working directory. |

`BUVRCP01` stores the next height C, `index[C]`, SHA-256 of the complete BLK
record C−1, epoch, configuration fingerprint, and sorted little-endian
`{uint64 key, float64 weight}` records. The key encodes creation height and Y
row; the value preserves the exact stored double bits. Header and full payload
have independent integrity checks. Save uses an adjacent temporary file and
atomic replacement; failed loads do not install partially read state.

This version supports `normalizedGeometric`. Resolution, graph rectangle,
amount scale, epoch settings, density weights/filter and palettes are bound to
the checkpoint. Paths, visible range, output limit and encoder are not density
state; the append planner separately enforces the accepted encoding contract.
Changing rendering semantics requires a new checkpoint format/fingerprint.

A checkpoint before C contains every creation/spend through C−1. C may equal
an epoch boundary, before the slide starts, but cannot lie partway through a
slide. A loaded checkpoint can precede the new visible warm-up start. The
renderer reconstructs its raster immediately, then processes intervening
changes normally. Flash/flow history is recreated by the 1,380-block warm-up.

The checkpoint's last-record binding is not proof that all historical input
bytes are unchanged. The sync step must establish prefix continuity first.
Likewise, the offset sidecar is a disposable acceleration cache, not a chain
integrity database. Same-size file edits invalidate its filesystem stamp;
growth must come from the verified append workflow.

Ledger weights are saved exactly, but re-inserting a hash map can change the
order of floating-point summation. Raw RGB comparison is the acceptance gate;
a lossy encoded comparison does not prove pixel equality. Legacy accumulation
order has not been globally changed to make tests pass.

## Commands and manifests

From the repository root:

```sh
cmake --build build_local --parallel 6
./build_local/buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3,block_index,renderer_checkpoint,renderer_checkpoint_sha256'
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s scripts/tests -v
```

Bootstrap the optional block index explicitly:

```sh
./build_local/buv -ns -tc=block_index_build -cfg=/absolute/path/render-config.json
```

Prepare an append from a fresh source manifest, then run its dependency graph:

```sh
python3 scripts/append_update.py plan /absolute/path/source.json
python3 scripts/append_update.py prepare /absolute/path/source.json
python3 scripts/append_update.py run /absolute/path/new-run
```

The source manifest supplies absolute `master`, `blk`, `history`, `config`,
`buv` and fresh `runPath` paths, explicit `oldEndBlock`/`newEndBlock`, port,
ending frame count, and optional `{path,nextHeight}` renderer checkpoint.
The planner measures a real closed-GOP IDR in the retained master; it does not
infer the join from filename or assume every keyframe flag is an IDR. The new
tail includes the overlap at JOIN and replaces all old ending frames.

Custom data/index/history/package/publish stages use argv arrays, dependencies,
durable receipts and semantic verification commands. Independent history work
may run beside rendering. A completed stage is skipped only when its manifest
and output evidence still match. Interrupted writers/partial outputs require
reconciliation; `--retry` is not permission to overwrite them. Each run keeps
`timings.jsonl`, process logs, progress, seals and stage status files.

Use the new `sync_blk_append.py` interface for data transfer. `dry-run` validates
its manifest locally, `prepare` obtains a fixed node checkpoint target and a
verified suffix, and `apply` revalidates snapshots before appending. All writers
must share the configured operational locks. Credentials are supplied through
the SSH agent/environment; never place passwords or tokens in a manifest.
Missing cache continuity deliberately falls back to a full prefix hash.

For media publication, `package_append.py` consumes the verified render plan
and a pinned previous fragment manifest. `publish_append.py prepare` creates a
new immutable publication; execution requires the explicit deployment and
rollback/check manifest described in `publication_commands.py`. Previous media
URIs remain referenced, not downloaded or reuploaded. The first migration from
the existing MP4/HLS needs a trusted fragment catalog; do not invent hashes for
old cloud objects or blindly reuse September 10 release constants.

`import_hls_catalog.py inventory SPEC.json` checks an existing saved, SHA-pinned
media playlist offline. To bootstrap the catalog, the separate explicit
`bootstrap SPEC.json --allow-remote` command streams and hashes actual media
objects once, validates their exact fragment timing, and saves only the init,
catalog and proof. It neither re-encodes nor stores the historical fragments.
Its specification and supported format limits are documented in the script.
This initial audit may read the entire ~84 GB corpus remotely when verified
local fragment caches are unavailable; budget it separately, never launch it
implicitly during an append. The command is fixture-tested, but the existing
production catalog has **not** been migrated in this implementation run.

## Initial validation evidence

Machine evidence is under
`/Volumes/4T Data/buv_render/append_optimization_20260912/`.

| Measurement | Result |
|---|---|
| Raw 1080p ranges beginning 209,999 / 210,060 / 210,120 / 224,000 | All 1,487 frames byte-identical to the saved original binary; ledger misses/dropped decrements 0. |
| Range 224,000–225,000, including ending | 19.10 s baseline → 8.16 s optimized. |
| Range 210,120–210,180, including ending | 15.26 s baseline → 4.78 s optimized. |
| Full BLK offset index build | 84.38 s once; cached load/build command 0.19 s. |
| Local 18.30 GB SHA-256 chunk bootstrap | 15.06 s. |
| Node chunk bootstrap | 61.23 s; all 69 chunk/prefix hashes match the local source. |
| Real node/local no-op sync, unchanged verified caches | 7.00 s total (4.32 s prepare + 2.69 s apply), down from 138.93 s before indexed tip lookup; zero bytes appended. |
| Fresh optimized replay + 1,681 raw 4K frames | 730.23 s, including checkpoint save. |
| Same 1,681 raw 4K frames from checkpoint | 36.74 s; every frame byte-identical to fresh replay (19.9× faster for this test). |
| Checkpoint size/save | 980,502,328 bytes, 61,281,384 ledger entries; save took 13.60 s. |

The accepted checkpoint is `/Volumes/4T Data/buv_render/renderer_before_964980.bin`;
`renderer_checkpoint_current.json` beside it records its input/config and proof
paths. The validation directory references the same inode, not a second 981 MB
copy. Both runs ended successfully with zero ledger misses/dropped decrements.
Their final raw frame also matches the saved final frame from the September 10
completed render. These are renderer/raw-output timings, not software HEVC
encoding or end-to-end publication timings. Unit/fixture checks of packaging and
publication remain separate from a real cloud promotion.

The final rebuilt binary repeated the same 1,681-frame equality gate in 38.26 s.
The six native test cases passed 2,127 assertions, and the guide/production
mapping check passed 57,459 coordinates/inverses. A bounded replay regression
also fixes the ending HUD using the first excluded block: ending frames now
retain the last actually processed block. This does not change full-tip output.

The old six-minute total estimate remains a target until a new data-to-live
append has been measured using these paths. A checkpoint eliminates genesis
replay; it does not eliminate data extraction, actual new-block processing,
history matching, network transfer, encoding or publication verification.

## Installed node schedule

**Removed.** The October 9, 2026 umbrelOS update replaced the node's system
partition and deleted the timer, the service and `/usr/local/lib/utxo-timelapse`;
the updater had already been failing since an out-of-memory kill on October 4.
The description below is the September configuration, kept for reference. A
reinstalled schedule must keep its files under `/home` or be reinstalled after
every umbrelOS update. See the [October 9 report](history/site-update-2026-10-09.md).

`utxo-timelapse-blk-update.timer` is enabled for 03:15 UTC daily. Its oneshot
service runs `/usr/local/lib/utxo-timelapse/umbrel_daily_blk_update.py --run` as
root, validates the retained container/config and uses
`/home/umbrel/buv_data/.daily-blk-update.lock`. The timer has no catch-up run and
does not restart failed jobs. Existing container image/config/data are retained.

Read status with `systemctl status utxo-timelapse-blk-update.timer` and logs with
`journalctl -u utxo-timelapse-blk-update.service` on the node. Disabling the timer
does not delete the BLK/checkpoint pair. Installation was verified without
starting the updater; the first scheduled execution is a separate runtime gate.
