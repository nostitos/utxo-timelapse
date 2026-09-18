# H.264 compatibility release — September 18, 2026

The explorer now defaults to 2560×1440 H.264 at 60 fps. The original 4K HEVC
4:4:4 stream remains available through the remembered Quality control, with
automatic fallback to 1440p after a 4K load or decoding failure. Both streams
cover blocks 0–966,827 and use the same frame timeline. History lookups, share
links and selected coordinates retain the 3840×2160 master grid.

## Media measurements

| Property | Verified value |
|---|---|
| Source | `utxo_4k_epoch105k_60fps_transition_crf21_to_966827.mp4` |
| Source size | 84,200,687,245 bytes |
| Source SHA-256 | `3a037755275eba6af0251d8122c6c0f7ec130ef1b8b1cb08daba1632e4786ec1` |
| Frames / duration | 967,128 / 4:28:38.800 at 60 fps |
| Ending | 300 additional frames repeating block 966,827 |
| Downscale | p=4 power mean, 16-bit planar RGB LUTs and area scaling |
| H.264 | libx264 medium, CRF 20, High 5.1, `avc1.640033` |
| Colour | 8-bit 4:2:0, limited-range BT.709, square pixels |
| Rate limits | 20 Mbps maximum, 40 Mb VBV buffer |
| GOP | 240 frames, closed, no B-frames, scene cuts disabled |
| Timing | 15,360 ticks/second, 256 ticks/frame |
| HLS | 4,030 fMP4 segments plus init; final segment 168 frames |
| Media bytes | 19,836,027,329, including init and all fragments |
| Encoder wall time | 4:18:51.56; average 62.27 fps |
| Build and full validation | 16,142.00 seconds (4:29:02) |
| Ledger SHA-256 | `a5ce41ede88a18aa50aca13f5ebe28495488d68294962b47f46aa5ad7784607e` |
| Run directory | `/Volumes/4T Data/buv_render/compat1440-20260918` |

The source master, chain data and checkpoints were preserved. This is a lossy
presentation transcode, not a rerender or an exact-pixel copy. The p=4 downscale
favours isolated bright points; magnifier colours are resampled. The earlier
incomplete mobile experiment remains untouched and is not a release input.

## Validation

The build checked every fragment's sample count, duration, decode timeline and
initial IDR, and recorded its content hash in an immutable ledger. It decoded
the entire new stream with FFmpeg error checking and verified all 967,128
frames with zero drops or duplicates and a successful process exit before
issuing the build receipt. Publication checks object hashes and
byte ranges, pins the preceding Worker version, and has a rollback path.

The 12-second comparison sample scored SSIM 0.993103 against the selected
downscale reference. This measures encoding fidelity to that resampling, not
pixel identity with the 4K source. Full-release boundary comparisons also
passed, and the decoded HUD heights were visually checked:

| Segment | Source frame | Displayed block | SSIM |
|---|---:|---:|---:|
| 0 | 0 | 0 | 0.999893 |
| 1,000 | 240,000 | 240,000 | 0.997270 |
| 4,029 | 966,960 | 966,827 (repeated ending) | 0.997444 |

The isolated suite passed 42 media and publication tests, 57,459 guide mapping
checks, and the sharing, quality-selection and Worker route/range checks. The
existing native build passed three cases with 1,965 assertions. Local browser
checks covered paused and playing quality switches, remembered selection,
0.5× speed preservation, forced 4K failure, unsupported HEVC, 390 px controls,
and the exact master-grid pixel (1100,1300) at block 756,180, including swatch
and crosshair refresh after a quality change.

## Published release

- Public player: <https://bitcointimelapse.com/explorer>.
- Release: `compat-1440p-20260918`.
- Worker version: `5c824ca4-a280-4139-92ff-2a070f110aec`.
- UI namespace: `explorer/compat-1440p-20260918/site`.
- Default playlist: `/hls/compat1/media.m3u8`; optional 4K remains `/hls/v5/media.m3u8`.
- Publication manifest SHA-256: `6fcb0aa3c1abe6dbdbd921b984a1c0514507401afc0274217524e5c7f58c333c`.

The published playlist matches the staged bytes. Init and boundary-segment
range responses matched their hashes, and the existing history response for
block 756,180 / pixel (1100,1300) was unchanged. Only the deployed descriptor's
version and UI prefix changed; its history routing was retained.

Fresh live Chrome, Pixel 7 emulation and iPhone 14 WebKit emulation selected
2560×1440 by default, reached decoded frames, and advanced after Play without
horizontal overflow. Chrome also loaded the optional 3840×2160 stream and
recovered from an injected 4K playlist 404 while retaining paused block
756,180. Live seeks to blocks 0, 210,000 and 966,827 passed; the ending HUD was
visually checked.

The first deployment attempt rolled back when its immediate header check saw
another Worker version during propagation. The previous release was verified
restored, the attempt journal was retained, and a fresh publication succeeded
after adding bounded version-propagation retries. Payload/hash mismatches and
pre-deployment baseline checks remain immediate failures.

Browser verification used desktop Chrome, Pixel browser emulation and iPhone
WebKit emulation. It does not establish playback on physical phones; actual
hardware decoder support still varies by device.

See [compatibility operations](../compat-rendition.md) for reproducible build,
append, verification and publication contracts. The compatibility default must
advance with the 4K timeline on subsequent data releases.
