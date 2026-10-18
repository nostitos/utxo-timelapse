# Site update to block 972,052 — October 18, 2026

## Result

Both public sites now end at **block 972,052** (2026-10-18 19:55:24 UTC), previously 971,587: **465 new blocks**.
The run followed the [October 15 update](site-update-2026-10-15.md) with the same updater on the Mac. From the
extractor's start to both releases live took **46 minutes**. On October 15 it took 1 h 24 min, after a 12-minute
checkpoint copy that this run did not need. Most of the time saved was in the 3D publish. With self-describing
snapshots it copied the unchanged files of the 971,587 dataset inside R2 and uploaded 195 MB; October 15 uploaded 58 GB.

- 2D release `append-972052-20261018` ([PR #27](https://github.com/nostitos/utxo-timelapse/pull/27)), Worker version
  `d72dfb9f-b0e8-494b-8da5-20b927a80655`, live 21:11 UTC. 4K stream `/hls/v8/media.m3u8` (1,619 earlier segments
  reused, 2 new); 1440p stream `/hls/compat4/media.m3u8` (4,048 earlier objects reused, 4 new). 972,353 frames
  including the 300-frame ending. The new site prefix carries the explorer-ui-20261015-2 HTML and hls.js byte for byte,
  with the new `info.json`.
- History: 3,698,836,500 records (3,614,761 new, 846,489 older outputs spent); 1,366 new objects (185 MB): spend
  patches for 1,362 shards, 2 rebuilt tail shards, 535 reused, zero historical rescans.
- 3D dataset `d972052-20261018`, release `landscape-20261018-2` ([PR #26](https://github.com/nostitos/utxo-timelapse/pull/26)),
  Worker version `2b427c91-6171-4bd9-9d90-5f6580a85d46`, live 21:06 UTC: 1,104 snapshots and 4,430 chunks. At the tip the
  set holds 165,041,642 outputs and 20,100,136.67 BTC, exactly 145,312,500,000 sat more than at 971,587 (465 blocks ×
  3.125 BTC subsidy). `d971587-20261015`, `d970658-20261009` and `d966827-20261008` stay servable.
- Master `utxo_4k_epoch105k_60fps_transition_crf21_to_972052.mp4`: 84,823,748,640 bytes, SHA-256 `b1dc7c1d…a24aa5`.
  Earlier masters, checkpoints, datasets and R2 prefixes are preserved.

## How it ran

1. **Extraction.** `update_20261018/extract/` held APFS clones (`cp -c`) of `changes.blk1.full964k` and of the October 15
   checkpoint at 971,587, with the October 15 config, wrapper and tunnel pointed at this run's paths. The unchanged v3
   updater exited 0 in 477 s with a 9.5 GB peak. Its checkpoint's block hash at 972,052 equals the node's best block.
2. **Sync.** The first `sync_blk_append.py prepare` stopped: the copied chunk manifest records the inode of the October 15
   file, a clone has a new inode, and the hashing library refuses that ("source replaced or shrunk; explicit scan
   required"). A full scan of the extraction BLK under its lock rebuilt the manifest in 32 s. The retry hashed both
   prefixes, checked the suffix's hash, tip, offset and block hash, and appended 17,307,614 bytes.
3. **Render and publish.** After the tail render and history extension, three chains ran in parallel: the 3D build,
   verify and publish; history staging, upload and the cloud check; and the 4K master, its hash and the 1440p tail. The
   3D release went live first. The 2D release followed after staging, a PR, a deploy from merged master and the public checks.

## Verification

- Render: renderer checkpoint before 970,200, warm-up from there, 773 new frames; ledger misses 0, dropped decrements 0.
  History update: 846,489 spends stamped, 0 unmatched.
- Nine `/api/pixel` results computed from the uploaded R2 objects equal exact counts and BTC sums from the local history
  file (a tenth, empty cell returned 0).
- Master: retained packets equal the previous master at five eras, and the join and the tip decode. 1440p: 833 frames
  encoded from frame 971,520 and verified; 4,052 segments.
- Public: `/api/info` on utxo.aiception.ai and bitcointimelapse.com, both playlists (byte-identical to staging), five range
  samples and ten pixel queries passed. FFmpeg decoded the public 4K segments 1,619–1,620 and the last six 1440p objects
  without error; frame 972,052 of the public 4K stream shows block 972,052 and its hash.
  `scripts/check_live_release.mjs` confirmed all nine hostnames serve master's release versions.
- 3D: `landscape_verify` passed: 1,104 snapshots equal fresh replays, 20 backward replays pass, every level-0 cell at 210,000,
  630,000 and 972,052 equals the history index (0 mismatches over 3,698,836,500 records), and the renderer checkpoint at
  970,199 is within 3.64e-12. In R2, the size and MD5 of all 5,538 objects (76.55 GB) match, with 0 problems. Online, all four
  landscape hostnames name the new dataset. On bitcoinlandscape.com its manifest and the first MiB of the tip snapshot
  equal the local files, and the documented example cell returns 1 output of 21,236 sat and 3 spent. The 41 browser checks
  in startup, inspector, hover, playback, keys-inputs-scrub and column-counts pass against https://bitcoinlandscape.com/.

## Measured stages

| Stage | Seconds | October 15 | Notes |
|---|---:|---:|---|
| Extract 465 blocks on the Mac | 477 | 398 | October 15 extracted 929 blocks; headers and blocks come through the tunnel |
| Rebuild the extraction BLK's chunk manifest | 32 | — | needed because the BLK is a clone (see How it ran) |
| Prefix proof and append | 102 | 41 | prepare 68, apply 34 |
| Render tail + extend history | 212 | 220 | render 63; history 211 |
| 3D build from genesis | 202 | 335 | |
| 3D verify | 481 | 356 | shared the disk with the packet copy and history staging |
| 3D publish | 703 | 3,161 | 5,527 files (76.4 GB) copied inside R2 and 10 (195 MB) uploaded in 484 s; size and MD5 checks of every object before and after the manifest 218 s |
| Assemble 4K master | 922 | 410 | packet copy and faststart 919, on the shared disk |
| Hash master | 113 | 137 | |
| 1440p append | 138 | 202 | 833 frames |
| Stage history patches | 1,520 | 884 | random reads on the disk shared with the packet copy and the 3D verify; 283 s on October 9 with the disk to itself |
| Upload history | 37 | 45 | 1,366 objects, 185 MB |
| Cloud/local history check | 14 | 37 | |
| Stage media and site | 9 | 69 | |

Extractor start (20:25:20) to 3D release live (21:06:05): 41 minutes. To 2D release live (21:11:27): 46 minutes.

History staging was the slowest stage and set the 2D release time. It reads one object at a time, so it slows the most
when other jobs share the disk. Next time, start it before the 4K packet copy and the 3D verify.

## State retained for the next update

- `renderer_checkpoint_current.json` → `renderer_before_970620.bin` (981,497,464 bytes, SHA-256 `11602be0…a74f19`).
- `history_publication_current.json` → `update_20261018/history-staged/catalog.json`.
- 1440p ledger: `compat1440-append972052-20261018/` and `update_20261018/compat-staged/segments.json` (with URIs).
- 4K: the next playlist reuses `/hls/v8/media.m3u8` entries; the next join is the last keyframe at or before 972,052. The
  next prefixes, `v9` and `compat5`, must be added to the video Worker's allowlist.
- Updater state: `update_20261018/extract/checkpoint_v3.utxo` (11,072,993,572 bytes, block 972,052) matches the working
  BLK. The node's pair is still at 970,658. For the next run on the Mac, clone the BLK and this checkpoint as here, and
  rebuild the extraction BLK's chunk manifest with a scan before the sync.
- R2: `landscape/d966827-20261008/` has been unused since October 9 and is due for deletion (README step 6); it was left
  in place and in `retainedDatasetIds`.

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261018/` (`timings.jsonl`, `run_update.py`,
`landscape_update.py`, `promote_local.py`, `make_drivers.py`, which derives them from the October 15 drivers by counted
substitutions, and `extract/` with the updater's config, wrapper and logs).
