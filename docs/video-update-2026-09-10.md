# Append-only update — September 10, 2026

Status: **completed and published** to block **966,360**. Public explorer: https://utxo.aiception.ai/ . Release `append-966360-20260910-r3`; Worker version `0c2c59b5-cfb9-4024-8912-9374c07d2d54`.

- Previous video: blocks 0–964,388, plus a 300-frame ending.
- Target: block **966,360**, captured at the start of this update (not a continually moving target).
- New data: **1,972 blocks**, or **32.8667 seconds** at 60 fps.
- Splice: preserve encoded frames for blocks **0–964,379** verbatim; re-encode the 9-block incomplete last GOP together with new blocks. Replace the old 300-frame ending with a new 300-frame ending.
- Output: **966,661 frames**, 4K60, libx265 superfast CRF 21, yuv444p, same density/palettes/stars/HUD/epoch settings.
- No full video re-encode. Earlier BLK records are replayed only to reconstruct renderer state; 1,380 pre-roll frames before the splice are discarded before encoding to restore flash/flow activity.

## Measured stages

Stages overlap, so their durations should not be added to estimate wall-clock elapsed time.

| Step | Actual time | Result |
|---|---:|---|
| Node v3 checkpoint load, new-block processing and checkpoint save | 5m 46.55s | Doctest SUCCESS; checkpoint ends 966,360 |
| Full old BLK-prefix SHA256 compatibility check | 1m 29.49s | All 18,219,536,984 old bytes identical on Mac and node |
| Transfer only new changes | 17.31s | 75,512,433 bytes; SHA256, contiguous block heights and node tip hash checked |
| Append verified changes locally | 0.03s | Old prefix unchanged |
| Existing palette/mapper tests | 1.76s | 2 tests, 1,917 assertions passed |
| Local exact explorer-history update | 3m 50.00s | 15,338,763 new records; 2,534,167 prior-output spends; 0 unmatched |
| Sequential BLK prefetch | 6.45s | Filled read cache during initial sparse block-index scans |
| Renderer state replay, pre-roll and tail encode (combined) | 50m 54.42s | No old prefix frames encoded; 2,281 tail frames |
| Historical-state replay until visible pre-roll (approximate, included above) | ~49m 21s | Main bottleneck: ledger replay and 1,080 historical slide rebuilds |
| x265 encoding (included above) | 1m 10.09s | 32.54 fps; 9 overlap frames + 1,972 new blocks + 300 ending frames |
| Incremental cloud history staging | 10m 19.30s | 330.5 MB uploaded rather than a full 58 GB history; original shard hashes validated |
| Cloud history correctness checks | 22.79s | Eight old/new-era pixels: counts and BTC sums exactly match local history |
| Packet-copy full MP4 + faststart | 3m 47.53s | 84.15 GB master; existing compressed prefix copied, not encoded |
| Short-join decode / master spot checks / full packet count | 12.61s / 3.17s / 27.18s | 966,661 packets; old packet/timestamp samples identical |
| Package HLS tail | 0.63s | Only final streaming segments changed |
| First HLS tail upload | 2m 1.34s | 1,607 old segments reused |
| Continuous-timestamp tail upload | 1m 16.22s | Same encoded payloads; corrected how container timing only |
| Final UI staging + deployment | 5.89s + 14.43s | Paused seeks use explicit preload=auto |
| Final public info, Range and eight pixel checks | 13.77s | All pass |

There was one transient SSH monitoring authentication failure. The monitor reconnected; the node updater continued and was **not restarted**. Docker's actual start/finish timestamps supply its 346.55-second runtime, not the later polling time.

## Audit and orchestration

All exact timestamps, process IDs, log files, immutable inputs and gate results:
`/Volumes/4T Data/buv_render/update_20260910/`.

- `timings.jsonl`: machine-readable measured steps and failures/recoveries.
- `prepared.json`: frame/range contract.
- `render_progress.json`, `render_tail.log`, `ffmpeg_tail.log`: completed rendering.
- `node-delta-verified.json`, `prefix-verification.json`: input continuity.
- `history_update.log`: exact in-place history update.
- `cloud-history-delta-state.json`: resumable immutable cloud changes.
- `finalizer.log`: tail validation, stream-copy splice, final master and HLS staging.

Scripts added for this first append are anchored to the verified source/range in this run; do not blindly rerun them for another tip. Use a fresh run manifest and current retained source for subsequent updates.

## Accuracy and publication gates

