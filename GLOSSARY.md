# Project Vocabulary

Canonical terminology for the Bitcoin UTXO Visualizer. **Code identifiers are
authoritative.** Where conversation has used a different phrase, it is listed as
an alias — prefer the canonical term in code, commits, configs, and docs.

Every term here resolves to a real identifier in `src/cpp/`.

---

## 1. Pipeline stages

The system is a four-stage pipeline. Stages 1 and 2 are `buv` tasks; 3 and 4 are FFmpeg.

```
Bitcoin Core REST  ──①──>  changes.blk1  ──②──>  RGB frames ──③──> .mkv ──④──> .mp4
                    utxo_to_change        visualizer      encode      remux
```

| # | Canonical | Invocation | Aliases |
|---|---|---|---|
| 1 | `utxo_to_change` | `buv -ns -tc=utxo_to_change -cfg=<config>` | BLK build, BLK rebuild, preprocessing |
| 2 | `visualizer` | `buv -ns -tc=visualizer -cfg=<config>` | render |
| 3 | encode | `ffmpeg` listening on TCP | — |
| 4 | remux | `ffmpeg -c copy` | container change |

**Task** — the `-tc=` argument. Built on doctest `TEST_CASE`, so tasks are
addressed by name. `utxo_to_change` and `visualizer` are the two production
tasks; `check_blocks`, `decode_change`, `parse_block`, `show_block_changes`,
`show_pixels_block`, `fetch_all_block_hashes`, and `find_distant_color` are
developer utilities.

**`-ns`** — doctest "no skip" flag. Required, because production tasks are
marked `doctest::skip()` so a bare `./buv` runs only unit tests.

---

## 2. Data artifacts

All are **generated artifacts**, excluded from Git. None are distributed.

### `changes.blk1` — the change file

*Aliases: BLK file, BLK data, the blk.*

Compact sequential record of UTXO changes, one record per block, produced by
`utxo_to_change` and memory-mapped by `visualizer`.

Record framing (`BlockEncoder.h`):

| Bytes | Field | Notes |
|---|---|---|
| 4 | marker | `BLK\x02` magic, identical every record |
| 4 | `block_height` | `uint32_t`, strictly increasing |
| 4 | `num_bytes` | payload size; skip this many to reach the next marker |
| … | header + changes | hash, merkleroot, chainwork, difficulty, time, then varint-encoded amount/blockheight deltas |

The `num_bytes` field makes the file **seekable without parsing** — walk
marker → height → length → skip. This is how integrity and tail-block checks are done.

Each change carries the **creation height** of the coin being spent. That
relationship is what the render colors by age; it is the reason the file exists.

### `checkpoint.utxo` — the checkpoint

Serialized in-memory UTXO set, allowing `utxo_to_change` to resume without
replaying from genesis. Written atomically via `.tmp` + rename.

Layout (`Utxo.cpp`): `UTXO0` magic (4 bytes) → block height (`uint32`) →
entry count (`uint64`) → per-entry txid prefix and packed vout/satoshi values.

> **Correctness caveat.** The checkpoint does **not** store each UTXO's original
> creation height. On restore, every loaded output is assigned the checkpoint
> height, so later spends render with wrong coin age. See §5, *checkpoint resume*.

---

## 3. Rendering concepts

### Density

**Density** — per-pixel count of UTXOs at a given (block height, satoshi value)
coordinate. Held in `Density::m_data`, one value per pixel.

**`DensityToImage`** — maps a density value to an RGB color through the colormap.

**`colorUpperValueLimit`** — density at which the colormap saturates.

**`colorMap`** — palette name. Valid values (`ColorMap.h`): `viridis`,
`magma`, `parula`, `turbo`, `spacious`.

### Axes

**`graphRect`** — `[x, y, width, height]` plotting area inside the frame,
leaving room for the HUD.

**Y-axis** — satoshi value, logarithmic, bounded by `minSatoshi`/`maxSatoshi`.

**`compressLowSatoshi`** — compresses the 1–100 sat range into one third of its
normal height so dust does not dominate.

