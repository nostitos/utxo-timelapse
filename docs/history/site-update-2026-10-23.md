# Site update to block 972,848 — October 23, 2026

## Result

Both public sites now end at **block 972,848** (2026-10-23 23:37:44 UTC), previously 972,052: **796 new blocks**. The same v3 updater ran on the Mac again, resuming from the [October 18](site-update-2026-10-18.md) checkpoint. From the extractor's start to both releases live took **46 minutes**, as on October 18, with 71% more blocks. History staging, which set the October 18 release time, took 524 s instead of 1,520 s because the 4K packet copy waited for it.

- One PR ([#54](https://github.com/nostitos/utxo-timelapse/pull/54)) carried both releases. Both Workers were deployed from merged master: the 2D Worker first, then the landscape Worker, which bundles the 2D `release.js` for its cell API.
- 2D release `append-972848-20261023`, Worker version `e75f85a7-85cf-4da1-9600-e81ccbda58cb`, live 00:48:57 UTC on October 24. 4K stream `/hls/v9/media.m3u8` (1,620 earlier segments reused, 2 new); 1440p stream `/hls/compat5/media.m3u8` (4,050 earlier objects reused, 5 new). 973,149 frames including the 300-frame ending. The new site prefix carries master's `explorer.html` and hls.js. The October 23 guide releases had kept the October 18 site prefix, so the merged latest-data wording (#51) and share-host change (#49) went online with this release.
- History: 3,704,866,574 records (6,030,074 new, 1,352,331 older outputs spent); 1,386 new objects (226 MB): spend patches for 1,381 shards, 3 rebuilt tail shards, 517 reused, zero historical rescans.
- 3D dataset `d972848-20261023`, release `landscape-20261023-2`, Worker version `0a5074ee-4154-48e3-aff6-a1b0093fef8b`, live 00:49:16 UTC: 1,106 snapshots and 4,437 chunks. At the tip the set holds 164,775,541 outputs and 20,102,624.17 BTC, exactly 248,750,000,000 sat more than at 972,052 (796 blocks × 3.125 BTC subsidy). `d972052-20261018` (the guide's capture dataset) and `d971587-20261015` stay servable.
- Master `utxo_4k_epoch105k_60fps_transition_crf21_to_972848.mp4`: 84,925,954,980 bytes, SHA-256 `35461db0…fd2666`. The October 18 master remains beside it.

## How it ran

1. **Extraction.** `update_20261023/extract/` held APFS clones (`cp -c`) of `changes.blk1.full964k` and the October 18 checkpoint at 972,052. `make_drivers.py` derived this run's drivers from October 18's by counted substitutions. Before the start, the checkpoint's recorded size matched the BLK and its block hash matched the node's. The unchanged v3 updater exited 0 in 898 s with a 14.0 GiB peak, and its checkpoint's hash at 972,848 equals the node's block hash.
2. **Two operational fixes.** The SSH tunnel exited with the shell that started it, so `daemon.py` now starts the tunnel, the extractor and the later chains detached. The first `sync_blk_append.py prepare` failed with "remote operation failed (exit 1)": the script opens the extraction lock read-only, and the new directory had none (the October 15 and 18 directories did). An empty `extract/.extract.lock` fixed it. As on October 18, a full scan rebuilt the clone's chunk manifest first (33 s).
3. **Sync.** After checking both prefixes and the suffix, the sync appended 29,996,378 bytes.
4. **Render and publish.** After the tail render and history extension, `chains.sh` started history staging and the 3D build together. The 4K packet copy waited for staging, then the master hash and the 1440p tail followed. The 3D verify and publish ran alongside. Master retired the `utxo.aiception.ai` alias (#49), so the public checks used `bitcointimelapse.com` and `utxo-cdn.hat39.com`.

## Verification

- **Render:** renderer checkpoint before 970,620, warm-up from there, 1,149 new frames; ledger misses 0, dropped decrements 0. History update: 1,352,331 spends stamped, 0 unmatched.
- **Cloud history:** nine `/api/pixel` results computed from the uploaded R2 objects equal exact counts and BTC sums from the local history file (a tenth, empty cell returned 0).
- **Master:** retained packets equal the previous master at sample points, and the join and the tip decode. The 1440p tail was verified, for 4,055 segments.
- **Public 2D:** `scripts/check_live_release.mjs` confirmed that all nine hostnames serve master's release versions. `/api/info` on both checked hosts, both playlists (byte-identical to staging), five range samples and ten pixel queries passed. FFmpeg decoded the public 4K segments 1,620–1,621 (600 and 549 frames) and the last six 1440p objects (1,389 frames) without error. Frame 972,848 of the public 4K stream shows block 972,848, its timestamp and its hash.
- **3D:** `landscape_verify` passed. All 1,106 snapshots equal fresh replays, 20 backward replays pass, every level-0 cell at 210,000, 630,000 and 972,848 equals the history index (0 mismatches over 3,704,866,574 records), and the renderer checkpoint at 970,619 is within 3.64e-12. In R2, the size and MD5 of all 5,547 objects (76.75 GB) match, with 0 problems. Online, all four landscape hostnames name the new dataset in `/dataset/index.json`. On bitcoinlandscape.com the manifest and the first MiB of the tip snapshot equal the local files, and the documented example cell returns 1 output of 21,236 sat.
- **Browser:** the 41 checks in startup, inspector, hover, playback, keys-inputs-scrub and column-counts pass against https://bitcoinlandscape.com/. On the first run, column-counts hit a WebGPU readback error inside three.js, and the block-input seek had not settled within its 200 ms wait. Both passed on an immediate re-run.

## Measured stages

| Stage | Seconds | October 18 | Notes |
|---|---:|---:|---|
| Extract 796 blocks on the Mac | 898 | 477 | October 18 extracted 465 blocks; headers and blocks come through the tunnel |
| Rebuild the extraction BLK's chunk manifest | 33 | 32 | |
| Prefix proof and append | 28 | 102 | prepare 18, apply 10 |
| Render tail + extend history | 240 | 212 | 1,149 frames |
| 3D build from genesis | 147 | 202 | |
| 3D verify | 251 | 481 | |
| 3D publish | 672 | 703 | 5,532 files (76.5 GB) copied inside R2 and 14 (295 MB) uploaded in 526 s; size and MD5 checks of every object before and after the manifest 146 s |
| Stage history patches | 524 | 1,520 | shared the disk with the 3D build and verify only |
| Upload history | 34 | 37 | 1,386 objects, 226 MB |
| Cloud/local history check | 18 | 14 | |
| Assemble 4K master | 363 | 922 | packet copy and faststart, after staging |
| Hash master | 102 | 113 | |
| 1440p append | 96 | 138 | |
| Stage media and site | 12 | 9 | |

Extractor start (00:03:24 UTC) to 2D release live (00:48:57): 46 minutes; the 3D release followed at 00:49:16.

## State retained for the next update

- `renderer_checkpoint_current.json` → `renderer_before_971460.bin` (982,224,360 bytes, SHA-256 `cc3ba48a…a4713a`).
- `history_publication_current.json` → `update_20261023/history-staged/catalog.json`.
- 1440p ledger: `compat1440-append972848-20261023/` and `update_20261023/compat-staged/segments.json` (with URIs).
- 4K: the next playlist reuses `/hls/v9/media.m3u8` entries. The next prefixes, `v10` and `compat6`, must be added to the video Worker's allowlist.
- Updater state: `update_20261023/extract/checkpoint_v3.utxo` (11,136,367,128 bytes, block 972,848) matches the working BLK. The node's pair is still at 970,658. For the next run on the Mac, clone the BLK and this checkpoint, create an empty `.extract.lock`, start the tunnel detached, and rebuild the extraction BLK's chunk manifest with a scan before the sync.
- Superseded local copies still on the drive: the October 18 master (84.82 GB), `update_20261018/extract/checkpoint_v3.utxo` (11.07 GB) and `renderer_before_970620.bin` (981 MB).

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261023/` (`timings.jsonl`, `make_drivers.py`, `run_update.py`, `landscape_update.py`, `promote_local.py`, `chains.sh`, `daemon.py`, `edit_release.py` and `extract/` with the updater's config, wrapper, tunnel and logs).

