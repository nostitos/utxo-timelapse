# H.264 compatibility rendition

The explorer defaults to 2560×1440 H.264 High 5.1, 60 fps, 8-bit 4:2:0. Its
optional 4K stream remains HEVC 4:4:4. Both have one frame per block and the
same ending. `imageWidth`, `imageHeight`, `graphRect`, history queries and share
coordinates always describe the 3840×2160 master.

The compatibility video is a lossy transcode of the master. A p=4 power mean
over neighbouring RGB samples gives isolated bright points more influence than
an ordinary average. The implementation uses 16-bit planar RGB LUTs and area
scaling, then an explicit full-to-limited-range BT.709 conversion. Low values
can quantize and mixed pixels change colour. This is presentation resampling,
not an alternative density calculation or an exact RGB preservation claim.
The magnifier displays resampled colours; coin lookups retain the master grid.

## Build and verify

Create a private JSON spec outside version control with absolute `source`, its
`sourceSHA256`, exact `frameCount`, and a fresh absolute `destination` directory.
The source must be the verified 3840×2160 HEVC 4:4:4, 60 fps master. For the
September 13 edition, the frame count is 967128, including 300 ending frames.

```sh
python3 scripts/compat_rendition.py build /absolute/path/build-spec.json
python3 scripts/compat_rendition.py verify /absolute/path/run
python3 scripts/publish_append.py prepare /absolute/path/run/ledger \
  /absolute/path/staged --object-prefix hls/compat1
```

Encoding uses libx264 medium/CRF 20, a 20 Mbps maximum and 40 Mb VBV buffer.
Closed GOPs have 240 frames, with B-frames disabled so presentation and decode
timestamps agree at every four-second boundary. The fMP4 track has 15360 ticks
per second (256 ticks per frame), square pixels, and `avc1.640033` signalling.
The current edition has 4030 segments; the final one contains 168 frames.

`encode/` contains FFmpeg output; `ledger/` contains content-addressed immutable
objects and `segments.json`. Every fragment is checked for its sample count,
duration, timeline and initial AVC IDR. The entire new range is then decoded
with error checking and a frame count. Only successful completion writes
`build_verified.json`. Monitor `status.json`, `progress.txt`, `decode-progress.txt`
and process exits; file growth or an ENDLIST alone is not completion evidence.
Interrupted encoding requires a fresh destination. Completed staging/upload
can be retried using the same immutable objects without re-encoding.

## Append

Use the newly assembled, verified master MP4 from an append. Include
`previousManifest` (the published compatibility ledger), `previousSHA256`,
`previousInit` (its exact init bytes), and `joinFrame` (the master append's first
changed frame, before the former ending) alongside the ordinary build fields.

```sh
python3 scripts/compat_rendition.py append /absolute/path/append-spec.json
python3 scripts/publish_append.py prepare /absolute/path/run/ledger \
  /absolute/path/staged --object-prefix hls/compat2 \
  --previous /absolute/path/previous/segments.json \
  --previous-sha256 EXACT_PREVIOUS_MANIFEST_SHA256
```

The script rounds the join down to the 240-frame boundary, re-encodes that short
overlap and the new tail, and retains earlier objects. It requires unchanged
AVC configuration, rebases new fragment timestamps, and removes the previous
ending from the new playlist. The parent ledger and objects remain intact.
This can be an `append_update.py` command stage after master assembly; workflows
that omit the optional MP4 assembly must produce that source before this stage.
Do not publish a new video cutoff until both renditions cover it.

## Publish and roll back

`publish_append.py` uses hashed media filenames, not `segment_00000.m4s` names.
Add the fresh prefix to the Worker's strict HLS allowlist before verifying its
public URLs; preserve older prefixes because new playlists may reuse them.
The public prefix exposes only the playlist and `.mp4`/`.m4s` media names.

The publication execution manifest optionally accepts `additionalStages`:
each entry has an absolute `manifest` path and its exact `sha256`. Use a prepared
compatibility stage here when publishing both renditions. All stage manifests,
ledgers and object hashes are checked before network activity. Upload every
new media object across both stages before either playlist, then deploy once.
Any failed post-deployment check rolls back the single release pointer.
Advertised renditions require a pinned previous frame count in the before-checks.
If the cutoff changes, every rendition must have a staged playlist. Staged
durations must match the new frame count and FPS (within one millisecond for
legacy HEVC timing). This prevents advancing 4K while retaining a stale default
H.264 timeline.

`/api/info` adds `videoDefaultRendition: "compat"` and `videoRenditions.full` /
`videoRenditions.compat` entries containing `url`, `codecs`, `width`, `height`,
and `label`; compat also has an immutable `version`. Existing `videoUrl` and
master geometry remain backward compatible. UI-only updates still get a fresh
`sitePrefix`. Read and retain the current deployed descriptor before changing
it; do not guess the rollback version from an older run report.

The player remembers the selected quality under `btl.quality`; optional
`quality=4k` or `quality=1440p` overrides it for the current visit. Share URLs
remain independent of quality. 4K is offered when codec probes report support;
actual decode/load failures fall back to 1440p, including paused shared links.
Legacy native `/api/info` without renditions continues using its own MP4.

Before promotion verify public manifest/media ranges, both quality choices,
paused and playing switches, forced 4K failure, deep-link frame alignment and
390 px controls. Chrome device emulation and Playwright WebKit exercise browser
behaviour but do not prove physical iPhone/Android decoder support. H.264 High
5.1 is within Apple's [HLS authoring requirements](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/);
support still depends on the actual device and browser.
