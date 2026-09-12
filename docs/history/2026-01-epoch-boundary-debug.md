# Epoch-boundary pixel-shift debugging notes (January 2026)

> **ARCHIVED — HISTORICAL SNAPSHOT. NOT CURRENT STATE.**
>
> Captured January 2026 while investigating an epoch-boundary rendering bug.
> Retained for the diagnostic reasoning; it is **not** a description of the
> system as it stands.
>
> Known to be stale:
> - "Current running test" refers to a January test run, long finished.
> - Paths point at `buv_deploy/`, which is now git-ignored legacy layout.
> - Predates: UTXO flow lines, `allowBlkFileTruncate`, and the
>   `robin_hood::hash_int` fix in `Utxo.h`.
> - Whether the described bug still reproduces has **not** been re-verified.
>
> For current terminology see [GLOSSARY.md](../../GLOSSARY.md); for build and
> operations see [CLAUDE.md](../../CLAUDE.md).

## Goal of this document
Provide full, actionable context for debugging the epoch-boundary pixel-shift bug in the Bitcoin UTXO Visualizer. This is a summary of everything learned in this chat: app architecture, rendering pipeline, recent fixes, bug definition, and relevant files/configs.

## App context (high level)
- C++ visualizer (`buv`) reads UTXO change data from a memory-mapped `.blk` file.
- It renders frames into a density buffer (per pixel counts) and streams raw frames over TCP.
- `ffmpeg` listens on a TCP port and encodes the stream to MP4.
- Docker containers run on an Umbrel server at `192.168.8.234`.

Key data flow:
1) UTXO changes -> `Density::change()` adds or removes density for a pixel.
2) Density -> color mapping via `DensityToImage` and colormap (e.g., "turbo").
3) Per-block "flash" effect via `PixelSetWithHistory` (recent pixels fade from white).
4) X-axis compression can be linear, epoch-based, or continuous-log; Y-axis compression can be enabled for low satoshi range.

## Rendering details (pixels, colors)
- `m_data` holds density values per pixel.
- `DensityToImage::update()` maps density to color.
- `PixelSetWithHistory` temporarily boosts updated pixels to white, then fades back.
- Resampling moves/merges density at epoch boundaries (epoch modes) or periodically (continuous-log).
- If resampling sums multiple pixels into one, density inflates and the color shifts (darker/redder).

## X-axis compression modes
- `linear`: direct block height -> pixel mapping.
- `epochLog`: epoch widths shrink by 1/2 per older epoch.
- `normalizedGeometric`: current epoch takes `epochRatio` of width; older epochs share the rest geometrically.
- `continuousLog`: power-law compression with periodic resampling every N blocks.

## Y-axis compression
`compressLowSatoshi` compresses the 1–100 sat range into 1/3 of its normal height, while keeping the full Y range in the same pixel height.

## Current bug definition (high priority)
At exactly block 210,000 (epoch boundary), in `normalizedGeometric` mode:
- There is a slight leftward pixel shift of the older epoch.
- This produces a red hue in the left epoch (not just a spatial shift).
- There are thin, regular black vertical lines appearing roughly every ~6500 blocks.
- The user confirms it is visible between two screenshots ("before" and "after").

This appears during the epoch resample step when transitioning from epoch 1 -> epoch 2.

## What has already been fixed (important history)
1) Continuous log: pixels "lost to the left" fixed by initializing `mTotalBlocks = 1` and growing dynamically.
2) Continuous log: red hue blowup fixed by averaging merged densities in `resampleForContinuousLog()` instead of summing.
3) Epoch resampling: The same averaging fix has now been applied to `resampleForNewEpoch()`.

Even after averaging, the user still observes a left-shift at epoch boundary + red hue + periodic black lines.

## Suspected root causes (next likely fixes)
Likely source is **inverse mapping + integer truncation** in epoch resampling:
- Current resample uses per-pixel inverse mapping:
  - old pixel X -> approximate block height via `pixelToBlockHeight(...)`
  - then maps block height -> new pixel X via `blockheightToPixelWidth*`
- This can introduce rounding/quantization artifacts:
  - Small left shifts at epoch boundaries due to different rounding of old/new mapping.
  - "Holes" (empty columns) where no source pixel maps to a target column, causing regular black vertical lines.

Potential fixes to consider:
- **Forward remap by block height** instead of inverse pixel mapping:
  - Iterate block heights and map directly oldX -> newX (reduces holes).
- **Smoothing / split distribution**:
  - When mapping a source pixel to a non-integer new X, distribute density between floor/ceil.
- **Consistent rounding**:
  - Use a consistent rounding strategy for both `pixelToBlockHeight` and `blockheightToPixelWidth*` to minimize off-by-one shifts.
- **Preserve density statistics per column**:
  - Use weighted averages so total density per vertical column remains stable across resample.

The current averaging fix stops blow-up, but it does not fix gaps or positional drift caused by rounding.

## Relevant files (most likely to change)
Primary:
- `src/cpp/buv/Density.h`
  - `Density::resampleForNewEpoch()` (epoch resampling)
  - `Density::pixelToBlockHeight()` (inverse mapping logic)
- `src/cpp/buv/SatoshiBlockheightToPixel.h`
  - X-axis mapping functions
  - `blockheightToPixelWidthNormalized()`, `getEpochStartXNormalized()`, `getEpochWidthNormalized()`

Deploy mirror (used for Docker builds):
- `buv_deploy/Density.h`
- `buv_deploy/SatoshiBlockheightToPixel.h`

Other relevant:
- `src/cpp/app/Visualizer.cpp` (frame loop)
- `src/cpp/app/Hud.*` (HUD uses mapping for axis labels)
- `src/cpp/app/Cfg.*` (config parsing)

## Config fields relevant to the bug
- `xAxisMode`: "normalizedGeometric"
- `epochBlocks`: 210000
- `epochRatio`: 0.5
- `compressLowSatoshi`: true

## Known test ranges
Epoch-boundary tests used:
- 208,000 to 212,000 (crosses 210,000)
- 2.5K test: 208,000 to 220,000 (3x longer)

## Observed artifacts (from screenshots)
- After epoch transition: leftward shift of older epoch
- Red hue appears in older epoch at boundary
- Regular vertical black lines at periodic intervals (approx every 6500 blocks)

## Docker locations on Umbrel
- Data: `/home/umbrel/buv_data/changes.blk1`
- Output: `/home/umbrel/buv_output/`
- Configs: `/home/umbrel/buv_deploy/`

## Current running test (as of last chat step)
- 2.5K test running with output:
  - `/home/umbrel/buv_output/smoke_epoch_208k_220k_2_5k.mp4`
  - Resolution 2560x1440, `normalizedGeometric`, epoch boundary included.

## Implementation notes (recent fix)
Averaging merged densities in epoch resampling was applied:
- Add `mergeCounts` during `resampleForNewEpoch()`
- After remap, `newData[i] /= mergeCounts[i]` when merged
This prevents density blow-up but does not resolve the positional drift or periodic gaps.

## Definition of the bug (exact)
When using `normalizedGeometric` with `epochBlocks=210000`, at block 210,000 (epoch transition):
- No visible resize should occur in the first epoch prior to resample.
- Instead, there is a visible left shift and hue change (reddening).
- Regular black vertical lines appear (spacing ~6500 blocks).
The bug is likely due to resampling math, not density coloring.
