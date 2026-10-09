# Timed append update — September 13, 2026

## Result

**Completed and publicly verified through block 966,764**, previously 966,360:
404 new blocks, adding 6.733 seconds at 60 fps. No full-chain re-render.

- Master: `/Volumes/4T Data/buv_render/utxo_4k_epoch105k_60fps_transition_crf21_to_966764.mp4`.
- 84,194,549,278 bytes; 967,065 packets/frames, including 300 ending frames;
  3840×2160, HEVC Rext `yuv444p`, `hvc1`, CRF 21, 60 fps nominal.
- Public release: `append-966764-20260913`, `/hls/v4/media.m3u8`.
- [Open the final block](https://utxo.aiception.ai/?block=966764).
- All earlier full/partial renders and the old renderer checkpoint remain untouched.

**Request-to-browser-verification wall time: 28m 23.52s**, from
03:47:41.586 UTC to 04:16:05.108 UTC. This includes manual preparation,
release checks and correcting a native UI source-selection bug; it is not
an unattended pipeline benchmark. Report-writing time is excluded.

## Measured stages

Several stages ran concurrently: **do not add these durations** to estimate wall time.

| Stage | Elapsed | Detail |
|---|---:|---|
| Node BLK/checkpoint update | 4m 58.46s | Already completed by the 03:15 UTC timer; outside this request's wall time |
| Verify/download/apply BLK suffix | 3m 35.04s | 15,071,840 new bytes; existing prefix re-verified |
| Prepare append manifest | 1.84s | Existing closed-GOP join and renderer checkpoint |
| Extend block offset index | 1.02s | No full index rebuild |
| Extend local explorer history | 46.65s | Concurrent with renderer |
| Renderer resume, warm-up, checkpoint save, encode and tail verification | 1m 02.93s | 705 encoded frames; processes finished after 58.77s, then decode/hash gates |
| Tail remux + splice compatibility + short joined preview/decode | 4.26s | Packet copy, not another encode |
| Assemble full MP4 and faststart | 7m 35.21s | Copies retained compressed prefix; competes for drive I/O with history publication |
| Master sampled packet/decode checks | 3.85s | Multiple eras and append boundary |
| Exact full-master packet count | 2m 04.81s | 967,065 packets; reads entire master, does not decode every frame |
| Prepare and upload cloud history | 11m 33.02s | 16 workers; 1,889 shard preparations; 383,371,123 uploaded bytes including metadata |
| Compare cloud history against local exact history | 11.52s | Eight pixels, including old eras and before/after append |
| HLS package, rebase and continuity check | 1.01s | Old 1,610 segments reused, two new segments |
| Upload new HLS tail | 6.73s | No upload of historical video |
| Stage immutable UI release | 0.91s | Retained current public UI |
| Deploy Worker | 3.62s | Successful version `fabba0a4-65d2-4e49-a3d2-98a53aa276f1` |
| Public API, history and Range-byte checks | 4.59s | Followed by actual Chrome playback and paused seeking |

### Where the time went

The expensive genesis replay is gone. Rendering was not the dominant stage.

BLK sync preparation spent 188.08s verifying the node prefix and suffix hashes,
10.55s on the local prefix, and 2.28s downloading the suffix. The node had advanced
without a reusable protected-source attestation, so the safe path re-hashed its
old prefix. The earlier no-change cached benchmark is not representative here.

Cloud history still prepares a **cumulative overlay from block 964,388** because
the deployed query model consumes one overlay on top of v1. It is not a new
404-block-only overlay. Instrumentation reports 10,021.76 cumulative worker-seconds
preparing shards versus 802.85 worker-seconds uploading; these are overlapping
worker occupancy times, not wall time or CPU measurements. Preparation dominates.
This run does not establish an apples-to-apples 16-versus-6-worker speedup:
the cumulative dataset grew and MP4 assembly shared the external drive.

The append avoided re-encoding history but still wrote a new complete MP4.
Publishing/serving immutable fragments and making full MP4 exports optional would
remove the 7m35 copy/faststart and the routine full-file packet scan. A trusted
fragment catalog was **not** bootstrapped in this run; the existing safe HLS
reuse path was used instead. No large migration or full HLS upload was started.

## Append and correctness gates

- Retained compressed prefix ends before block 966,360. That block is the measured
  closed-IDR overlap. New encoded content: one overlap frame + 404 blocks + 300
  ending frames = 705. The original prefix was packet-copied without re-encoding;
  retained packet samples from multiple eras were byte-identical.
- Loaded renderer state before 964,980. Warmed up 1,380 frames, discarded before
  encoding. Saved the next rolling checkpoint before 965,340.
- Visualizer and FFmpeg exit codes zero; Doctest SUCCESS and FFmpeg `Lsize=`.
  `ledger misses=0`, `dropped decrements=0`.
- Entire tail and short joined boundary clip decoded successfully. Master metadata,
  exact packet count and multi-era spot decodes passed. This is not a claim of
  renderer RGB identity through lossy CRF 21 encoding.
- HLS uses v1 segments 0–1606, v3 segments 1607–1609 and new v4 segments
  1610–1611. Retained playlist entries and the new fragments' encoded media
  payload hashes were verified. Timeline duration matches 967,065 / 60.
- Public `/api/info` reports the new release and 966,765 blocks. Three HTTP 206
  samples at segment head/middle byte ranges matched local bytes exactly.
- Eight public pixel queries matched the local exact lifecycle history, including
  the historical 350 BTC and empty-pixel cases and changed recent pixels.
- Chrome actually played from 966,350 through the append seam and ending, with
  `/hls/v4/media.m3u8`, 3840×2160 and readyState 4. Paused seeking to 966,764
  yielded time 16112.741666 and the rendered HUD displayed block 966,764.
- Native explorer playback and paused seeks at 966,350/966,360 also passed using
  the new local MP4. It remains running on port 12988.

## Local UI correction discovered during verification

The native UI's `videoUrl()` was hardcoded to an old CDN pointer. Therefore new
local `/api/info` could describe the updated history while playback used an old
video. It now uses the API's video URL or native `/video.mp4`, with the API's
video-version cache key. Public HLS behavior is unchanged. Regression test:

```sh
node scripts/tests/test_explorer_video_url.cjs
```

All five URL assertions, the static guide check and 57,459 guide/production
coordinate and inverse checks passed. Root Worker release/routes/info and both
native explorer configs now match the verified deployment. Changes are local;
no Git commit or push was requested.

## State retained for the next append

- Working BLK: 18,310,121,257 bytes, through 966,764; offset and SHA-256 caches extended.
- Local history: 3,657,583,802 records, 58,544,497,588 bytes; added 3,152,191 records.
- Umbrel v3 checkpoint and BLK remain matched at 966,764. Timer next scheduled
  at 03:15 UTC September 14; `allowBlkFileTruncate=false` remains in force.
- New canonical checkpoint: `/Volumes/4T Data/buv_render/renderer_before_965340.bin`,
  978,961,048 bytes. `renderer_checkpoint_current.json` atomically points to it.
  SHA-256: `24559524124438f1e30aef225417309f38dd1b0ae5a750256334c52737a1138c`.
- Existing master and checkpoint preserved as rollback artifacts, not duplicated
  source-dataset backups. The new canonical checkpoint is a hard link to this
  run's saved checkpoint, not a second physical copy.

Raw timings, immutable manifests, upload receipts, checks, logs and promotion
backups are in `/Volumes/4T Data/buv_render/update_20260913/`.
`final_result.json` records the completed outcome; `public_browser_verified.json`
records observed playback/seek evidence. Run-specific scripts contain pinned
ranges and release identifiers and must not be blindly reused for a future tip.
