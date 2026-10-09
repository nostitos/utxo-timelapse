# Site update to block 970,658 and node timing estimate — October 9, 2026

## Result

Both public sites now end at **block 970,658** (2026-10-09 16:49:26 UTC), previously 966,827: **3,831 new blocks**.
The node prepared the chain data; this Mac rendered, packaged and published everything. Each stage was timed, the
same workloads were benchmarked on both machines, and the measured ratios give the node-only estimate below.

- 2D release `append-970658-20261009`, Worker version `7f6c07a8-1845-43b4-833f-b640394a0ada`, live 18:10:20 UTC.
  4K stream `/hls/v6/media.m3u8` (1,611 earlier segments reused, 8 new); 1440p stream `/hls/compat2/media.m3u8`
  (4,029 `compat1` segments reused, 18 new objects, 116 MB). 970,959 frames including the 300-frame ending.
- History: 3,687,985,863 records; 1,650 new objects (579 MB): spend patches for 1,640 shards, 8 rebuilt tail shards, 248 reused,
  zero historical rescans. Ten `/api/pixel` results from the new cloud data equal exact counts and BTC sums from the local file.
- 3D dataset `d970658-20261009`, release `landscape-20261009-1` (Worker version `fcb20b5e-5341-45e1-8afe-ba22677e4d71`), live 19:11 UTC:
  1,101 snapshots and 4,417 chunks; the previous dataset stays servable for open tabs and rollback. At the tip the set holds 165,211,779 outputs
  and 20,095,780.42 BTC (3.125 BTC per block more than at 966,827, the subsidy).
- Master `utxo_4k_epoch105k_60fps_transition_crf21_to_970658.mp4`: 84,655,801,774 bytes, SHA-256 `23888292…8f1a45`.
  Earlier masters, checkpoints and datasets are preserved.

## Verification

- Node: the October 3 checkpoint (block 969,664) loaded; the extractor trimmed the unverified October 4 tail
  (18,423,900,218 → 18,419,243,160 bytes) and re-appended. Exit 0; checkpoint and BLK both end at 970,658.
- Sync: node and Mac BLK prefixes hashed equal; only the 144,401,500-byte suffix was transferred.
- Render: renderer checkpoint before 965,400, 1,380 hidden warm-up frames, 4,179 encoded frames; ledger misses 0, dropped
  decrements 0; the entire tail decoded with error checking. Retained master packets equal the previous master at five eras.
- 1440p: 4,239 frames encoded from frame 966,720; ledger verified and the full new range decoded.
- Public: `/api/info`, both playlists (byte-identical to staging), five range samples and ten pixel queries passed on
  utxo.aiception.ai and bitcointimelapse.com. FFmpeg decoded the public 4K segments 1,609–1,612 without error; frames 966,779,
  966,780, 966,828 and 967,799 show their own block heights. Chrome played 4K from 966,740 through the join and the old ending
  to 967,119; the in-app browser played 1440p from 966,700 to 967,017 and fell back from 4K as designed (it lacks HEVC 4:4:4).
- 3D: `landscape_verify` passed: 1,101 snapshots equal fresh replays, 20 backward replays, every level-0 cell at 210,000,
  630,000 and 970,658 equals the history index (0 mismatches), renderer checkpoint at 965,399 within 3.64e-12. Online, the
  tip snapshot range and manifest equal the local files, the documented example cell returns 1 output of 21,236 sat and 3 spent,
  a cell created at 968,114 equals the local history (79 live, 888 spent, 5,102,956 sat), and all 58 browser checks pass
  against https://3d.bitcointimelapse.com/.

## Measured stages

Mac: M4 Max (12P+4E cores), 64 GB, data on a Crucial P3 4 TB QLC NVMe in a Thunderbolt enclosure. Node: Umbrel VM, 16 vCPU
"QEMU Virtual CPU" on a 3.3 GHz AMD host exposing **SSE4.2 but no AVX, AVX2 or FMA**, 28.7 GiB RAM, virtual disk.

| Stage | Where | Seconds | Notes |
|---|---|---:|---|
| Extract 994 blocks (969,665–970,658) | node | 620 | headers 9, checkpoint load 166, blocks 268 (3.7/s), checkpoint write 176; peak 18.8 GiB |
| BLK sync (prefix proof + suffix) | both | 198 | node prefix hash 150, Mac 28, download 8 (17 MB/s over Tailscale), apply 12.5 |
| Render + encode 4K tail | Mac | 177 | checkpoint load 14, warm-up 15, encode 123 (34 fps), decode check 22 |
| Extend lifecycle history | Mac | 564 | matching 193; writing 3.6 M spends in 346,891 spans 370 (QD1 random I/O) |
| Stage history patches | Mac | 283 | parallel position-cache reads (about 7,000 IOPS) |
| Upload history | Mac | 66 | 1,650 objects, 579 MB |
| Cloud/local history check | Mac | 15 | |
| Assemble 4K master (two passes) | Mac | 404 | packet copy 210, faststart 194 |
| Hash master | Mac | 117 | the 1440p append hashes it again (part of its 189 s) |
| 1440p append | Mac | 189 | 117 hash + 72 encode/verify of 4,239 frames |
| Stage and upload media, site, deploy, public checks | Mac | 51 | 590 MB in 26 s |
| 3D build from genesis | Mac | 120 | 7,210,759,947 changes |
| 3D verify | Mac | 177 | |
| 3D publish | Mac | 2,884 | 4,382 chunks (18.3 GB) copied inside R2 in about 160 s; 1,139 files (57.9 GB) uploaded at 20 MB/s average |
| 3D object checks, manifest, deploy | Mac | 153 | size and MD5 of all 5,522 objects (76.2 GB): 0 problems; deploy 8 s |

