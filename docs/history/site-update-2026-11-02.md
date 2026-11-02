# Site update to block 974,310 — November 2, 2026

## Result

Both public sites now end at **block 974,310** (2026-11-02 22:38:14 UTC), previously 972,848: **1,462 new blocks**. This is the first update without a full 4K master. A 230 MB window master took over from the 85 GB master's packet copy, its hash and the 1440p encoder's second full read ([#58](https://github.com/nostitos/utxo-timelapse/pull/58)). The window, the 4K HLS tail and the 1440p tail took 66 s together. From the end of the BLK sync to both releases live took **26 minutes**, against 28 on October 23 for 796 blocks. The updater itself took 38 minutes. It processed 0.64 blocks/s, limited by the node's block JSON, so the extractor's start to both releases live took 66 minutes.

- One PR ([#59](https://github.com/nostitos/utxo-timelapse/pull/59)) carried both releases. Both Workers were deployed from merged master, the 2D Worker first.
- 2D release `append-974310-20261102`, Worker version `44980266-2fe0-43fb-907f-8d2e222ce733`, live 23:46:36 UTC. 4K stream `/hls/v10/media.m3u8` (1,621 earlier segments reused, 4 new); 1440p stream `/hls/compat6/media.m3u8` (4,053 earlier objects reused, 8 new). 974,611 frames including the 300-frame ending. The new site prefix carries master's `explorer.html` (the October 27 welcome UI) and hls.js with the new `info.json`.
- History: 3,715,768,459 records (10,901,885 new, 2,292,088 older outputs spent); 1,497 new objects (297 MB): spend patches for 1,492 shards, 3 rebuilt tail shards, 408 reused, zero historical rescans.
- 3D dataset `d974310-20261102`, release `landscape-20261102-1`, Worker version `e0964b45-f970-4197-ad65-25d5dcc7aa45`, live 23:46:43 UTC: 1,109 snapshots and 4,450 chunks. At the tip the set holds 164,246,096 outputs and 20,107,192.92 BTC, exactly 456,875,000,000 sat more than at 972,848 (1,462 blocks × 3.125 BTC subsidy). `d972848-20261023`, `d972052-20261018` (the guide's capture dataset) and `d971587-20261015` stay servable.
- Window master `utxo_4k_epoch105k_60fps_transition_crf21_window972600_to_974310.mp4`: blocks 972,600–974,610 (2,011 frames), 230,504,844 bytes, SHA-256 `c062f3c4…fb48fe7`. The October 23 master (blocks 0–972,848) stays as the base and as the native explorer's video. `configs/buv_explorer.json` still points at it.

## The window master

Nothing published is read from the master before the join, except the frames that the 4K HLS segment and the 1440p segment containing the join re-package. `finalize` now packet-copies the old master from a keyframe at or before both segment starts (block 972,600), up to the join (972,840). It appends the new tail. Every packet is checked against its source by block number, the whole file decodes, and its HEVC parameter sets equal the old master's. The 4K HLS tail is packaged from it, and `compat_rendition.py` encodes the 1440p tail from it with `sourceStartFrame`.

Before this run, a replay of the October 23 release from a window (the October 18 master's blocks 971,400–971,999 plus the October 23 tail) reproduced the published 4K segments 1620–1621 and the tail playlist byte for byte. The join planner found 972,840 in both the window and the full master. The 1,149 frames decoded for the 1440p encode were identical (framemd5). The 1440p segments themselves are not reproducible: two encodes of the same window differ in four of five segments. So every 1440p tail has always been a fresh encode. The 4K `init.mp4` differs only in its `btrt` box. The release reuses `/hls/v1/init.mp4` and checks parameter sets.

The next run uses the window as its old master with `masterStartFrame` 972,600 (see `master_window_current.json`). A self-test rebuilt this window from itself at this run's join, which is that path. Packets matched, the HLS tail was byte-identical, and the planner put the next join at 974,280. Each run then rewrites the window from 972,600 onward, about 115 MB more per 1,000 blocks. A full master for export is the base's blocks before 972,600 followed by the window, joined with the concat demuxer by packet copy.

## How it ran

1. **Library break.** On October 25 Homebrew upgraded `abseil` to 20260817, but Homebrew's OpenCV 4.13.0 still links abseil 20260107. `buv` aborted at load, before opening any file. The old keg is still installed, so `run_extract.sh`, `run_update.py` and `landscape_update.py` set `DYLD_FALLBACK_LIBRARY_PATH` to it. `brew upgrade opencv` would also upgrade x265 and FFmpeg. That could change the tail's HEVC parameter sets, and the splice requires them to equal the published stream's.
2. **Extraction.** `update_20261102/extract/` held APFS clones of `changes.blk1.full964k` and the October 23 checkpoint at 972,848, and `make_drivers.py` derived this run's drivers. The unchanged v3 updater exited 0 in 2,297 s with a 12 GiB peak. Its checkpoint's block hash at 974,310 equals the node's.
3. **Remount.** The Mac restarted on October 31, and the drive came back with a new device number, which both local caches record. The local BLK's chunk manifest was rescanned: all 70 chunk hashes were identical. Then the sync checked both prefixes and the suffix and appended 54,169,689 bytes. History staging stopped with "position cache changed". A new `revalidate_catalog` phase re-hashed all 1,901 content-addressed position files in 30 s. It accepted the new device only where SHA-256, size, mtime, ctime and inode all matched.
4. **Render and publish.** After the tail render and history extension, `chains.sh` ran three chains. The media chain (window, 4K HLS tail, 1440p tail) no longer waits for history staging. The 3D body uploaded with 32 workers while the local 3D verify ran, and its manifest waited for both. History staging set the release time.

## Verification

- **Render:** renderer checkpoint before 971,460, warm-up from there, 1,771 new frames; ledger misses 0, dropped decrements 0. History update: 2,292,088 spends stamped, 0 unmatched.
- **Cloud history:** nine `/api/pixel` results computed from the uploaded R2 objects equal exact counts and BTC sums from the local history file (a tenth, empty cell returned 0).
- **Window master:** 2,011 frames; every packet equals the October 23 master's (blocks 972,600–972,839) or the new tail's; full decode without error. 1440p: 1,891 frames encoded from block 972,720 and verified; 4,061 segments.
- **Public 2D:** `scripts/check_live_release.mjs` confirmed that all nine hostnames serve master's release versions. `/api/info` on both checked hosts, both playlists (byte-identical to staging), five range samples and ten pixel queries passed. The public 4K segments 1621 and 1624 equal staging and decode (600 and 211 frames), and the eight new 1440p objects decode (1,891 frames). Frame 974,310 of the public 4K stream shows block 974,310, its timestamp and its hash.
- **3D:** `landscape_verify` passed. All 1,109 snapshots equal fresh replays, 20 backward replays pass, every level-0 cell at 210,000, 630,000 and 974,310 equals the history index (0 mismatches over 3,715,768,459 records), and the renderer checkpoint at 971,459 is within 3.64e-12. In R2, the size and MD5 of all 5,563 objects (77.07 GB) match, with 0 problems. Online, all four landscape hostnames name the new dataset. On bitcoinlandscape.com the manifest and the first MiB of the tip snapshot equal the local files, and the documented example cell returns 1 output of 21,236 sat.
- **Browser:** the 51 checks in startup, inspector, hover, playback, keys-inputs-scrub and column-counts pass against https://bitcoinlandscape.com/. On the first run, column-counts hit the same WebGPU readback error inside three.js as on October 23; its 5 checks passed on an immediate re-run.

## Measured stages

| Stage | Seconds | October 23 | Notes |
|---|---:|---:|---|
| Extract new blocks on the Mac | 2,297 | 898 | 1,462 blocks against 796; 0.64 blocks/s against 0.89, limited by the node's block JSON |
| Rebuild the extraction BLK's chunk manifest | 11 | 33 | |
| Rescan the local BLK's chunk manifest | 11 | — | after the remount |
| Prefix proof and append | 72 | 28 | prepare 41, apply 32 |
| Render tail + extend history | 302 | 240 | 1,771 frames |
| Window master, check and 4K HLS tail | 30 | 467 | October 23: packet copy and faststart of the 85 GB master 363, its checks 5, its hash 102 (HLS packaging is under 3 s either way) |
| 1440p append | 34 | 96 | its source digest now reads 230 MB instead of 85 GB |
| 3D build from genesis | 188 | 147 | |
| 3D verify | 280 | 251 | alongside the body upload |
| 3D publish | 463 | 672 | body 308 with 32 workers (526 with 16), R2 checks 30 and 124 |
| Revalidate the position cache | 30 | — | after the remount |
| Stage history patches | 753 | 524 | 2,292,088 spends against 1,352,331 |
| Upload history | 57 | 34 | 1,497 objects, 297 MB |
| Cloud/local history check | 16 | 18 | |
| Stage media and site | 38 | 12 | 4 new 4K segments and 8 1440p objects |

Extractor start (22:40:14 UTC) to sync end (23:21:00): 41 minutes. Sync end to 2D release live (23:46:36): 26 minutes; the 3D release followed at 23:46:43.

## State retained for the next update

- `master_window_current.json` → the window master (from block 972,600) and its base, the October 23 master. Use the window as `OLD_MASTER` and add `masterStartFrame=972600` to the source in `prepare()`; without it, `append_update.py` stops with "master lacks real frames".
- `renderer_checkpoint_current.json` → `renderer_before_972900.bin` (982,395,384 bytes).
- `history_publication_current.json` → `update_20261102/history-staged/catalog.json`, whose identities carry the new device number.
- 1440p ledger: `compat1440-append974310-20261102/` and `update_20261102/compat-staged/segments.json` (with URIs).
- 4K: the next playlist reuses `/hls/v10/media.m3u8` entries. The next prefixes, `v11` and `compat7`, must be added to the video Worker's allowlist.
- Updater state: `update_20261102/extract/checkpoint_v3.utxo` (11,244,514,852 bytes, block 974,310) matches the working BLK. The node's pair is still at 970,658.
- Superseded local copies still on the drive: the October 18 master (84.82 GB), the October 18 and 23 updater checkpoints (11.07 and 11.14 GB) and `renderer_before_970620.bin` and `renderer_before_971460.bin` (981 and 982 MB). Keep the October 23 master: it is the window's base.

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261102/` (`timings.jsonl`, `make_drivers.py`, `run_update.py`, `landscape_update.py`, `promote_local.py`, `chains.sh`, `edit_release.py`, `replay_20261023.py` and `replay/equivalence.json`, `next_run_selftest.py` and `extract/`).

