# Site update to block 971,587 with the updater on the Mac — October 15, 2026

## Result

Both public sites now end at **block 971,587** (2026-10-15 14:18:29 UTC), previously 970,658: **929 new blocks**.
The node's virtual machine no longer had enough memory for the v3 updater, so the same updater ran on this Mac,
resuming from a copy of the node's checkpoint and reading blocks from the node's Bitcoin Core over an SSH tunnel.
Everything else followed the [October 9 run](site-update-2026-10-09.md).

- 2D release `append-971587-20261015`, Worker version `41427b69-f521-42dc-9353-200a5ce80480`, live 15:13 UTC.
  4K stream `/hls/v7/media.m3u8` (1,617 earlier segments reused, 3 new); 1440p stream `/hls/compat3/media.m3u8`
  (4,044 earlier objects reused, 6 new, 34 MB). 971,888 frames including the 300-frame ending. The new site prefix
  carries the explorer-ui-20261015-2 HTML and hls.js byte for byte, with the new `info.json`.
- History: 3,695,221,739 records (7,235,876 new, 1,252,612 older outputs spent); 1,520 new objects (254 MB): spend
  patches for 1,515 shards, 3 rebuilt tail shards, 380 reused, zero historical rescans.
- 3D dataset `d971587-20261015`, release `landscape-20261015-5` (Worker version `c62d88c2-c929-4eae-9d44-4f452ebd90c3`), live 15:50 UTC:
  1,103 snapshots and 4,426 chunks. At the tip the set holds 165,117,712 outputs and 20,098,683.54 BTC, 2,903.125 BTC
  more than at 970,658 (929 blocks × 3.125 BTC subsidy). `d970658-20261009` and `d966827-20261008` stay servable.
- Master `utxo_4k_epoch105k_60fps_transition_crf21_to_971587.mp4`: 84,770,730,111 bytes, SHA-256 `e2b758ce…70f65b`.
  Earlier masters, checkpoints, datasets and R2 prefixes are preserved.

## Why the updater ran on the Mac

On October 9 the Umbrel VM had 28.7 GiB and the updater peaked at 18.8 GiB with Fulcrum and Mempool stopped. Since a
restart on October 11 the VM has 20 GB (19.07 GiB usable). Fulcrum is installed and running again (6.2 GiB), Bitcoin
Core holds 5.4–6.9 GiB, and 8.3 GiB was available, with 14.3 GiB of zram swap that compresses into the same memory.
The updater would have been killed again, so it was not started on the node. [Updating `changes.blk1`](../data-update.md)
already names the alternative: generate on a machine with more memory.

1. **Same code.** `Utxo.h`, `Utxo.cpp` and `utxo_to_change.cpp` on master are byte-identical to the node's
   `/home/umbrel/buv_v3_patch` sources, and `BlockEncoder` has not changed since August 28. `buv` was built from
   master in a separate worktree (the targeted cases pass, 1,965 assertions).
