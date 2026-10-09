# Current render and update files

**September 13 journal append completed:** the working BLK, exact history, node v3 pair and published video cover block 966,827. Only 408 tail frames were encoded, including overlap and the ending. See [timed journal append](history/video-update-2026-09-13-journal.md).

After the September 9, 2026 cleanup, keep these working files in their existing locations. No additional backup copy of the update data is retained.

## Mac: render and publish

All large working files are in `/Volumes/4T Data/buv_render/`:

| File | Purpose | Size |
|---|---|---:|
| `utxo_4k_epoch105k_60fps_transition_crf21_to_966827.mp4` | Latest video and source for the next append | 84.20 GB |
| `changes.blk1.full964k` | Working render input, blocks 0–966,827 | 18.31 GB |
| `utxo_history.bin` | Pixel-explorer history, extendable with `utxo_history_update` | 58.55 GB |
| `renderer_before_965400.bin` | Validated renderer ledger before block 965,400; skips genesis replay on the next compatible append | 979 MB |
| `renderer_checkpoint_current.json` | Pointer to the validated checkpoint, source/config and raw-frame proof | Small |
| `changes.blk1.full964k.idx` | Disposable block-offset cache, rebuilt/extended if needed | 7.4 MB |
| `changes.blk1.full964k.chunks.json` | Verified SHA-256 prefix chunks; reuse requires protected-source continuity | Small |
| `history_positions/` | Validated cloud-record position cache; avoids repeated old-shard sorting | 14.66 GB |
| `history_delta_objects/` | Read-through cache of small published spend patches; new staged objects can share hard links | About 46 MB initially |
| `history_publication_current.json` | Pointer to the validated current-data publication catalog | Small |

Render settings: `configs/buv_render_full_weighted.json`.
Encoder/supervisor recipe: `scripts/run_full_transition_crf21.sh`.
Explorer settings: `configs/buv_explorer.json` and the installed copy under `~/.local/share/buv-explorer/configs/`.

The retained master is 3840×2160, 60 fps, HEVC 4:4:4 CRF 21, with 967,128 frames including the 300-frame ending. Rendering is possible from the local changes file without a node connection. Choose a new output filename for another render; the existing supervisor correctly refuses to overwrite the latest video.

The previous full HLS staging directory was removed during cleanup. The current run retains append staging and diagnostics under `update_20260913_journal/`; cloud v5 reuses 1,611 existing segments (v1 indices 0–1606, v3 indices 1607–1609, v4 index 1610), plus one replacement segment. Cloud history uses the validated per-shard catalog in this run's `history-staged/catalog.json`; follow `history_publication_current.json` for subsequent updates. Do not regenerate/upload the full HLS stream for the next append. Keep publishing scripts, upload state/credentials, and `cloudflare/` sources. Deployed cloud HLS/history/UI objects were not removed and the public site does not depend on the Mac being online.

## Umbrel: update processed block data

| File | Purpose | Size |
|---|---|---:|
| `/home/umbrel/buv_data/changes.blk1.v3` | Full incremental changes stream, currently through block 966,827 | 18.31 GB |
| `/home/umbrel/buv_data/checkpoint_v3.utxo` | Matching state for processing new blocks | 10.45 GB |

Use the v3 implementation: retained container `buv_blk_v3`, image `buv:checkpoint-v3`, and `/home/umbrel/buv_v3_patch/buv_node_checkpoint_v3.json`. The checkpoint's marker, height, recorded BLK length, final record hash and EOF were checked against the node during cleanup. The two files must remain matched.

`allowBlkFileTruncate` is now `false` in the node's v3 configuration and in the repository's canonical update/v3 configurations. Do not use the retired v1/v2 updater recipes or the old `buv:latest` image against the v3 pair.

## Next update

1. Run the existing v3 updater on the node, keeping its BLK/checkpoint pair consistent. Do not refresh data merely as part of rendering a chosen existing range.
2. Verify the node stream has the exact local BLK prefix, transfer only the suffix, check its hash and contiguous block heights, then append it to the existing local input. No permanent second local dataset or Mac checkpoint copy is required.
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

The node's `utxo-timelapse-blk-update.timer` is enabled for 03:15 UTC daily.
Its first scheduled execution succeeded on September 13, 03:15–03:20 UTC,
advancing the matched v3 pair to 966,764 before this timed append began.
The processed pair can advance independently of the local/video tip shown above.

The five core working files are the latest master, local BLK/history, and node BLK/checkpoint, excluding Bitcoin Core data, software and cloud-hosted copies. Earlier masters, including the 84.15 GB September 10 master, were preserved by this update. They are rollback artifacts, not inputs required for the next append. The old renderer checkpoint is likewise preserved; `renderer_checkpoint_current.json` now points to the validated rolling checkpoint before 965,400. The Mac input is a working dataset and the node pair is the updater's state; there is no extra backup pair.

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
