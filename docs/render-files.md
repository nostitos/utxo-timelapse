# Current render and update files

**November 4 3D-only update:** the working BLK and the 3D landscape (`d974621-20261104`) cover block 974,621; the 2D video streams and the exact history still end at 974,310, so the 3D inspector shows lifecycle details through 974,310. The next 2D update keeps 974,310 as its video and history old end, while its sync appends to the BLK from 974,621. See the [November 4 report](history/landscape-update-2026-11-04.md).

**November 4 R2 change:** the 3D datasets share their snapshots and chunks at `landscape/blobs/<sha256>`, so the bucket holds 327.15 GB, and a 3D update stores only its new files. Publish with `scripts/landscape_r2_publish.py` as the [Worker README](../cloudflare/utxo-landscape-worker/README.md#publish-a-dataset) describes. See the [November 4 record](history/r2-shared-landscape-2026-11-04.md).

**November 3 3D-only update:** the working BLK and the 3D landscape (`d974481-20261103`) cover block 974,481. The 2D video streams and the exact history, local and in the cloud, still end at 974,310, so the 3D inspector shows lifecycle details through 974,310. The next 2D update keeps 974,310 as its video and history old end, while its sync appends to the BLK from 974,481; check that its driver expects those two different tips. See the [November 3 report](history/landscape-update-2026-11-03.md).

**November 2 site update completed:** the working BLK, exact history, both published video streams and the 3D landscape cover block 974,310. The node's v3 pair still ends at 970,658: the node VM has 20 GB of memory, too little for the updater, so the same v3 updater ran on this Mac again, resuming from its October 23 checkpoint, and its checkpoint at 974,310 stays on the Mac (see [Next update](#next-update)). The 4K and 1440p tails, the history patches and a rebuilt 3D dataset were published; earlier objects are reused, including every 3D snapshot before 972,848. No full 4K master was assembled: a window master fed both video tails (see [the November 2 report](history/site-update-2026-11-02.md)). See also the [October 23 report](history/site-update-2026-10-23.md), the [October 15 report](history/site-update-2026-10-15.md) for the first Mac run and, for the node timing estimate, the [October 9 report](history/site-update-2026-10-09.md).

**October 20 R2 first pass completed:** cloud storage is now 401.22 GB after retiring the two oldest
3D dataset editions and pruning an audited list of superseded objects. Current and immediate
rollback editions, both video renditions, history dependencies and legacy MP4 downloads remain.
No local update inputs were removed; the history-publication pointer is unchanged. See the
[retention receipt](history/r2-retention-2026-10-20.md) for exact bytes and verification records.

**October 20 lean local cleanup completed:** freed **728.75 GB** of measured container
space, including superseded masters, retired local 3D editions, obsolete extraction and
renderer checkpoints, duplicate compatibility staging and film caches. Keep only the
current full master locally. All current update inputs, the published compatibility
`ledger/`, current and immediate rollback 3D datasets, finished captures and the complete
film package remain in place. No backup copies were created. See the
[local cleanup receipt](history/local-storage-cleanup-2026-10-20.md).

After the September 9, 2026 cleanup, keep these working files in their existing locations. No additional backup copy of the update data is retained.

## Mac: render and publish

All large working files are in `/Volumes/4T Data/buv_render/`:

| File | Purpose | Size |
|---|---|---:|
| `utxo_4k_epoch105k_60fps_transition_crf21_window972600_to_974310.mp4` | Window master: blocks 972,600–974,310 and the ending. Source for the next append, with `masterStartFrame` 972,600; `master_window_current.json` points at it | 230 MB |
| `utxo_4k_epoch105k_60fps_transition_crf21_to_972848.mp4` | Last full master (blocks 0–972,848) and the window's base: its blocks before 972,600 plus the window make a full export. The native explorer plays it | 84.93 GB |
| `changes.blk1.full964k` | Working render input, blocks 0–974,621 (video and history end at 974,310) | 18.61 GB |
| `utxo_history.bin` | Pixel-explorer history, extendable with `utxo_history_update` | 59.48 GB |
| `renderer_before_972900.bin` | Validated renderer ledger before block 972,900; skips genesis replay on the next compatible append | 982 MB |
| `renderer_checkpoint_current.json` | Pointer to the validated checkpoint, source/config and raw-frame proof | Small |
| `changes.blk1.full964k.idx` | Disposable block-offset cache, rebuilt/extended if needed | 7.8 MB |
| `changes.blk1.full964k.chunks.json` | Verified SHA-256 prefix chunks; reuse requires protected-source continuity | Small |
| `history_positions/` | Validated cloud-record position cache; avoids repeated old-shard sorting | 14.81 GB |
| `history_delta_objects/` | Read-through cache of small published spend patches; new staged objects can share hard links | About 46 MB initially |
| `history_publication_current.json` | Pointer to the validated current-data publication catalog | Small |
| `compat1440-append974310-20261102/` | 1440p append run; its ledger and `update_20261102/compat-staged/segments.json` (with object URIs) are the previous ledger for the next 1440p append. The init segment is still `compat1440-20260918/ledger/5156c6f2….mp4` | 100 MB |
| `update_20261104/extract/checkpoint_v3.utxo` | v3 updater checkpoint at block 974,621, matching `changes.blk1.full964k`; the next extraction resumes from it (the node's pair is older) | 11.27 GB |
| `landscape_974621/` | Current 3D dataset, published as `d974621-20261104` | 77.08 GB |
| `landscape_974481/`, `landscape_972052/` and `landscape_971587/` | The rollback edition `d974481-20261103`, the guide's capture dataset `d972052-20261018` and `d971587-20261015`, which the replay and data tests read. The cloud editions share their snapshots and chunks under `landscape/blobs/`, so serving one needs no local copy; `landscape_974310/` and `landscape_972848/` were removed on November 4 | 77.07, 76.55 and 76.45 GB |
| `compat1440-20260918/ledger/` | Retained published compatibility objects and original init. Duplicate `encode/` output and media in both publication staging directories were removed; small metadata remains | 19.84 GB |

Render settings: `configs/buv_render_full_weighted.json`.
Encoder/supervisor recipe: `scripts/run_full_transition_crf21.sh`.
Explorer settings: `configs/buv_explorer.json` and the installed copy under `~/.local/share/buv-explorer/configs/`.

The masters are 3840×2160, 60 fps, HEVC 4:4:4 CRF 21. The published timeline has 974,611 frames including the 300-frame ending: the full master's blocks 0–972,599, then the window's 2,011 frames. Rendering is possible from the local changes file without a node connection. Choose a new output filename for another render; the existing supervisor correctly refuses to overwrite the latest video.

The previous full HLS staging directory was removed during cleanup. The current run retains append staging, drivers and diagnostics under `update_20261102/`; cloud v10 reuses 1,621 existing segments (v1 indices 0–1606, v3 1607–1609, v4 1610, v6 1611–1616, v7 1617–1618, v8 1619, v9 1620) plus four new segments 1621–1624, and cloud compat6 reuses 4,053 compat1–compat5 objects plus 8 new ones. Cloud history uses the validated per-shard catalog in this run's `history-staged/catalog.json`; follow `history_publication_current.json` for subsequent updates. Do not regenerate/upload the full HLS stream for the next append. The next append needs fresh prefixes (`v11`, `compat7`) added to the video Worker's allowlist. Keep publishing scripts, upload state/credentials, and `cloudflare/` sources. Deployed cloud HLS/history/UI objects were not removed and the public site does not depend on the Mac being online.

## Umbrel: update processed block data

| File | Purpose | Size |
|---|---|---:|
| `/home/umbrel/buv_data/changes.blk1.v3` | Full incremental changes stream, currently through block 970,658 (the Mac is ahead at 974,621) | 18.46 GB |
| `/home/umbrel/buv_data/checkpoint_v3.utxo` | Matching state for processing new blocks, at 970,658 | 10.95 GB |

Use the v3 implementation: retained container `buv_blk_v3`, image `buv:checkpoint-v3`, and `/home/umbrel/buv_v3_patch/buv_node_checkpoint_v3.json`. The checkpoint's marker, height, recorded BLK length, final record hash and EOF were checked against the node during cleanup. The two files must remain matched.

`allowBlkFileTruncate` is now `false` in the node's v3 configuration and in the repository's canonical update/v3 configurations. Do not use the retired v1/v2 updater recipes or the old `buv:latest` image against the v3 pair.

## Next update

1. Run the v3 updater, keeping its BLK/checkpoint pair consistent. Do not refresh data merely as part of rendering a chosen existing range. While the node has 20 GB of memory, run it on the Mac as on October 15, 18 and 23 and November 2: clone `changes.blk1.full964k` and `update_20261102/extract/checkpoint_v3.utxo` (`cp -c`) into a new extraction directory, and point the node's v3 config at them and at the node's REST port through an SSH tunnel (`update_20261102/extract/` has the config, wrapper and tunnel). Until Homebrew's OpenCV and `buv` are rebuilt together, `buv` needs `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/Cellar/abseil/20260107.0/lib`; the November 2 wrapper and drivers set it. Do not `brew upgrade` x265 or FFmpeg without checking that the new tail's HEVC parameter sets still equal the published stream's. Start the tunnel and the updater detached (`update_20261102/daemon.py`); a tunnel started from a short-lived shell exits with it. Create an empty `.extract.lock` in the extraction directory: `sync_blk_append.py` opens it read-only and otherwise fails with "remote operation failed". A clone is a new file, so rebuild the extraction BLK's chunk manifest with a full scan before the sync (11 s on November 2). After a reboot the drive's device number changes: rescan the local BLK's manifest the same way, and run `revalidate_catalog` (`update_20261102/run_update.py`) before history staging; it re-hashes the content-addressed position files. The node can take over again once it has about 19 GiB free; it then resumes from its own pair at 970,658, and step 2's prefix proof checks that its output equals the Mac's.
2. Verify the updater's stream has the exact local BLK prefix, transfer only the suffix, check its hash and contiguous block heights, then append it to the existing local input (`sync_blk_append.py`; `update_20261102/run_update.py` shows the settings for a Mac source). No permanent second local dataset is required.
3. Extend compatible explorer history with `utxo_history_update`; validate source/history continuity first. Keep the published current video's mapping unchanged until its replacement is ready.
   Use the [journal-based publisher](history-delta-publication.md): prepare a fresh `historyDeltaFile` before the history update, and start from the catalog in `history_publication_current.json`. Do not update history un-journaled and then invoke the old full-scan publisher.
4. Load the validated compatible renderer checkpoint, replay only the short warm-up, and encode the new tail plus a small closed-GOP overlap. Save a rolling checkpoint for the next append. Remove the old ending and publish only replacement/added HLS segments and history patches. Verify playback, counts and metadata before promotion. Do not assemble the full master: use the window master from `master_window_current.json` as `master` with its `masterStartFrame`, and `finalize` in `update_20261102/run_update.py` rewrites it from the same start with the new tail. A full MP4 export, for the native explorer or downloads, is the base's blocks before the window start followed by the window, packet-copied with the concat demuxer.

The node checkpoint accelerates the **data update**; it is not a renderer frame.
The new, separate renderer checkpoint accelerates **density reconstruction**.
Its September 12 raw-frame acceptance reduced replay plus 1,681 output frames
from 730.23 s to 36.74 s with exact frame equality. A from-genesis fallback
remains available when settings change, without rendering hidden frames or
animating invisible historical epoch slides. See [faster append updates](append-optimization.md)
for manifest-driven commands, trust boundaries and measured timing. The old
September 10 scripts remain historical, run-specific recipes; do not reuse their
ranges/release constants for a new append. The fragment publisher still requires
a one-time trusted catalog of the currently published media before production use.

**The node has no update schedule.** The daily `utxo-timelapse-blk-update.timer`
ran from September 13 until October 4, when the updater was killed for lack of
memory while writing its checkpoint; the timer then refused to restart the failed
container each night. The October 9 umbrelOS update replaced the system partition
and removed the timer, its service and `/usr/local/lib/utxo-timelapse`. Docker, the
`buv_blk_v3` container and everything under `/home` survived. Run the updater
manually (see the [October 9 report](history/site-update-2026-10-09.md)); it needs
about 19 GiB of free memory at its peak. Since a restart on October 11 the node VM
has 20 GB (19.07 GiB usable, 8.3 GiB available with Bitcoin Core and Fulcrum
running), so the October 15, 18 and 23 and November 2 updates ran the updater on the Mac instead (see the
[October 15 report](history/site-update-2026-10-15.md)). Anything installed outside `/home` on the
node disappears at the next umbrelOS update.

The core working files are the window master and its base (the October 23 master), local BLK/history, the Mac's updater checkpoint at 974,621 and the node BLK/checkpoint at 970,658, excluding Bitcoin Core data, software and cloud-hosted copies. The October 18 master, the October 18 and 23 updater checkpoints, `renderer_before_970620.bin` and `renderer_before_971460.bin` remain until they are removed as superseded. They are not inputs for the next append. `renderer_checkpoint_current.json` now points to the validated rolling checkpoint before 972,900. The Mac input is a working dataset and an updater checkpoint is the updater's state; there is no extra backup pair. Historical run configs, scripts, receipts and small publication metadata remain, but their old payload paths are historical records and must not be reused as current inputs.

After a future update verifies, retain the new current master and current updater/renderer
state, then remove superseded copies under the same lean policy. Retain current and supported
rollback 3D datasets until their cloud editions retire. Keep useful append ledgers and exact
publication catalogues. Remove disposable encoding, decoding, browser and frame-extraction
caches after checking the finished outputs. Do not create archival copies of retired payloads.

Legacy `buv_data/buv_resume.json` and `buv_data/buv_update_mac.json`, v2 presets and `buv_deploy` recipes are historical source records. Their old datasets were retired. The current local render presets and canonical v3 update configuration are the maintained paths above.

## Compatibility rendition

The 1440p H.264 conversion uses fresh run directory `compat1440-20260918/` beside
the retained masters. Its `encode/` staging, immutable `ledger/`, verification
receipt and publication catalog are described in [compatibility operations](compat-rendition.md).
The September 18 conversion used the now-retired September 13 master
`utxo_4k_epoch105k_60fps_transition_crf21_to_966827.mp4`: 84,200,687,245 bytes,
967,128 frames through block 966,827 plus its repeated ending, and 4:28:38.800
at 60 fps. Its compatibility init and 4,030 segments total 19,836,027,329 bytes.
See the [measured compatibility release](history/compat-rendition-2026-09-18.md).

The old `mobile-966360/` experiment is incomplete and is not a publication input.
It remains untouched. New renditions never overwrite the HEVC master or chain data.