Extractor start to 2D release live: 48 min 23 s, and to the 3D release live: 1 h 49 min, both including orchestration pauses
and the benchmarks run in between. The node's daily timer had been failing since
October 4 (out of memory while writing its checkpoint) and the October 9 umbrelOS update removed the timer, its service and
`/usr/local/lib/utxo-timelapse` with the system partition. Docker, the v3 container and `/home` survived.

## Same workload on both machines

| Benchmark | Mac | Node | Node slower by |
|---|---:|---:|---:|
| x265 4K 4:4:4 superfast CRF 21, 240 real frames | 47.7 fps | 16.5 fps | 2.9× |
| Renderer + x265, blocks 965,400–966,827 from the same checkpoint | 35.9 fps | 14.7 fps | 2.4× |
| Load renderer checkpoint (61.2 M entries) | 14.1 s | 47.8 s | 3.4× |
| 1440p chain (p=4 downscale, libx264 medium) | 68 fps | 30.2 fps | 2.3× |
| 4K HEVC 4:4:4 decode | 170 fps | 102 fps | 1.7× |
| Sequential read / write, 16 GiB direct | 2,866 / 2,699 MB/s | 239 / 485 MB/s | 12× / 5.6× |
| Random 32 KiB reads, 1 / 8 in flight | 5,996 / 39,584 IOPS | 2,000 / 9,276 IOPS | 3.0× / 4.3× |
| History-write replay (43,361 real spans, QD1 read-modify-write) | 3,610 /s | 472 /s | 7.6× |

The node renderer benchmark matched the Mac exactly (1,428 frames, ledger misses 0). On the node the renderer runs at the
speed of x265, so the missing AVX2 path is the video bottleneck. The node Docker image needed a one-line include fix
(`DensityFlashWeightTest.cpp`), now in the repository; macOS builds skip that legacy directory.

## Estimate for the node

The node's time for each stage is the Mac's measured time multiplied by the matching benchmark ratio. Ranges show where two
ratios apply. A daily update is about 144 blocks: from this run's journal, a 144-block window averages 142,500 spends in 49,700
write spans and 1.12 M new records, and 474 frames to encode (new blocks, keyframe overlap and the 300-frame ending).

| Stage | Today, Mac | Today, node (est.) | Daily, node (est.) |
|---|---:|---:|---:|
| Extract | 620 (node) | 620 | 390 |
| Move BLK to the renderer | 198 | none | none |
| Render + encode 4K tail | 177 | 410–420 | 120–135 |
| Extend history | 564 | 1,300–3,500 | 165–465 |
| Stage history patches | 283 | 850–1,220 | 850–1,220 |
| Upload history | 66 | uplink-bound | 20–60 |
| 4K master + hashes | 521 | not needed | not needed |
| 1440p append | 72 | 165 | 20–30 |
| Media, release switch, checks | 66 | 70 | 40 |
| **2D total** | **≈ 2,500 s (42 min)** | **≈ 3,400–6,000 s** | **≈ 1,600–2,350 s (27–39 min)** |
| 3D (today's format: full rebuild, 58 GB upload) | 3,334 | ≈ 4,100–4,500 | same as today |
| 3D (if snapshots stop recording the grid size) | — | — | 60–120 |

A daily node-only run therefore takes about **30–40 minutes**. The same daily update driven from this Mac takes about
28 minutes when it still assembles and hashes the 84 GB master, or about 17 minutes without it (node extraction 390 s,
BLK transfer 198 s, history staging 283 s and short render/history/upload stages). The node is 2–3× slower on CPU and
3–12× slower on storage, but it skips the transfer, the master and both full-file hashes, so the gap per day is about
10–20 minutes. History staging dominates and is the least certain estimate: its Mac time is roughly fixed per update
(283 s today, 357 s on September 13 for 63 blocks), and the node range assumes it scales with random-read speed.

Three changes would shrink the node time most:

1. Expose the host CPU to the VM (QEMU `host-passthrough`). The current model hides AVX2, which x265 and compiled code use.
2. Make 3D snapshots independent of the tip. Only the block count and level-0 column count in the snapshot header change
   (3 bytes of a 52.6 MB snapshot); the tile data is identical. Reusing snapshots turns a 58 GB upload into about 60 MB a day.
3. Read history inputs in parallel or sequentially first: the history write is one-at-a-time I/O (QD1), and the node does
   4.6× more random reads with eight in flight.

The 3D upload dominates either way, because both machines share one internet connection (the same public IP).
The node also needs about 19 GiB free for the extractor; Bitcoin Core (6 GB) and Lightning fit alongside, Fulcrum and Mempool do not.

## State retained for the next update

- `renderer_checkpoint_current.json` → `renderer_before_969240.bin` (980,471,192 bytes, SHA-256 `3319a0a2…d728482`).
- `history_publication_current.json` → `update_20261009/history-staged/catalog.json`.
- 1440p ledger: `compat1440-append970658-20261009/` and `update_20261009/compat-staged/segments.json` (with URIs).
- 4K: the next playlist reuses `/hls/v6/media.m3u8` entries; the next join is the last keyframe at or before 970,658.
- Node: BLK 18,456,887,854 bytes and checkpoint 10,951,124,156 bytes, both at 970,658. No schedule is installed.

Evidence, drivers and benchmark outputs: `/Volumes/4T Data/buv_render/update_20261009/` (`timings.jsonl`,
`bench/`, `run_update.py`, `landscape_update.py`, `landscape_publish.py`) and `/home/umbrel/buv_bench_20261009/` on the node.