- Renderer/encoder success; zero ledger misses and dropped decrements; tail = 2,281 packets.
- Same HEVC VPS/SPS/PPS and pixel/color/time-base metadata as retained master.
- Exclusive concatenation cut at the new GOP's **DTS**, with explicit prefix duration; packet-only fixture passed (360 packets).
- Final master = 966,661 frames; retained packet/timestamp samples identical at multiple eras; full short join decode and multi-era spot decodes.
- HLS reuses segments 0–1606. Repackage only the old partial last ten-second segment plus the append, using continuous fMP4 timestamps and the existing init map (the initial discontinuity version was superseded). Do not upload or replace old segments.
- Cloud spend patches use stable row-sorted record ordinals. Reconstructing each original patched shard must match the prior upload's MD5 before publishing a patch. Same-height/same-amount coins remain distinguishable by ordinal.
- Test cloud/API counts and BTC sums against local exact history, including output spends after the old tip.
- Atomic Worker release switches video, history routing, geometry limit and site info together. New version namespaces cache entries; old cloud objects remain valid.
- Verify actual browser playback/seek and public HTTP/API/Range responses before marking complete.

## Result and delivery checks

- Master: `/Volumes/4T Data/buv_render/utxo_4k_epoch105k_60fps_transition_crf21_to_966360.mp4` — **84,150,399,131 bytes**, 966,661 frames/packets, 3840×2160, 60 fps, HEVC Rext/yuv444p, CRF 21, hvc1. Duration 4h 28m 31.016s.
- Input BLK: 18,295,049,417 bytes; exact history: 58,494,057,684 bytes, 3,654,431,611 records. Both cover blocks 0–966,360. The node BLK/checkpoint pair matches that same tip.
- HLS `/hls/v3/media.m3u8` reuses v1 segments 0–1606; only five appended/replacement segments 1607–1611 were uploaded. Continuous timestamps shift `tfdt` and `sidx` by 257,120,000 ticks at 16 kHz; `mfhd` sequence numbers continue from the prefix. All encoded `mdat` hashes remain unchanged.
- History routing reuses original v1 shards, with v2 small spend patches and five new/replaced shards. Site metadata/UI uses `explorer/v4/site`; this is a release namespace, not a new copy of the full dataset.
- Native in-app-browser playback was observed across the splice, and the final stream showed the correct HUD at 964,380, 966,300 and 966,360. Final explorer paused seeking at 966,300 succeeds with readyState 4 and no media error. Public counts and BTC sums match local exact history for eight test cases.
- Both maintained local explorer configs point at the new MP4 and explicit end block 966,360. The retired local explorer service was not restarted. The public explorer does not depend on this Mac.
- Prior master and shared cloud objects are preserved. No Bitcoin/node data or earlier video was deleted during this update.

### Extra delivery troubleshooting (not rendering time)

The verified local master was ready at 14:07 UTC. Initial public API tests passed, but browser seeking stalled, so the Worker was rolled back while investigating. Standalone MP4/HLS clips decoded and played correctly. Local discontinuity playback also worked, so **the initial stall is not proven to be a discontinuity/codec defect**. The final stream avoids the unnecessary timestamp reset anyway, without re-encoding pixels.

The explorer originally omitted `preload=auto`; paused exact-block loads could remain at metadata-only readiness. Explicit preloading was added, after which the final public paused seek displayed the expected frame. Intermittent network slowness was also measured: the same 56.2 MB open-ended Range request took 142.23s in one default-route request and 3.86s with IPv4 forced. One Wrangler network failure recovered on retry with IPv4-first DNS ordering. No system network settings were changed. Streaming speed still depends on the viewer's connection.

Delivery investigation, rollback, replacement HLS publication and final browser checks added roughly **38 minutes** after local completion; this was not another render. Exact operational timestamps, retries and overlapping stages remain in `timings.jsonl`. The old nine-frame overlap is CRF-encoded again, not pixel-lossless; its layout/colors were visually checked, and active-area comparison PSNR was 30.94 dB. The much larger retained prefix is packet-copied.

## What the next append can improve

The node's checkpoint saves blockchain extraction work; it does **not** save the renderer's density/flash state. This append therefore still replayed history, but did not encode historical video. A renderer checkpoint or skipping invisible historical slide rebuilds could remove much of the ~49-minute replay cost; neither optimization was implemented here.

The first-append scripts contain this run's verified source heights and filenames. For the next update, create a new manifest from this new master, compute the closed-GOP cut and HLS partial-segment boundary, validate BLK prefix continuity, and update the script constants before running. Do not rerun the September 10 manifest against its now-extended input.

Measured operational wall time (from initial node-update dispatch through final browser verification): **102m 24s**. This includes overlapping jobs and delivery troubleshooting, but not preparatory coding before dispatch.
