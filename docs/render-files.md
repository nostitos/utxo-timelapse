# Current render and update files

**October 18 site update completed:** the working BLK, exact history, both published video streams and the 3D landscape cover block 972,052. The node's v3 pair still ends at 970,658: the node VM has 20 GB of memory, too little for the updater, so the same v3 updater ran on this Mac again, resuming from its October 15 checkpoint, and its checkpoint at 972,052 stays on the Mac (see [Next update](#next-update)). The 4K and 1440p tails, the history patches and a rebuilt 3D dataset were published; earlier objects are reused, including every 3D snapshot before 971,587. See the [October 18 report](history/site-update-2026-10-18.md), the [October 15 report](history/site-update-2026-10-15.md) for the first Mac run and, for the node timing estimate, the [October 9 report](history/site-update-2026-10-09.md).

**October 20 R2 first pass completed:** cloud storage is now 401.22 GB after retiring the two oldest
3D dataset editions and pruning an audited list of superseded objects. Current and immediate
rollback editions, both video renditions, history dependencies and legacy MP4 downloads remain.
No local update inputs were removed; the history-publication pointer is unchanged. See the
[retention receipt](history/r2-retention-2026-10-20.md) for exact bytes, recovery files and checks.

After the September 9, 2026 cleanup, keep these working files in their existing locations. No additional backup copy of the update data is retained.

## Mac: render and publish

All large working files are in `/Volumes/4T Data/buv_render/`:

| File | Purpose | Size |
|---|---|---:|
| `utxo_4k_epoch105k_60fps_transition_crf21_to_972052.mp4` | Latest video and source for the next append | 84.82 GB |
| `changes.blk1.full964k` | Working render input, blocks 0–972,052 | 18.51 GB |
| `utxo_history.bin` | Pixel-explorer history, extendable with `utxo_history_update` | 59.20 GB |
| `renderer_before_970620.bin` | Validated renderer ledger before block 970,620; skips genesis replay on the next compatible append | 981 MB |
| `renderer_checkpoint_current.json` | Pointer to the validated checkpoint, source/config and raw-frame proof | Small |
| `changes.blk1.full964k.idx` | Disposable block-offset cache, rebuilt/extended if needed | 7.8 MB |
| `changes.blk1.full964k.chunks.json` | Verified SHA-256 prefix chunks; reuse requires protected-source continuity | Small |
| `history_positions/` | Validated cloud-record position cache; avoids repeated old-shard sorting | 14.81 GB |
| `history_delta_objects/` | Read-through cache of small published spend patches; new staged objects can share hard links | About 46 MB initially |
| `history_publication_current.json` | Pointer to the validated current-data publication catalog | Small |
| `compat1440-append972052-20261018/` | 1440p append run; its ledger and `update_20261018/compat-staged/segments.json` (with object URIs) are the previous ledger for the next 1440p append. The init segment is still `compat1440-20260918/ledger/5156c6f2….mp4` | 40 MB |
| `update_20261018/extract/checkpoint_v3.utxo` | v3 updater checkpoint at block 972,052, matching `changes.blk1.full964k`; the next extraction resumes from it (the node's pair is older) | 11.07 GB |
| `landscape_972052/` | 3D dataset published as `d972052-20261018`; its `manifest.json` and `chunks.json` are what the next publish compares against. The previous `landscape_971587/`, `landscape_970658/` and `landscape_966827/` stay until their R2 prefixes are retired | 71 GiB |

Render settings: `configs/buv_render_full_weighted.json`.
Encoder/supervisor recipe: `scripts/run_full_transition_crf21.sh`.
Explorer settings: `configs/buv_explorer.json` and the installed copy under `~/.local/share/buv-explorer/configs/`.

The retained master is 3840×2160, 60 fps, HEVC 4:4:4 CRF 21, with 972,353 frames including the 300-frame ending. Rendering is possible from the local changes file without a node connection. Choose a new output filename for another render; the existing supervisor correctly refuses to overwrite the latest video.

The previous full HLS staging directory was removed during cleanup. The current run retains append staging, drivers and diagnostics under `update_20261018/`; cloud v8 reuses 1,619 existing segments (v1 indices 0–1606, v3 1607–1609, v4 1610, v6 1611–1616, v7 1617–1618) plus two new segments 1619–1620, and cloud compat4 reuses 4,048 compat1/compat2/compat3 objects plus 4 new ones. Cloud history uses the validated per-shard catalog in this run's `history-staged/catalog.json`; follow `history_publication_current.json` for subsequent updates. Do not regenerate/upload the full HLS stream for the next append. The next append needs fresh prefixes (`v9`, `compat5`) added to the video Worker's allowlist. Keep publishing scripts, upload state/credentials, and `cloudflare/` sources. Deployed cloud HLS/history/UI objects were not removed and the public site does not depend on the Mac being online.

## Umbrel: update processed block data

| File | Purpose | Size |
|---|---|---:|
| `/home/umbrel/buv_data/changes.blk1.v3` | Full incremental changes stream, currently through block 970,658 (the Mac is ahead at 972,052) | 18.46 GB |
| `/home/umbrel/buv_data/checkpoint_v3.utxo` | Matching state for processing new blocks, at 970,658 | 10.95 GB |

Use the v3 implementation: retained container `buv_blk_v3`, image `buv:checkpoint-v3`, and `/home/umbrel/buv_v3_patch/buv_node_checkpoint_v3.json`. The checkpoint's marker, height, recorded BLK length, final record hash and EOF were checked against the node during cleanup. The two files must remain matched.

`allowBlkFileTruncate` is now `false` in the node's v3 configuration and in the repository's canonical update/v3 configurations. Do not use the retired v1/v2 updater recipes or the old `buv:latest` image against the v3 pair.

## Next update

1. Run the v3 updater, keeping its BLK/checkpoint pair consistent. Do not refresh data merely as part of rendering a chosen existing range. While the node has 20 GB of memory, run it on the Mac as on October 15 and 18: clone `changes.blk1.full964k` and `update_20261018/extract/checkpoint_v3.utxo` (`cp -c`) into a new extraction directory, and point the node's v3 config at them and at the node's REST port through an SSH tunnel (`update_20261018/extract/` has the config and wrapper, `update_20261015/extract/tunnel.py` the tunnel). A clone is a new file, so rebuild the extraction BLK's chunk manifest with a full scan before the sync (32 s on October 18). The node can take over again once it has about 19 GiB free; it then resumes from its own pair at 970,658, and step 2's prefix proof checks that its output equals the Mac's.
2. Verify the updater's stream has the exact local BLK prefix, transfer only the suffix, check its hash and contiguous block heights, then append it to the existing local input (`sync_blk_append.py`; `update_20261018/run_update.py` shows the settings for a Mac source). No permanent second local dataset is required.
3. Extend compatible explorer history with `utxo_history_update`; validate source/history continuity first. Keep the published current video's mapping unchanged until its replacement is ready.
   Use the [journal-based publisher](history-delta-publication.md): prepare a fresh `historyDeltaFile` before the history update, and start from the catalog in `history_publication_current.json`. Do not update history un-journaled and then invoke the old full-scan publisher.
4. Load the validated compatible renderer checkpoint, replay only the short warm-up, and encode the new tail plus a small closed-GOP overlap. Save a rolling checkpoint for the next append. Remove the old ending and publish only replacement/added HLS segments and history patches. Verify playback, counts and metadata before promotion. A single MP4 export can be packet-copy assembled separately when needed.

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
running), so the October 15 and 18 updates ran the updater on the Mac instead (see the
[October 15 report](history/site-update-2026-10-15.md)). Anything installed outside `/home` on the
node disappears at the next umbrelOS update.

