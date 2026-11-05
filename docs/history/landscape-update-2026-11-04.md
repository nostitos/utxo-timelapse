# 3D landscape update to block 974,621 — November 4, 2026

## Result

The 3D landscape now ends at **block 974,621** (2026-11-05 04:01:04 UTC), previously 974,481: **140 new blocks**. Only the 3D landscape was updated. The 2D explorer's video streams and the exact history, local and in the cloud, still end at 974,310, so the landscape's cell inspector shows lifecycle details through 974,310.

- Dataset `d974621-20261104`, release `landscape-20261104-2`: 1,109 snapshots and 4,453 chunks. At the tip the set holds 164,196,030 outputs and 20,108,164.79 BTC, exactly 43,750,000,000 sat more than at 974,481 (140 blocks × 3.125 BTC subsidy). `d974481-20261103` joins the retained ids.
- The owner data stays at `o974481-20261104` (block 974,481), so the Owners view lights outputs as they stood at 974,481. The owner refresh is not part of a routine update (`docs/landscape-owners.md`, Refreshing the owner data). A refresh started during this run was stopped during its history scan; no owner data was built or published.
- This is the first dataset published with shared files ([#66](https://github.com/nostitos/utxo-timelapse/pull/66)). Of its 5,562 snapshots and chunks, 5,558 (76.98 GB) were already in `landscape/blobs/`; the publisher uploaded and stored the other 4 (95.9 MB) in 9.4 s. On November 3 the same step copied 77.0 GB inside R2 in 214 s.
- Locally, `landscape_974310/` and `landscape_972848/` were removed (about 150 GB). Their cloud editions are served from the shared files, which had been checked against these copies by size and MD5 the same evening. The rollback `landscape_974481/`, the guide's capture dataset `landscape_972052/` and `landscape_971587/`, which the replay and data tests read, remain.

## How it ran

1. **Extraction.** `update_20261104/extract/` held APFS clones of `changes.blk1.full964k` and the November 3 checkpoint at 974,481, and `make_drivers.py` derived this run's drivers from November 3's by counted substitutions. The checkpoint's block hash at 974,481 equalled the node's before the run. The unchanged v3 updater exited 0 in 261 s with an 8.8 GiB peak; its checkpoint's block hash at 974,621 equals the node's, and the extraction BLK has the size it records.
2. **Remount.** The drive had remounted (device 16777240 became 16777242), so the sync refused the local BLK's chunk manifest. The manifest was rescanned: all 70 chunk hashes, the inode, size and times were unchanged. The extraction BLK's manifest was scanned, and its first 69 full chunks equal the working BLK's.
3. **Lock.** A second sync attempt stopped because `extract/.extract.lock`, which `sync_blk_append.py` requires the caller to create, was missing; the November 3 directory had one. With it, the sync checked both prefixes and the suffix and appended 5,368,757 bytes.
4. **3D.** `chain3d.sh` built the dataset, uploaded the body while the local verify ran, and uploaded the manifest only after both passed. History was not extended, so the verify compared it at 974,310.

## Verification

- `landscape_verify` passed. All 1,109 snapshots equal fresh replays, 20 backward replays pass, every level-0 cell at 210,000, 630,000 and 974,310 equals the history index (0 mismatches over 3,715,768,459 records), block times equal the history through 974,310 and the BLK through 974,621, and the renderer checkpoint at 972,899 is within 3.64e-12.
- In R2, the size and MD5 of all 5,566 files match, with 0 problems, before and after the manifest; the snapshots and chunks are checked under `landscape/blobs/`.
- Online: release `landscape-20261104-2`, Worker version `acbe8fff-c526-492f-9102-0e48a219c016`, deployed from merged master ([#68](https://github.com/nostitos/utxo-timelapse/pull/68)). `scripts/check_live_release.mjs` confirmed all four landscape hostnames serve it and the 2D hostnames still serve `append-974310-20261102`. All four landscape hostnames name the new dataset, with `d974481-20261103` next. On bitcoinlandscape.com the manifest, the four new or changed files and the first MiB of the tip snapshot equal the local files, and the documented example cell returns 1 output of 21,236 sat.
- Browser, against https://bitcoinlandscape.com/: 50 of the 51 checks in startup, inspector, hover, playback, keys-inputs-scrub and column-counts pass. The one failure is Max playback's steadiness, which follows the download: on three playback runs Max paused for 1.3 s, 0.46 s and 1.6 s (the limit is 300 ms) at 80–128 blocks/s, while Cloudflare's speed test measured 1.4–11.5 MB/s from this Mac (one further run returned no output). Served locally from `landscape_974621/`, the same dataset passes every playback check: Max advances 1,271 blocks/s and never pauses.

## Measured stages

| Stage | Seconds |
|---|---:|
| Extract 140 blocks on the Mac | 261 |
| Rescan both chunk manifests | 20 |
| Prefix proof and append | 129 |
| 3D build from genesis | 162 |
| 3D body upload (4 files), alongside the verify | 13 |
| R2 check of the body | 115 |
| 3D verify | 399 |
| Manifest and full R2 check | 34 |

## State retained for the next update

- Updater state: `update_20261104/extract/checkpoint_v3.utxo` (block 974,621) matches the working BLK.
- The BLK is ahead of the video and history. The next 2D update keeps 974,310 as its video and history old end while its sync's old tip is 974,621.
- Create `extract/.extract.lock` with the extraction directory; `make_drivers.py` does not.

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261104/` (`timings.jsonl`, `make_drivers.py`, `sync_blk.py`, `chain3d.sh`, `landscape_update.py`, `edit_release.py` and `extract/`).
