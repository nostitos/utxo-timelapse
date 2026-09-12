# UTXO Timelapse vocabulary

Code identifiers are canonical. The [technical reference](https://nostitos.github.io/utxo-timelapse/technical.html) contains the complete setting table and tradeoffs; [operations](docs/README.md) covers commands.

## Chain and data

| Term | Meaning / source |
|---|---|
| Output / UTXO | A transaction output; an unspent transaction output remains available to be spent. An output is not a person, address balance or transaction. |
| Creation height | Block that created an output. The plotted horizontal coordinate and age calculations depend on preserving it. |
| Spend height | Block that consumed an output. The history sentinel `UINT32_MAX` means unspent at the dataset cutoff. |
| Data cutoff | Last block in the published edition, currently 966,360 (2026-09-10). Unspent status is relative to this cutoff. |
| `changes.blk1` | Sequential `BLK\x02` change records, produced by `utxo_to_change`. Framing: marker, block height, payload length, encoded block metadata and deltas. See [`BlockEncoder.h`](src/cpp/app/BlockEncoder.h). |
| Checkpoint v3 / `UTX3` | Node preprocessing state with creation heights, zero-value outputs, matching BLK byte length/tail offset/hash, and compact-prefix UTXO entries. Atomically written. Legacy formats are rejected; the old lost-creation-height caveat does not apply to v3. See [`Utxo.cpp`](src/cpp/app/Utxo.cpp). |
| `BUVHIST1` | Historical lifecycle table with a 64-byte offset-based header and 16-byte creation/spend/amount records. Section order can change after incremental updates. See [`UtxoHistory.h`](src/cpp/app/UtxoHistory.h). |
| Shard / spend patch | Cloud history slices indexed by Y row; later-spend changes reference stable record ordinals. They allow bounded R2 reads instead of loading the full history. |
| Outpoint | Transaction ID plus output index. The compact history does not retain full outpoints; candidate txid resolution may return multiple matches. |

## Image

| Term / identifier | Meaning |
|---|---|
| `graphRect` | `[x,y,width,height]` plotting rectangle inside the frame. Published: `[0,10,3720,2072]` within 3840×2160. |
| Pixel | An aggregate of outputs sharing a mapped creation-height column and amount row. Many outputs can occupy it. |
| Density / `Density::m_data` | Persistent double-precision sum at a pixel. With `amountWeightedDensity`, an output contributes `max(1, amount/5 BTC)`. This is not raw UTXO count. |
| Alive ledger | Surviving density grouped by creation height and Y row. Epoch changes rebuild the destination raster exactly from these contributions; merged contributions are **summed**, not averaged. |
| `DensityToImage` | Logarithmic density-to-palette transfer: `log(density+30)`, scaled from density 1 to `colorUpperValueLimit` (500 in the film). |
| `whiteHotTail` | Optional warm-white upper palette. `whiteHotTailMinSatoshi=1000000000` confines it to rows at or above 10 BTC. Lower rows retain base turbo. |
| `amountColorFloor` | Experimental amount-dependent colour minimum. Disabled in the published edition. |
| Flash / `PixelSetWithHistory` | Transient activity at touched creation coordinates. With amount weighting, emphasis uses actual BTC moved / 5 BTC, without a per-output minimum. Older activity can use larger marks and longer fades. |
| Flow lines | Orange marks from a rolling ten-block creation window, separated from the current column by 15 pixels. Drawn/restored without altering density. |
| HUD | Block metadata and labels drawn over the image; the HUD's mapper stays synchronized with the renderer. |

## Axes

| Identifier | Meaning |
|---|---|
| `linear` | Full-range linear block-height mapping. |
| `epochLog` | Geometric epoch widths. Also the current fallback for unknown mode strings. |
| `normalizedGeometric` | Reserve `epochRatio` for the newest epoch; older epochs share the remaining width geometrically once compression is needed. |
| `continuousLog` | Power-law time compression, with periodic resampling. Its legacy raster-resampling path differs from exact epoch-ledger rebuilding. |
| `epochBlocks` | Layout epoch length. The film uses 105,000 blocks; a Bitcoin subsidy-halving interval is 210,000. |
| `epochTransitionBlocks` | Smoothstep interpolation length at each boundary (120 blocks in the film). A value of zero gives an immediate cut. |
| `compressLowSatoshi` | Shrink the 1–100 satoshi band to one third of its ordinary logarithmic height. |
| `compressTopSatoshi` | Give 10k–100k BTC a thin band: 15% of one middle logarithmic decade. Values ≥100k BTC share the top row. |

X coordinates are clamped then truncated to integer pixels. Positions stay stable within an epoch after its slide. The public query mapper must reproduce this exact arithmetic; an educational schematic should not invent a different axis. See [`SatoshiBlockheightToPixel.h`](src/cpp/buv/SatoshiBlockheightToPixel.h) and [`mapping.js`](cloudflare/utxo-video-worker/src/mapping.js).

## Execution and delivery

- **Task:** a doctest case selected with `-tc=…`; production tasks are skipped unless `-ns` is supplied.
- **Node-local:** preprocessing beside Bitcoin Core's REST endpoint, avoiding a slow forwarded bulk data path.
- **Render:** replay change data and emit RGB24 frames through TCP. A late starting frame still requires reconstructing prior density; a node checkpoint is not a renderer checkpoint.
- **Encode:** compress RGB frames into a video codec. The published master uses HEVC 4:4:4 CRF 21. Lossy compression remains lossy even with full chroma resolution.
- **Remux:** change the container without re-encoding. Record long jobs to MKV, then remux to MP4 for delivery.
- **HLS:** a playlist plus independently cached fragmented MP4 segments. Current HLS packaging preserves the master HEVC stream.
- **Append:** preserve a verified encoded prefix and replace a short GOP overlap plus the new tail. Matching mapping, codec state, timestamps and source history must be checked, including epoch transitions.
- **Release descriptor:** one versioned selection of UI, video and history routing. UI-only releases can retain all video/history objects.
- **CoinJoin denomination filter:** an optional amount-pattern heuristic; neither output amounts nor visual patterns prove transaction intent.
- **Audio synthesis:** optional float32 mono spending impulses. Disabled in the published film.

## Correctness vocabulary

**Ledger consistency** means contributions and decrements match in the renderer. **History accuracy** means counts/amounts match the indexed source. **Pixel equality** means exact decoded image values. **Transaction identity** means a full outpoint. These are different claims and need different evidence.

Use the focused palette, epoch-transition and checkpoint tests; verify real frames, history queries and browser playback too. A process still running, a growing file or an empty test suite does not prove success. See the [release verification report](docs/video-update-2026-09-10.md).
