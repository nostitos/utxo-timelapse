# 3D landscape update to block 974,481 — November 3, 2026

## Result

The 3D landscape now ends at **block 974,481** (2026-11-04 04:30:31 UTC), previously 974,310: **171 new blocks**. Only the 3D landscape was updated. The 2D explorer's video streams and the exact history, local and in the cloud, still end at 974,310. The landscape's cell inspector therefore shows lifecycle details through 974,310 and says so. From the extractor's start to the dataset complete in R2 took 23 minutes.

- Dataset `d974481-20261103`, release `landscape-20261103-1`: 1,109 snapshots and 4,451 chunks. At the tip the set holds 164,246,660 outputs and 20,107,727.29 BTC, exactly 53,437,500,000 sat more than at 974,310 (171 blocks × 3.125 BTC subsidy). `d974310-20261102` joins the retained ids with `d972848-20261023`, `d972052-20261018` (the guide's capture dataset) and `d971587-20261015`.
- The publish copied 5,557 files (77.0 GB) inside R2 and uploaded 6 (100 MB) in 214 s, while the local verify ran.

## How it ran

1. **Extraction.** `update_20261103/extract/` held APFS clones of `changes.blk1.full964k` and the November 2 checkpoint at 974,310, with that run's config, wrapper and tunnel. The unchanged v3 updater exited 0 in 728 s, 192 s of it loading the checkpoint. Its checkpoint's block hash at 974,481 equals the node's.
2. **Sync.** The drive had remounted again (disk8 became disk5), so the local BLK's chunk manifest was rescanned first: all 70 chunk hashes were unchanged. `sync_blk.py` (`sync()` from the November 2 driver) checked both prefixes and the suffix and appended 6,285,702 bytes.
3. **3D.** `chain3d.sh` built the dataset, uploaded the body while the local verify ran, and uploaded the manifest only after both passed. History was not extended, so later block times come from the BLK. The verify's tip check is skipped because the tip is past the history, and the history comparison ran at 974,310 instead.

## Verification

- `landscape_verify` passed. All 1,109 snapshots equal fresh replays, 20 backward replays pass, every level-0 cell at 210,000, 630,000 and 974,310 equals the history index (0 mismatches over 3,715,768,459 records), block times equal the history through 974,310 and the BLK through 974,481, and the renderer checkpoint at 972,899 is within 3.64e-12.
- In R2, the size and MD5 of all 5,564 objects (77.07 GB) match, with 0 problems, before and after the manifest.
- Online: release `landscape-20261103-1`, Worker version `4ad7755d-aab3-47c7-aa01-5d9fc1fbc181`, deployed alone from merged master ([#63](https://github.com/nostitos/utxo-timelapse/pull/63)). `scripts/check_live_release.mjs` confirmed all four landscape hostnames serve it and all five 2D hostnames still serve `append-974310-20261102`. All four landscape hostnames name the new dataset. On bitcoinlandscape.com the manifest and the first MiB of the tip snapshot equal the local files, and the documented example cell returns 1 output of 21,236 sat with history through 974,310. The 51 browser checks in startup, inspector, hover, playback, keys-inputs-scrub and column-counts pass; column-counts hit the same WebGPU readback error inside three.js on its first run, as on October 23 and November 2, and passed on an immediate re-run.

## Measured stages

| Stage | Seconds |
|---|---:|
| Extract 171 blocks on the Mac (checkpoint load 192) | 728 |
| Rescan both chunk manifests | 49 |
| Prefix proof and append | 73 |
| 3D build from genesis | 137 |
| 3D body upload, alongside the verify | 214 |
| 3D verify | 330 |
| Manifest and full R2 check | 30 |

## State retained for the next update

- Updater state: `update_20261103/extract/checkpoint_v3.utxo` (11,256,414,852 bytes, block 974,481) matches the working BLK.
- The BLK is ahead of the video and history. The next 2D update keeps 974,310 as its video and history old end (`OLD_END` in its driver), while its sync's old tip is 974,481: the November 2 `prepare()` asserts they are equal, so change that assertion. `utxo_history_update` extends from the history's own block count, so one journal covers 974,311 onward. The history catalog's position-file identities need `revalidate_catalog` after this remount.
- The renderer checkpoint, history publication pointer, window master and 1440p ledger are unchanged from November 2.

Evidence and drivers: `/Volumes/4T Data/buv_render/update_20261103/` (`timings.jsonl`, `make_drivers.py`, `landscape_update.py`, `sync_blk.py`, `chain3d.sh`, `edit_release.py` and `extract/`).

