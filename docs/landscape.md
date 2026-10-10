# UTXO Timelapse Landscape

The landscape is a 3D view of the same UTXO set the film shows, explored in a browser, either online or on this machine. Creation block runs left to right on a linear axis, one column per 64 blocks. The film's 2,072 amount rows run front to back, with the largest amounts farthest from the default camera. Height and colour show a switchable measure — amount-weighted density, output count or BTC value — of the outputs still unspent at the current block.

The browser rebuilds that state exactly. A Web Worker replays `changes.blk1` from tile-indexed snapshots, so every block you land on, by seeking, stepping or playing at 1×, is the exact UTXO set after that block. `landscape_build` writes the dataset once. Online, at **https://3d.bitcointimelapse.com/**, a Cloudflare Worker serves the app and the dataset from R2 and answers the inspector's cell lookups from the 2D explorer's history shards (see Online below). Locally, a dependency-free Node server serves the app and the dataset on `127.0.0.1:12990`, and an optional second native explorer answers cell lookups.

The implementation contract, with byte formats, the worker protocol and the rendering and settings interfaces, is [`landscape/SPEC.md`](../landscape/SPEC.md).

## Run it

Build and verify the dataset once. The output directory must be new or empty.

```sh
./build_local/buv -ns -tc=landscape_build -cfg=configs/buv_explorer.json \
  -outDir="/Volumes/4T Data/buv_render/landscape_966827"
./build_local/buv -ns -tc=landscape_verify -cfg=configs/buv_explorer.json \
  -data="/Volumes/4T Data/buv_render/landscape_966827" \
  -checkpoint="/Volumes/4T Data/buv_render/renderer_before_965400.bin"
```

Use `-outDir=`. doctest treats `-out=` and `-o=` as its own report file and truncates that path before any task runs, so the build refuses them. Optional build arguments are `-end=BLOCK` for a shorter development dataset, `-snapshotBytes=` (default 16 MiB) and `-threads=`. The build reads the BLK file, its index and `utxo_history.bin` read-only and refuses any axis other than the published film axis.

Serve the app, then open http://127.0.0.1:12990/ in a WebGPU browser (tested: Chrome 154, Safari 27.0.1 and the Codex in-app browser):

```sh
node landscape/tools/serve.mjs --data "/Volumes/4T Data/buv_render/landscape_966827"
```

The inspector's history section reads the native explorer's cell API. Run a second explorer next to the installed one, which stays on port 12988:

```sh
./build_local/buv -ns -tc=utxo_explorer -cfg=configs/buv_explorer.json -port=12989
```

`?webgl=1` forces the WebGL2 fallback. Presets are then capped at High, and the features that need compute shaders (instanced columns, SSGI, automatic exposure) are off. The URL hash keeps the block, camera, navigation mode, preset and setting overrides, so a copied link reproduces the view.

## Online

The landscape runs publicly at **https://3d.bitcointimelapse.com/**, also reachable at https://utxo-landscape.nostisos.workers.dev/. A separate Cloudflare Worker, `utxo-landscape`, serves the app from Workers Static Assets and the dataset from the 2D explorer's private R2 bucket under `landscape/d970658-20261009/` (blocks 0–970,658), and it answers the inspector's cell lookups from the explorer's history shards. [`cloudflare/utxo-landscape-worker/README.md`](../cloudflare/utxo-landscape-worker/README.md) covers deploying, publishing a dataset for a new tip and rolling back. The guide and the 2D explorer do not link to the landscape yet.

Three things change online, all decided in `landscape/web/ui/online.js`:

- The app loads the dataset named in `/dataset/index.json`, so a new tip only changes the Worker's release file. Each tip is a full, immutable dataset under its own prefix.
- A first visit, with no saved settings and none in the link, starts at Balanced with automatic resolution scaling (target 60 fps, scale 0.5–1). A browser without WebGPU, a touch-only device or one that reports 4 GB of memory or less starts at Performance and says so. Saved and linked settings take precedence, every preset stays one click away, and `?startup=high` gives the local default.
- The inspector's history section asks `/api/landscape/cell` on the same origin, and its 2D link opens https://bitcointimelapse.com/explorer at the nearest pixel.

The cell API reuses the 2D explorer's lifecycle code: `lifecycleJson` was extracted from `/api/pixel` in `cloudflare/utxo-video-worker/src/history.js` and is bundled into the landscape Worker. The 2D Worker itself was not redeployed. Against the same R2 data, the refactored code answers 27 sampled `/api/pixel` queries byte-identically to the old code and to the live 2D explorer.

### Online measurements