The core working files are the latest master, local BLK/history, the Mac's updater checkpoint at 972,052 and the node BLK/checkpoint at 970,658, excluding Bitcoin Core data, software and cloud-hosted copies. Earlier masters, including the September 10, September 13, October 9 and October 15 masters, were preserved by these updates. They are rollback artifacts, not inputs required for the next append. The old renderer checkpoints are likewise preserved; `renderer_checkpoint_current.json` now points to the validated rolling checkpoint before 970,620. The Mac input is a working dataset and an updater checkpoint is the updater's state; there is no extra backup pair.

Legacy `buv_data/buv_resume.json` and `buv_data/buv_update_mac.json`, v2 presets and `buv_deploy` recipes are historical source records. Their old datasets were retired. The current local render presets and canonical v3 update configuration are the maintained paths above.

## Compatibility rendition

The 1440p H.264 conversion uses fresh run directory `compat1440-20260918/` beside
the retained masters. Its `encode/` staging, immutable `ledger/`, verification
receipt and publication catalog are described in [compatibility operations](compat-rendition.md).
The September 18 conversion uses the September 13 master
`utxo_4k_epoch105k_60fps_transition_crf21_to_966827.mp4`: 84,200,687,245 bytes,
967,128 frames through block 966,827 plus its repeated ending, and 4:28:38.800
at 60 fps. Its compatibility init and 4,030 segments total 19,836,027,329 bytes.
See the [measured compatibility release](history/compat-rendition-2026-09-18.md).

The old `mobile-966360/` experiment is incomplete and is not a publication input.
It remains untouched. New renditions never overwrite the HEVC master or chain data.