**X-axis** — block height, mapped by `xAxisMode`.

### `xAxisMode` — layout modes

*Alias: compression mode, layout.*

Dispatched by string comparison in `SatoshiBlockheightToPixel.h`.

| Mode | Behavior |
|---|---|
| `linear` | Block height maps directly to pixel X. |
| `epochLog` | Each older epoch is half the width of the next. |
| `normalizedGeometric` | Newest epoch takes `epochRatio` of the width; older epochs share the remainder geometrically. |
| `continuousLog` | Smooth power-law `x = (h/N)^k` with periodic resampling. |

`epochLog` is the fallthrough when the string matches nothing else.

### Epoch

**Epoch** — a block range of `epochBlocks` length; epoch index is
`blockHeight / epochBlocks`. *Alias: halving epoch* when `epochBlocks = 210000`.

**`epochRatio`** — fraction of graph width given to the current epoch
(`normalizedGeometric`). `0.5` means newest epoch gets half, all older epochs
share the other half.

> **Layout stability.** Position depends on **epoch index, not chain length**, so
> renders stay pixel-comparable until an epoch boundary is crossed. At that point
> the whole X-axis rescales and older renders no longer align. See §5, *epoch rebasing*.

**`logCompressionFactor`** — the `k` exponent for `continuousLog`; higher
compresses old blocks more.

**`resampleEveryNBlocks`** — resample interval for `continuousLog`.

### Resample

**Resample** — redistributing accumulated density when the X-axis mapping
changes, so existing pixels land in their new positions.

- `resampleForNewEpoch()` — on epoch boundary crossing (epoch modes).
- `resampleForContinuousLog()` — every `resampleEveryNBlocks` (continuous mode).

Merged densities are **averaged, not summed**; summing inflates density and
shifts color toward red.

### Flash and fade

**Flash** — brief white highlight on pixels touched by the current block, via
`PixelSetWithHistory`.

**Flash size** scales with distance from the current block position: under 100 px
→ 1 px; 100–250 px → 4 px; over 250 px → 9 px (3×3).

**Fade duration** scales linearly with the same distance —
`10 + (pixel_distance * 290 / 3720)` blocks. Nearby activity fades fast; distant
activity lingers.

### UTXO flow lines

Short horizontal marks drawn to the right of the current block position,
indicating recent UTXO creation per Y band. Implemented in
`Density::drawUtxoFlowLines()`; pixels are saved and restored so flow lines do
not corrupt the density buffer.

- `FLOW_WINDOW_BLOCKS = 10` — rolling window of blocks counted.
- `FLOW_GAP_PIXELS = 15` — gap between current block column and the lines.

### HUD

Overlay drawn on top of the rendered frame: block height, timestamp, hash,
transaction count, UTXO created/destroyed, and axis legends.

The HUD stays on the **left** side. It keeps its own copy of the axis mapping,
synchronized each frame via `setCurrentEpoch()` and `setTotalBlocks()`; without
that sync, axis labels drift from the plotted data.

### Optional features

**`coinjoinFilter`** — renders only changes whose absolute amount matches a
known CoinJoin denomination (a fixed set in `Density.h`, powers of 2/3 and round
decimal values). Isolates coordinated-mixing structure.

**Audio synthesis** (`audioEnabled`) — writes raw mono float32 samples derived
from spending activity. Impulse/noise based: coin age selects one of
`NUM_BANDS = 5` bandpass filters, capped at `MAX_IMPULSES = 64` concurrent
events. `audioSamplesPerBlock` sets duration per block (800 ≈ 60 fps at 48 kHz).

---

## 4. Configuration

Parsed by `Cfg.cpp` into `struct Cfg`. One JSON file per render profile, in
`configs/`.

### Data and connection