2. **Same input.** The node's checkpoint (10,951,124,156 bytes, block 970,658) was copied over SSH in 696 s
   (15.7 MB/s through the Tailscale subnet route); SHA-256 `db82ebf8…c6fcda` on both machines. An APFS clone of the
   working BLK (18,456,887,854 bytes, equal to the node's) sat beside it, and the checkpoint's tail record matched it.
3. **Same configuration.** The node's v3 config with only the two paths and the REST URL changed;
   `allowBlkFileTruncate` stayed `false`. REST went through `ssh -C -L`: a block is about 13 MB of JSON and
   compresses about 4×, so eight blocks arrived in 2.4 s.
4. **Run.** Exit 0 in 398 s: headers 44 s, checkpoint load 49 s (371,722,479 entries), 929 blocks in 276 s
   (3.4 blocks/s), checkpoint write 30 s (442,648,572 outputs). The new checkpoint's block hash at 971,587 equals the
   node's best chain. macOS held the process at about 18 GB, 11 GB of it compressed.
5. **Append.** `sync_blk_append.py` treated the extraction directory as the node: a local shell instead of SSH and a
   stand-in for `docker inspect` that reports the updater's exit code. It hashed both 18.46 GB prefixes, checked the
   suffix's hash, tip, offset and block hash, and appended 35,372,522 bytes (41 s).

The node's own pair is unchanged at 970,658 and nothing on the node was stopped or written.

## Verification

- Render: renderer checkpoint before 969,240, warm-up from there, 1,268 new frames; ledger misses 0, dropped
  decrements 0. History update: every spend matched (0 unmatched).
- Nine `/api/pixel` results computed from the uploaded R2 objects equal exact counts and BTC sums from the local
  history file (a tenth, empty cell returned 0). A coin spent in the new blocks moves from 3 live outputs to 2, and the
  pixel of a new output holds 325.
- Master: retained packets equal the previous master at five eras, the join and the tip decode. 1440p: 1,328 frames
  encoded from frame 970,560 and verified; 4,050 segments.
- Public: `/api/info`, both playlists (byte-identical to staging), five range samples and ten pixel queries passed on
  utxo.aiception.ai and bitcointimelapse.com. FFmpeg decoded the public 4K segments 1,616–1,619 and the last eight
  1440p objects without error; frame 971,587 of the public 4K stream shows block 971,587 and its hash.
  `scripts/check_live_release.mjs` confirmed all nine hostnames serve master's release versions.
- 3D: `landscape_verify` passed: 1,103 snapshots equal fresh replays, 20 backward replays, every level-0 cell at
  210,000, 630,000 and 971,587 equals the history index (0 mismatches over 3,695,221,739 records), renderer checkpoint
  at 969,239 within 3.64e-12. Online, all four landscape hostnames name the new dataset; on bitcoinlandscape.com its manifest and the first MiB of the tip snapshot equal the local files, the documented example cell returns 1 output of 21,236 sat and 3 spent, and a cell created at 971,200–971,263 equals the local history (105 live with 8,706,324 sat, 774 spent). 148 of 149 browser checks pass against https://bitcoinlandscape.com/ (games and the settings audit skipped). The failure, `quick-settings: glow changes the picture` (mean RGB difference 5.69 where 10 is required), tests the app code that this deploy carried from master, which changed bloom the same day; it is being handled separately from the data.

## Measured stages

| Stage | Seconds | Notes |
|---|---:|---|
| Copy node checkpoint to the Mac | 696 | 10.95 GB at 15.7 MB/s; not needed while the Mac's checkpoint is current |
| Extract 929 blocks (970,659–971,587) on the Mac | 398 | through the tunnel; the node took 620 s for 994 blocks on October 9 |
| Prefix proof and append | 41 | both prefixes on the Mac's disk |
| Render tail + extend history | 220 | render 88 (checkpoint load 17); history 219 |
| Stage history patches | 884 | 283 on October 9; this time it shared the disk with the 3D build and verify |
| Upload history | 45 | 1,520 objects, 254 MB |
| Cloud/local history check | 37 | |
| Assemble 4K master | 410 | packet copy and faststart 396, splice and master checks 14 |
| Hash master | 137 | |
| 1440p append | 202 | 1,328 frames |
| Stage media and site | 69 | shared the uplink with the 3D upload |
| Deploy, public checks | 20 | one retry after a dropped connection |
| 3D build from genesis | 335 | 7,225,325,766 changes; 120 s on October 9 without the parallel history staging |
| 3D verify | 356 | |
| 3D publish | 3,102 | 4,416 chunks (18.5 GB) copied inside R2; 1,116 files (58.0 GB) uploaded at 18.7 MB/s: every snapshot once more, because the 970,658 files predate self-describing snapshots |
| 3D object checks, manifest, deploy | 66 | size and MD5 of all 5,533 objects (76.4 GB) before and after the manifest: 0 problems; deploy 7 s |

Extractor start (14:25:54) to 2D release live (15:13:09): 47 minutes, after the 12-minute checkpoint copy. To the 3D release live (15:50:12): 1 h 24 min, most of it the 52-minute upload.

## State retained for the next update

- `renderer_checkpoint_current.json` → `renderer_before_970200.bin` (981,004,408 bytes, SHA-256 `54c9db39…2f67dec`).
- `history_publication_current.json` → `update_20261015/history-staged/catalog.json`.
- 1440p ledger: `compat1440-append971587-20261015/` and `update_20261015/compat-staged/segments.json` (with URIs).
- 4K: the next playlist reuses `/hls/v7/media.m3u8` entries; the next join is the last keyframe at or before
  971,587. The next prefixes, `v8` and `compat4`, must be added to the video Worker's allowlist.
- Updater state: `update_20261015/extract/checkpoint_v3.utxo` (11,037,484,640 bytes, block 971,587) matches the working
  BLK. The node's pair is still at 970,658 (BLK 18,456,887,854 bytes, checkpoint 10,951,124,156 bytes). The next
  update can resume on the Mac from that checkpoint with a fresh BLK clone and no copy, or on the node once it has
  about 19 GiB free; the node would then redo 970,659–971,587, and the sync's prefix proof checks that its bytes
  equal the Mac's.
- R2: `landscape/d966827-20261008/` has been unused since October 9 and is due for deletion
  (README step 6); it was left in place and in `retainedDatasetIds`.

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261015/` (`timings.jsonl`, `run_update.py`,
`landscape_update.py`, `promote_local.py`, and `extract/` with the updater's config, tunnel, wrapper and logs).
