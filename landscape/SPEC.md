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
- JavaScript: plain ES modules, no bundler, no npm runtime dependencies. Node 20 for
  tests and the server. Tests live in `landscape/tests/*.test.mjs` and run with
  `node --test landscape/tests/`. Browser code must not import Node modules; shared
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
replay.snapshotBlocks   // sorted snapshot block heights (for scrubbing / 100× stepping)
replay.grid; replay.status; replay.stats; replay.setChunkCacheMB(mb)
// onFrame/onStatus/onError return unsubscribe functions; the top tile is grid.tiles - 1 (757 on the full grid)
replay.dispose()
```

Frame delivered to `onFrame` (buffers are transferred):
```js
{
  seq, block, reason: 'seek' | 'advance' | 'tiles' | 'measure', partial: false,
  full: [{ id, level, tx, ty, empty: false, data: Float32Array(258*258*4) }],
  deltas: { ids: Uint32Array(k), offsets: Uint32Array(k + 1),
            index: Uint32Array(n) /* slot-local 0..258*258-1 */, data: Float32Array(n * 4) },
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
`empty: true` tiles carry `data: null`. Deltas include border copies in neighbours.

Policies: a seek loads coarse tiles (L4–L6) first and emits a `partial: true` frame, then
the rest. Seek planning picks the cheapest of: current resident state, nearest snapshot
at or below the target (forward replay), nearest snapshot above (backward replay).
Tiles that become resident during playback load from a snapshot and replay to the current
block before their first full frame. Chunk bytes are cached (LRU, `chunkCacheMB`) with
read-ahead in the playback direction. Worker memory budget ≤ 1.5 GB.

Playback (implemented by ui_shell on top of the client): 1× = 60 blocks/s exact; 10× =
600 blocks/s exact, HUD shows achieved rate when the worker cannot keep up; 100× = target
moves at 6000 blocks/s, using exact `advance` when the gap is small and seeking to the
largest snapshot ≤ target when it is not; Max = exact advance with the whole frame budget;
scrubbing seeks to the nearest snapshot at/below the scrub position while dragging, then
an exact seek on release. `[`/`]` step 1 block, Shift+`[`/`]` step 1,008 (via seek).

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
overlaps; L6 is always resident), heightfield mesh with skirts, stepped cells,
smoothing, subdivision, instanced columns, palette LUTs and colour transfer, heat
emissive and flash sprites, creation-edge glow, now plane, grid, axis labels
(HTML positioned by projection into `labelsElement`), CPU tile copies for picking.
Terrain materials are NodeMaterials (`MeshStandardNodeMaterial`) so lights, shadows
and the MRT outputs used by AO/SSGI/SSR/TRAA/motion blur work.

Height curve (on the area-normalised value `v`, with `e = amp.exposure`,
`R = amp.reference`): log: `log(1 + e*v) / log(1 + e*R)`; power:
`(e*v / (e*R))^amp.exponent`; linear: `e*v / (e*R)`. Height =
`amp.exaggeration * curve`, times `amp.whale` on rows at/above the white-hot row, plus
`amp.floor` for occupied cells; empty cells have height 0.

Colour transfer (on the colour value `v`): `v ≤ 0` → `color.ground`; otherwise
`t = clamp((ln(v + o) − ln(1 + o)) / (ln(U + o) − ln(1 + o)), 0, 1)^color.gamma`, palette
index `floor(255 t)` (`o = color.offset`, `U = color.upper`). With the Film preset
(`o = 30`, `U = 500`, gamma 1, palette `film` with the whale palette on rows at/above
`row(color.whiteHotBTC × 1e8)`), the index equals `DensityToImage`'s exactly.
Palettes: `film` = `site/assets/palettes.json` `base`, whale variant = `whale`.

render_post owns everything else in the frame: renderer creation (WebGPU with raised
`requiredLimits` and `trackTimestamp` when available; `forceWebGL` / missing
`navigator.gpu` → WebGL2 backend, compute features off, presets capped at High), sun +
cascaded shadows (CSMShadowNode), hemisphere ambient, sky, stars, fog, volumetric
scattering, god rays, the RenderPipeline chain (AO → SSGI → SSR → volumetrics/god rays →
bloom → DOF → motion blur → tone mapping → exposure → grade → LUT → grain/CA/vignette →
AA/SSAA), resolution scale and auto scale, Display P3, perf overlay, GPU timing.

## 7. Settings

`settings.schema.js` exports `SCHEMA` (array of entries) and `PRESETS`. Entry:
`{ id, group, label, type: 'number'|'int'|'bool'|'enum'|'color'|'gradient'|'file',
min, max, step, scale: 'linear'|'log', options, default, webgpu: bool, rebuild:
'none'|'material'|'terrain'|'post'|'shadows'|'renderer'|'worker', url: bool, help }`.
Extra entry fields (documented in the schema header): `section`, `optionLabels`, `unit`,
`logMin`, `webgpuOptions`/`fallback`, `capMax` (capped by `view.capabilities.maxTileBudget` /
`maxInstances`), `maxStops`, `accept`, `preset: false` (personal preferences presets never change).
`PRESETS` maps preset name → partial `{id: value}` (Film, Performance, Balanced, High,
Ultra, Extreme); unspecified ids use `default`. Startup preset: High (capped at High on
WebGL2).