| Key | Meaning |
|---|---|
| `bitcoinRpcUrl` | Base URL for Bitcoin Core **REST** routes (not JSON-RPC). |
| `blkFile` | Path to `changes.blk1` — output for `utxo_to_change`, input for `visualizer`. |
| `checkpointFile` | Checkpoint path; empty disables. |
| `checkpointIntervalBlocks` | Blocks between checkpoint writes; `0` disables. |
| `allowBlkFileTruncate` | **Data safety.** Default `false`. When false, `utxo_to_change` refuses to truncate an existing non-empty `blkFile`. Set `true` only to deliberately overwrite. |
| `utxoToChangeNumThreads` | Concurrent block fetch/parse workers. |
| `utxoToChangeNumResources` | Reusable HTTP/parser resources; ≥ thread count. |
| `connectionIpAddr`, `connectionSocket` | TCP target for raw frames (default `127.0.0.1:12987`). |

### Frame and range

| Key | Meaning |
|---|---|
| `imageWidth`, `imageHeight` | Output resolution; must match FFmpeg's `-video_size`. |
| `graphRect` | Plot area `[x, y, w, h]`. |
| `minSatoshi`, `maxSatoshi` | Y-axis bounds. |
| `startShowAtBlockHeight` | First block **emitted as a frame**. |
| `endShowAtBlockHeight` | Last block rendered; `0` = end of file. |
| `skipBlocks` | Emit only every Nth block. |
| `repeatLastBlockTimes` | Hold/fade frames appended at the end. |

> **Important:** `startShowAtBlockHeight` gates *frame emission only*. Density
> state is always accumulated from block 0, so a partial-range render is
> pixel-identical to the same frames in a full render.

---

## 5. Operations

### Execution location

**Node-local** — running on the Umbrel node, where Bitcoin Core is reachable over
loopback. **Strongly preferred** for `utxo_to_change`.

**Tunnel** — SSH port-forward from a workstation to the node's REST port.
*Unsuitable for bulk block fetching.* Measured: the same 13.8 MB block took
**0.156 s node-local vs ~21.8 s over the tunnel**. SSH forwarding multiplexes
every connection through one TCP session, so parallel workers serialize and
latency compounds. A wedged forward also leaves the process alive but the channel
dead, which `ServerAliveInterval` does not detect.

### BLK build strategies

**Full rebuild** — process from genesis. Slower, but produces correct creation
heights throughout. **Preferred for production data.**

**Checkpoint resume** — load `checkpoint.utxo` and continue. Much faster, but
see the creation-height caveat in §2. Requires the change file to end exactly at
the checkpoint height, or resume will duplicate or gap blocks.

### Render and remux

**Render** — `visualizer` streams raw RGB24 frames over TCP; FFmpeg listens and
encodes. One frame per rendered block.

Record to **MKV**, then remux to MP4. MKV tolerates interruption; an MP4 killed
before its trailer is written has **no `moov` atom and is unrecoverable**, even
at tens of gigabytes.

**Completion is verified by three signals**, not file size:

1. both processes exited,
2. FFmpeg logged its `Lsize=` summary,
3. `ffprobe` reads back a valid duration.

**Epoch rebasing** — when the chain crosses an epoch boundary, the X-axis
rescales and new renders no longer align with older ones. Differential renders
can only be appended within a single epoch.

---

## 6. Known pitfalls

**robin_hood map overflow.** Raw Bitcoin txid prefixes are not uniformly
distributed in the low bits robin_hood uses for bucket selection. Using the bytes
directly as a hash triggers a spurious `robin_hood::map overflow` once the table
passes roughly 76M entries — regardless of available RAM. Fixed by mixing through
`robin_hood::hash_int()` in `Utxo.h`, which allows the full 278M+ UTXO set to load.

**Silent spend skipping.** An earlier local edit replaced the "txid not found"
exception with a counter and `return`. That converts a loud failure into silently
incomplete change data. The throw is correct; keep it.

**Sequential bottleneck.** Block fetching parallelizes; UTXO integration does
not. Blocks must be applied in order, so one core saturates while others idle.

**Progress is transaction-bound, not block-bound.** Early blocks are nearly
empty. A "60% of blocks" reading can be under 30% of the real work; judge
progress by transaction count.

**Disk exhaustion.** A 4K/60fps full-chain render is tens of GB. Estimating from
early sparse blocks badly understates the total — measure against dense recent
blocks.