Measured on 2026-10-08 from this Mac over a home connection in Toronto (served from Cloudflare's Toronto location), in Chrome 154 with a fresh profile, so on the first-visit settings. The replay downloaded at roughly 13–18 MiB/s.

| Measure | Result |
|---|---|
| Upload | 5,478 data files in 44.6 min (26.8 MiB/s, eight parallel single-part uploads), then the manifest. All 5,479 objects, 75,324,834,046 bytes, match the local files by size and MD5. |
| First visit | Balanced with auto scale. The exact tip appears 1.5–2.0 s after navigation, after 6.9 MB in 101 requests. |
| Random seeks, 30 blocks | Median 1.48 s, 95th percentile 1.97 s from cold R2 (one outlier at 6.6 s). The same 30 blocks again with Cloudflare's cache warm: 0.86 s and 1.14 s. Every seek landed exactly. |
| 1× from block 840,000 | 3,602 blocks in 60.0 s, exact, with no snapshot shortcut and never behind. |
| 10× from block 630,000 | 446 blocks/s, limited by the download; the HUD showed the achieved rate. |
| Max | 1,040 blocks/s at 630,000 and 667 at 840,000. |
| Replay worker memory | 526 MB |
| 4K, headed fullscreen (3840 × 2072) | First visit: Balanced at full resolution, 119.6 fps (the display's 120 Hz cap), 5.4 ms GPU. Ultra at block 630,000 with the inspector open: 61.5 fps at full resolution, 14.8 ms GPU. |
| Browser checks | `shell-browser-checks.mjs` passes 43 of 43 in Chrome and in Brave against https://3d.bitcointimelapse.com/. |
| Cell API against the native explorer | 24 of 26 sampled cells identical. The other two are the densest cell at the tip (column 15,100, row 1,822), queried at the tip and with a block beyond it; they differ only in the `pop` curve, from floating-point histogram bin edges, as `/api/pixel` does against the native explorer. Median 260 ms per lookup. |

Playback streams the change log. After block 420,000, 1× needs about 1.2–2.2 MiB/s and 10× about 12–22 MiB/s, so 1× suits most broadband connections while 10× and Max follow the connection's speed. Each seek replays up to 16 MiB of changes from the nearest snapshot, which accounts for most of an online seek.

Storing the dataset costs about 1.1 USD a month in R2 (75 GB); R2 charges nothing for egress. Cloudflare Web Analytics counts visits: the zone injects its beacon into every page, and both this site's and the 2D explorer's Content Security Policy allow it.

## Controls

| Keys or gesture | Action |
|---|---|
| Space | Play or pause |
| `[` / `]` | Back or forward one block (exact) |
| Shift + `[` / `]` | Back or forward 1,008 blocks (about a week) |
| 1, 2, 3, 4 | Speed 1×, 10×, 100×, Max |
| Drag | Pan; the grabbed point stays under the cursor |
| Right-drag or Shift-drag | Orbit around the point under the cursor |
| Wheel or trackpad pinch | Zoom toward the cursor |
| Double-click | Fly to that point |
| Click or I | Inspect the cell under the cursor (crosshair in flight mode) |
| Arrows, Q/E, PgUp/PgDn | Pan, rotate, tilt |
| F | Flight mode: mouse look, WASD, E/Q up and down, Shift 4×, wheel sets speed; Esc returns to map mode |
| G, P, H or ? | Graphics settings, places, help |

On a touch screen, map mode follows the conventions of map apps. Every gesture keeps the ground under your fingers where it is:

| Gesture | Action |
|---|---|
| One finger | Pan; the ground stays under your finger |
| Pinch | Zoom around the point between your fingers |
| Twist | Rotate around the point between your fingers |
| Two fingers up or down | Tilt toward the horizon or toward a top view |
| Tap | Inspect the cell |
| Double-tap | Fly closer to that point; keep the second tap down and drag down or up to zoom in or out |
| Two-finger tap | Zoom out |

Pinch, twist and a two-finger drag combine in one movement, as in a map app. Moving both fingers up or down together, side by side, tilts instead. Over empty ground or the sky, gestures stay at the landscape's scale, so a pinch near the horizon cannot throw the camera thousands of units away. The page itself never zooms. Flight mode needs a keyboard to enter; on a touchscreen laptop, one finger then looks around and two fingers fly (spread to go forward, drag to slide or climb). The help panel lists the touch gestures first on touch-only devices, and the first visit shows a one-line hint.

Phones get their own layout below 700 px of width, or below 500 px of height in landscape. The HUD shrinks to the block, date and play state (tap it for the totals). The minimap, legend and block and date fields are hidden, and the timeline keeps the scrubber, transport, one speed button that cycles through 1×, 10×, 100× and Max, and Places, Settings and Help, with 40 px touch targets. In portrait the inspector and the settings open as sheets from the bottom; in landscape they open at the right. When the inspector's sheet would cover the tapped cell, the view slides so the cell stays visible beside it. In portrait the first view looks along the block axis from beyond the tip, so the landscape fills the screen. Safe areas such as the iPhone home indicator are respected.

Places jumps to the eras at blocks 50,000, 210,000, 314,000, 420,000, 500,000, 630,000, 700,000, 840,000, 900,000 and the tip, or flies to the amount bands: the 50 BTC coinbase row, 10 BTC and up, 1 BTC, 10,000 sat, 546 sat and 1–100 sat. The timeline accepts a block height or a UTC date.

## How it works

### Grid and measures

Level 0 cells cover 64 creation blocks and one film amount row, 15,167 × 2,072 cells for blocks 0–970,658. Each coarser level doubles the block width and doubles the rows per cell up to 16. Every level is cut into 256 × 256 tiles, 758 tiles in all:

| Level | Columns × rows | Tiles |
|---|---|---|
| 0 | 15,167 × 2,072 | 60 × 9 |
| 1 | 7,584 × 1,036 | 30 × 5 |
| 2 | 3,792 × 518 | 15 × 3 |
| 3 | 1,896 × 259 | 8 × 2 |
| 4 | 948 × 130 | 4 × 1 |
| 5 | 474 × 130 | 2 × 1 |
| 6 | 237 × 130 | 1 × 1 |

A cell stores four exact integers: the count and satoshi sum of outputs up to 5 BTC and of outputs above 5 BTC. Weighted density is `countSmall + satsLarge / 5 BTC`, the film's persistent density; count is both counts; value is the satoshi sum in BTC. Coarser levels show the mean per level-0 cell. Zero-value outputs are skipped, as the renderer does. The amount row of an output comes from the compiled C++ mapper through `rows.bin`, because the project's `-ffast-math` build moves one row boundary by 1 sat compared with strict IEEE arithmetic (779,521,282,186 sat sits in row 49).

### Dataset

| File | Contents |
|---|---|
| `manifest.json` | Grid, axis, source identity, snapshot schedule and build measurements; written last, so its presence means the build completed |
| `rows.bin`, `blocktimes.bin` | Smallest amount of each row; block timestamps from `BUVHIST1` |
| `chunks.json`, `chunks/` | 4,383 exact copies of the BLK2 records, block-aligned, up to 4 MiB each |
| `snapshots/` | 1,092 `BUVLSN1` snapshots of the exact state, after block 0, then every 16 MiB of change data, and at the tip |

A snapshot stores every level. A per-tile directory with CRC-32 checksums lets the browser fetch only the tiles it needs with HTTP range requests. Each snapshot describes the grid of blocks 0 through its own block, so a block's snapshot is byte-identical in every dataset that contains it; readers place its tiles by level and position in the larger dataset grid (`landscape/SPEC.md` §4). Snapshots written before October 9, 2026 record their dataset's block count and remain readable.

### Exact replay in the browser

The worker keeps exact Float64 state for the resident tiles at every level and decodes BLK2 records exactly as `ChangesInBlock::decode` does. A seek picks the cheapest start: the current state, the nearest snapshot below with forward replay, or the nearest snapshot above with backward replay. Coarse tiles arrive first, so an exact overview appears before the detail. Tiles stream to the main thread as 258 × 258 cells with a one-cell border, followed by per-cell changes. Change chunks are cached (512 MB LRU, read ahead in the playback direction), and a memory guard keeps tiles plus cache under 1.4 GB.

| Speed | Behaviour |
|---|---|
| 1× | 60 blocks/s, exact |
| 10× | 600 blocks/s, exact; the HUD shows the achieved rate if the worker falls behind |
| 100× | The target moves at 6,000 blocks/s; small gaps replay exactly, large gaps seek to the snapshot at or below the target |
| Max | Back-to-back exact replay |
| Scrubbing | The snapshot at or below the handle while dragging, then an exact seek on release |

Activity heat adds the BTC each spend moves to its cell and decays with a half-life in blocks. Seeks and backward steps clear it, and pausing keeps it. Every spend makes its cell glow: at least a floor brightness (as every spent output flashes in the film), brighter for more BTC moved, and dimmer for coins created within the last four weeks, which are spent constantly. Spends also get flash sprites that keep a minimum on-screen size, so activity stays visible from far away.

### Rendering

Rendering uses three.js 0.186.0 `WebGPURenderer` with TSL node materials, vendored unmodified in `landscape/web/vendor/three/`. The terrain draws from a GPU tile atlas and always uses the deepest fully resident level, so there are no holes or overlaps. Heightfield patches are displaced in the vertex stage, with normals from neighbouring cells and bicubic derivatives when bicubic smoothing is on. Stepped cells, subdivision up to 4 and skirts are options. Column mode draws one instanced box per occupied level-0 cell near the camera focus; a compute pass builds the instances and an indirect draw renders them. The Film palette path compares against a 255-entry boundary table generated from the compiled `DensityToImage`, because AppleClang fuses its `mK*x + mD` and about 400 boundary densities would otherwise land one index off.

The frame pipeline adds cascaded sun shadows (PCF or PCSS), hemisphere light, sky, stars, height fog, a sun-shadowed volumetric fog at half resolution, screen-space god rays, GTAO or SSAO, SSGI, SSR at half resolution, bloom, depth of field with autofocus, motion blur, six tone mappers, manual or automatic exposure (luminance histogram in a compute pass), a colour grade, a `.cube` 3D LUT, grain, chromatic aberration, vignette, and FXAA, SMAA, TRAA or 2×/4× supersampling. Only enabled passes are built. Numeric and colour settings update uniforms, and structural switches rebuild only the affected pass. The overlay reports GPU time from timestamp queries; Apple GPUs overlap pass intervals, so it shows their union.

## Presets and measured performance

| Preset | What it turns on |
|---|---|
| Film | Unlit film colours: weighted density through the film palette (white-hot rows at 10 BTC and above), stepped cells, black background and ground; no grid, lighting, shadows, fog, sky, tone mapping or post effects. Heat glow and flashes still appear during playback, like the film's activity flashes, and are zero right after a seek. |
| Performance | 75% resolution, FXAA, no shadows or ambient occlusion, light bloom, 96 resident tiles, coarser detail |
| Balanced | Native resolution, SMAA, two 2048 shadow cascades, SSAO, bloom, 160 resident tiles |
| High | Startup preset: TRAA, three 2048 shadow cascades, GTAO, bloom, fog, sky, stars, 225 resident tiles |
| Ultra | High plus three 4096 shadow cascades, volumetric light, god rays and bicubic smoothing; targets 60 fps at 4K |
| Extreme | Ultra plus a fourth cascade, 2× supersampling, softer shadows, GTAO with 32 samples, SSR, 64 volumetric steps, motion blur, subdivision 2, finer detail and up to 2 million instanced columns; deliberately GPU-bound |

Measured in Chrome 154 on the 120 Hz LG 3840 × 2160 display (headed window, exact 3840 × 2160 viewport), full dataset at the tip, M4 Max with 40 GPU cores. Figures are fps (GPU ms) and GPU busy time from `landscape/tools/gpu-util.mjs`, the counter Activity Monitor's GPU history shows. The display caps frame rate at 120.

| Preset | Overview | Close view | GPU busy |
|---|---|---|---|
| Film | 118.9 (5.5) | 119.7 (8.8) | 75% / 97% |
| Performance¹ | 120 (3.7) | 119.5 (5.5) | 60–73% |
| Balanced¹ | 120 (4.9) | 118.7 (6.9) | 69–87% |
| High | 119.1 (8.4) | 92.6 (10.8) | 99% |
| Ultra | 86.2 (11.5) | 73.2 (13.5) | 99% |
| Extreme | 33.5 (29.9; frame 28.4 ms) | 16.2 (62.9) | 99% |

¹ From the earlier runs of the same session (the close view at 3840 × 2072 in fullscreen); the other rows come from the final run.

Ultra originally used four cascades and measured 59.2–65 fps in the close view. The fourth cascade cost 1.1 ms while shadow-map size and bicubic smoothing cost nothing measurable, so Ultra now uses three 4096 cascades. Extreme keeps the GPU 99% busy, with GPU time about equal to frame time.

Safari 27.0.1 in a 3840 × 2078 window on the same display (overview at the tip): High 60.1 fps (7.8 ms GPU), Ultra 60 fps (10.5 ms), Extreme 30.7 fps (32.5 ms). Safari limits animation frames to 60 Hz; Ultra's GPU time leaves room under that cap. GPU busy time reached 100% during Extreme.

To repeat the measurement, open `/dev/render_post-bench.html?terrain=real&block=966827&cam=overview&warm=4000&measure=6000` (or `cam=close`, or `presets=High,Ultra`) and run `node landscape/tools/gpu-util.mjs --interval 500 --duration 120` alongside. Results appear at the top right and in `window.__benchResult`.

## Settings reference

The settings panel (G) is generated from `landscape/web/settings.schema.js`: 137 settings in seven groups, presets with a Custom state and override list, per-group and global reset, search, JSON export and import, a share link, a gradient editor and `.cube` LUT loading. Personal preferences such as camera feel and overlays are never changed by presets. The table below is generated from the schema.

### Colour

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Palette <br><code>color.palette</code> | film, turbo, viridis, inferno, magma, plasma, cividis, grey, custom | film | — | Colour map. Film is the film palette (site/assets/palettes.json base, with the white-hot variant on whale rows). |
| Custom gradient <br><code>color.gradient</code> | ≤ 16 stops | 5 stops | — | Stops {t 0..1, colour} used when Palette is Custom gradient: 2 to 16 stops, sorted by t, interpolated in sRGB like the panel preview. |
| Reverse palette <br><code>color.reverse</code> | bool | off | — | Flip the palette end to end (applies to the white-hot variant too). |
| Colour measure <br><code>color.measure</code> | height, density, count, value | height | Film density | rebuilds worker. Value that drives colour. Same as height follows Amplification > Measure. Values are per L0 cell (coarser levels show the mean). |
| Log offset <br><code>color.offset</code> | 0.0001–10,000 (log) | 30 | — | t = (ln(v + o) - ln(1 + o)) / (ln(U + o) - ln(1 + o)), clamped to 0..1. Larger o compresses the low end. Film: 30. |
| Upper limit <br><code>color.upper</code> | 1.01–10,000,000 (log) | 500 | — | Colour value U that reaches the top of the palette. Film: 500. |
| Transfer gamma <br><code>color.gamma</code> | 0.2–5 (log) | 1 | — | Exponent applied to t before the palette lookup; below 1 brightens low values. Film: 1. |
| White-hot whale rows <br><code>color.whiteHot</code> | bool | on | — | Use the white-hot palette variant on rows at or above the whale threshold, as the film does. |
| Whale threshold (BTC) <br><code>color.whiteHotBTC</code> | 1e-8–100,000 (log) BTC | 10 | — | Rows whose amounts are at least this many BTC count as whale rows (white-hot palette and the whale height multiplier). Film: 10 BTC. |
| Background <br><code>color.background</code> | color | #05070c | Film #000000 | Clear colour behind the landscape; the sky gradient covers it when Sky is on. Film: black. |
| Empty cells <br><code>color.ground</code> | color | #0c0f15 | Film #000000 | Colour of cells with no outputs (v <= 0). Film: black. |
| Fog <br><code>color.fog</code> | color | #141b2b | — | Fog and volumetric scattering colour. |
| Heat colour <br><code>color.heat</code> | color | #ffe9c4 | Film #ffffff | Colour of spend flashes: the glow on cells whose outputs were just spent, and the flash sprites. |
| Heat gain <br><code>color.heatGain</code> | 0–20 | 2.5 | — | Overall brightness of spend flashes on the terrain; 0 hides them. Above 1 they glow through bloom. |
| Hue shift <br><code>color.hueShift</code> | -180–180 deg | 0 | — | Rotates every hue by this many degrees. |
| Saturation <br><code>color.saturation</code> | 0–2 | 1 | — | 0 = greyscale, 1 = unchanged, 2 = double. |
| Contrast <br><code>color.contrast</code> | 0–2 | 1 | — | Contrast around mid grey; 1 = unchanged. |
| Temperature <br><code>color.temperature</code> | -1–1 | 0 | — | White balance: -1 cool (blue) to +1 warm (amber). |
| Tint <br><code>color.tint</code> | -1–1 | 0 | — | White balance: -1 green to +1 magenta. |
| Lift <br><code>color.lift</code> | -0.5–0.5 | 0 | — | Shadow offset, tinted by Lift colour: out = (in * gain * gainColour + lift * liftColour * (1 - in)) ^ (1 / gamma). |
| Lift colour <br><code>color.liftColor</code> | color | #ffffff | — | Tint of the lift (white = neutral). |
| Gamma <br><code>color.gradeGamma</code> | 0.2–5 (log) | 1 | — | Midtone gamma of the grade; 1 = unchanged. |
| Gain <br><code>color.gain</code> | 0–4 | 1 | — | Highlight multiplier, tinted by Gain colour; 1 = unchanged. |
| Gain colour <br><code>color.gainColor</code> | color | #ffffff | — | Tint of the gain (white = neutral). |
| Tone mapping <br><code>color.toneMapping</code> | none, linear, reinhard, aces, agx, neutral | agx | Film none | rebuilds post. HDR to display mapping. Film: none. |
| Exposure mode <br><code>color.exposureMode</code> | manual, auto | manual | — | rebuilds post. Auto measures a luminance histogram with a compute pass (WebGPU only). |
| Exposure <br><code>color.exposure</code> | 0.01–16 (log) x | 1 | — | Linear exposure multiplier; in auto mode it is the compensation applied on top. Film: 1. |
| Auto minimum <br><code>color.autoExposureMin</code> | 0.01–16 (log) x | 0.25 | — | WebGPU only. Lowest exposure multiplier auto exposure may choose. |
| Auto maximum <br><code>color.autoExposureMax</code> | 0.01–16 (log) x | 4 | — | WebGPU only. Highest exposure multiplier auto exposure may choose. |
| Auto speed <br><code>color.autoExposureSpeed</code> | 0.1–10 (log) /s | 1.5 | — | WebGPU only. Adaptation rate per second. |
| 3D LUT (.cube) <br><code>color.lut</code> | file | — | — | personal preference, rebuilds post. A .cube 3D LUT applied after the grade. Value {name, text}: kept in memory and in JSON exports, never in the URL. |
| LUT intensity <br><code>color.lutIntensity</code> | 0–1 | 1 | Film 0 | Mix between the graded image (0) and the LUT result (1). |
| Display P3 output <br><code>color.p3</code> | bool | off | — | rebuilds post. Wide-gamut Display P3 canvas where the browser supports it. Film: off (sRGB). |

### Amplification

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Measure <br><code>amp.measure</code> | density, count, value | density | — | rebuilds worker. Height value per L0 cell: weighted density = outputs up to 5 BTC + (BTC above 5 BTC outputs) / 5; count = outputs; value = BTC. Coarser levels show the mean per L0 cell. |
| Height curve <br><code>amp.curve</code> | log, power, linear | log | — | log: ln(1 + e v) / ln(1 + e R); power: (v / R) ^ exponent; linear: v / R (e = exposure, R = reference). |
| Power exponent <br><code>amp.exponent</code> | 0.05–4 (log) | 0.5 | — | Exponent of the power curve. |
| Log exposure <br><code>amp.exposure</code> | 0.0001–10,000 (log) | 1 | — | Value normalisation e of the log curve; higher lifts small values. The power and linear curves ignore it. |
| Reference value <br><code>amp.reference</code> | 0.001–10,000,000 (log) | 500 | — | Value R at which the curve reaches 1, i.e. Exaggeration world units of height. |
| Exaggeration <br><code>amp.exaggeration</code> | 0–200 world units | 10 | — | Height at curve value 1. The landscape is 966.8 units wide (block / 1000) and 207.2 deep (row / 10). |
| Floor height <br><code>amp.floor</code> | 0–5 world units | 0.05 | — | Minimum height added to every occupied cell so sparse cells stay visible; empty cells stay at 0. |
| Whale multiplier <br><code>amp.whale</code> | 0–10 x | 1 | — | Height multiplier for rows at or above Colour > Whale threshold. |
| Heat half-life (blocks) <br><code>amp.heatHalfLife</code> | 0.5–100,000 (log) blocks | 30 | — | rebuilds worker. A spend flash fades to half every this many blocks (30 blocks = 0.5 s at 1x, about 5 hours of chain time). |
| Flash floor <br><code>amp.heatFloor</code> | 0–1 | 0.35 | — | Brightness every spend reaches at its block, whatever its amount (as every spent output flashes in the film); 0 makes brightness depend only on the BTC moved. |
| Full flash at (BTC) <br><code>amp.heatReference</code> | 0.001–100,000 (log) BTC | 100 | — | BTC moved from one cell (summed with its recent spends) that reaches full flash brightness; smaller spends scale down logarithmically to the floor. |
| Edge flash strength <br><code>amp.heatEdge</code> | 0–1 | 0.3 | — | Brightness of flashes for coins created within the edge flash window of the current block, ramping to full beyond it. Young coins are spent constantly; the film also keeps those flashes small. 1 treats them like old coins. |
| Edge flash window (blocks) <br><code>amp.heatEdgeBlocks</code> | 1–100,000 (log) blocks | 4,032 | — | Coins created within this many blocks of the current block count as creation-edge spends for Edge flash strength (4,032 blocks = about four weeks, close to the film's creation-edge flash zone). |
| Flash size <br><code>amp.flashSize</code> | 0–10 | 1 | — | Size of the flash sprites over spent cells: at least 3 px on screen, growing to 16 px at the full-flash amount, smaller for coins spent near the creation edge. 0 hides them. |
| Flash threshold (BTC) <br><code>amp.flashThreshold</code> | 1e-8–100,000 (log) BTC | 0.0001 | — | Smallest BTC moved from one cell within one block that spawns a flash sprite; the default skips dust. Up to 400 new sprites per frame, old coins and larger amounts first. |
| Creation-edge glow <br><code>amp.edgeGlow</code> | 0–10 | 1 | Film 0 | Emissive boost on outputs created in the most recent blocks; 0 = off. |
| Edge width (blocks) <br><code>amp.edgeBlocks</code> | 1–100,000 (log) blocks | 1,008 | — | Width of the creation-edge glow, counted back from the current block (1,008 blocks = about one week). |
| Now plane <br><code>amp.nowPlane</code> | 0–1 | 0.15 | Film 0 | Opacity of the translucent vertical plane at the current block; 0 = off. |

### Geometry

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Smoothing <br><code>geo.smoothing</code> | none, bilinear, bicubic | bilinear | Film none; Ultra bicubic; Extreme bicubic | rebuilds material. Height interpolation between cell centres. Changes the surface only when Subdivision is 2 or 4 (at 1x every vertex sits on a cell centre); Stepped cells ignore it. |
| Stepped cells <br><code>geo.stepped</code> | bool | off | Film on | rebuilds material. Flat-topped cells with vertical walls; each cell shows exactly one palette colour. Ignores Smoothing and Subdivision. |
| Subdivision <br><code>geo.subdivision</code> | 1, 2, 4 | 1 | Extreme 2 | rebuilds terrain. Heightfield vertices per cell edge (more = smoother bicubic surfaces, more triangles). |
| Skirts <br><code>geo.skirts</code> | bool | on | — | rebuilds terrain. Vertical skirts hide cracks between tiles of different levels. |
| Wireframe <br><code>geo.wireframe</code> | bool | off | — | personal preference, rebuilds material. Draw the terrain as wireframe (diagnostic). |
| Column mode <br><code>geo.columns</code> | bool | off | Extreme on | WebGPU only, rebuilds terrain. One instanced box per occupied L0 cell near the view focus; the heightfield continues beyond the radius. Needs WebGPU compute. |
| Column radius <br><code>geo.columnRadius</code> | 16–8,192 (log) L0 cells | 512 | Extreme 1,024 | WebGPU only. Columns are drawn within this many L0 cells of the view focus. |
| Instance budget <br><code>geo.instanceBudget</code> | 10,000–8,000,000 (log) | 1,000,000 | Extreme 2,000,000 | WebGPU only, rebuilds terrain. Maximum instanced columns per frame (up to 8,000,000). |
| Column gap <br><code>geo.columnGap</code> | 0–0.9 | 0.12 | — | WebGPU only. Fraction of each cell footprint left empty between columns. |
| LOD bias <br><code>geo.lodBias</code> | -3–3 | 0 | — | +1 asks for one level finer detail, -1 one level coarser (refinement threshold = pixels per cell x 2^-bias). |
| Pixels per cell <br><code>geo.pixelsPerCell</code> | 0.5–32 (log) px | 3 | Performance 6; Balanced 4; Extreme 2 | Refine a tile while its cells cover more than this many screen pixels; lower = finer, more tiles. |
| Tile budget <br><code>geo.tileBudget</code> | 32–400 | 225 | Performance 96; Balanced 160; Extreme 320 | rebuilds terrain. Maximum resident tiles in the worker and the GPU atlas (each costs about 1 MB of GPU memory and 2 MB in the worker). |

### Lighting

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Sun azimuth <br><code>light.sunAzimuth</code> | 0–360 deg | 225 | — | Direction the sunlight comes from, clockwise seen from above: 0 = from -z (large-amount rows), 90 = from +x (tip), 180 = from +z (default camera side), 270 = from -x (genesis). |
| Sun elevation <br><code>light.sunElevation</code> | -5–90 deg | 35 | — | Height of the sun above the horizon. |
| Sun intensity <br><code>light.sunIntensity</code> | 0–20 | 3 | Film 0 | Directional light intensity. Film: 0. |
| Sun colour <br><code>light.sunColor</code> | color | #fff1dc | — | Colour of the directional light. |
| Sky light <br><code>light.skyColor</code> | color | #9bb7ff | — | Hemisphere light colour from above. |
| Ground light <br><code>light.groundColor</code> | color | #2a2420 | — | Hemisphere light colour from below. |
| Ambient intensity <br><code>light.ambient</code> | 0–5 | 0.6 | Film 0 | Hemisphere (sky and ground) light intensity. Film: 0. |
| Rim light <br><code>light.rim</code> | 0–5 | 0.35 | Film 0 | Fresnel rim light that outlines peaks against the background. Film: 0. |
| Rim colour <br><code>light.rimColor</code> | color | #8fb8ff | — | Colour of the rim light. |
| Emissive strength <br><code>light.emissive</code> | 0–10 | 0.4 | Film 1 | Self-illumination by the palette colour. Emissive 1 with albedo 0 shows the unlit palette colour (Film). |
| Albedo <br><code>light.albedo</code> | 0–1 | 0.85 | Film 0 | Diffuse reflectance as a fraction of the palette colour. Film: 0. |
| Roughness <br><code>light.roughness</code> | 0–1 | 0.65 | — | Surface roughness of the terrain material. |
| Metalness <br><code>light.metalness</code> | 0–1 | 0.05 | — | Metalness of the terrain material. |
| Floor reflection <br><code>light.floorReflection</code> | 0–1 | 0 | — | Makes the ground (empty cells) a mirror through screen-space reflections; needs Effects > SSR. 0 = off. |
| Shadows <br><code>light.shadows</code> | bool | on | Film off; Performance off | rebuilds shadows. Sun shadows through cascaded shadow maps. Film: off. |
| Cascades <br><code>light.cascades</code> | 1–4 | 3 | Performance 2; Balanced 2; Extreme 4 | rebuilds shadows. Cascaded shadow map splits. |
| Shadow map size <br><code>light.shadowMapSize</code> | 1024, 2048, 4096 | 2,048 | Performance 1,024; Ultra 4,096; Extreme 4,096 | rebuilds shadows. Resolution of each cascade. |
| Shadow filter <br><code>light.shadowFilter</code> | basic, pcf, vsm, pcss | pcf | — | rebuilds shadows. Shadow filtering. PCSS softens shadows with distance from the occluder (custom filter node; measured about +10 ms per frame at 4K on the M4 Max). |
| Softness <br><code>light.shadowSoftness</code> | 0–10 | 1 | Extreme 1.5 | Filter radius (shadow.radius); light size for PCSS. |
| Bias <br><code>light.shadowBias</code> | -0.01–0.01 | -0.0005 | — | Depth bias against shadow acne. |
| Fog density <br><code>light.fogDensity</code> | 0–0.05 (log) | 0.002 | Film 0 | Fog density per world unit; 0 = no fog. Film: 0. |
| Fog height falloff <br><code>light.fogHeightFalloff</code> | 0–1 (log) | 0.05 | — | Fog thins with height: density * exp(-falloff * y). 0 = uniform fog. |
| Volumetric light <br><code>light.volumetric</code> | bool | off | Ultra on; Extreme on | rebuilds post. Ray-marched height-fog volume lit by the sun with its own shadow map, so peaks cast shafts through the haze. Density follows Fog density and Fog height falloff. |
| Volumetric steps <br><code>light.volumetricSteps</code> | 8–256 (log) | 32 | Extreme 64 | Ray-march steps of the half-resolution volumetric pass. |
| Volumetric intensity <br><code>light.volumetricIntensity</code> | 0–4 | 1 | — | Scales the scattered light. |
| God rays <br><code>light.godRays</code> | bool | off | Ultra on; Extreme on | rebuilds post. Screen-space light shafts: a half-resolution radial blur of the sky around the sun position on screen, visible when the sun is near or in view. Needs no shadows; shadowed shafts through the haze come from Volumetric light. |
| God ray intensity <br><code>light.godRaysIntensity</code> | 0–4 | 1 | — | Strength of the light shafts. |
| Sky <br><code>light.sky</code> | bool | on | Film off | Sky gradient dome, which covers the background colour. Film: off. |
| Stars <br><code>light.stars</code> | bool | on | Film off | Star field. Film: off. |
| Star density <br><code>light.starDensity</code> | 0–1 | 0.5 | — | Fraction of the star field shown. |

### Effects

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Ambient occlusion <br><code>fx.ao</code> | off, ssao, gtao | gtao | Film off; Performance off; Balanced ssao | rebuilds post. Screen-space ambient occlusion. Film: off. |
| AO radius <br><code>fx.aoRadius</code> | 0.05–10 (log) world units | 1 | — | Occlusion sampling radius. |
| AO intensity <br><code>fx.aoIntensity</code> | 0–4 | 1 | — | Darkening strength. |
| AO samples <br><code>fx.aoSamples</code> | 4–64 | 16 | Performance 8; Balanced 8; Extreme 32 | rebuilds post. Samples per pixel. |
| SSGI <br><code>fx.ssgi</code> | bool | off | — | WebGPU only, rebuilds post. Screen-space global illumination: indirect light and colour bleeding between peaks. |
| SSGI steps <br><code>fx.ssgiSamples</code> | 4–32 | 8 | — | WebGPU only. SSGINode stepCount; slices = ceil(steps / 8); samples per pixel = slices * steps * 2. |
| SSGI intensity <br><code>fx.ssgiIntensity</code> | 0–4 | 1 | — | WebGPU only. Strength of the indirect light. |
| SSR <br><code>fx.ssr</code> | bool | off | Extreme on | rebuilds post. Screen-space reflections. |
| SSR intensity <br><code>fx.ssrIntensity</code> | 0–2 | 1 | — | Reflection strength. |
| SSR steps <br><code>fx.ssrSteps</code> | 8–64 | 32 | — | Ray-march steps (SSRNode quality = steps / 64). |
| Bloom <br><code>fx.bloom</code> | bool | on | Film off | rebuilds post. Glow around bright pixels. Film: off. |
| Threshold <br><code>fx.bloomThreshold</code> | 0–4 | 0.85 | — | Luminance above which pixels bloom. |
| Strength <br><code>fx.bloomStrength</code> | 0–3 | 0.6 | — | Bloom intensity. |
| Radius <br><code>fx.bloomRadius</code> | 0–1 | 0.4 | — | Bloom spread (0..1). |
| Mip levels <br><code>fx.bloomMips</code> | 1–5 | 5 | Performance 4 | rebuilds post. Narrows the glow by dropping the widest mips. It does not reduce GPU cost: the stock BloomNode always runs 5 passes. |
| Depth of field <br><code>fx.dof</code> | bool | off | — | rebuilds post. Blur outside the focal plane. |
| Auto focus <br><code>fx.dofAutoFocus</code> | bool | on | — | Focus on the terrain at screen centre (the crosshair). |
| Focus distance <br><code>fx.dofFocus</code> | 0.5–2,000 (log) world units | 100 | — | Focus distance when auto focus is off. |
| Aperture <br><code>fx.dofAperture</code> | 0.1–10 (log) | 1 | — | Bigger = shallower focus. |
| Max blur <br><code>fx.dofMaxBlur</code> | 0–20 | 4 | — | Largest bokeh size. |
| Motion blur <br><code>fx.motionBlur</code> | bool | off | Extreme on | rebuilds post. Velocity-based blur while the camera or terrain moves. |
| Amount <br><code>fx.motionBlurAmount</code> | 0–2 | 0.5 | — | Velocity scale; 1 = one frame of motion. |
| Film grain <br><code>fx.grain</code> | 0–1 | 0 | — | Grain intensity; 0 = off. |
| Chromatic aberration <br><code>fx.chromatic</code> | 0–2 | 0 | — | Colour fringing towards the edges; 0 = off. |
| Vignette <br><code>fx.vignette</code> | 0–1 | 0 | — | Darkening towards the corners; 0 = off. |

### Camera

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Field of view <br><code>camera.fov</code> | 15–110 deg | 50 | — | personal preference. Vertical field of view. |
| Flight speed <br><code>camera.flySpeed</code> | 0.05–50 (log) x | 1 | — | personal preference. Flight speed multiplier; speed also scales with height above the terrain and the wheel changes it in flight. |
| Mouse sensitivity <br><code>camera.sensitivity</code> | 0.1–5 (log) x | 1 | — | personal preference. Mouse look and orbit sensitivity. |
| Invert Y <br><code>camera.invertY</code> | bool | off | — | personal preference. Invert vertical mouse look in flight mode. |
| Damping <br><code>camera.damping</code> | 0–0.95 | 0.2 | — | personal preference. Smoothing of camera motion: 0 = immediate, higher = smoother. |
| Terrain collision <br><code>camera.collision</code> | bool | on | — | personal preference. Keep the camera above the terrain surface. |

### Display

| Setting | Range / options | Default (High) | Preset changes | Notes |
|---|---|---|---|---|
| Resolution scale <br><code>display.scale</code> | 0.25–2 x | 1 | Performance 0.75 | Render resolution as a multiple of devicePixelRatio (2 = 7680x4320 on a 3840x2160 canvas). |
| Auto scale <br><code>display.autoScale</code> | bool | off | — | personal preference. Adjust the scale between minimum and maximum to hold the target frame rate. A personal preference: presets leave it alone, so turn it off to let Ultra or Extreme load the GPU fully. |
| Target fps <br><code>display.targetFps</code> | 24–240 fps | 60 | — | personal preference. Frame rate auto scale aims for. |
| Auto minimum <br><code>display.scaleMin</code> | 0.25–2 x | 0.5 | — | personal preference. Lowest scale auto scale may choose. |
| Auto maximum <br><code>display.scaleMax</code> | 0.25–2 x | 2 | — | personal preference. Highest scale auto scale may choose. |
| Anti-aliasing <br><code>display.aa</code> | none, fxaa, smaa, traa | traa | Film none; Performance fxaa; Balanced smaa | rebuilds post. Post-process anti-aliasing. Film: none. |
| Supersampling <br><code>display.ssaa</code> | 1, 2, 4 | 1 | Extreme 2 | rebuilds post. Supersamples the scene pass only, at sqrt(N) times the resolution per axis (4 = 2x2), resolved by an exact box downsample. Effects run at output resolution; TRAA is skipped while supersampling is on. |
| Performance overlay <br><code>display.overlay</code> | bool | off | — | personal preference. fps, CPU and GPU ms per pass, triangles, instances, tiles and worker rate. |
| Axis labels <br><code>display.labels</code> | bool | on | — | personal preference. Block, date and amount labels in the scene. |
| Grid <br><code>display.grid</code> | bool | on | Film off | Reference grid lines on the ground. Film: off, because grid lines draw over palette colours. |
| Legend <br><code>display.legend</code> | bool | on | — | personal preference. Colour and height legend. |
| Minimap <br><code>display.minimap</code> | bool | on | — | personal preference. Overview map with the camera footprint. |
| HUD <br><code>display.hud</code> | bool | on | — | personal preference. Block, date and playback readout. |

## Measurements

All figures were measured on 2026-10-07 on this Mac (M4 Max, 40-core GPU, 64 GB, macOS 27.0.1) with the dataset on the PCIe SSD `/Volumes/4T Data`.

### Dataset build and verification

The full build ran 403.1 s and replayed 7,150,703,243 changes. It wrote 1,092 snapshots (57,007,340,987 bytes; the plan estimated about 40 GB) and 4,383 chunks (18,312,486,354 bytes, the whole BLK), 70 GiB on disk, with a peak resident size of 14.7 GB. That time is pessimistic: the build used the original memory-mapped reads while the machine was swapping about 11 GB. The current uncached `pread` path rebuilt blocks 0–330,000 byte-identically 5.3 times faster; a clean full build was not re-timed. At the tip, block 966,827 (2026-09-13 13:44:20 UTC), the set holds 165,425,175 outputs and 20,083,808.54 BTC.

`landscape_verify` passed in 319.9 s:

| Check | Result |
|---|---|
| Chunks | 4,383 of 4,383 equal the source bytes and their SHA-256 |
| Block times | 966,828 blocks match the history file and the BLK headers |
| Forward replay | 1,092 of 1,092 snapshots equal a fresh replay, 0 mismatching cells |
| Backward replay | 20 of 20 random snapshot pairs (16,805 blocks undone) |
| History index | 3,658,064,209 records reproduce every level-0 cell at blocks 210,000, 630,000 and 966,827 |
| Renderer checkpoint | 61,166,407 entries at block 965,399; 0 cells off by more than 1e-6 (largest difference 3.64e-12) |

The data-free `landscape_state` case passes 445 assertions, and the focused palette, epoch-transition and checkpoint cases still pass 3 cases and 1,965 assertions. Independently, the JavaScript replay matched the C++ snapshots with zero mismatches on every snapshot pair of both development datasets and on 60 pairs spread across the full dataset (29,521 tile checks, 144,396 blocks forward and backward).

### Replay

Headless Chrome 154 on the full dataset:

| Measure | Result |
|---|---|
| Random seeks, default view (66–74 tiles) | median 157 ms, 95th percentile 267 ms; first coarse frame 66 ms |
| Random seeks, 225 / 400 resident tiles | 95th percentile 537 ms / 624 ms |
| 1× in seven eras (50,000 to 960,000) | exactly 60 blocks/s, never behind |
| 10× from 420,000 to 960,000 | 598–599 blocks/s, exact |
| Max (chained exact replay) | 1,154 blocks/s at 630,000, 886 at 840,000, 868 at 960,000 |
| Worker memory | 714 MB (74 tiles), 853 MB (225), 878 MB (400) |

In the app, 1× playback from block 314,000 advanced 602 blocks in 10.03 s without a snapshot shortcut. The totals and 20 sampled cells at the end equalled a fresh seek to the same block. The browser checks in `landscape/tests/shell-browser-checks.mjs` pass 43 of 43 against the full dataset and the native explorer. Among them, the inspector's replay matches the explorer's history index: at block 840,000, for example, one cell holds 3,156 outputs and 7.89260638 BTC in both.

## Limitations

- Every block has the same width, so early eras look sparse next to the film. Horizontal detail stops at 64-block cells, although the HUD, stepping and playback are exact per block.
- Smooth surfaces blend colours between cells. Exact per-cell colours need stepped cells, which the Film preset uses.
- Heat starts empty after a seek, and tiles that load during playback start without heat history.
- Instanced columns, SSGI and automatic exposure need WebGPU. On WebGL2, at most 24 tiles upload per frame, so distant tiles can lag during playback.
- God rays work in screen space and appear only when the sun is near the view; the volumetric option gives shadowed light shafts from any angle. Fewer bloom mips narrow the glow without saving GPU time. PCSS estimates blocker distance approximately.
- Flight-mode pointer lock was checked only through its drag-to-look fallback. Firefox was not tested; Brave passed the browser checks online. Touch gestures were checked with real multi-touch input in Chrome's phone emulation (390 × 844), not yet on a physical phone or in iOS Safari.
- Locally, the inspector's history section needs the explorer on port 12989, and its cell API shares `/api/pixel`'s rate limit (15 requests/s, burst 40). Online, the Worker answers it with 8 requests/s and a burst of 20 per visitor and Worker instance.
- Online, a seek takes about 1–2 s and 10× or Max playback follows the connection's download speed (see Online). The dataset ends at block 970,658; a newer tip needs a new dataset. `scripts/landscape_r2_publish.py` copies every chunk and snapshot before the old tip inside R2 and uploads only the new ones, about 60 MB of snapshots a day. The first dataset built after snapshots became self-describing still uploads its snapshots once (58 GB, about 36 minutes from here), because the published 970,658 files record that dataset's block count.
- Unchanged and worth a follow-up: `/api/pixel` and `/api/ranges` share one mutable inverter across request threads, so simultaneous requests for blocks in different epochs could compute wrong column ranges. The new cell endpoint does not use it.

## Files

| Path | Role |
|---|---|
| [`src/cpp/app/Landscape.h`](../src/cpp/app/Landscape.h), [`Landscape.cpp`](../src/cpp/app/Landscape.cpp) | Grid, exact state, `BUVLSN1`, build and verify |
| [`src/cpp/app/landscape_tasks.cpp`](../src/cpp/app/landscape_tasks.cpp) | `landscape_state`, `landscape_build`, `landscape_verify` |
| [`src/cpp/app/utxo_explorer.cpp`](../src/cpp/app/utxo_explorer.cpp) | `GET /api/landscape/cell`, loopback CORS and `-port=` |
| [`landscape/tools/serve.mjs`](../landscape/tools/serve.mjs) | Local server with range requests and cross-origin isolation |
| `landscape/web/data/`, `replay/`, `replay.worker.js`, `client/` | Grid and axis maths, snapshot reader, decoder, exact state, seek planning, worker and client |
| `landscape/web/render/` | Renderer, environment, post pipeline, overlay and resolution scaling |
| `landscape/web/render/terrain/` | Tile atlas, level of detail, heightfield, columns, palettes, heat, labels and picking |
| `landscape/web/settings.schema.js`, `settings.js`, `ui/panel.js` | Settings schema, presets, store and panel |
| `landscape/web/index.html`, `main.js`, `ui/` | App shell, navigation, playback, timeline, places, minimap, inspector, legend and HUD |
| `landscape/web/ui/online.js` | Online versus local: dataset index, cell API and 2D link, first-visit quality |
| [`cloudflare/utxo-landscape-worker/`](../cloudflare/utxo-landscape-worker/README.md) | The online Worker: static app, dataset from R2, cell API, deploy and publish procedure |
| `scripts/landscape_r2_verify.py`, `scripts/check_landscape_worker.mjs`, `landscape/tools/csp-hash.mjs` | Uploaded-dataset verification, Worker checks, CSP hash of the import map |
| `landscape/tests/` | `node --test landscape/tests/` (138 tests) and the browser checks, including the `touch` check that drives every gesture with real multi-touch input on an emulated phone |
| `landscape/tools/browser-check.mjs`, `gpu-util.mjs`, `landscape/web/dev/` | Headless Chrome checker (`--mobile` emulates a phone with touch input), GPU utilisation sampler and development harnesses |

The vendored three.js 0.186.0 and lil-gui 0.17 are MIT licensed ([`vendor/three/README.md`](../landscape/web/vendor/three/README.md)); the fonts keep their OFL licences. The original concept and code are by Martinus ([BitcoinUtxoVisualizer](https://github.com/martinus/BitcoinUtxoVisualizer), MIT).