`settings.js` exports `createSettingsStore(schema, presets, {capabilities, storage})`:
`get(id)`, `set(id, v)`, `setMany(obj)`, `subscribe(filter, fn)` (filter: id, group
name, or `'*'`; fn receives `[{id, value, previous, entry}]` batched per microtask),
`applyPreset(name)`, `reset(group?)`, `preset` (name, `'Custom'` when overridden),
`overrides()`, `toJSON()`, `fromJSON()`, `toURL()`, `fromURL()`, `load()`/`save()`
(localStorage key `utxo-landscape-settings-v1`). Values are validated and clamped.

Required ids (consumers must use exactly these; ranges/defaults may be refined by
ui_settings with the consumers):

- Colour: `color.palette` (film, turbo, viridis, inferno, magma, plasma, cividis,
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
- Geometry: `geo.smoothing` (none, bilinear, bicubic), `geo.stepped`,
  `geo.subdivision` (1, 2, 4), `geo.columns`, `geo.columnRadius` (L0 cells),
  `geo.instanceBudget` (≤ 8,000,000), `geo.columnGap`, `geo.lodBias`,
  `geo.pixelsPerCell`, `geo.tileBudget` (32–400), `geo.skirts`, `geo.wireframe`.
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

Preset intent: **Film** reproduces the film's colours (density colour measure, film
palette with whale rows ≥ 10 BTC, offset 30, upper 500, gamma 1, unlit: albedo 0,
emissive 1, no sun/ambient/rim/shadows/sky/stars/fog, every post effect off, tone mapping
none, exposure 1, neutral grade, AA none, black background and ground).
**Performance → Balanced → High → Ultra → Extreme** scale quality up: Ultra targets
≥ 60 fps at 3840×2160 on the M4 Max; Extreme deliberately exceeds it (≈30 fps, GPU-bound:
2× scale or SSAA, 4 shadow cascades at 4096, high AO/SSGI/SSR/volumetric samples,
columns with large budgets, subdivision 4).

Consumers: worker ← `amp.measure`, `color.measure`, `amp.heatHalfLife`,
`geo.tileBudget` (via the client in main.js); terrain ← color.* transfer/palette/heat,
amp.*, geo.*, `light.emissive/albedo/rim/rimColor/roughness/metalness/floorReflection`,
`display.labels/grid`; render_post ← the rest of color.* (background, fog, grade, tone
mapping, exposure, LUT, P3), light.*, fx.*, display.scale/autoScale/targetFps/aa/ssaa/
overlay; ui_shell ← camera.*, `display.legend/minimap/hud`.

## 8. App shell (ui_shell)

`index.html` provides the import map, `<canvas id="view">`, and containers
`#labels`, `#overlay`, `#hud`, `#timeline`, `#panel`, `#minimap`, `#inspector`,
`#legend`, `#toast`. `main.js` creates the settings store, replay client and view,
wires frames → view, settings → consumers, and runs the rAF loop:
controls → playback → `view.update` → (`replay.setTiles` when desired tiles change) →
`view.render`. `?webgl=1` forces WebGL2. URL hash keeps
`b` (block), `cam`, `mode`, `preset` and settings overrides.

Navigation: map mode (left-drag pans keeping the grabbed point under the cursor;
right-drag or Shift-drag orbits the point under the cursor; wheel/pinch zooms toward the
cursor; double-click flies there; arrows pan, Q/E rotate, PageUp/PageDown tilt) and flight
mode (F toggles; pointer lock, mouse look, WASD, E/Q up/down, Shift 4×, wheel sets speed,
speed scales with height above terrain; collision keeps the camera above the surface).
Keys everywhere (ignored while typing in inputs): Space play/pause, `[`/`]` ±1 block,
Shift+`[`/`]` ±1,008, I inspect at cursor (crosshair in flight), Esc exits flight/closes
the drawer. Places: eras at 50,000, 210,000, 314,000, 420,000, 500,000, 630,000,
700,000, 840,000, 900,000 and the tip (seek + fly to that creation column); amount bands:
50 BTC coinbase row, ≥10 BTC, 1 BTC, 10,000 sat, 546 sat, 1–100 sat (fly to that row).
Minimap from the always-resident L6 tile. Inspection drawer: exact worker state for the
cell, the explorer cell API lifecycle data, and the 2D explorer link.

Test hook: main.js sets `window.__landscape = { ready, settings, replay, view, controls,
playback, seek(block), flyTo(place), inspect(x, y) }` and sets `ready = true` after the
first rendered frame that contains real data. Dev harness pages set `window.__ready` and
expose their objects on `window.__dev`. browser-check scripts use these hooks.

## 9. Verification commands

Note: doctest owns `-out=`/`-o=` (report file, truncated before the task runs), so the build takes `-outDir=`.

```sh
node --test landscape/tests/
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
- Speeds: 1× = 60 blocks/s exact; 10× exact while the worker sustains ≥600 blocks/s, otherwise the HUD shows the achieved rate; 100× and scrubbing step snapshot to snapshot. Frame deltas go to the main thread as transferable buffers: per tile either full 258×258 values (per measure) + heat, or changed-cell lists.
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
- Navigation and UI as previously planned: map mode (pan under cursor, orbit under cursor, zoom to cursor, double-click fly-to), flight mode (pointer lock, WASD/EQ, Shift 4×, speed by height), Space play/pause, `[`/`]` step 1, Shift+`[`/`]` step 1,008, I inspect; timeline with block and UTC date inputs; places (eras at 50,000, 210,000, 314,000, 420,000, 500,000, 630,000, 700,000, 840,000, 900,000, tip; amount bands 50 BTC coinbase row, ≥10 BTC, 1 BTC, 10,000 sat, 546 sat, 1–100 sat); minimap; inspection drawer with a link to the nearest 2D explorer pixel; view state in the URL hash.

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
