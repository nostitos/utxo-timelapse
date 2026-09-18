# Current render and update files

**September 10 append completed:** the working BLK, exact history, node v3 pair and published video all cover block 966,360. The old encoded prefix was preserved; only the short tail was encoded. See [timed append update](video-update-2026-09-10.md).

After the September 9, 2026 cleanup, keep these working files in their existing locations. No additional backup copy of the update data is retained.

## Mac: render and publish

All large working files are in `/Volumes/4T Data/buv_render/`:

| File | Purpose | Size |
|---|---|---:|
| `utxo_4k_epoch105k_60fps_transition_crf21_to_966360.mp4` | Latest video and source for the next append | 84.15 GB |
| `changes.blk1.full964k` | Working render input, blocks 0–966,360 | 18.30 GB |
| `utxo_history.bin` | Pixel-explorer history, extendable with `utxo_history_update` | 58.49 GB |

Render settings: `configs/buv_render_full_weighted.json`.
Encoder/supervisor recipe: `scripts/run_full_transition_crf21.sh`.
Explorer settings: `configs/buv_explorer.json` and the installed copy under `~/.local/share/buv-explorer/configs/`.

The retained master is 3840×2160, 60 fps, HEVC 4:4:4 CRF 21, with 966,661 frames including the 300-frame ending. Rendering is possible from the local changes file without a node connection. Choose a new output filename for another render; the existing supervisor correctly refuses to overwrite the latest video.

The previous full HLS staging directory was removed during cleanup. The September 10 run retains only append staging and diagnostics under `update_20260910/`; cloud v3 reuses v1 segments 0–1606. Do not regenerate/upload the full HLS stream for the next append. Keep publishing scripts, upload state/credentials, and `cloudflare/` sources. Deployed cloud HLS/history/UI objects were not removed and the public site does not depend on the Mac being online.

## Umbrel: update processed block data

| File | Purpose | Size |
|---|---|---:|
| `/home/umbrel/buv_data/changes.blk1.v3` | Full incremental changes stream, currently through block 966,360 | 18.30 GB |
| `/home/umbrel/buv_data/checkpoint_v3.utxo` | Matching state for processing new blocks | 10.45 GB |

Use the v3 implementation: retained container `buv_blk_v3`, image `buv:checkpoint-v3`, and `/home/umbrel/buv_v3_patch/buv_node_checkpoint_v3.json`. The checkpoint's marker, height, recorded BLK length, final record hash and EOF were checked against the node during cleanup. The two files must remain matched.

`allowBlkFileTruncate` is now `false` in the node's v3 configuration and in the repository's canonical update/v3 configurations. Do not use the retired v1/v2 updater recipes or the old `buv:latest` image against the v3 pair.

## Next update

1. Run the existing v3 updater on the node, keeping its BLK/checkpoint pair consistent. Do not refresh data merely as part of rendering a chosen existing range.
2. Verify the node stream has the exact local BLK prefix, transfer only the suffix, check its hash and contiguous block heights, then append it to the existing local input. No permanent second local dataset or Mac checkpoint copy is required.
3. Extend compatible explorer history with `utxo_history_update`; validate source/history continuity first. Keep the published current video's mapping unchanged until its replacement is ready.
4. Reconstruct renderer state without encoding old frames, encode only the new tail plus a small closed-GOP overlap, remove the old ending, and packet-copy splice into a uniquely named MP4. Publish only replacement/added HLS segments and history patches, then verify native playback, counts and metadata. See the timed append report for the first-run scripts and required manifest changes.

The node checkpoint accelerates the **data update**. The renderer still replays historical changes to reconstruct density and flashes. An append-only workflow is now implemented and validated in the September 10 scripts; those scripts are anchored to that first manifest and require fresh source/range values for the next run. Do not treat the node checkpoint as a saved renderer frame.

The five core working files are the latest master, local BLK/history, and node BLK/checkpoint, excluding Bitcoin Core data, software and cloud-hosted copies. The prior 83.93 GB local master is temporarily retained as the verified rollback source for this update; it is not required for the next append once using the new master. The Mac input is a working dataset and the node pair is the updater's state; there is no extra backup pair.

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
