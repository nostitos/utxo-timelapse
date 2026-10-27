# UTXO Timelapse Landscape — implementation contract

This file is the shared contract for everyone building the 3D landscape explorer.
Owner: root agent. If a contract here is wrong or incomplete, message
`/root` before diverging; keep the code and this file consistent.

The approved plan is reproduced at the end ("Approved plan"). Where this file is
more specific, this file wins.

## 0. Ground rules

- Work in the current checkout. Never commit, push, deploy, or upload. Preserve all
  unrelated dirty work. Do not modify chain data, renders, checkpoints, the installed
  explorer under `~/.local/share/buv-explorer`, the Cloudflare Worker, R2, GitHub Pages
  or `site/`.
- Source data is read-only: `/Volumes/4T Data/buv_render/changes.blk1.full964k`
  (+ its `.idx` sidecar, which must NOT be rewritten), `utxo_history.bin`,
  `renderer_before_965400.bin`. Data output goes only to
  `/Volumes/4T Data/buv_render/landscape_966827/` (must be new/empty) or to dev
  datasets under `/tmp/landscape_dev*`.
- C++ development uses private build directories (`build_landscape/`,
  `build_explorer/`); `build_local/` is rebuilt once by root at integration.
- JavaScript: plain ES modules, no bundler, no npm runtime dependencies. Node 22 (`.nvmrc`;
  20 and 26 work too) for tests and the server. Tests live in `landscape/tests/*.test.mjs`
  and run with `node --test landscape/tests/*.test.mjs` (Node 22 and later reject a
  directory argument). Browser code must not import Node modules; shared
  pure modules (data/, replay/, settings) must not import three.js.
- three.js 0.186.0 is vendored (unmodified) in `landscape/web/vendor/three/`; add more
  addons only by copying unmodified files from `/tmp/three_probe/package/examples/jsm/`
  to the same relative path under `vendor/three/addons/`. Use `RenderPipeline`
  (`PostProcessing` is a deprecated alias in this version).
- Report measured facts. A running process, a growing file, or a passing synthetic test
  is not proof that the real path works.
- Browser verification: `~/.nvm/versions/node/v22.23.2/bin/node landscape/tools/browser-check.mjs --url URL [--wait-for EXPR] [--eval EXPR]... [--script FILE] [--screenshot PNG] [--width W --height H --dpr D] [--browser chrome|canary|brave] [--flag CHROME_FLAG]... [--fail-on-error]` 
  launches an isolated headless Chrome (own temp profile) and prints JSON with console
  messages, exceptions, failed requests, eval results and timings. Verified on this Mac:
  headless Chrome has WebGPU (Apple `metal-3` adapter with timestamp-query,
  shader-f16, subgroups, float32-filterable, float32-blendable; maxBufferSize and
  maxStorageBufferBindingSize 4 GiB; maxTextureDimension2D 16384;
  maxStorageBuffersPerShaderStage 10) and WebGL2 via ANGLE Metal on the M4 Max. Use it on
  every page you build and look at the screenshot (image viewer) before claiming a visual
  result. Node 20 has no global WebSocket, so use the Node 22 binary above for this tool.
- Dev servers and ports: js_replay 12991, render_terrain 12992, render_post 12993,
  ui_settings 12994, ui_shell 12995, root 12990 and 12996–12998, second explorer 12989.
  Use `node landscape/tools/serve.mjs --port N --data DIR` once js_replay announces it;
  until then `python3 -m http.server N --bind 127.0.0.1` from `landscape/web` works for pages
  that do not need Range requests. Stop your servers when you finish.
- Dev dataset: cpp_data builds `/tmp/landscape_dev` (same format, shorter range via
  `-end=`) early and announces its block range; the full dataset follows in
  `/Volumes/4T Data/buv_render/landscape_966827/`.
- Vendor additions: any agent may copy further unmodified three.js files from
  `/tmp/three_probe/package/examples/jsm/` to the same relative path under
  `landscape/web/vendor/three/addons/` (never edit vendored files); list the additions in
  your final report.

