# Timed journal-based append — September 13, 2026

## Result

**Completed through block 966,827**, previously 966,764: **63 new blocks**
(1.05 seconds of chain time at 60 fps). No full-chain re-render.

- [Open the updated video](https://utxo.aiception.ai/?block=966827).
- Master: `/Volumes/4T Data/buv_render/utxo_4k_epoch105k_60fps_transition_crf21_to_966827.mp4`.
- 84,200,687,245 bytes; **967,128 packets/frames**, including 300 ending frames.
  3840×2160, HEVC Rext `yuv444p`, `hvc1`, superfast CRF 21, nominal 60 fps.
- Public release `append-966827-20260913-journal`, `/hls/v5/media.m3u8`;
  Worker version `795cf7e4-e677-461f-a0ca-7968aa599ae4`.
- All earlier masters, checkpoints, logs and partial artifacts preserved.

**Request-to-verified-state wall time: 27m51.48s**, 13:59:33–14:27:24.481 UTC.
This includes preparation, a fresh node update, operational corrections, browser
checks and pointer promotion. Report-writing is excluded. It is not an unattended
pipeline benchmark. The previous run took 28m23.52s but its node update had already
finished outside the request; it also appended 404 blocks rather than 63.

## Measured stages

Stages overlap; **do not add their durations** to infer wall time.

| Stage | Elapsed | Detail |
|---|---:|---|
| Node BLK/checkpoint update | 4m51.55s | Fresh 63-block update, successful retained v3 service |
| BLK continuity / suffix transfer / apply | 2m39.02s | Only 2,365,097 new bytes transferred |
| Prepare journal config and append plan | 2.08s | Fresh journal and measured closed-IDR join |
| Extend local lifecycle history | 14.05s | 132,225 old spends, 480,407 new records; zero unmatched |
| Renderer resume, warm-up, checkpoint save, encode and verify | 49.60s | 408 encoded frames; no genesis replay |
| Tail remux, parameter-set/splice checks and join decode | 2.98s | Packet copy and short decode |
| Full MP4 assembly and faststart | 6m28.72s | Copies the 84 GB compressed master, not re-encoding it |
| Master sampled packet/decode checks | 2.99s | Retained packet samples identical; multiple eras and join |
| Journal-based cloud-history preparation | 5m57.39s | Zero historical discovery scans; one creation shard rebuilt |
| Cloud-history upload | 16.65s | 827 immutable objects, 59,699,985 bytes |
| Cloud/local exact-history comparison | 14.03s | Ten pixels, counts and BTC sums |
| HLS package and rebase validation | 0.21s | 1,611 old segments reused; one replacement segment |
| New HLS upload | 3.31s | No historical video upload |
| Immutable site staging | 1.01s | Existing UI retained |
| Exact full-master packet count | 1m55.97s | 967,128 packets; no full decode |
| Worker deployment | 4.01s | New per-shard history catalog support deployed |

Public API/Range checks and actual public/local playback followed. The public
release was deployed at 14:21:18 UTC; local restart/range checks and interactive
browser verification account for much of the remaining wall time.

## What the publisher improvement actually achieved

Previous cloud-history preparation plus upload: **693.02s (11m33s)**.
This run: **374.04s (6m14s)**. Observed reduction: 318.98s, about 46%.
This is **not a controlled same-delta speedup**: new block counts differ, cache
state differs, and both runs competed with MP4 assembly for external-drive I/O.

The structural change is verified independently of that comparison:

- **0** historical shards scanned to rediscover spends.
- **1** creation-tail shard rebuilt: shard 1888.
- **824** old shards received merged spend patches; **1,064** were reused unchanged.
- **1,889** total history shards still cover the complete chain; these are not
  video segments. The HLS video separately has **1,612** segments.
- 827 uploaded objects = 824 patches + one base shard + timestamps + manifest.
- Uploaded bytes fell from 383.37 MB to 59.70 MB. Actual upload took only 16.65s.

Preparation is still not instant. A one-second process sample during the slow
stage was predominantly inside NumPy indexed reads of mapped data, consistent
with scattered disk/page reads while the large MP4 copy was also active. This
sample is not a full-stage I/O profile and does not establish a precise split
between validation, paging, cache access, sorting and durable writes. Evidence:
`history-stage-sample.txt` in the run directory.

The remaining major avoidable work is still the complete MP4 copy/faststart and
full-file packet scan. Serving immutable append fragments while making full MP4
exports optional would remove these recurring passes; no such migration was
silently introduced in this run.

## Correctness and playback

- Input BLK prefix continuity verified; only the suffix appended. Node hash work
  took 136.46s, local prefix work 10.60s, actual download 1.75s.
- Join at measured closed IDR **966,720**; replaced 45 overlap frames + 63 new
  blocks + 300 ending frames = **408**. Frames before the join are packet-copied.
- Loaded renderer state before 965,340; discarded 1,380 warm-up frames before
  encoding. Saved next state before 965,400.
- Visualizer/FFmpeg exit zero, Doctest SUCCESS, FFmpeg `Lsize=`, ledger misses=0,
  dropped decrements=0. Entire tail and short splice preview decoded successfully.
- Retained compressed packet/timestamp samples at multiple eras and the join
  matched the previous master. This does not claim lossless RGB through CRF 21.
- Public metadata, retained playlist URLs and three HTTP 206 byte samples passed.
  Ten public pixel results matched exact local lifecycle counts and BTC sums,
  including old spent/unspent controls and newly created/spent tail records.
- Both public HLS and local MP4 actually played from 966,710 through the new ending
  in the Codex in-app browser, 3840×2160, readyState 4. Paused exact seek to 966,827
  returned 16113.791666s and visually showed HUD block 966,827. Local single-block
  stepping also visibly showed 966,826.
- Native `/api/info` counts real block frames only (966,828); public metadata and
  ffprobe count all 967,128 frames including the ending. Both clamp correctly at
  videoEndBlock=966827. Both native configs have the new path and explicit range.

Operational corrections were limited to the run harness: reading the node journal
with the required privilege, invoking public validation with the boto3-equipped
Python, terminating the exact old explorer child after screen exit left it running,
and updating the inherited native end-height. Initial failed helper logs remain;
no BLK repair, repeat node update, repeated encode or artifact overwrite was needed.
A transient blank local screenshot was rechecked by single-frame stepping; the
correct final HUD/graph were subsequently visible. Chrome extension inspection was
unavailable while the Mac was locked; verification used the functioning in-app browser.

## State retained for the next update

- BLK: **18,312,486,354 bytes**, through 966,827; matched node v3 checkpoint.
- History: **3,658,064,209 records**, **58,552,184,856 bytes**; immutable journal retained.
- `renderer_checkpoint_current.json` points to `renderer_before_965400.bin`,
  978,662,696 bytes, SHA-256
  `3febc2f5a7d57c2434e1c3eeb32e05239b4385ca543536ca243c296963319b20`.
- `history_publication_current.json` points to this run's `history-staged/catalog.json`,
  matching the committed history header and successfully deployed release. The
  next update must extend this catalog using a **fresh** journal.
- New checkpoint and cache artifacts use hard links where applicable, not another
  full source-data backup. No earlier artifact was deleted.
- Native explorer remains on port 12988 in `buv_explorer_966827`. No new recurring
  automation was installed; the existing daily node timer is unchanged.

Evidence and run-specific scripts:
`/Volumes/4T Data/buv_render/update_20260913_journal/`. Do not reuse its pinned
paths/releases/ranges unedited. Source/config/documentation changes are local;
no Git commit or push was requested.