- Online deployment (https://3d.bitcointimelapse.com/): the Worker in `cloudflare/utxo-landscape-worker/`
  serves `landscape/web/` (minus `dev/`), the dataset from R2 at `/dataset/<id>/` and the cell API at
  `/api/landscape/cell` (same JSON as §5's native endpoint, from the 2D explorer's history shards). The app
  decides online versus local in `landscape/web/ui/online.js`: online it reads `/dataset/index.json` for the
  current dataset URL, calls the cell API on its own origin, links the 2D view to
  `https://bitcointimelapse.com/explorer` and starts a first visit at Balanced (Performance on WebGL2,
  touch-only or low-memory devices) with auto resolution scaling. Local behaviour is unchanged. Changing the
  inline import map in `index.html` requires the new CSP hash in the Worker's `release.js`
  (`node landscape/tools/csp-hash.mjs --check`).

## 1. File ownership

| Path | Owner |
|---|---|
| `landscape/SPEC.md`, `landscape/web/vendor/`, `landscape/tools/browser-check.mjs` | root |
| `src/cpp/app/Landscape.h`, `src/cpp/app/Landscape.cpp`, `src/cpp/app/landscape_tasks.cpp` (doctest tasks; a separate `landscape.cpp` would collide with `Landscape.cpp` on case-insensitive APFS), `src/cpp/CMakeLists.txt` (adding these sources only) | cpp_data |
| `src/cpp/app/utxo_explorer.cpp` | cpp_explorer |
| `landscape/tools/serve.mjs`, `landscape/web/data/*`, `landscape/web/replay/*`, `landscape/web/replay.worker.js`, `landscape/web/client/*` | js_replay |
| `landscape/web/render/terrain/*` | render_terrain |
| `landscape/web/render/context.js`, `render/index.js`, `render/env.js`, `render/post.js`, `render/post-plan.js`, `render/cube-lut.js`, `render/overlay.js`, `render/scale.js`, `render/stub-terrain.js` (dev only), `landscape/tools/gpu-util.mjs` | render_post |
| `landscape/web/settings.schema.js`, `landscape/web/settings.js`, `landscape/web/ui/panel.js` | ui_settings |
| `landscape/web/index.html`, `app.css`, `main.js`, `landscape/web/ui/*` (except panel.js), `landscape/web/fonts/` | ui_shell |
| `landscape/web/dev/<owner>-*.html` | each owner's own dev harness pages |
| `landscape/tests/<area>.test.mjs` | the owner of that area |
| `docs/landscape.md`, glossary/doc rows | docs (later) |

## 2. Grid and coordinates

Constants (all derived from `manifest.json`; never hard-code the tip):

- `numBlocks = 966828`, tip `966827`. `BLOCKS_PER_COL = 64`, `ROWS = 2072`,
  `L0_COLS = ceil(numBlocks / 64) = 15107`, `TILE = 256`, `LEVELS = 7`.
- Level `l` (0..6): `colShift = l`, `rowShift = min(l, 4)`,
  `cols_l = ceil(L0_COLS / 2^l)`, `rows_l = ceil(ROWS / 2^rowShift)`,
  `tilesX_l = ceil(cols_l / 256)`, `tilesY_l = ceil(rows_l / 256)`.

| l | cols | rows | tilesX × tilesY | first tile id |
|---|---:|---:|---:|---:|
| 0 | 15107 | 2072 | 60 × 9 | 0 |
| 1 | 7554 | 1036 | 30 × 5 | 540 |
| 2 | 3777 | 518 | 15 × 3 | 690 |
| 3 | 1889 | 259 | 8 × 2 | 735 |
| 4 | 945 | 130 | 4 × 1 | 751 |
| 5 | 473 | 130 | 2 × 1 | 755 |
| 6 | 237 | 130 | 1 × 1 | 757 |

758 tiles in total. Tile id = `firstTile[l] + ty * tilesX_l + tx` (levels ascending,
row-major within a level). Within a tile, local index = `localRow * 256 + localCol`.

- A change for an output created at height `h` with amount `a` lands in L0 cell
  `(c0, r0) = (floor(h / 64), row(a))`; at level `l` the cell is
  `(c0 >> l, r0 >> rowShift_l)`.
- `row(a)` is the film's graph-local row (0 = top = largest amounts, 2071 = 1 sat):
  `SatoshiBlockheightToPixel::satoshiToPixelHeight(a) - graphRect.y` with the published
  film axis (graphRect `[0,10,3720,2072]`, minSatoshi 1, maxSatoshi 1e13,
  compressLowSatoshi and compressTopSatoshi true). The C++ tools refuse any other axis.
- Tile hierarchy: children of `(l, tx, ty)` at level `l-1` are columns `2tx, 2tx+1`
  and rows `2ty, 2ty+1` when `rowShift_{l-1} < rowShift_l` (l ≤ 4), otherwise row
  `ty` only; children outside the grid do not exist.
- Area of a level-`l` cell = number of L0 cells it covers inside the grid:
  `min(2^l, L0_COLS - c*2^l) * min(2^rowShift, ROWS - r*2^rowShift)`.
- World space (three.js, y up): `x = block / 1000` (L0 column `c` spans
  `[c*0.064, (c+1)*0.064)`), `z = row / 10` (row `r` spans `[r*0.1, (r+1)*0.1)`;
  large amounts are at small z, i.e. farthest from the default camera, which sits at
  positive z looking toward -z). The full landscape spans x ∈ [0, 966.848), z ∈ [0, 207.2).
  Heights are produced by the height curve (§6).

## 3. Exact state and measures

Per cell, four exact integers: `countSmall`, `countLarge`, `satsSmall`, `satsLarge`.
Small means `1 ≤ a ≤ 500000000` (exactly 5 BTC is small); large means `a > 500000000`.

Applying one change `(satoshi s, creation height h)`: if `s == 0` skip it entirely
(as the renderer does). Otherwise `sign = s > 0 ? +1 : -1`, `a = |s|`; add `sign` to the
cell's count of its class and `sign * a` to its sats. Undoing a block applies all of
that block's changes with the opposite sign. State "at block B" means blocks 0..B are
applied (same moment as the film frame for block B). Counts never go negative at a block
boundary; inside a block they may transiently (create-and-spend in one block).

Measures (raw, per cell):
- `density = countSmall + satsLarge / 5e8` (the film's amount-weighted density)
- `count = countSmall + countLarge`
- `value = (satsSmall + satsLarge) / 1e8` (BTC)

Displayed values are normalised by cell area (§2): `v = measure / area`, so L0 values
are the raw measure and coarser levels show the mean per L0 cell.

Activity heat (worker only, forward playback only): each spend (`s < 0`) adds
`|s| / 1e8` BTC to its cell's heat at every resident level. Heat is stored as
`(heat, heatBlock)` and decays with half-life `H` blocks:
on add at block `b`: `heat = heat * 2^(-(b - heatBlock)/H) + add; heatBlock = b`.
Seeks and backward steps clear all heat. Packed heat is the cell's raw BTC sum (not divided
by area, so activity stays visible at coarse levels). The GPU draws a spend flash of brightness
`gain * (floor + (1 - floor) * clamp(ln(1 + heat/1e-4) / ln(1 + reference/1e-4), 0, 1)) * 2^(-(B - heatBlock)/H)`
(`color.heatGain`, `amp.heatFloor`, `amp.heatReference`, `amp.heatHalfLife`): every spend reaches at least the
floor at its block, as every spent output flashes in the film; more BTC moved is brighter.
Coins created within `amp.heatEdgeBlocks` of the current block flash at `amp.heatEdge` of that brightness
(ramping to full beyond it), like the film's small creation-edge flashes.

## 4. Data directory (`landscape_966827/`)

All integers little-endian. Written by `landscape_build`; `manifest.json` last
(atomic rename) so its presence means the build completed.

```
manifest.json
rows.bin                 2072 × float64: minAmt[r] = smallest integer amount a ≥ 1 with row(a) ≤ r
blocktimes.bin           numBlocks × u32: block timestamp (BUVHIST1 blockTimes, via header offsets)
chunks.json              chunk table
chunks/00000.bin …       exact copies of consecutive BLK2 records, block-aligned, ≤ 4 MiB each
snapshots/0000000.bin …  BUVLSN1 snapshots, file name = 7-digit block height
```

Row lookup: `row(a) = min { r : a ≥ minAmt[r] }` (`minAmt` is non-increasing in r;
`minAmt[2071] = 1`; empty rows repeat the previous value). Use binary search, or the
film formula as a first guess corrected against the table. Never rely on `Math.log`
alone for exactness.

### manifest.json
```json
{
  "format": "utxo-landscape-1",
  "createdUtc": "…",
  "numBlocks": 966828, "tip": 966827, "tipTime": 0,
  "grid": {"blocksPerColumn": 64, "rows": 2072, "l0Columns": 15107, "tileSize": 256,
           "border": 1, "tiles": 758,
           "levels": [{"level": 0, "columnShift": 0, "rowShift": 0, "columns": 15107,
                       "rows": 2072, "tilesX": 60, "tilesY": 9, "firstTile": 0}]},
  "axis": {"graphRect": [0,10,3720,2072], "minSatoshi": 1, "maxSatoshi": 10000000000000,
           "compressLowSatoshi": true, "compressTopSatoshi": true,
           "whiteHotTailMinSatoshi": 1000000000, "epochBlocks": 105000,
           "epochRatio": 0.5, "epochTransitionBlocks": 120},
  "weightThresholdSatoshi": 500000000,
  "files": {"rows": "rows.bin", "blocktimes": "blocktimes.bin", "chunks": "chunks.json"},
  "chunkBytesTarget": 4194304,
  "snapshotIntervalBytes": 16777216,
  "snapshots": [{"block": 0, "file": "snapshots/0000000.bin", "bytes": 0,
                 "sha256": "… (whole file)", "blkEnd": 0}],
  "source": {"blk": "…", "blkBytes": 0, "history": "…",
             "historyNumBlocks": 0, "historyNumRecords": 0},
  "build": {"seconds": 0, "snapshotBytes": 0, "chunkBytes": 0}
}
```
`blkEnd` = source BLK byte offset just past the last applied block (= start of block
`block + 1`). Snapshots exist after block 0, then whenever at least
`snapshotIntervalBytes` of BLK data has been applied since the previous snapshot, and
after the tip.

### chunks.json
`{"format": "utxo-landscape-chunks-1", "chunks": [{"index": 0, "file": "chunks/00000.bin",
"firstBlock": 0, "lastBlock": 0, "blkOffset": 0, "bytes": 0, "sha256": "…"}]}`.
A chunk holds whole consecutive blocks; a single block larger than the target gets its
own chunk.

### BLK2 record (inside chunks; same as the source)
`"BLK\x02"` (u32 0x024b4c42), u32 height, u32 payloadBytes, payload. Payload: 32+32+32
bytes hash/merkle/chainwork, 8 bytes difficulty, u32 version, u32 time, u32 medianTime,
u32 nonce, 4 bytes bits (124 bytes), then varuint nTx, size, strippedSize, weight; then
changes: first `zigzag-varint satoshi`, `varuint blockHeight` (this first entry uses that
height whatever its sign); then until payload end: `satoshi += varuint`; if
`satoshi <= 0` then `blockHeight += zigzag-varint` and emit (satoshi, blockHeight),
else emit (satoshi, record height). Mirror `ChangesInBlock::decode` exactly.
varuint = unsigned LEB128; zigzag: `(z >>> 1) ^ -(z & 1)` done arithmetically
(values exceed 2^32; use Number arithmetic, never 32-bit bitwise ops on them).

### Snapshot BUVLSN1 (`snapshots/NNNNNNN.bin`)
```
0    char[8]  "BUVLSN1\0"
8    u32      version = 1
12   u32      headerBytes = 128
16   u32      block           state after blocks 0..block
20   u32      numBlocks       of the snapshot's own grid: block + 1 (see below)
24   u32      levels = 7
28   u32      tileSize = 256
32   u32      rows = 2072
36   u32      l0Columns       ceil(numBlocks / 64)
40   u32      blocksPerColumn = 64
44   u32      tiles           of gridFromManifest({numBlocks})
48   u64      blkEnd
56   i64      totalCountSmall
64   i64      totalCountLarge
72   i64      totalSatsSmall
80   i64      totalSatsLarge
88   u8[32]   SHA-256 of bytes [128, EOF)
120  u8[8]    zero
128  directory: tiles × {u64 offset (absolute), u32 bytes, u32 crc32 (IEEE) of the blob}
     empty tile: offset 0, bytes 0, crc 0
…    tile blobs
```
A snapshot describes its own grid, the grid of blocks 0..block, so the same block encodes to
the same bytes in every dataset that contains it and a new dataset copies earlier snapshots
unchanged. Its tile ids follow that grid: a tile keeps its level and position (tx, ty) in
any larger grid, where the tiles beyond the snapshot are empty, so readers map tiles by
(level, tx, ty). Readers accept any numBlocks in [block + 1, dataset numBlocks] whose
l0Columns and tiles match: snapshots written before October 9, 2026 record their dataset's
numBlocks (966,828 or 970,659) and stay valid. A reader that fetches the directory first
needs at most the dataset's prefix (128 + 16 × dataset tiles bytes), capped at the file size.
Tile blob: occupied cells (count > 0) in ascending local index, each encoded as
`varuint gap` (local index − (previous index + 1); first cell: its index),
`varuint (countSmall * 2 + (countLarge > 0 ? 1 : 0))`, then `varuint satsSmall` if
countSmall > 0, then `varuint countLarge, varuint satsLarge` if countLarge > 0.
Every level is stored in full (coarse levels are exact sums of L0). Totals equal the sum
of any level.

## 5. Worker and client protocol

### 5.0 Shared pure modules (owner js_replay, delivered first)

Pure ES modules with no three.js and no DOM, used by the worker, terrain and the shell.
js_replay writes them before anything else and announces them; consumers import them
instead of re-deriving grid or axis math.

`landscape/web/data/grid.js`:
```js
export function gridFromManifest(manifest)  // → grid {numBlocks, tip, blocksPerColumn, rows, l0Columns,
                                            //   tileSize, border, tiles, levels:[{level, columnShift, rowShift,
                                            //   columns, rows, tilesX, tilesY, firstTile}]}
export function tileId(grid, level, tx, ty)
export function tileInfo(grid, id)          // → {id, level, tx, ty, col0, row0, cols, rows} (cells at that level)
export function tileOfCell(grid, level, col, row)  // → tile id
export function cellArea(grid, level, col, row)    // L0 cells covered inside the grid
export function cellOfL0(grid, level, c0, r0)      // → {col, row} at that level
export function childTiles(grid, id)        // → ids at level-1 (empty for L0)
export function parentTile(grid, id)        // → id at level+1 (null for L6)
export function columnBlocks(grid, col)     // L0 column → [firstBlock, lastBlock]
export function worldX(block), worldZ(row), blockFromWorldX(x), rowFromWorldZ(z)  // x = block/1000, z = row/10
```

`landscape/web/data/axis.js`:
```js
export function rowOfAmount(minAmt, sats)   // exact graph row 0..2071 from rows.bin (binary search)
export function rowAmountRange(minAmt, row) // → {min, max} satoshis covered by the row, or null if empty
export function filmRowEstimate(sats, axis) // film formula (float), for tests and first guesses
export function blockToX(height, block, axis)  // port of cloudflare/utxo-video-worker/src/mapping.js (2D link)
```


`landscape/web/replay.worker.js` (module worker) owns all exact state. The main thread
talks to it only through `landscape/web/client/replay-client.js`:

```js
const replay = await createReplayClient({ dataUrl: '/dataset/', maxResidentTiles: 225, chunkCacheMB: 512 });
replay.manifest; replay.rows /* Float64Array minAmt */; replay.blocktimes /* Uint32Array */;
replay.block            // exact block of the delivered state, or null before the first seek
replay.busy             // true while a seek/tile load is in progress
replay.setTiles(ids)    // desired residency, priority order; L6 (id 757) is always kept
replay.setMeasures({height, color})   // each 'density' | 'count' | 'value'
replay.setHeatHalfLife(blocks)
replay.setMaxResidentTiles(n)
await replay.seek(block)              // → {block, ms, plan}; latest seek wins; superseded promises resolve {cancelled: true}
await replay.advance(target, {budgetMs: 10})  // exact replay toward target, either direction;
                                      // resolves {block, reached, blocks, ms}; one in flight
await replay.cell(level, col, row, {load} = {})  // raw (not area-normalised) {countSmall, countLarge, satsSmall,
                                      // satsLarge, heat (decayed to the current block)}; loads a non-resident tile on
                                      // demand (≤ 4 pinned) unless {load: false}, which returns null instead
replay.onFrame(cb); replay.onStatus(cb); replay.onError(cb)
replay.meta             // {block, time, nTx, size, created, spent, totals:{countSmall,countLarge,satsSmall,satsLarge}}
replay.snapshotBlocks   // sorted snapshot block heights (for scrubbing and seek planning)
replay.grid; replay.status; replay.stats; replay.setChunkCacheMB(mb)
// onFrame/onStatus/onError return unsubscribe functions; the top tile is grid.tiles - 1 (757 on the full grid)
replay.dispose()
```

Frame delivered to `onFrame` (buffers are transferred):
```js
{
  seq, block, reason: 'seek' | 'advance' | 'tiles' | 'measure', partial: false,
  full: [{ id, level, tx, ty, empty: false, data: Float32Array(258*258*4), counts: Uint32Array(258*258) }],
  deltas: { ids: Uint32Array(k), offsets: Uint32Array(k + 1),
            index: Uint32Array(n) /* slot-local 0..258*258-1 */, data: Float32Array(n * 4), counts: Uint32Array(n) },
  evicted: [ids],
  stats: { blocksApplied, changesApplied, ms, blocksPerSecond, residentTiles, pendingTiles, chunkCacheBytes },
  meta: { … as replay.meta }
}
```
Slot layout: 258 × 258 cells, row-major, cell `(lx, ly)` of the tile at index
`(ly + 1) * 258 + (lx + 1)`; the one-cell border holds the same-level neighbour's cells
when that neighbour is resident, else a copy of the nearest interior cell; cells outside
the grid are 0. Four floats per cell:
`[heightValue, heat, heatBlock, colorValue]` (height and colour values divided by area; heat is the raw sum).
`counts` carries the raw `countSmall + countLarge` at each matching slot/delta index,
independent of the height/colour measures and never divided by area. It stays uint32 through
transfer and GPU storage. `empty: true` tiles carry `data: null, counts: null`. Deltas include
border copies in neighbours. A tile is sent in full when it is newly delivered or when more than
16,384 distinct cells changed since the last frame (`DIRTY_CAP`); each slot lists a changed cell
once per frame (a bitmap of 65,536 bits), so the thousands of changes a busy block makes to the
same coarse cells stay deltas instead of a full 1 MB resend of every coarse tile. WebGPU columns split their sides into exactly N equal-height
layers for N current UTXOs, drawing only the N-1 internal boundaries. The cap stays plain;
1 UTXO has no internal line. The lines fade when a layer falls below 2–5 screen pixels,
without substituting fewer layers. Playback, rewind, measure changes and tile reloads update
the count buffer together with the existing four-float buffer. The GPU count plane adds
about 0.25 MiB per resident WebGPU tile; WebGL2 keeps its existing four-float texture.

Policies: a seek loads coarse tiles (L4–L6) first and emits a `partial: true` frame, then
the rest. Seek planning picks the cheapest of: current resident state, nearest snapshot
at or below the target (forward replay), nearest snapshot above (backward replay).
Tiles that become resident during playback load from a snapshot and replay to the current
block before their first full frame. Chunk bytes are cached (LRU, `chunkCacheMB`) with
read-ahead in the playback direction: 2 chunks around seeks, 8 (32 MiB) during forward
playback, at most 3 fetches in flight. The chunk store meters delivery (bytes per second of
time with a fetch in flight, including verification) and the worker reports `buffer`
{frontier, blocksPerSec} with every advance, seek and chunk load: the last block of the
cached run of chunks ahead of the state block, and the blocks per second the download
delivers for the chunks after it. Worker memory budget ≤ 1.5 GB.

Playback (implemented by ui_shell on top of the client): 1× = 60 blocks/s exact; 2× = 120
blocks/s exact; 5× = 300, 10× = 600 and 20× = 1,200 blocks/s exact. The HUD shows the achieved rate when the worker cannot
keep up; Max = exact advance with the whole frame budget. When the download is slower than
the playback speed (Max online; any speed on a slow connection) playback is paced to it:
0.7 × the download rate plus the downloaded blocks ahead spread over 3 s, eased over 0.5 s,
and never past the downloaded frontier, so it settles at the download rate with about 0.9 s
of blocks in hand and moves every frame instead of racing through each chunk and then
waiting for the next; the HUD says "download-limited". Every speed replays every block;
only scrubbing seeks to snapshots: the nearest snapshot at/below the scrub position while
dragging, then an exact seek on release. `[`/`]` step 1 block, Shift+`[`/`]` step 1,008
(via seek).

Local server: `node landscape/tools/serve.mjs --data "/Volumes/4T Data/buv_render/landscape_966827"
[--port 12990] [--host 127.0.0.1]` serves `landscape/web/` at `/` and the data
directory at `/dataset/` (not `/data/`, which is the app's module directory `landscape/web/data/`), with single-range `Range` support, HEAD, correct MIME types,
path-traversal protection, `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, immutable caching for `/dataset/` binaries and
`no-cache` for app files.

Cell inspection API (native explorer, port 12989):
`GET http://127.0.0.1:12989/api/landscape/cell?block=B&col=C&row=R` (L0 column and
graph row) returns the same JSON fields as `/api/pixel` for heights
`[C*64, min(C*64+63, numBlocks-1)]` (scan stops at B) and the satoshi range of row R,
plus `"col"` and `"row"`. CORS allows exactly `http://127.0.0.1:P` and `http://localhost:P`
for P = 12990–12998 (the app port plus the dev ports; loopback only, no wildcard). The explorer gains `-port=` to override `explorerPort`.
Run: `./build_local/buv -ns -tc=utxo_explorer -cfg=configs/buv_explorer.json -port=12989`
from the repository root. Link to the 2D explorer as
`http://127.0.0.1:12989/?block=B&x=X&y=Y` with `X = blockToX(midHeight, B)` (port of
`cloudflare/utxo-video-worker/src/mapping.js`) and `Y = row + 10`.

## 6. Rendering contract

Render modules use `three/webgpu` + `three/tsl` (import map in index.html):
`three` and `three/webgpu` → `vendor/three/three.webgpu.js`, `three/tsl` →
`vendor/three/three.tsl.js`, `three/addons/` → `vendor/three/addons/`.

`render/index.js` (render_post) exports:
```js
const caps = await probeCapabilities({ forceWebGL });   // before the view: lets the store cap presets
const view = await createLandscapeView({ canvas, settings, manifest, rows, blocktimes,
  forceWebGL, labelsElement, overlayElement });
view.backend            // 'webgpu' | 'webgl2'
view.capabilities       // {compute, timestamp, maxTileBudget, limits}
view.renderer; view.scene; view.camera   // PerspectiveCamera owned here, moved by ui controls
view.setBlock(block)    // exact block of the delivered state (uniforms: now plane, heat decay, edge glow)
view.applyFrame(frame)  // forwards worker frames to the terrain atlas
view.update(dt)         // per frame before render; returns {desiredTiles: number[] | null}
view.render()           // full pipeline
view.resize()
view.pick(clientX, clientY) // {x, y, z, level, col, row, l0Col, l0Row, value, colorValue, heat} | null
view.heightAt(x, z)
view.focusDistance()    // terrain distance at screen centre (DOF autofocus, flight)
view.stats              // {fps, cpuMs, gpuMs, gpuPasses, triangles, instances, tiles, resident, scale, width, height}
view.setAnimationLoop(fn) // optional; a plain rAF loop in main.js also works (three's loop starts at init)
view.dispose()
```

`render/terrain/index.js` (render_terrain) exports `createTerrain({ renderer, scene,
camera, settings, manifest, rows, blocktimes, capabilities, labelsElement })` returning
`{ object3d, applyFrame, setBlock, update(camera, viewportHeightPx) → desiredTiles|null,
pick(ray) → hit|null, heightAt(x,z), focusDistance(camera), stats, dispose }`.
Terrain owns: GPU tile atlas (storage buffer on WebGPU, texture on WebGL2), page table,
LOD selection (always drawing the deepest fully resident level so there are no holes or
overlaps; L6 is always resident), heightfield mesh with skirts, stepped cells (everywhere, or
on the whale rows only, at least 1.5 px wide far away: `geo.steppedWhales`),
smoothing, subdivision, instanced columns, palette LUTs and colour transfer, heat
emissive and flash sprites, creation-edge glow, now plane, grid, axis labels
(HTML positioned by projection into `labelsElement`), CPU tile copies for picking.
Terrain materials are NodeMaterials (`MeshStandardNodeMaterial`) so lights, shadows
and the MRT outputs used by AO/SSGI/SSR/TRAA/motion blur work. Transparent quads (flash
sprites, the now plane) write zero alpha to exactly the G-buffer attachments the scene pass
has (`render/post.js` reports them to `setGBufferLayout` in `render/gbuffer.js`) and the scene pass
alpha-blends them, so a sprite's rectangle never lands in the normal, roughness or velocity
buffers (it used to: SSR drew a square around every flash). Outputs for attachments the pass
lacks broke rendering: no G-buffer left an empty output struct (the now plane never compiled
at Performance), and, because three r186 keys a pipeline by shader code plus the first colour
format, identical zero outputs reused a pipeline across layouts and blacked out the frame
(Extreme with motion blur off). Each output therefore writes its own constant (alpha 0).
SSGI is left out while depth of field is on (`render/post-plan.js`): the two together froze
the page (WebGPU, Chrome 155, Apple M4 Max, 2026-10-13); the cause is open.

Height curve (on the area-normalised value `v`, with `e = amp.exposure`,
`R = amp.reference`): log: `log(1 + e*v) / log(1 + e*R)`; power:
`(e*v / (e*R))^amp.exponent`; linear: `e*v / (e*R)`. Height =
`amp.exaggeration * curve`, times the whale factor, plus `amp.floor` for occupied cells;
empty cells have height 0. The whale factor is `amp.whale` on rows at/above the white-hot
row `W` and eases back to 1 across the rows down to `E = row(color.whiteHotBTC / 10 × 1e8)`
(one decade of amounts, `WHALE_RAMP_DECADES`): `1 + (amp.whale − 1) · s(t)` with
`t = clamp((E − row) / (E − W), 0, 1)` and `s(t) = t²(3 − 2t)`, so the taller rows have
no cliff at the threshold (`curve.js` `whaleFactorCpu`; the shader mirrors it).

Colour transfer (on the colour value `v`): `v ≤ 0` → `color.ground`; otherwise
`t = clamp((ln(v + o) − ln(1 + o)) / (ln(U + o) − ln(1 + o)), 0, 1)^color.gamma`, palette
index `floor(255 t)` (`o = color.offset`, `U = color.upper`). With the BitcoinTimelapse.com look
(`o = 30`, `U = 500`, gamma 1, palette `film` with the whale palette on rows at/above
`row(color.whiteHotBTC × 1e8)`), the index equals `DensityToImage`'s exactly.
Palettes: `film` = `site/assets/palettes.json` `base`, whale variant = `whale`; `earth` is
a gradient (`GRADIENT_PALETTES` in `palette.js`) from sand through brown earth to green.

render_post owns everything else in the frame: renderer creation (WebGPU with raised
`requiredLimits` and `trackTimestamp` when available; `forceWebGL` / missing
`navigator.gpu` → WebGL2 backend, compute features off, presets capped at High), sun +
cascaded shadows (CSMShadowNode), hemisphere ambient, sky, stars, fog, volumetric
scattering (half-resolution ray march with a fixed per-pixel dither, blurred with a small
gaussian before compositing; a per-frame dither sparkled during motion), god rays, the
RenderPipeline chain (AO → SSGI → SSR → volumetrics/god rays →
bloom → DOF → motion blur → tone mapping → exposure → grade → LUT → grain/CA/vignette →
AA/SSAA), resolution scale and auto scale, Display P3, perf overlay, GPU timing.

## 7. Settings

`settings.schema.js` exports `SCHEMA` (array of entries) and the presets. Entry:
`{ id, group, label, type: 'number'|'int'|'bool'|'enum'|'color'|'gradient'|'file',
min, max, step, scale: 'linear'|'log', options, default, webgpu: bool, rebuild:
'none'|'material'|'terrain'|'post'|'shadows'|'renderer'|'worker', url: bool, help }`.
Extra entry fields (documented in the schema header): `section`, `optionLabels`, `unit`,
`logMin`, `webgpuOptions`/`fallback`, `capMax` (capped by `view.capabilities.maxTileBudget` /
`maxInstances`), `maxStops`, `accept`, `preset: false` (personal preferences that looks and quality
never change), `needs` (conditions under which the setting changes the image, from `NEEDS`:
`[{id, is | ne | gt | notNull}]` must all hold, `{any: [...]}` holds when one does; only the
panel reads it).

Presets have two axes. `LOOK_PRESETS` (`LOOKS`: Landscape, BitcoinTimelapse.com, Daylight, Golden
hour, Earth, Whales, Pulse, Outputs, Money map, Linear, Paper; `LOOK_INFO`) set the
appearance; `QUALITY_PRESETS` (`QUALITY_ORDER`:
Performance, Balanced, High, Ultra, Extreme; `QUALITY_INFO`) set the cost. Both are partial
`{id: value}` maps; a setting's base value is the look's value, else the quality tier's, else
`default`. Landscape and High are empty (the schema defaults); startup is Landscape at High,
and on WebGL2 quality stops at High. `PRESETS` merges both maps. Looks are built from value
bundles shared with the quick settings (`TIME_OF_DAY`, `SKY`, `HAZE`, `SHADOWS`, `GLOW`, `BIG_COINS`,
`CELL_SHAPES`, `FLASHES`, `FLASH_TRAIL`), so each built-in look reads as one option in every quick
control (BitcoinTimelapse.com's time of day aside: it turns the sun off). `LOOK_ALIASES` maps
earlier look names to current ones (`Film` → `BitcoinTimelapse.com`, and the removed
`Neon night` → `Pulse`): the store accepts them
wherever a look is named (`setLook`, `applyPreset`, `baseValues`, JSON, URLs, stored settings and
saved looks), writes only the current name, and reserves them as saved-look names.

`settings.js` exports `createSettingsStore(schema, presets, {capabilities, storage})`:
`get(id)`, `set(id, v)`, `setMany(obj)`, `subscribe(filter, fn)` (filter: id, group
name, or `'*'`; fn receives `[{id, value, previous, entry}]` batched per microtask),
`setLook(name)` (built-in or saved look; every look and quality setting to its base value,
dropping changes made by hand), `setQuality(name)` (settings still at the old base value move to the
new one; changed settings stay), `applyPreset(name)` (either, by name), `reset(group?)`, `look`,
`quality`, `baseLook`, `modified`, `preset` (display label: `'Custom'` when modified, the quality for
Landscape, else `'Look · Quality'`), `overrides()`, `baseValues(look?, quality?)`, `inert(id)` and
`checkNeeds(needs)` (null, or `{text}` such as 'Bloom off' naming the root cause),
`toJSON()` (`{format, quality, look, baseLook, values, preset: quality}`), `fromJSON()`, `toURL()`
(`preset=<quality>`, `look=<built-in look>` unless Landscape, then the url settings that differ),
`fromURL()` (a pre-look `preset=Film` opens BitcoinTimelapse.com at High), `canonicalLook(name)`,
`load()`/`save()`
(localStorage key `utxo-landscape-settings-v1`). Saved looks: `saveUserPreset(name)`,
`deleteUserPreset(name)`, `restoreUserPreset(record, {activate})`, `userPresets`, `userPreset(name)`
in localStorage key `utxo-landscape-presets-v1` (`{format: 'utxo-landscape-presets-1', presets: [{name,
savedAt, look, quality, overrides}]}`; up to 50; names 1–40 characters, unique in any case, not a
built-in or quality name or Custom). A record keeps its built-in look, its quality and the
governed values that differ from them. Values are validated and clamped.

`settings.quick.js` exports `QUICK`, the quick controls in five sections, ordered Look, Data,
Performance, Scene, View. Data is immediately after Look and Quality and exposes Height shows,
Height scale (Linear/Logarithmic/Power), the exact Reference value, Height size, Minimum height
and the active Log exposure or Power exponent. Its visible note explains compression and the
reference-to-height mapping. Numeric fields bind directly to schema values; irrelevant curve
parameters are hidden. The legend names the active scale, maps reference to height without a
multiplier, and its Edit height scale link opens/focuses the main controls.
Performance contains Now, Every distance, Uniform detail, Resolution, Column distance,
Column cap, Far columns, Far shadows, Terrain detail and Loaded tiles. The remaining controls
cover Time of day, Sky, Haze, Shadows, Glow, Colours, Big coins, Cell shape, Flashes, Flash trail,
Field of view and Show. Pure helpers include `quickOption`, `quickState`, `quickPatch`,
`quickIds`, `blendPatch`, `blendPosition`, `blendValue` and `blendIndex`. Choice,
toggle and blend controls write a bundle (`set`) and recognise their option by a subset of it
(`match`); none matching means set by hand. A blend control is a slider across its options:
between two stops numbers interpolate (`log` ids in log space), colours mix in sRGB, a boolean
is true if either stop has it, and a stop's `blendAs` gives values it blends from without
writing them; `blendPosition` finds the point the current values lie on, or null. Time of
day maps its stops to clock hours (`at`). Column distance and Terrain detail bind
`geo.columnPixels` and `geo.pixelsPerCell` on inverted log sliders. Tiles under the column
disc always refine to level 0 (`selectTiles` option `mustRefine`), so columns appear wherever
Column distance reaches. A tile desired in the previous selection stays visible while its box at
the assumed height of unloaded tiles is (`previousDesired`): a tile assumed tall until it loads,
then culled by its real height, would otherwise be requested and dropped on alternate frames
while Follow tip moves the camera. `ui/quick.js` draws them at the top of the panel,
with Save… and Delete for saved looks; the schema's settings sit in the panel's closed
Advanced folder, dimmed while their `needs` fail.

Required ids (consumers must use exactly these; ranges/defaults may be refined by
ui_settings with the consumers):

- Colour: `color.palette` (film, turbo, viridis, inferno, magma, plasma, cividis, earth,
  grey, custom), `color.gradient` (≤16 stops `{t, color}`), `color.reverse`,
  `color.measure` (height, density, count, value), `color.offset` (30),
  `color.upper` (500), `color.gamma` (1), `color.whiteHot` (true),
  `color.whiteHotBTC` (10), `color.background`, `color.ground`, `color.fog`,
  `color.heat`, `color.heatGain`, `color.hueShift`, `color.saturation`,
  `color.contrast`, `color.temperature`, `color.tint`, `color.lift`,
  `color.liftColor`, `color.gradeGamma`, `color.gain`, `color.gainColor`,
  `color.toneMapping` (none, linear, reinhard, aces, agx, neutral),
  `color.exposureMode` (manual, auto), `color.exposure`, `color.autoExposureMin`,
  `color.autoExposureMax`, `color.autoExposureSpeed`, `color.lut` (file, not in URL),
  `color.lutIntensity`, `color.p3`.
- Amplification: `amp.measure` (density, count, value), `amp.curve` (log, power,
  linear), `amp.exponent`, `amp.exposure`, `amp.reference`, `amp.exaggeration`,
  `amp.floor`, `amp.whale`, `amp.heatHalfLife` (blocks), `amp.heatFloor`, `amp.heatReference` (BTC), `amp.heatEdge`, `amp.heatEdgeBlocks`, `amp.flashSize`,
  `amp.flashThreshold` (BTC), `amp.edgeGlow`, `amp.edgeBlocks`, `amp.nowPlane`.
- Geometry: `geo.smoothing` (none, bilinear, bicubic), `geo.stepped`, `geo.steppedWhales`,
  `geo.subdivision` (1, 2, 4), `geo.columns`, `geo.columnShape` (cylinder, oval, box),
  `geo.cylinderSides` (6–32),
  `geo.columnRadius` (L0 cells), `geo.columnPixels` (px),
  `geo.instanceBudget` (≤ 8,000,000), `geo.columnGap`, `geo.farColumns` (prism, card, flat,
  cross), `geo.farShadows`, `geo.lodBias`,
  `geo.pixelsPerCell`, `geo.tileBudget` (32–400), `geo.uniform`, `geo.uniformLevel` (0–4), `geo.skirts`,
  `geo.groundHorizon`, `geo.wireframe`.
- Lighting: `light.sunAzimuth`, `light.sunElevation`, `light.sunIntensity`,
  `light.sunColor`, `light.skyColor`, `light.groundColor`, `light.ambient`,
  `light.emissive`, `light.albedo`, `light.rim`, `light.rimColor`,
  `light.roughness`, `light.metalness`, `light.shadows`, `light.cascades` (1–4),
  `light.shadowMapSize` (1024, 2048, 4096), `light.shadowFilter`,
  `light.shadowSoftness`, `light.shadowBias`, `light.fogDensity`,
  `light.fogHeightFalloff`, `light.volumetric`, `light.volumetricSteps`,
  `light.volumetricIntensity`, `light.godRays`, `light.godRaysIntensity`,
  `light.sky`, `light.stars`, `light.starDensity`, `light.floorReflection`.
- Effects: `fx.ao` (off, ssao, gtao), `fx.aoRadius`, `fx.aoIntensity`,
  `fx.aoSamples`, `fx.ssgi`, `fx.ssgiSamples`, `fx.ssgiIntensity`, `fx.ssr`,
  `fx.ssrIntensity`, `fx.ssrSteps`, `fx.bloom`, `fx.bloomThreshold`,
  `fx.bloomStrength`, `fx.bloomRadius`, `fx.bloomMips`, `fx.dof`,
  `fx.dofAperture`, `fx.dofFocus`, `fx.dofAutoFocus`, `fx.dofMaxBlur`,
  `fx.motionBlur`, `fx.motionBlurAmount`, `fx.grain`, `fx.chromatic`,
  `fx.vignette`.
- Camera: `camera.fov`, `camera.flySpeed`, `camera.sensitivity`,
  `camera.invertY`, `camera.damping`, `camera.collision`.
- Display: `display.scale` (0.25–2), `display.autoScale`, `display.targetFps`,
  `display.scaleMin`, `display.scaleMax`, `display.aa` (none, fxaa, smaa, traa),
  `display.ssaa` (1, 2, 4), `display.overlay`, `display.labels`, `display.grid`,
  `display.legend`, `display.minimap`, `display.hud`.

Look intent: **Landscape** is the schema defaults. **BitcoinTimelapse.com** (named Film until
October 2026) reproduces the film's colours
(density colour measure, film palette with whale rows ≥ 10 BTC, offset 30, upper 500,
gamma 1, unlit: albedo 0, emissive 1, no sun/ambient/rim/shadows/sky/stars/fog, every post
effect off, tone mapping none, exposure 1, neutral grade, AA none, black background and
ground). **Daylight** (high white sun, viridis, no bloom), **Golden hour** (low sun from the
tip side, thick haze, god rays, inferno), **Earth** (the Morning time of day, Mist haze, soft glow,
ground to the horizon, smooth surface, water-blue empty cells under the `earth` palette on a
colour scale from 1 to 25 (offset 1), no white-hot rows, AO intensity 1.5, saturation 1.1 and
contrast 1.05), **Whales** (height
and colour by BTC value, magma, whale rows twice as tall) and **Pulse** (dim grey on a
near-black background with the sky off, strong amber flashes with a 300-block trail) each
change at least eight settings. The data looks share one plain stage (`STUDIO`: high white
sun, sky, haze and bloom off, boxes, neutral tone mapping, grid, now plane 0.2, subtle
flashes, background #1e2126, empty cells #15171b): **Outputs** (height and colour by output
count, cividis), **Money map** (height by count, colour by BTC value from 1 to 2,000 BTC in
the ember palette, whose grey low end leaves the cells below 1 BTC neutral), **Linear**
(linear height curve, reference 100,000, exaggeration 40, film palette) and
**Paper** (reversed grey palette with gamma 0.7 on a white page, red flashes, exposure 0.8).
Quality intent: **Performance → Balanced → High → Ultra → Extreme** scale quality up: Ultra targets
≥ 60 fps at 3840×2160 on the M4 Max with the heightfield alone; with cylinder columns (the
default since 2026-10-09) it measures about 35–40 fps in close and middle views and
60 fps in the overview. Extreme deliberately exceeds the GPU (GPU-bound: 2× scale or SSAA,
4 shadow cascades at 4096, high AO/SSGI/SSR/volumetric samples, columns with large
budgets, subdivision 2). Cylinder detail falls toward Performance: Column detail 4 px on
High and above, 6 px on Balanced, 12 px with 8 sides and at most 250,000 stacks on
Performance; BitcoinTimelapse.com draws stepped cells without cylinders.

Consumers: worker ← `amp.measure`, `color.measure`, `amp.heatHalfLife`,
`geo.tileBudget` (via the client in main.js); terrain ← color.* transfer/palette/heat,
amp.*, geo.*, `light.emissive/albedo/rim/rimColor/roughness/metalness/floorReflection`,
`display.labels/grid`; render_post ← the rest of color.* (background, fog, grade, tone
mapping, exposure, LUT, P3), light.*, fx.*, display.scale/autoScale/targetFps/aa/ssaa/
overlay; ui_shell ← camera.*, `display.legend/minimap/hud`.

## 8. App shell (ui_shell)

`index.html` provides the import map, `<canvas id="view">`, and containers
`#labels`, `#overlay`, `#hud`, `#timeline`, `#panel`, `#minimap`, `#inspector`, `#hover`,
`#legend`, `#toast`, `#share` (the share dialog), and for plane mode `#plane-nose`, `#planehud`, `#funpops`, `#planekeys`,
`#fun` (the Fun menu) and `#funcard` (the Stack sats end card). `main.js` creates the settings store, replay client and view,
wires frames → view, settings → consumers, and runs the rAF loop:
follow tip → controls → playback → `view.update` → (`replay.setTiles` when desired tiles change) →
`view.render`. `?webgl=1` forces WebGL2. URL hash keeps
`b` (block), `cam`, `mode`, `follow=1` (Follow tip on), `cell=col,row` (one exact L0 cell),
`play=1` (explicit autoplay for a location link), `preset` and settings overrides.
Without `b`, the app opens at the latest snapshot at least 1,008 blocks (about a week)
before the tip, so Play has blocks to play (`defaultStartBlock` in `ui/playback.js`).

Cell inspector: one exact L0 cell is the primary scope, with selected-block count and
satoshi value, a secondary BTC conversion, and a compact verification badge only when
replay and history agree at the selected block. History responses carry `block`,
`cutoffBlock`, and `cutoffDate` (independent of the replay dataset). The primary chart always shows the cell's
full lifetime population samples from creation to the latest history block, including outputs spent before
selection; the selected block has an amber marker. This aggregate chart remains available
even when output lists are capped. A secondary After the selected block disclosure shows
an exact survival chart from spend heights only when every live record is available. Outputs use Unspent at selection / Spent earlier tabs,
three-row previews, expansion to all returned records, explicit API caps (500 live / 100
past), and four aligned columns with calendar dates first, block heights second, and
age/lifespan visible inline. Holding time uses block timestamps, or an explicitly approximate
10-minute-per-block estimate when those timestamps are unavailable. Rendering/data details retain density,
spending, value breakdowns and cell/pixel coordinates. Disclosure, tab and
scroll state survive refreshes; stale history and disagreement remain visible.

Sharing: a visible Share button in the timeline opens Current view / Selected cell
choices, and Share cell in the inspector selects the latter directly. Links snapshot the
block, camera, Follow state and appearance; view links omit any selection, while cell
links restore the exact L0 cell and its drawer after the replay reaches the shared block.
Cell links always open paused. Location links optionally autoplay. Copy link confirms only
successful clipboard writes, with a selectable manual-copy fallback; X, email and the
native share sheet are user-invoked alternatives. Public aliases share the canonical
bitcoinlandscape.com URL; local previews keep their origin and necessary data/API query
parameters and identify themselves as local links. Hash navigation and settings imports
use the same restoration path; opening/closing the inspector updates the cell in the URL.

Navigation: map mode (left-drag pans keeping the grabbed point under the cursor;
right-drag or Shift-drag orbits the point under the cursor; wheel/pinch zooms toward the
cursor; double-click flies there; arrows pan, Q/E rotate, PageUp/PageDown tilt), flight
mode (F or the timeline's Fly button, `aria-pressed` while on; pointer lock, mouse look, WASD,
E/Q up/down, Shift 4×, wheel sets speed, speed scales with height above terrain; collision
keeps the camera above the surface) and plane mode (T or the timeline's Fun menu; neither the
Fly nor the Fun button on touch-only devices). Plane mode flies one of three crafts, the plane,
the bird or the jet (`CRAFTS` in `ui/plane.js`; models in `render/plane-model.js`), all with
the same flight model and their own numbers (table below). The plane banks to
turn: sideways stick rolls the plane (80°/s, bank up to 75°) and the bank turns it, at
35°/s × tan(bank) × √(4 / speed) (at most 75°/s); centred, the bank holds and decays slowly
(0.3/s). Nose-up stick raises the nose along the plane's own axis (35°/s), so nose-up stick in
a bank tightens the turn; pitch is limited to ±70°. The mouse is a stick that springs back to
the centre (160 px ÷ `camera.sensitivity` for full deflection, return 3/s); A/D and ←/→ bank,
↑/↓ pitch (up for nose up with the mouse, the arrows and the gamepad stick; `camera.invertY`
switches to the flight-sim convention, pull back for nose up), easing in over 0.25 s; the
chase camera swings after the plane (4/s) and never rolls, so the bank shows. W/S throttle
0.25–16 units/s on a logarithmic throttle (start 2; each quarter of the bar multiplies the
speed by 2.83), Shift 3×, wheel sets the chase distance (0.8–40, default 2); the synthesized
engine sound (`ui/plane-sound.js`) plays while the Sound switch is on (M, below). A
controls card stays visible while flying. With `view.setDetailAhead(0.6, 1.6)` the terrain
draws cylinders down to `geo.columnPixels / 1.6` and moves their disc 0.6 radii ahead of
the camera (near cylinders still measured from the camera; L0 tiles kept that far out).
With `camera.collision` the plane keeps 0.15 above the
surface, rides over rises up to 0.35 and bumps on taller columns (stops, half speed, nose
pitched up). A top-centre line shows
the column, date and row amount under the plane. Esc, T or a lost pointer lock returns to
map mode at the camera; the URL hash records plane mode as `mode=map` and never records the
craft or a game. Standard gamepads: left stick banks and pitches (up for nose up), RT/LT throttle, A boost,
Start takes off or lands, B lands, Y next craft, X starts Stack sats.

Hover readout (`ui/hover.js`, `#hover`): a card docked under the HUD (same left edge and width,
10 px below it) names the cell as drawn under a mouse or pen pointer over the canvas ("Under the
cursor"), or under the crosshair in flight mode ("At the crosshair"). Its rows, like the HUD's:
Size (the amount band of its rows, `rowAmountRange` over rows.bin; BTC to 4 significant figures
rounded outward, so the band shown contains the exact one), Blocks (first to last), Mined (their
UTC dates), Unspent outputs and Value (at the replayed block, from `replay.cell(level, col, row,
{ load: false })`, refreshed at most 4 times a second while blocks change). Every range reads
"A to B". Zoomed out, the drawn cell merges 2^l columns and 2^rowShift rows; the card covers all
of them and says so. It never sends a request. When the pointer leaves the canvas or aims at
nothing, the card keeps its last reading, dimmed (`.linger`), for 1.5 s (`LINGER_MS`) and for as
long as the pointer is over the card, so the pointer can reach its ×; it hides at once while
dragging, in plane mode (whose top-centre line does the same job), on blur, and on touch-only
devices. Its × hides it until the page reloads (`hover.dismiss()`, `hover.dismissed`): no pointer
move, cell change or mode change shows it again, and nothing is saved. Picking runs at most
once a frame on pointer moves and every 100 ms for a still pointer, so camera moves and playback
keep it current.

Fun (`ui/fun-menu.js`, timeline button `data-act="fun"`, `aria-haspopup`; it lands first in
plane mode, as G/P/H do): a popover with a Craft column (Plane "Steady; banks to turn", Bird
"Slow and nimble; flaps and hugs the ground", Jet "Fast and wide; afterburner"; `aria-pressed`,
choosing keeps the menu open) and a Play column (Free flight, Stack sats with the craft's best
stack). Play closes the menu and takes off inside the click. C cycles plane → bird → jet (in
flight at the same pose, heading and throttle fraction, speed, bank and pitch clamped into the
new craft's limits; refused during a run); the choice and the best runs are kept in
localStorage `utxo-landscape-fun` (`ui/fun-store.js`, invalid data falls back to the
defaults). Each craft keeps its own chase distance; the controls card is titled with the craft
and lists C (next craft) and Enter.

| Craft | Speed (u/s) | Start throttle, boost | Roll, max bank, stability | Pitch rate, max | turnAt45, turnSpeed, max turn | Clearance, stepUp, bump speed | Chase (min–max), spawn | Model scale | Detail ahead (shift, reach) | Coin reach |
|---|---|---|---|---|---|---|---|---|---|---|
| Plane | 0.25–16 | 0.5, 3× | 80°/s, 75°, 0.3/s | 35°/s, 70° | 35°/s, 4, 75°/s | 0.15, 0.35, 0.5 | 2 (0.8–40), 3 | 0.5 | 0.6, 1.6 | 1 |
| Bird | 0.1–4 | 0.5, 2× | 140°/s, 80°, 1/s | 60°/s, 75° | 70°/s, 1, 150°/s | 0.06, 0.5, 0.7 | 1 (0.4–20), 1.5 | 0.25 | 0.3, 1.2 | 0.8 |
| Jet | 2–60 | 0.4, 1.6× | 180°/s, 85°, 0.15/s | 40°/s, 70° | 30°/s, 16, 60°/s | 0.3, 0.2, 0.4 | 4 (1.5–60), 5 | 0.6 | 0.8, 2.2 | 1.6 |

The bird beats its hinged wings ±30° at `flapRate` = 2 + 4 × throttle Hz (+2 boosting) and
glides with them raised 8° below 0.15 throttle; the jet's tail lamp glows 1 + 7 × throttle and
an afterburner cone shows while boosting. Sound profiles (`engineTargets(state, volume,
profile)`): the plane as above; the jet no oscillator engine (a pitched sawtooth sounded like
a vacuum cleaner) but a turbine heard from behind: brown-noise rumble low-passed at 140–360 Hz
(+120 on boost), a low-passed noise roar opening from 500 to 2,000 Hz with the throttle, slow
turbulence (0.71 and 1.93 Hz) on both, a faint two-tone whine (1,500–2,800 Hz and × 1.5, gain
0.016 falling with the throttle) and more rumble and roar on boost; the bird no engine, wind pulsed at the flap rate (depth
0.6, none while gliding), half-strength bump. The airspeed is measured against each craft's
full throttle with boost.

Stack sats (`ui/stack-sats.js`, pure; coins drawn by `render/coins.js`): Enter in plane mode,
gamepad X or the Fun menu starts (or restarts) a 60 s run in the current craft; it steps once
the takeoff ends; randomness comes from a generator seeded per run. Trails: a chain of 10
coins ahead along the heading, 0.45 s of flight apart (0.7–6 units), the first 1.5 s of flight
ahead (1.5–40 units) and up to 25° off the heading; each coin's turn changes by up to 3°
(at most 8° a coin) and its climb by up to 0.05 (at most 0.15 a coin), at the craft's height
clamped between 0.5 and 8.5 above the highest ground within 0.15; at the landscape's edge a
chain turns up to 30° a coin toward the middle (a chain that would start outside starts just
inside, heading to the middle). A new trail, continuing from the last trail coin while that is
still ahead, is laid whenever fewer than 8 trail coins are ahead (at most one a second).
Bonus coins: up to 6, placed every 3 s: the ground is sampled on a square of side 2R
(R = clamp(4 × speed, 5, 24)) centred 0.5R ahead of the craft at R/30 spacing; 3×3 local
maxima at least 0.25 high, tallest first, at least 1.5 from other bonus coins and the craft,
become coins 0.5 above the highest ground within 0.15. At most 60 coins are out. A coin is
worth `rowAmountRange(rows, floor(z × 10)).min` satoshis and vanishes after 20 s or once it
is more than 3 s of flight (at least 12 units) behind the craft; it is collected when this
frame's path passes within the craft's coin reach horizontally and vertically. Coins: upright
discs r 0.22, 0.05 thick, no shadow, Bitcoin orange with a ₿ face, spinning
2 rad/s, bobbing ±0.05 at 1 Hz, growing in and shrinking out over 0.25 s. During a run the
`#planehud` line starts with "Stack sats · m:ss · stack · n coins" and each coin pops "+amount"
under it for 0.8 s. At 60 s the best for that craft is updated and `#funcard` shows the stack,
the coins, "New best with the <craft>" or the best, and Again (Enter) / Land (Esc); it releases
pointer lock without landing (`controls.releaseLock()`) and the craft flies on. Landing, Fly
or Fun abandons a run without a score.

Follow tip (N or the timeline's Follow button, `aria-pressed`; also on touch devices,
`ui/follow.js`): turning it on leaves the camera where it is. Every replay frame that changes
the block moves a target block: playback and the 1-block steps (advance frames) and the
scrubber, block and date input and the 1,008-block steps (seek frames). Seeks that place the
camera themselves (Places, links, imported views, startup) run between `beginJump()` and
`endJump(block)`, and frames in between re-anchor instead. Each frame, before the controls, the
camera's anchor eases toward the target (τ = 0.25 s, snapping within 0.01 blocks) and
`controls.shiftX(dx)` moves the camera by the change in world x (block / 1000), together with
every point a gesture or animation in progress is anchored to (each point once). So the camera
keeps the tip's speed and direction, glides to the new tip after a seek, and its total shift
equals the tip's. Map and flight mode follow; plane mode holds (re-anchors on every frame and replay
frame), so landing never jumps.

Sound (`ui/sound.js`; M or the timeline's Sound button between Fun and Places, `aria-pressed`
while on, also on touch devices): one switch for every sound, off by default and remembered in
localStorage (`utxo-landscape-sound` = `on` | `off`; without it, the old plane switch
`utxo-landscape-plane-sound` = `on` counts as on). Turning it on creates the one shared
`AudioContext` inside that gesture; later key presses and clicks resume it; turned off (after
0.6 s) or with the page hidden it is suspended. The notice reads "Sound on", "Sound off", or
"Sound on · turn on Flashes to hear spends" when `amp.flashSize` is 0. The plane engine plays
in that context while the switch is on; landing fades it and removes its graph.
Spend sound (`ui/flash-sound.js`): `render/terrain/flashes.js` calls `onSpawn(chosen, { block,
reason, now })` with each frame's new flash sprites (`t` = the amount scale, `old` outside the
edge window); terrain `onFlashes(fn)` and `view.onFlashes(fn)` pass them on, and
`view.cameraView()` gives the camera position and its column-major view-projection. Only
`advance` frames sound (playback and 1-block steps forward), so seeks and scrubs are silent. A
flash sounds when it projects in front of the camera within NDC ±1.1. Reference distance: the
median distance of the frame's flashes on screen, clamped to 1–1,000 and eased in log space
(τ = 0.5 s), so zooming shifts the balance but not the overall level. Level = (0.25 + 0.75 t) ×
(0.35 for creation-edge spends) × min(1, 2 / (1 + (d / ref)²)): full at the reference and nearer,
0.4 at twice, 0.118 at four times; beyond twice its band-pass centre is also 0.6 times lower, so far
clicks are darker. Each tick is a raindrop-like click: white noise of peak 0.65 with a 0.2 ms linear
rise and an exponential decay, through its own RBJ band-pass (0 dB peak, Q 0.9), ending three decays
later, 78 dB down, and equal-power panned by its screen x. The age of the cell's newest coins (block
− xEnd × 1000) picks the band, the film's age bands (`src/cpp/buv/AudioSynthesizer.h`) as
brightness: under 100 blocks centred at 7 kHz, 1,000 4.8 kHz, 10,000 3.3 kHz, 100,000 2.3 kHz, older
1.6 kHz, with decay time constants of 1.2 to 2.8 ms and band gains 0.8 to 1.1, so older coins are
darker, slightly longer and slightly louder. Clicks have no pitch: pitched noise ticks (narrow-band
noise at 1–6 kHz with a 1 ms attack) seemed to start high on old coins, and clean tones at 330 Hz to
2.4 kHz sounded like bubbles under water. Nothing sounds below 300 Hz (24 dB an octave): on a
MacBook's built-in speakers the film's 80 Hz thuds came out as surges and near-silences. Every
flash on screen ticks, loudest
first, from a budget that refills at 4,000 a second and holds at most 400 (one frame's sprites):
a few spends are separate clicks, and from a few hundred a second they overlap into the hiss of rain.
Loudness follows the energy of every flash on screen (the sum of level squared a second, voiced
or not): unchanged up to 40, above that compressed to the power 0.4 (10 times the energy is 4 dB
louder), with the voiced ticks raised at most 2 times to stand for the rest. Each frame's ticks
become compact events (`tickEvents`) spread over the time since the previous frame, 120 ms ahead
of the audio clock, and the `flash-ticks` AudioWorklet (`ui/flash-worklet.js`,
`TickRenderer`) synthesizes them on the audio thread, so the page spends about 0.15 ms a frame
on sound; without AudioWorklet, `mixFrame` mixes each frame on the page into one buffer with the
same renderer. Spans follow one another, so when frames pause (a worker stall, a slow frame, a
busy browser) the sound plays on through the lead and the next frame fills the pause. A schedule
that comes within 15 ms of the audio clock has run dry: it restarts 30 ms ahead, and the lead is
raised to 1.5 times or the pause plus 50 ms, at most 0.4 s, then eases back toward 120 ms with a
60 s time constant. A span whose next-frame lead would fall short is stretched by up to a quarter
to win it back, and one more than 10 ms beyond is tightened by up to a tenth. It runs at most
0.2 s beyond the lead, so frames that arrive in a clump are spread out. Two 300 Hz high-passes, a
peak limiter (−6 dB, 20:1) and a 1.1 master gain follow.
Keys everywhere (ignored while typing in inputs): Space play/pause, `[`/`]` ±1 block,
Shift+`[`/`]` ±1,008, N Follow tip, M sound, I inspect at cursor (crosshair in flight, nose circle in plane mode), C next craft,
Enter Stack sats (plane mode), Esc exits flight or plane mode/closes the drawer or a menu. Places (`ui/places.js`):
landmarks of the unspent set, each a region (creation blocks × amount rows) and a camera view
(a target block, or blocks relative to the current block, and an amount; distance, yaw, pitch):
the first line (50 BTC, first era), the July 2015 flood (1,000 sat, blocks 364,544–365,119),
round amounts (1, 0.1, 0.01 BTC), the dust ridge (546, 330, 294 sat since 2023), towers at the
edge (≥100 BTC) and the newest block (seek the tip, opening view). A place keeps the block; one
newer than the block (block < region start) seeks the tip first. Halvings are not places: after
the first era no subsidy row stands out. `landscape/tools/places-survey.mjs` measures each
region in a snapshot. `flyTo(block)` on the hook still seeks a block and flies to its creation edge.
Minimap from the always-resident L6 tile. Inspection drawer: exact worker state for the
cell, the explorer cell API lifecycle data, and the 2D explorer link.
The HUD's brand row (not in the phone layout) and the legend and minimap headers each end in a ×
(`ui/dismiss.js`, `.box-close`, also used by the hover card) that hides the box for the current
page load only: main.js keeps the dismissal in memory, so nothing reaches
the settings store, localStorage or the URL hash, and a reload shows the box again. Changing
`display.hud`, `display.legend` or `display.minimap` clears that box's dismissal. With the HUD
hidden, the hover card docks at the top left in its place (`#hover.undocked`).
The brand row's wordmark, *UTXO Timelapse Landscape*, is an unstyled link to `/guide/` that opens
in a new tab, so the replay keeps running; a pointer click leaves no focus ring behind it.

Test hook: main.js sets `window.__landscape = { ready, settings, replay, view, controls,
playback, seek(block), flyTo(place), inspect(x, y), follow: { active, lag, toggle(), set(on) },
sound: { on, toggle(), set(on), state }, flashSound: { state },
plane: { active, takingOff, state, pose,
model, craft, crafts, setCraft(id), coins, game: { active, state, start(), stop() }, sound, takeoff(), land() },
fun: { open, toggle(), card } }` and sets `ready = true` after the
first rendered frame that contains real data. Dev harness pages set `window.__ready` and
expose their objects on `window.__dev`. browser-check scripts use these hooks.

## 9. Verification commands

Note: doctest owns `-out=`/`-o=` (report file, truncated before the task runs), so the build takes `-outDir=`.

```sh
node --test landscape/tests/*.test.mjs
./build_local/buv -ns -tc=landscape_state
./build_local/buv -ns -tc=landscape_build -cfg=configs/buv_explorer.json -outDir="/Volumes/4T Data/buv_render/landscape_966827"
./build_local/buv -ns -tc=landscape_verify -cfg=configs/buv_explorer.json -data="/Volumes/4T Data/buv_render/landscape_966827" -checkpoint="/Volumes/4T Data/buv_render/renderer_before_965400.bin"
./build_local/buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3'
node landscape/tools/serve.mjs --data "/Volumes/4T Data/buv_render/landscape_966827"
```



## Approved plan (verbatim)

# UTXO Timelapse Landscape: WebGPU 3D explorer with exact browser replay and full graphics controls

## Summary
A static browser app in `landscape/web/` renders the UTXO set as a 3D landscape: creation block left to right (linear), the film's 2,072 amount rows front to back, and a switchable measure (weighted density, count, BTC value) as height and colour. The exact state is reconstructed in a Web Worker by replaying `changes.blk1` from tile-indexed snapshots, so every displayed block is exact at 1× and single-step. Rendering uses three.js 0.186.0 `WebGPURenderer` with a scalable pipeline (instanced columns, cascaded shadows, GTAO/SSGI/SSR, volumetric fog, bloom, DOF, TRAA/SSAA, resolution scale to 2×) whose Ultra and Extreme presets are tuned to load the M4 Max at 4K. A settings panel built from one schema exposes about 90 parameters across colour, amplification, effects, lighting, camera and display, with presets, JSON export/import and URL sharing. Data is built once by C++ tools into a new directory on the 4T drive and served locally by a small Node server on `127.0.0.1:12990`.

## Data build and exact replay
- Grid: finest level L0 = 64 creation blocks × 1 amount row (15,107 × 2,072); seven levels, each doubling block width with rows per cell `min(2^level, 16)`; tiles 256×256 cells plus a one-cell border. Cell state is four exact integers: `countSmall`, `countLarge`, `satsSmall`, `satsLarge` (boundary 5 BTC). Weighted density = `countSmall + satsLarge/5e8`; count = both counts; value = sats/1e8.
- New C++ task `landscape_build` (reads sources read-only, writes only to a new empty `/Volumes/4T Data/buv_render/landscape_966827/`): splits the change log into `chunks/NNNNN.bin` (raw BLK2 records, ≤4 MiB, block-aligned) with `chunks.json` (first block, offset, sha256); replays from genesis and writes a snapshot every 16 MiB of change data plus genesis and tip (`snapshots/NNNNNN.bin`, format `BUVLSN1`: header with block, dims, totals, SHA-256; per-level/per-tile directory of offset+length; varint-packed occupied cells); writes `blocktimes.bin` from BUVHIST1 through its header offsets and `manifest.json` (source identity, schedule, numBlocks, tip date). Estimate about 1,100 snapshots, 40 GB, 15–20 minutes; measured values replace these in the manifest and docs.
- New C++ task `landscape_verify`: every snapshot equals a fresh replay; 20 random backward replays equal the snapshot below; history-index pass reproduces every L0 cell at blocks 210,000, 630,000 and the tip; weighted density at 965,399 matches the renderer checkpoint within 1e-6 per cell; unit case `landscape_state` covers apply/undo round trip, same-block create+spend, zero amounts skipped, exact 5 BTC boundary, level sums, tile borders, snapshot round trip, row mapping at boundary amounts.
- Worker `landscape/web/replay.worker.js` (plain JS, no WASM in v1): decodes BLK2 (LEB128, zigzag), applies changes to all loaded levels; backward steps negate a block. Satoshi sums stay exact in doubles (< 2^53). Only tiles the viewer has requested are allocated (sparse), with a 512 MB LRU of chunk bytes. Measured in Node on this Mac: 293–378 blocks/s apply in the busiest eras, about 5,400 in 2012, 33–37M changes/s decode, exact return to zero after forward+backward.
- Seek: pick the cheapest of current state, nearest snapshot at or below the target, or the one above with backward replay; range-request only the loaded tiles' directory entries; load L4–L6 first so an exact coarse view appears immediately, then stream finer tiles; replay the gap. A tile that becomes visible mid-playback initialises from the nearest snapshot plus cached chunks. Latest seek wins.
- Even pace at exact speeds: the replay client can hold the worker's frames (`showThrough(block)` delivers them in order up to a block; `client.block` is the block on screen, `client.workerBlock` the worker's). At 0.5× to 20× playback asks the worker for 0.1 s of blocks beyond the playhead and shows each block when the playhead reaches it, so a worker answer that misses a frame, or a short pause, does not stop the count; the playhead never passes the worker, so a longer pause holds it instead of making it jump. Paused, stepping, seeking, scrubbing and Max show frames as they come; pausing shows the blocks already done (at most 0.1 s of play).
- Speeds (a menu in the timeline; keys 0 to 4 keep selecting 0.5×, 1×, 2×, 5× and Max): 0.5× = 30 blocks/s exact; 1× = 60 blocks/s exact; 2× = 120 blocks/s exact; 5× = 300 blocks/s exact; 10× = 600 blocks/s exact; 20× = 1,200 blocks/s exact; the HUD shows the achieved rate when the worker cannot keep up; Max replays with the whole frame budget, paced to the download when that is slower; only scrubbing steps snapshot to snapshot. Frame deltas go to the main thread as transferable buffers: per tile either full 258×258 values (per measure) + heat, or changed-cell lists.
- Activity heat: during forward playback each spend adds actual BTC moved to its cell's heat; decay half-life in blocks is a setting; seeks and backward steps clear heat.
- Cell inspection: add `GET /api/landscape/cell?block&col&row` to `src/cpp/app/utxo_explorer.cpp` (heights `col*64 … col*64+63`, satoshi range from `rowSatoshiRange`, same JSON fields as `/api/pixel`, CORS for `127.0.0.1:12990`). Run a second explorer instance from `build_local/buv` on port 12989 with `configs/buv_explorer.json`; the installed copy under `~/.local/share/buv-explorer` is untouched.
- Local serving: `landscape/tools/serve.mjs` (Node 20, no dependencies) serves `landscape/web/` and the data directory with HTTP Range support and correct MIME types on `127.0.0.1:12990`.

## Rendering (three.js 0.186.0, WebGPU)
- Vendor `three.webgpu.js`, `three.tsl.js`, needed addons (display nodes, lil-gui) and the MIT license into `landscape/web/vendor/`. Use `WebGPURenderer`; on missing `navigator.gpu` fall back to the WebGL2 backend with compute-dependent features disabled and the preset capped at High.
- Scene: X = block/1000, Z = row/10 (large amounts farthest), Y = `exaggeration × curve(measure)`; curve selectable: `log(1+exposure·v)/log(1+exposure·vmax)`, power (gamma), or linear; values normalised to one L0 cell's area; optional minimum floor height for occupied cells and a whale multiplier for rows ≥ the white-hot threshold.
- Two geometry paths, both driven by one tile-texture atlas (float32, 4096², LRU of tile slots): (a) heightfield clipmap per level, TSL vertex stage samples heights, normals from a compute pass (WebGPU) or screen-space derivatives (fallback), smoothing none/bilinear/bicubic; (b) column mode: one instanced box per occupied L0 cell within a configurable radius and instance budget (up to 8M), per-instance height/colour written by a compute pass from the atlas, culled per tile; heightfield continues beyond the column radius. Stepped (flat-top) cells are a heightfield option as well.
- Colour: 256-entry palette LUT texture; built-in palettes from `site/assets/palettes.json` (film turbo and white-hot variant) plus viridis/inferno/magma/plasma/grey and a custom gradient editor (up to 16 stops); transfer `log(v+offset)` scaled between 1 and an upper limit (film defaults 30 and 500) with gamma; split palette above the white-hot row; heat blended as emissive with its own colour/gain. A "Film" preset reproduces the film's colours exactly at matching density.
- Lighting and materials: standard node material with emissive term, directional sun with 1–4 shadow cascades (1024–4096 each, PCF/PCSS), hemisphere ambient, rim light, roughness/metalness; environment fog (density, colour, height falloff), volumetric scattering/god rays (step count setting), sky gradient and stars, optional reflective floor via SSR.
- Post chain (TSL `PostProcessing`, only enabled nodes are built; toggling rebuilds): GTAO or SSAO → SSGI → SSR → volumetric/god rays → bloom (threshold, strength, radius, mip count) → depth of field (auto-focus on crosshair, aperture) → motion blur → tone mapping (none/Linear/Reinhard/ACES/AgX/Neutral) → exposure (manual or histogram auto via compute) → colour grade (lift/gamma/gain, contrast, saturation, temperature/tint, hue shift) → 3D LUT (.cube upload) → film grain, chromatic aberration, vignette → AA (none/FXAA/SMAA/TRAA) or SSAA 2×/4×.
- Resolution scale 0.5–2.0 of canvas size (up to 7680×4320 internal at 4K); Auto mode adjusts scale within min/max to hold a target fps. Optional Display P3 canvas where supported.
- Performance overlay: fps, CPU ms, GPU ms total and per pass via `timestamp-query` when the adapter offers it (otherwise CPU timing only), triangles, instances, loaded tiles, worker blocks/s, memory.
- Navigation and UI as previously planned: map mode (pan under cursor, orbit under cursor, zoom to cursor, double-click fly-to), flight mode (pointer lock, WASD/EQ, Shift 4×, speed by height), Space play/pause, `[`/`]` step 1, Shift+`[`/`]` step 1,008, I inspect; timeline with one field holding the block and UTC date inputs; places (eras at 50,000, 210,000, 314,000, 420,000, 500,000, 630,000, 700,000, 840,000, 900,000, tip; amount bands 50 BTC coinbase row, ≥10 BTC, 1 BTC, 10,000 sat, 546 sat, 1–100 sat); minimap; inspection drawer with a link to the nearest 2D explorer pixel; view state in the URL hash.

## Graphics settings
- One schema (`landscape/web/settings.schema.js`): id, group, type, range/step or options, default, per-preset value, "requires WebGPU" flag, "rebuild" flag. The lil-gui panel, URL encoding, JSON export/import, localStorage persistence and the uniform/node updates are all generated from it. Changes to numeric/colour settings update uniforms without recompiling; structural toggles rebuild the affected pass.
- Presets: Film, Performance, Balanced, High, Ultra (target 60 fps at 3840×2160 on this Mac), Extreme (exceeds the GPU on purpose, target 30 fps), Custom. Reset per group and reset all. Current preset name and any overrides are shown.

| Group | Parameters |
|---|---|
| Colour | palette, custom gradient stops, transfer offset, upper limit, gamma, white-hot on/off and threshold, background, fog colour, heat colour and gain, hue shift, saturation, contrast, temperature/tint, lift/gamma/gain, tone mapping, exposure mode/value/auto range, LUT file, Display P3 |
| Amplification | measure, height curve and exponent, exposure (value normalisation), exaggeration, floor height, whale multiplier, heat decay half-life, flash size by amount, creation-edge glow, now-plane opacity |
| Geometry | heightfield smoothing, stepped cells, column mode on/off, column radius, instance budget, LOD bias, tiles budget, wireframe |
| Lighting | sun azimuth/elevation/intensity/colour, ambient sky/ground, emissive strength, rim light, roughness, metalness, shadows on/off, cascades, shadow map size, softness, fog density/falloff, volumetric on/off and steps, god rays, sky/stars, floor reflection |
| Effects | AO mode/radius/intensity/samples, SSGI on/off and samples, SSR on/off, bloom threshold/strength/radius/mips, DOF on/off/aperture/auto-focus, motion blur, film grain, chromatic aberration, vignette |
| Display | resolution scale, auto scale target fps and bounds, anti-aliasing mode, SSAA factor, overlay on/off, labels/grid/legend, minimap |

## Test plan
- Node tests: worker replay module (decode, apply, undo, sparse tiles, seek planning), snapshot reader, axis mapping equals the Worker's `mapping.js` row function, settings schema (every parameter has default within range; URL and JSON round trips; preset values valid), frame delta encoding.
- C++: `landscape_state` unit case; `landscape_verify` against the built data with zero mismatches; rebuild and rerun the focused palette, epoch-transition and checkpoint cases and confirm the reported case count; native explorer example pixel (block 314,000, x 3000, y 1525) still returns 2 outputs totalling 42,430 sat after the endpoint addition.
- Browser (in-app browser, then Safari and Chrome on the 4K display): WebGPU adapter selected, timestamp-query availability reported; first frame renders; jump to 314,000; 10 s at 1× advances about 600 exact blocks; cell click equals the cell API; Film preset colour at a known cell matches the film palette entry; every preset switches without reload; each settings group changes the image; export/import restores an identical view; WebGL2 fallback forced via query flag renders with capped preset.
- Acceptance: 1× exact in every era; local seeks ≤ 2 s at the 95th percentile; Ultra holds ≥ 60 fps at 3840×2160 on this Mac or the measured figure is recorded and Ultra retuned; Extreme shows GPU ms ≈ frame time with GPU utilisation ≥ 90% (overlay plus Activity Monitor GPU history); worker memory ≤ 1.5 GB; verify passes with zero mismatches; measured build size/time and playback rates per era recorded in `docs/landscape.md`.
- Docs: `docs/landscape.md` (build, serve, settings reference, measurements), glossary entries, one row in `docs/README.md`.

## Assumptions
- Web-first architecture, run locally only: no changes to the Worker, R2, GitHub Pages or the public site, and no publication; the same files can later be uploaded to R2 after approval.
- WebGPU in Safari 26+ and Chrome/Brave on this Mac is the primary path; Firefox and other WebGL2-only browsers get the fallback (Firefox's WebGPU status was not verified this turn).
- three.js 0.186.0 and its bundled lil-gui; no WASM, no extra npm runtime dependencies.
- Snapshot interval 16 MiB of change data; horizontal detail limited to 64-block cells; old eras appear sparser than in the film because every block gets equal width (legend and docs explain this).
- One viewer per data directory; existing uncommitted work and all local artifacts are preserved; nothing is committed unless you ask.
- M4 Max throughput figures are from memory and may be dated; preset tuning relies on measurements, not those figures.
