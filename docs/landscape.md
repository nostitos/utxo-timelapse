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

`?webgl=1` forces the WebGL2 fallback. Quality is then capped at High, and the features that need compute shaders (cylinder columns, SSGI, automatic exposure) are off, so the whole landscape is the heightfield. The URL hash keeps the block, camera, navigation mode, look, quality and the settings that differ from them, so a copied link reproduces the view.

## Online

The landscape runs publicly at **https://3d.bitcointimelapse.com/**, also reachable at https://utxo-landscape.nostisos.workers.dev/. A separate Cloudflare Worker, `utxo-landscape`, serves the app from Workers Static Assets and the dataset from the 2D explorer's private R2 bucket under `landscape/d970658-20261009/` (blocks 0–970,658), and it answers the inspector's cell lookups from the explorer's history shards. [`cloudflare/utxo-landscape-worker/README.md`](../cloudflare/utxo-landscape-worker/README.md) covers deploying, publishing a dataset for a new tip and rolling back. The guide and the 2D explorer do not link to the landscape yet.

Three things change online, all decided in `landscape/web/ui/online.js`:

- The app loads the dataset named in `/dataset/index.json`, so a new tip only changes the Worker's release file. Each tip is a full, immutable dataset under its own prefix.
- A first visit, with no saved settings and none in the link, starts at Balanced quality with automatic resolution scaling (target 60 fps, scale 0.5–1). A browser without WebGPU, a touch-only device or one that reports 4 GB of memory or less starts at Performance and says so. Saved and linked settings take precedence, every look and quality stays one click away, and `?startup=high` gives the local default.
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
| 600 blocks/s target from block 630,000 (the 10× speed of that release) | 446 blocks/s, limited by the download; the HUD showed the achieved rate. |
| Max | 1,040 blocks/s at 630,000 and 667 at 840,000. |
| Replay worker memory | 526 MB |
| 4K, headed fullscreen (3840 × 2072) | First visit: Balanced at full resolution, 119.6 fps (the display's 120 Hz cap), 5.4 ms GPU. Ultra at block 630,000 with the inspector open: 61.5 fps at full resolution, 14.8 ms GPU. |
| Browser checks | `shell-browser-checks.mjs` passes 43 of 43 in Chrome and in Brave against https://3d.bitcointimelapse.com/. |
| Cell API against the native explorer | 24 of 26 sampled cells identical. The other two are the densest cell at the tip (column 15,100, row 1,822), queried at the tip and with a block beyond it; they differ only in the `pop` curve, from floating-point histogram bin edges, as `/api/pixel` does against the native explorer. Median 260 ms per lookup. |

Playback streams the change log. After block 420,000, 1× needs about 1.2–2.2 MiB/s, 2× twice that and 5× about 6–11 MiB/s, so 1× and 2× suit most broadband connections while 5× and Max follow the connection's speed. When the download is slower than the speed, playback is paced to it and the HUD says download-limited: the picture moves on every frame at the download rate instead of racing through each 4 MiB chunk and then waiting for the next. Each seek replays up to 16 MiB of changes from the nearest snapshot, which accounts for most of an online seek.

Storing the dataset costs about 1.1 USD a month in R2 (75 GB); R2 charges nothing for egress. Cloudflare Web Analytics counts visits: the zone injects its beacon into every page, and both this site's and the 2D explorer's Content Security Policy allow it.

## Controls

| Keys or gesture | Action |
|---|---|
| Space | Play or pause |
| `[` / `]` | Back or forward one block (exact) |
| Shift + `[` / `]` | Back or forward 1,008 blocks (about a week) |
| 1, 2, 3, 4 | Speed 1×, 2×, 5×, Max |
| N or the Follow button | Follow tip: the camera moves with the newest block, at its speed and in its direction; N again stops |
| Drag | Pan; the grabbed point stays under the cursor |
| Right-drag or Shift-drag | Orbit around the point under the cursor |
| Wheel or trackpad pinch | Zoom toward the cursor |
| Double-click | Fly to that point |
| Point | A card beside the cursor (beside the crosshair in flight mode) shows the cell under it: its amount band, its blocks and dates, and its unspent outputs and BTC at the current block, updating live from data already in the browser. Zoomed out, it covers the merged cell drawn there |
| Click or I | Inspect the cell under the cursor (the crosshair in flight mode, the nose circle in plane mode) |
| Arrows, Q/E, PgUp/PgDn | Pan, rotate, tilt |
| F or the Fly button | Flight mode: mouse look, WASD, E/Q up and down, Shift 4×, wheel sets speed; the button stays lit while it is on; Esc returns to map mode |
| T or the Fun button | Plane mode in the chosen craft (plane, bird or jet): the mouse is a stick (sideways banks, up raises the nose) and the bank turns the craft; A/D and ←/→ bank, ↑/↓ nose up and down, W/S speed, Shift boost, wheel sets the camera distance, C next craft, Enter Stack sats, M engine sound; Esc or T returns to map mode |
| G, P, H or ? | Graphics settings, places, help |

Follow tip keeps the camera moving with the tip, the edge where new outputs are created. Turning it on (N or the Follow button) leaves the camera where it is; from then on, while the blocks advance, the camera slides along the block axis by the same distance (one block is 0.001 units, so 1× moves it 0.06 units a second) and keeps its height, depth and direction. The worker delivers blocks in small bursts, so the camera eases after the tip with a quarter-second time constant: it glides on every frame, trails the tip by about a quarter second of blocks while playing and settles exactly as far as the tip went once playback stops. Moving through time any other way moves it too: the single-block and 1,008-block steps, dragging the scrubber and the block and date fields glide the camera to the new tip, as far as the tip went, in about a second. Places, links and imported views set the camera themselves, so following starts again from where they put it. Following works in map and flight mode; you can still pan, orbit, zoom and fly, and every gesture and animation in progress moves with it. Plane mode pauses it, and it resumes from wherever the plane lands. Links and exported views record it as `follow=1`.

Plane mode is a simple arcade flight sim for exploring the landscape, with three crafts and a game (Fun, below). T or Free flight in the Fun menu puts the chosen craft, at first a small plane, in the air above the point at the centre of the view, already flying in the view's direction; there is nothing to start or set up. It flies like a plane: you bank to turn. The mouse is a stick that springs back to the centre: move it sideways and the plane rolls, and the bank, not the stick, turns it, more steeply the more it is banked and more widely the faster it flies. Centre the stick and the plane holds its bank and slowly rolls level; roll the other way to level the wings sooner. Pushing the stick up raises the nose along the plane's own axis, so nose up in a bank tightens the turn. A/D and the left and right arrows bank; the up and down arrows raise and lower the nose. Mouse, arrows and gamepad all go up for nose up; Invert Y in the camera settings switches them to the flight-sim convention, pulling back for nose up. Keys ease in over a quarter of a second. The chase camera swings after the plane and keeps the horizon level, so the bank shows, and a stick dot next to the throttle bar shows where the stick is. W and S set the throttle (0.25 to 16 units a second on a logarithmic scale, so each quarter of the bar multiplies the speed by 2.83; it starts at 2, and full throttle takes about a minute from genesis to the tip) and Shift triples it. The plane spans 0.4 units, about six columns, and the chase camera starts 2 units behind it (the wheel moves it from 0.8 to 40). Hitting a column taller than a small step bumps the plane: it stops in front of the column, loses half its speed and pitches up, and flies on. With Terrain collision off it flies through the columns. A card at the bottom right lists the controls for as long as you fly. A line at the top shows the 64-block column under the plane, its date and the amount of its row, with a throttle bar; the small circle shows where the nose points, and I inspects the cell there. While flying, the cylinders reach 1.6 times farther and their disc moves ahead of the camera, so the sharp area extends about 2.5 times as far in front of the plane (about 26 units at Balanced and 39 at High in a 1600 × 900 window, against 10 and 15 in the other modes); this roughly doubles the cylinder GPU time. A synthesized propeller engine (Web Audio, no files) follows the throttle and boost, adds wind with the airspeed and thumps on a bump; M turns it off or on and the choice is remembered. Time runs independently: Space and the time keys still work, and flying never seeks. Links made while flying open in map mode at the camera. A standard gamepad also flies the plane: left stick to bank and pitch (pull back for nose up), RT and LT for the throttle, A to boost, Start to take off or land, B to land, Y for the next craft and X to start Stack sats. Plane mode is for keyboard and mouse; touch-only devices show neither the Fly nor the Fun button.

The Fun button opens a menu in the style of Places. On the left you choose the craft; the choice is remembered in this browser. On the right, Free flight takes off and Stack sats takes off and starts the game; the Stack sats line shows your best stack with the chosen craft. C changes the craft at any time, also in flight, where the new craft carries on from the same spot, heading and throttle setting. The three crafts share the flight model above and differ in their numbers:

| Craft | Speed | Feel | Size, chase camera | Collects coins within |
|---|---|---|---|---|
| Plane | 0.25 to 16 units a second, Shift 3× | Steady; banks to turn, the wings level slowly | 0.4 units; 2 behind (0.8 to 40) | 1 unit |
| Bird | 0.1 to 4, Shift 2× | Slow and nimble: rolls quickly, turns in about a sixth of the plane's radius (each at its start speed and 45° of bank), levels its wings three times as fast, flies 0.06 above the columns and rides over rises up to 0.5; it flaps faster with the throttle and glides below 15% | 0.2 units; 1 behind (0.4 to 20) | 0.8 units |
| Jet | 2 to 60, Shift 1.6× | Fast and wide: rolls very quickly but turns in about four and a half times the plane's radius, holds its bank, keeps 0.3 above the columns and bumps on rises over 0.2; the tail lamp brightens with the throttle and Shift lights the afterburner | 0.48 units; 4 behind (1.5 to 60) | 1.6 units |

Each craft has its own sound: the plane's propeller; for the jet the roar of a turbine heard from behind, a deep rumble and a broader roar that opens up with the throttle, with a faint whine at low power and more rumble on boost; and for the bird only the wind, pulsing with its wing beat. The jet draws the sharp cylinders 2.2 times farther and 0.8 radii ahead, which costs more GPU time than the plane; the bird 1.2 times and 0.3 radii.

Stack sats is a one-minute game for every craft. Enter in plane mode (or Stack sats in the Fun menu) starts it. Bitcoin coins appear in trails: a curving line of ten coins ahead of you at about your height, always above the columns, and a new stretch continues the line before you reach its end, so there is always a path to follow. Up to six bonus coins also sit on the tallest columns nearby. Each coin is worth the amount of the row it floats over: a coin over the 50 BTC coinbase row pays 50 BTC, one over the 546 sat row 546 sat, so steering a trail toward the back of the landscape, over the whale rows, pays most. Fly through a coin to stack it; its value pops up under the line at the top, which shows the time left, your stack and the coins collected. Following the trails, a minute brings about 130 coins with the plane or the jet and about 55 with the slower bird; a coin you leave behind vanishes. When the minute is up a card shows your stack, the coins and your best with that craft (a new best is saved in this browser). The cursor is free on that card while the craft flies on: Again (Enter) plays another minute from where you are, Land (Esc) returns to map mode. C cannot change the craft during a run; landing, Fly or the Fun button ends a run without a score.

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

Phones get their own layout below 700 px of width, or below 500 px of height in landscape. The HUD shrinks to the block, date and play state (tap it for the totals). The minimap, legend and block and date fields are hidden, and the timeline keeps the scrubber, transport, one speed button that cycles through 1×, 2×, 5× and Max, and Places, Settings and Help, with 40 px touch targets. In portrait the inspector and the settings open as sheets from the bottom; in landscape they open at the right. When the inspector's sheet would cover the tapped cell, the view slides so the cell stays visible beside it. In portrait the first view looks along the block axis from beyond the tip, so the landscape fills the screen. Safe areas such as the iPhone home indicator are respected.

Places jumps to the eras at blocks 50,000, 210,000, 314,000, 420,000, 500,000, 630,000, 700,000, 840,000, 900,000 and the tip, or flies to the amount bands: the 50 BTC coinbase row, 10 BTC and up, 1 BTC, 10,000 sat, 546 sat and 1–100 sat. The timeline accepts a block height or a UTC date.

A link without a block opens at the latest snapshot at least 1,008 blocks (about a week) before the last block, so Play has something to play: with snapshots about 440 blocks apart near the tip, that is 1,008 to about 1,450 blocks back, 17 to 24 seconds at 1×. The view loads straight from that snapshot without replay. Places → Latest block goes to the tip.

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

| Speed | Behaviour | Bitcoin time per second (10 minutes a block) |
|---|---|---|
| 1× | 60 blocks/s, exact | 10 hours, 36,000× real time |
| 2× | 120 blocks/s, exact | 20 hours, 72,000× real time |
| 5× | 300 blocks/s, exact; the HUD shows the achieved rate if the worker falls behind | about 2.1 days, 180,000× real time |
| Max | Back-to-back exact replay; paced to the download when that is slower (online, near the tip) | the HUD's blocks/s × 10 minutes |
| Scrubbing | The snapshot at or below the handle while dragging, then an exact seek on release | — |

The speed buttons' tooltips give the same figures. Blocks have averaged about 9.6 minutes over the chain's history, so measured against the real calendar 1× is closer to 34,600× real time.

Activity heat adds the BTC each spend moves to its cell and decays with a half-life in blocks. Seeks and backward steps clear it, and pausing keeps it. Every spend makes its cell glow: at least a floor brightness (as every spent output flashes in the film), brighter for more BTC moved, and dimmer for coins created within the last four weeks, which are spent constantly. Spends also get flash sprites that keep a minimum on-screen size, so activity stays visible from far away.

### Rendering

Rendering uses three.js 0.186.0 `WebGPURenderer` with TSL node materials, vendored unmodified in `landscape/web/vendor/three/`. The terrain draws from a GPU tile atlas and always uses the deepest fully resident level, so there are no holes or overlaps. Heightfield patches are displaced in the vertex stage, with normals from neighbouring cells and bicubic derivatives when bicubic smoothing is on. Stepped cells, subdivision up to 4 and skirts are options. The Film palette path compares against a 255-entry boundary table generated from the compiled `DensityToImage`, because AppleClang fuses its `mK*x + mD` and about 400 boundary densities would otherwise land one index off.

The whale rows (10 BTC and up by default) are stepped even when the rest of the surface is smooth (Geometry → Stepped whale rows, on by default). Large amounts are sparse, so a whale cell is usually a lone tall value between empty neighbours. The smooth surface puts its vertices on cell centres, which turns such a cell into a pyramid that narrows to a point; at a distance its upper part is thinner than a pixel and breaks into a dotted hair. A stepped cell keeps its full width to the top. Far away, a whale cell narrower than 1.5 px on screen is widened, up to three times its width, so a distant spike stays a solid line; each boundary between two cells moves away from the taller one, so walls stay vertical and the surface stays closed. Colours stay exact per cell. Patches that hold whale rows are drawn by a stepped mesh, the others by the smooth meshes, and the one patch row across the band edge is drawn by both, each discarding fragments on the other side of the edge. Measured at 1920×1080 on High at block 700,000 (Apple M4 Max, Chrome), the band roughly triples the heightfield triangles when looking along the whale rows (1.7M to 5.8M) and raises them from 4.5M to 7.6M over the whole landscape; GPU time rose by 0.4 to 1.0 ms looking at the whale rows and by 0.3 ms in the overview. Stepping every row instead cost up to 15 ms more in the overview.

Near the camera, every occupied level-0 cell is drawn as its own cylinder (Geometry → Column cells, on by default with WebGPU). Each frame a compute pass scans the resident level-0 tiles inside a disc around the camera and appends the occupied cells to an instance list, and two indirect draws render it, so playback needs no CPU work. The disc reaches as far as cells stay at least Column detail pixels wide on screen (4 px on High); beyond it the heightfield takes over, and heightfield patches entirely under the disc are skipped. Cylinders wider than 20 px use Cylinder sides (12 on High); smaller ones use a 4-sided prism with the circle's area that is still shaded round, because its outline cannot be seen at that size. A cylinder is as wide as its cell's 64 blocks, so rows keep a gap between them; Oval fills the cell and Box draws square prisms. Cylinder height follows the height curve, not a count of outputs. Each cylinder has one palette colour, the exact colour of its cell. Spend flashes light the cap and the top quarter of the side at full strength, dropping to 30% further down, so a busy area reads as lit cylinder tops instead of glowing walls.

The frame pipeline adds cascaded sun shadows (PCF or PCSS), hemisphere light, sky, stars, height fog, a sun-shadowed volumetric fog at half resolution, screen-space god rays, GTAO or SSAO, SSGI, SSR at half resolution, bloom, depth of field with autofocus, motion blur, six tone mappers, manual or automatic exposure (luminance histogram in a compute pass), a colour grade, a `.cube` 3D LUT, grain, chromatic aberration, vignette, and FXAA, SMAA, TRAA or 2×/4× supersampling. Only enabled passes are built. Numeric and colour settings update uniforms, and structural switches rebuild only the affected pass. The overlay reports GPU time from timestamp queries; Apple GPUs overlap pass intervals, so it shows their union.

## Looks, quality and measured performance

The settings combine two independent choices. A **look** sets the appearance: palette, light, sky, cell shape and the effects that define it. A **quality** tier sets the cost: resolution, anti-aliasing, shadow maps, effect samples and detail. A setting takes the look's value when the look names it, otherwise the quality tier's, otherwise the schema default, so choosing a look keeps the quality and choosing a quality keeps the look and the settings changed by hand. The app starts at Landscape and High (online, a first visit starts at Balanced quality; see Online). Links and saved settings from before looks still open: `preset=Film` and a saved Film preset load as the Film look at High.

| Look | What it shows |
|---|---|
| Landscape | The default: film palette colours in the blue hour just after sunset, the afterglow on the walls that face it and the first stars out, with light haze, shadows, bloom and cylinder columns near the camera |
| Film | Unlit film colours: weighted density through the film palette (white-hot rows at 10 BTC and above), stepped cells instead of cylinders, black background and ground; no grid, lighting, shadows, fog, sky, tone mapping or post effects. Heat glow and flashes still appear during playback, like the film's activity flashes, and are zero right after a seek |
| Daylight | Midday: a high white sun in a pale blue sky, crisp shadows and the viridis palette with no glow, so the relief reads like a map |
| Golden hour | Sunset from the tip side: a low orange sun, long shadows, thick warm haze, light shafts toward the sun and the inferno palette |
| Neon night | A deep violet night full of stars, glowing boxes in the plasma palette with pink rims, strong bloom and bright white spend flashes |
| Whales | Sunrise over the BTC held in each cell: height and colour show value instead of the number of outputs, with the rows of 10 BTC and above twice as tall, so the large holdings tower over the dust in the magma palette. The extra height eases in from 1 BTC, so the surface rises toward 10 BTC instead of meeting a cliff |
| Pulse | A dim grey landscape on a near-black background with the sky off, where spends flash amber and their glow fades over about 300 blocks; made to watch during playback |

| Quality | What it turns on |
|---|---|
| Performance | 75% resolution, FXAA, no shadows or ambient occlusion, light bloom, 96 resident tiles, coarser detail; 8-sided cylinders only where cells are 12 px wide or more, at most 250,000 |
| Balanced | Native resolution, SMAA, two 2048 shadow cascades, SSAO, bloom, 160 resident tiles; cylinders where cells are 6 px wide or more |
| High | Startup quality: TRAA, three 2048 shadow cascades, GTAO, bloom, fog, sky, stars, 225 resident tiles; 12-sided cylinders where cells are 4 px wide or more |
| Ultra | High plus three 4096 shadow cascades, volumetric light, god rays and bicubic smoothing |
| Extreme | Ultra plus a fourth cascade, 2× supersampling, softer shadows, GTAO with 32 samples, SSR, 64 volumetric steps, motion blur, subdivision 2, finer detail and up to 2 million cylinders; deliberately GPU-bound |

A look may switch on an effect that defines it, and the look wins over the tier for that setting: Daylight and Golden hour keep their shadows at Performance, Golden hour keeps its light shafts, and Film keeps native resolution and no anti-aliasing at every tier. The quality tier sets everything a look leaves alone. In the measurements below, which predate looks, Film is the Film look at High.

The table below predates the cylinders: it was measured on 2026-10-07 with the heightfield alone, which is what Column cells off gives today (Extreme already drew its columns). The cylinder measurements follow it. Measured in Chrome 154 on the 120 Hz LG 3840 × 2160 display (headed window, exact 3840 × 2160 viewport), full dataset at the tip, M4 Max with 40 GPU cores. Figures are fps (GPU ms) and GPU busy time from `landscape/tools/gpu-util.mjs`, the counter Activity Monitor's GPU history shows. The display caps frame rate at 120.

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

### Cylinders

Measured on 2026-10-09 in headless Chrome 154 with WebGPU at 3840 × 2160 on the same M4 Max, at block 840,000, with two interleaved runs per cell (median of 40 samples each). Headless Chrome caps at 60 fps, so the table gives GPU ms; before this change, headless and headed runs agreed within 0.5 ms for Ultra's close view. Camera targets (x, z, distance, yaw, pitch) were overview 600, 104, 700, 36, −31; middle 820, 110, 30, 28, −30; close 835, 120, 8, 30, −32.

| Preset | Overview | Middle view | Close view | Cylinders in the close view |
|---|---|---|---|---|
| Performance | 3.6–3.9 | 6.0–7.2 | 5.8–6.1 | 41,000 |
| Balanced | 5.6–6.2 | 12.7–15.8 | 13.1–16.2 | 154,000 |
| High | 5.9–6.2 | 20.9–23.0 | 20.7–22.3 | 235,000 |
| Ultra | 7.2 | 24.5–28.7 | 24.6–26.6 | 235,000 |
| Extreme | 17.6–18.4 | 74.9–79.5 | 65.6–73.9 | 273,000 |

With Column cells off, High measured 9.6–9.7 ms close and 10.0–13.8 ms in the middle view, and Ultra 13.0 and 16.4 ms. Cylinders therefore take High from the display's frame rate to about 45 fps and Ultra to about 35–40 fps in close and middle views. The overview does not change, because its cells are narrower than Column detail and stay heightfield. Balanced, the online first-visit preset, stays within 60 fps at 4K. The cost follows the number of stacks more than their shape: in the same runs boxes took 17.4–24.1 ms against 20.8–26.9 ms for 12-sided cylinders, and Column detail 8 px (79,000–92,000 cylinders) took 18.8–21.4 ms. Shadows account for 3–5 ms. Extreme's overview no longer draws sub-pixel columns, so it runs at about 55 fps there; close up it stays deliberately GPU-bound at 13–15 fps, mostly SSR. These runs still painted thin coin lines on the cylinder sides; that shading was removed on 2026-10-10, and with and without it the High close view at 1600 × 900 measured 6.2–8.6 ms and 5.7–8.0 ms, within run-to-run noise.

To repeat the measurement, open `/dev/render_post-bench.html?terrain=real&block=966827&cam=overview&warm=4000&measure=6000` (or `cam=close`, or `presets=High,Ultra`) and run `node landscape/tools/gpu-util.mjs --interval 500 --duration 120` alongside. Results appear at the top right and in `window.__benchResult`.

**Far columns and the column cap.** Measured on 2026-10-13 in headless Chrome with WebGPU at 1440 × 900 at 2× scale on the M4 Max, at block 969,265 from 58 units above the landscape, with Column distance ×4 on High. The column cap was set to 1 million when cylinders were introduced, when the close views needed about 235,000; it only limits the reach since Column distance can ask for cells down to 1 px. Here the cells within reach need 1.17 million columns, so at the 1M cap the area shrinks to 99 of the 109 units asked for (95% of the cap is drawn). GPU time per frame, median of 12 samples: columns off 17.8 ms; Box 39.1–42.1 ms; Cross 39.5 ms (two crossed rectangles cover the same pixels twice); Card 30.9 ms; Flat 26.9 ms; Box without far shadows 35.4 ms; Card without far shadows 27.2 ms. With a 3M cap the full reach takes 1.17 million columns: Box 46.3 ms, Card without far shadows 30.0 ms. Card looks like Box from the side; from directly above it keeps a flat top, while Flat and Cross show no tops.

## Settings panel

G or the Settings button opens the panel. Its header shows the look and the quality, with the number of settings changed by hand. Quick settings follow for what people change most; Advanced, closed until opened, holds every setting.

| Quick setting | Choices | What it sets |
|---|---|---|
| Look | The seven looks above and the looks saved in this browser | Every look and quality setting, from the look at the current quality; changes made by hand are cleared, with Undo |
| Quality | Performance, Balanced, High, Ultra, Extreme | The cost settings; the look and the settings changed by hand stay (Ultra and Extreme need WebGPU) |
| Now | Live readout | GPU time (or frame time) and frame rate, and the columns drawn against Column cap; it says when the cap cut the column area short and how much of the asked reach is left |
| Resolution | Slider, 50% to 200% | Resolution > Resolution scale; GPU time grows with the pixel count |
| Column distance | Slider, Near to Far (×0.25 to ×4 of High) | Columns > Column detail, 16 to 1 px: how far from the camera cells stand as columns. The quality tier sets it too (Performance ×0.33, Balanced ×0.67, High ×1); needs Column cells |
| Column cap | Slider, 100k to 8M | Columns > Instance budget: the most columns drawn per frame (Performance 250k, High 1M, Extreme 2M). Past it the column area shrinks to fit, so a higher cap lets columns reach farther |
| Far columns | Box, Card, Flat, Cross | Columns > Far columns: how columns narrower than 20 px on screen are drawn (12, 4, 2 or 4 triangles each) |
| Far shadows | On, Off | Columns > Far column shadows |
| Terrain detail | Slider, Coarse to Fine (×0.38 to ×3 of High) | Level of detail > Pixels per cell, 8 to 1 px: how fine the surface beyond the columns is |
| Loaded tiles | Slider, 32 to 400 | Level of detail > Tile budget: tiles kept loaded, about 1 MB of GPU memory and 2 MB in the worker each |
| Time of day | Slider, 6:30 to 21:00, with Sunrise, Day, Sunset, Dusk and Night as stops | A clock along one sun path: sun direction, height, intensity and colour, sky and ground light, ambient light, stars and fog colour blend between the stops. Dusk (18:15, the default) is the blue hour, with the sun just below the horizon; Night is moonlight, so the palette's own glow lights the landscape |
| Sky | On, Off | The sky dome; Off also hides the stars and shows the background colour |
| Haze | Slider, None to Thick | Fog density 0 to 0.008, thinning with height |
| Shadows | On, Off | Sun shadows |
| Glow | Slider, Off to Strong | Bloom with its strength, threshold and radius |
| Height shows | Weighted density, Output count, BTC value | Amplification > Measure; colour follows it unless set otherwise |
| Colours | Film, Turbo, Viridis, Inferno, Magma, Plasma, Cividis, Grey | Colour > Palette; the custom gradient is edited in Advanced |
| Height | 0–40 | Amplification > Exaggeration (Advanced allows up to 200) |
| Big coins | Slider, Normal to Towering | Height multiplier 1 to 4 for the rows at or above the whale threshold (10 BTC), easing in from 1 BTC |
| Cell shape | Smooth, Columns, Boxes, Stepped | Column cells, their shape and stepped cells; Boxes also steps the landscape beyond the columns. Columns and Boxes need WebGPU |
| Flashes | Slider, Off to Strong | Heat gain and flash size of spends |
| Flash trail | Slider, Short to Long | Heat half-life from 10 to 300 blocks, applied when the slider is released (the replay worker recomputes heat) |
| Field of view | 15–110° | Camera > Field of view |
| Show | Grid, Labels, Legend, Minimap, HUD | The overlays |

The Performance section gathers what sets the GPU's work, with a live readout of its cost; the quality tier sets all of them, and the sliders adjust from there. Settings that come in degrees are sliders: the named options sit under the slider as stops, a click jumps to one, and between stops the values blend (colours mix, numbers interpolate). A quick setting shows the option or slider position the current values match, or a dash when they were set by hand in Advanced. Every built-in look reads as one option in each of them; Film's time of day is the exception, because Film turns the sun off (choosing a time of day turns it back on). Quick settings and Advanced settings that have no effect with the current values are dimmed, and their tooltip says why: the bloom settings with Bloom off, Shadows and the sun direction with Film (it has no sun), Flash trail with Flashes off, the cylinder settings with Column cells off. The conditions are `NEEDS` in `landscape/web/settings.schema.js`; a condition on a setting that itself has no effect counts as unmet, and the tooltip names the root cause.

**Saving looks.** Save… beside the look stores the current settings under a name in this browser's local storage (`utxo-landscape-presets-v1`; up to 50 looks, names up to 40 characters, built-in names excluded). A saved look records its built-in look, its quality and the settings that differ from them; personal preferences such as camera feel and overlays stay out. It appears under Saved in the look list. Choosing it restores its values and quality, saving again under the same name updates it, and Delete removes it while keeping the values on screen; each offers Undo. A copied link carries the built-in look and the changed settings, so it opens the same view in any browser. An exported JSON file names the saved look; where it is not saved, the import shows its values on its built-in look and says so.

Advanced holds every setting in seven groups, with search, JSON export and import, the list of changed settings with per-setting revert, per-group reset, a gradient editor and `.cube` LUT loading. Reset returns everything to the look and quality, and Copy link copies a link to the view. While searching, the quick settings step aside so the matches sit at the top.

### Settings audit

The opt-in `settings-audit` browser check (`--audit`, about 25 minutes) starts at Extreme quality on the Landscape look with every effect on, sets each of the 123 look and quality settings to its minimum, default and maximum (every option of a list), and compares a 48 × 27 average of the frame at three cameras: the overview, a close view near the tip and a low view toward the horizon. It then breaks each setting's first condition and checks that the setting stops changing the frame. On 2026-10-13, 107 settings changed the frame by at least 0.5 (mean RGB difference out of 255) at one camera or more, and with its condition broken, no setting changed it at all.

The audit found three problems, fixed in the same change:

| Problem | What happened | Fix |
|---|---|---|
| Depth of field with SSGI | The page froze for good, also online | SSGI stays off while depth of field is on, and the panel says so; the cause is still open |
| Zero G-buffer outputs of the now plane and the flash sprites | At Performance and Film, which have no G-buffer, the now plane's shader failed to compile, so Now plane did nothing and the console filled with errors, also online. At Extreme with motion blur off, and with 2× supersampling and SSR, every frame came out black | They write zero only to the attachments the scene pass has, each with its own constant (`render/gbuffer.js`); the `render-layouts` check covers these layouts |
| Wrong conditions | The sun's direction, colour and shadows still give specular highlights at albedo 0; floor reflection darkens the floor without SSR; the shadow filter also sets the volumetric light's shadow map; volumetric light changes the frame at fog density 0 | Conditions corrected |

Sixteen settings changed the frame by less than 0.5 in all three views. None is broken; each needs a view or a moment the audit does not show:

| Settings | When they show |
|---|---|
| Shadows (0.08), and faintly cascades, map size and softness | Measured with the earlier default, a high sun; the glowing palette leaves little to shade, and a low sun (Sunrise, Sunset, Golden hour) casts long shadows |
| SSGI intensity (0) | Not visibly: SSGI's indirect light is too faint at any intensity, and what SSGI adds is its ambient occlusion |
| God rays and their intensity (0) | With the sun in or near the view |
| Stars and star density (0.02, 0.04) | At night or with the sky off; daylight hides them |
| White-hot whale rows (0.01) | Where the rows of 10 BTC and above are in view: the far side of the default view, or from behind |
| Cylinder sides, cell shape, column radius, instance budget (0–0.47) | Close to the columns: sides apply only to columns wide on screen, radius and budget only when more columns are wanted than they allow |
| Smoothing, subdivision and skirts (0.22–0.34) | In the heightfield beyond the columns, close up |
| Flash threshold (0.2) | During playback, for small spends |
| Anti-aliasing (0.29) | On edges; at Extreme, supersampling already smooths them |

The full results are in `settings-audit.json` in the `--shots` directory.

## Settings reference

The tables below are generated from `landscape/web/settings.schema.js` by `node landscape/tools/settings-reference.mjs`: 143 settings in seven groups. The default is the Landscape look at High quality; the fourth column lists the looks and quality tiers whose value differs from it. Personal preferences such as camera feel and overlays are never changed by looks or quality. "Has an effect with" names the conditions under which a setting changes the image; otherwise the panel dims it.

### Colour

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Palette <br><code>color.palette</code> | film, turbo, viridis, inferno, magma, plasma, cividis, grey, custom | film | Daylight viridis; Golden hour inferno; Neon night plasma; Whales magma; Pulse grey | Colour map. Film is the film palette (site/assets/palettes.json base, with the white-hot variant on whale rows). |
| Custom gradient <br><code>color.gradient</code> | ≤ 16 stops | 5 stops | — | Stops {t 0..1, colour} used when Palette is Custom gradient: 2 to 16 stops, sorted by t, interpolated in sRGB like the panel preview. Has an effect with Palette Custom gradient. |
| Reverse palette <br><code>color.reverse</code> | bool | off | — | Flip the palette end to end (applies to the white-hot variant too). |
| Colour measure <br><code>color.measure</code> | height, density, count, value | height | Film density | rebuilds worker. Value that drives colour. Same as height follows Amplification > Measure. Values are per L0 cell (coarser levels show the mean). |
| Log offset <br><code>color.offset</code> | 0.0001–10,000 (log) | 30 | Whales 2 | t = (ln(v + o) - ln(1 + o)) / (ln(U + o) - ln(1 + o)), clamped to 0..1. Larger o compresses the low end. Film: 30. |
| Upper limit <br><code>color.upper</code> | 1.01–10,000,000 (log) | 500 | Neon night 1,500; Whales 20,000; Pulse 5,000 | Colour value U that reaches the top of the palette. Film: 500. |
| Transfer gamma <br><code>color.gamma</code> | 0.2–5 (log) | 1 | Pulse 1.6 | Exponent applied to t before the palette lookup; below 1 brightens low values. Film: 1. |
| White-hot whale rows <br><code>color.whiteHot</code> | bool | on | — | Use the white-hot palette variant on rows at or above the whale threshold, as the film does. |
| Whale threshold (BTC) <br><code>color.whiteHotBTC</code> | 1e-8–100,000 (log) BTC | 10 | — | Rows whose amounts are at least this many BTC count as whale rows (white-hot palette, the whale height multiplier and Stepped whale rows). Film: 10 BTC. Has an effect with White-hot whale rows on or Whale multiplier not 1 or Stepped whale rows on. |
| Background <br><code>color.background</code> | color | #05070c | Film #000000; Daylight #c9d8ee; Golden hour #2a1a1a; Neon night #0e0824; Pulse #060a14 | Clear colour behind the landscape; the sky gradient covers it when Sky is on. Film: black. Has an effect with Sky off. |
| Empty cells <br><code>color.ground</code> | color | #0c0f15 | Film #000000; Daylight #3b3f48; Golden hour #1a1210; Neon night #07080f; Pulse #000000 | Colour of cells with no outputs (v <= 0). Film: black. |
| Fog <br><code>color.fog</code> | color | #1a2034 | Daylight #bed3ee; Golden hour #4a2a2a; Neon night #05070d; Whales #5a3f3a; Pulse #05070d | Fog and volumetric scattering colour. Has an effect with Fog density above 0 or Sky on. |
| Heat colour <br><code>color.heat</code> | color | #ffe9c4 | Film #ffffff; Neon night #ffffff; Pulse #ffd27a | Colour of spend flashes: the glow on cells whose outputs were just spent, and the flash sprites. Has an effect with Heat gain above 0 or Flash size above 0. |
| Heat gain <br><code>color.heatGain</code> | 0–20 | 2.5 | Neon night 6; Pulse 6 | Overall brightness of spend flashes on the terrain; 0 hides them. Above 1 they glow through bloom. |
| Hue shift <br><code>color.hueShift</code> | -180–180 deg | 0 | — | Rotates every hue by this many degrees. |
| Saturation <br><code>color.saturation</code> | 0–2 | 1 | Neon night 1.25 | 0 = greyscale, 1 = unchanged, 2 = double. |
| Contrast <br><code>color.contrast</code> | 0–2 | 1 | — | Contrast around mid grey; 1 = unchanged. |
| Temperature <br><code>color.temperature</code> | -1–1 | 0 | Golden hour 0.25 | White balance: -1 cool (blue) to +1 warm (amber). |
| Tint <br><code>color.tint</code> | -1–1 | 0 | — | White balance: -1 green to +1 magenta. |
| Lift <br><code>color.lift</code> | -0.5–0.5 | 0 | — | Shadow offset, tinted by Lift colour: out = (in * gain * gainColour + lift * liftColour * (1 - in)) ^ (1 / gamma). |
| Lift colour <br><code>color.liftColor</code> | color | #ffffff | — | Tint of the lift (white = neutral). Has an effect with Lift not 0. |
| Gamma <br><code>color.gradeGamma</code> | 0.2–5 (log) | 1 | — | Midtone gamma of the grade; 1 = unchanged. |
| Gain <br><code>color.gain</code> | 0–4 | 1 | — | Highlight multiplier, tinted by Gain colour; 1 = unchanged. |
| Gain colour <br><code>color.gainColor</code> | color | #ffffff | — | Tint of the gain (white = neutral). |
| Tone mapping <br><code>color.toneMapping</code> | none, linear, reinhard, aces, agx, neutral | agx | Film none; Daylight neutral | rebuilds post. HDR to display mapping. Film: none. |
| Exposure mode <br><code>color.exposureMode</code> | manual, auto | manual | — | rebuilds post. Auto measures a luminance histogram with a compute pass (WebGPU only). |
| Exposure <br><code>color.exposure</code> | 0.01–16 (log) x | 1 | Neon night 0.8 | Linear exposure multiplier; in auto mode it is the compensation applied on top. Film: 1. |
| Auto minimum <br><code>color.autoExposureMin</code> | 0.01–16 (log) x | 0.25 | — | WebGPU only. Lowest exposure multiplier auto exposure may choose. Has an effect with Exposure mode Auto (histogram). |
| Auto maximum <br><code>color.autoExposureMax</code> | 0.01–16 (log) x | 4 | — | WebGPU only. Highest exposure multiplier auto exposure may choose. Has an effect with Exposure mode Auto (histogram). |
| Auto speed <br><code>color.autoExposureSpeed</code> | 0.1–10 (log) /s | 1.5 | — | WebGPU only. Adaptation rate per second. Has an effect with Exposure mode Auto (histogram). |
| 3D LUT (.cube) <br><code>color.lut</code> | file | — | — | personal preference, rebuilds post. A .cube 3D LUT applied after the grade. Value {name, text}: kept in memory and in JSON exports, never in the URL. |
| LUT intensity <br><code>color.lutIntensity</code> | 0–1 | 1 | Film 0 | Mix between the graded image (0) and the LUT result (1). Has an effect with a 3D LUT (.cube) loaded. |
| Display P3 output <br><code>color.p3</code> | bool | off | — | rebuilds post. Wide-gamut Display P3 canvas where the browser supports it. Film: off (sRGB). |

### Amplification

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Measure <br><code>amp.measure</code> | density, count, value | density | Whales value | rebuilds worker. Height value per L0 cell: weighted density = outputs up to 5 BTC + (BTC above 5 BTC outputs) / 5; count = outputs; value = BTC. Coarser levels show the mean per L0 cell. |
| Height curve <br><code>amp.curve</code> | log, power, linear | log | — | log: ln(1 + e v) / ln(1 + e R); power: (v / R) ^ exponent; linear: v / R (e = exposure, R = reference). |
| Power exponent <br><code>amp.exponent</code> | 0.05–4 (log) | 0.5 | — | Exponent of the power curve. Has an effect with Height curve Power. |
| Log exposure <br><code>amp.exposure</code> | 0.0001–10,000 (log) | 1 | Whales 0.5 | Value normalisation e of the log curve; higher lifts small values. The power and linear curves ignore it. Has an effect with Height curve Logarithmic. |
| Reference value <br><code>amp.reference</code> | 0.001–10,000,000 (log) | 500 | Whales 50,000 | Value R at which the curve reaches 1, i.e. Exaggeration world units of height. |
| Exaggeration <br><code>amp.exaggeration</code> | 0–200 world units | 10 | Whales 16 | Height at curve value 1. The landscape is 966.8 units wide (block / 1000) and 207.2 deep (row / 10). |
| Floor height <br><code>amp.floor</code> | 0–5 world units | 0.05 | — | Minimum height added to every occupied cell so sparse cells stay visible; empty cells stay at 0. |
| Whale multiplier <br><code>amp.whale</code> | 0–10 x | 1 | Whales 2 | Height multiplier for rows at or above Colour > Whale threshold. It eases in over the decade of amounts below the threshold (from 1 BTC at the default 10 BTC), so the taller rows rise gradually instead of starting at a cliff. |
| Heat half-life (blocks) <br><code>amp.heatHalfLife</code> | 0.5–100,000 (log) blocks | 30 | Pulse 300 | rebuilds worker. A spend flash fades to half every this many blocks (30 blocks = 0.5 s at 1x, about 5 hours of chain time). Has an effect with Heat gain above 0 or Flash size above 0. |
| Flash floor <br><code>amp.heatFloor</code> | 0–1 | 0.35 | Pulse 0.5 | Brightness every spend reaches at its block, whatever its amount (as every spent output flashes in the film); 0 makes brightness depend only on the BTC moved. Has an effect with Heat gain above 0. |
| Full flash at (BTC) <br><code>amp.heatReference</code> | 0.001–100,000 (log) BTC | 100 | — | BTC moved from one cell (summed with its recent spends) that reaches full flash brightness; smaller spends scale down logarithmically to the floor. Has an effect with Heat gain above 0 or Flash size above 0. |
| Edge flash strength <br><code>amp.heatEdge</code> | 0–1 | 0.15 | — | Brightness of flashes for coins created within the edge flash window of the current block, ramping to full beyond it. Young coins are spent constantly; the film also keeps those flashes small. 1 treats them like old coins. Has an effect with Heat gain above 0 or Flash size above 0. |
| Edge flash window (blocks) <br><code>amp.heatEdgeBlocks</code> | 1–100,000 (log) blocks | 4,032 | — | Coins created within this many blocks of the current block count as creation-edge spends for Edge flash strength (4,032 blocks = about four weeks, close to the film's creation-edge flash zone). Has an effect with Heat gain above 0 or Flash size above 0. |
| Flash size <br><code>amp.flashSize</code> | 0–10 | 1 | Neon night 2; Pulse 2 | Size of the flash sprites over spent cells: at least 3 px on screen, growing to 16 px at the full-flash amount, smaller for coins spent near the creation edge. 0 hides them. |
| Flash threshold (BTC) <br><code>amp.flashThreshold</code> | 1e-8–100,000 (log) BTC | 0.0001 | — | Smallest BTC moved from one cell within one block that spawns a flash sprite; the default skips dust. Up to 400 new sprites per frame, old coins and larger amounts first. Has an effect with Flash size above 0. |
| Creation-edge glow <br><code>amp.edgeGlow</code> | 0–10 | 0.25 | Film 0; Pulse 0 | Emissive boost on outputs created in the most recent blocks, fading over Edge width; 0 = off. At 1 the newest cells glow at twice their colour and bloom spreads a bright haze around the creation edge. |
| Edge width (blocks) <br><code>amp.edgeBlocks</code> | 1–100,000 (log) blocks | 1,008 | — | Width of the creation-edge glow, counted back from the current block (1,008 blocks = about one week). Has an effect with Creation-edge glow above 0. |
| Now plane <br><code>amp.nowPlane</code> | 0–1 | 0.15 | Film 0; Daylight 0.1; Pulse 0.25 | Opacity of the translucent vertical plane at the current block; 0 = off. |

### Geometry

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Smoothing <br><code>geo.smoothing</code> | none, bilinear, bicubic | bilinear | Film none; Ultra bicubic; Extreme bicubic | rebuilds material. Height interpolation between cell centres. Changes the surface only when Subdivision is 2 or 4 (at 1x every vertex sits on a cell centre); Stepped cells ignore it. Has an effect with Stepped cells off and Subdivision not 1x. |
| Stepped cells <br><code>geo.stepped</code> | bool | off | Film on; Neon night on | rebuilds material. Flat-topped cells with vertical walls; each cell shows exactly one palette colour. Ignores Smoothing and Subdivision. Applies to the heightfield, which draws the landscape beyond the cylinders of Column cells (and everywhere on WebGL2). About four times the triangles of the smooth surface. |
| Stepped whale rows <br><code>geo.steppedWhales</code> | bool | on | — | rebuilds material. Draws the whale rows (amounts at or above the whale threshold, 10 BTC by default) as stepped cells while the rest of the surface stays smooth. Large amounts are sparse, and the smooth surface turns a lone tall cell into a pyramid that narrows to a point, so whale spikes break into dotted hairs from a distance; a stepped cell keeps its width to the top, and far away it is widened to at least 1.5 px. Costs about four times the triangles on those rows. Has an effect with Stepped cells off. |
| Subdivision <br><code>geo.subdivision</code> | 1, 2, 4 | 1 | Extreme 2 | rebuilds terrain. Heightfield vertices per cell edge (more = smoother bicubic surfaces, more triangles). Has an effect with Stepped cells off. |
| Skirts <br><code>geo.skirts</code> | bool | on | — | rebuilds terrain. Vertical skirts hide cracks between tiles of different levels. |
| Wireframe <br><code>geo.wireframe</code> | bool | off | — | personal preference, rebuilds material. Draw the terrain as wireframe (diagnostic). |
| Column cells <br><code>geo.columns</code> | bool | on | Film off | WebGPU only, rebuilds terrain. Near the view, every occupied level-0 cell (64 blocks x 1 amount row) is its own column, a cylinder by default (Cell shape); the heightfield continues beyond Column radius. Needs WebGPU compute; WebGL2 draws the heightfield only. |
| Cell shape <br><code>geo.columnShape</code> | cylinder, oval, box | cylinder | Neon night box | WebGPU only, rebuilds material. Shape of each column. Cylinder: a plain round column as wide as the cell (64 blocks), leaving room between amount rows. Oval: a cylinder stretched to fill the cell. Box: a square prism like Stepped cells. Has an effect with Column cells on. |
| Cylinder sides <br><code>geo.cylinderSides</code> | 6, 8, 12, 16, 24, 32 | 12 | Performance 8 | WebGPU only, rebuilds material. Sides of each cylinder: rounder outlines up close, at 3 triangles per side per column. Has an effect with Column cells on and Cell shape not Box. |
| Column radius <br><code>geo.columnRadius</code> | 16–8,192 (log) L0 cells | 4,096 | — | WebGPU only. Upper limit on how far columns reach from the camera, in level-0 cell widths (64 blocks each). Column detail and the instance budget set the reach first. Has an effect with Column cells on. |
| Column detail <br><code>geo.columnPixels</code> | 1–32 (log) px | 4 | Performance 12; Balanced 6 | WebGPU only. Columns are drawn where a cell is at least this many pixels wide on screen, measured from the camera to the ground, so they follow the camera; smaller cells are drawn by the heightfield. Lower = columns reach farther and cost more (quick setting Column distance). Has an effect with Column cells on. |
| Instance budget <br><code>geo.instanceBudget</code> | 10,000–8,000,000 (log) | 1,000,000 | Performance 250,000; Extreme 2,000,000 | WebGPU only, rebuilds terrain. Maximum columns drawn per frame (up to 8,000,000; quick setting Column cap). When the cells within Column distance need more, the column area shrinks to fit. On an Apple M4 Max at 2880x1800, each 100,000 far columns cost about 1.2 to 1.8 ms of GPU time with the Box far style and shadows. Has an effect with Column cells on. |
| Column gap <br><code>geo.columnGap</code> | 0–0.9 | 0.12 | Neon night 0.25 | WebGPU only. Fraction of each cell footprint left empty between columns. Has an effect with Column cells on. |
| Far columns <br><code>geo.farColumns</code> | prism, card, flat, cross | prism | — | WebGPU only, rebuilds material. How columns narrower than 20 px on screen are drawn (most columns, far from the camera). Box: a 4-sided box shaded round, 12 triangles. Card: one rectangle that turns to face the camera, with a flat top, 4 triangles. Flat card: the rectangle alone, 2 triangles; seen from straight above it thins to nothing. Cross: two crossed rectangles that stay put, 4 triangles. The rectangles are shaded as if round. Has an effect with Column cells on. |
| Far column shadows <br><code>geo.farShadows</code> | bool | on | — | Far columns (narrower than 20 px on screen) cast sun shadows. Off saves most of the shadow cost of the columns; the near columns and the landscape beyond the columns keep their shadows. Has an effect with Column cells on and Shadows on. |
| LOD bias <br><code>geo.lodBias</code> | -3–3 | 0 | — | +1 asks for one level finer detail, -1 one level coarser (refinement threshold = pixels per cell x 2^-bias). |
| Pixels per cell <br><code>geo.pixelsPerCell</code> | 0.5–32 (log) px | 3 | Performance 6; Balanced 4; Extreme 2 | Refine a tile while its cells cover more than this many screen pixels; lower = finer, more tiles. |
| Tile budget <br><code>geo.tileBudget</code> | 32–400 | 225 | Performance 96; Balanced 160; Extreme 320 | rebuilds terrain. Maximum resident tiles in the worker and the GPU atlas (each costs about 1 MB of GPU memory and 2 MB in the worker). |

### Lighting

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Sun azimuth <br><code>light.sunAzimuth</code> | 0–360 deg | 98 | Daylight 200; Golden hour 110; Neon night 225; Whales 290; Pulse 225 | Direction the sunlight comes from, clockwise seen from above: 0 = from -z (large-amount rows), 90 = from +x (tip), 180 = from +z (default camera side), 270 = from -x (genesis). Has an effect with Sun intensity above 0 or Sky on or Volumetric light on or God rays on. |
| Sun elevation <br><code>light.sunElevation</code> | -5–90 deg | -1.5 | Daylight 62; Golden hour 6; Neon night -3; Whales 9; Pulse -3 | Height of the sun above the horizon; below 0 only its afterglow lights the walls that face it. Has an effect with Sun intensity above 0 or Sky on or Volumetric light on or God rays on. |
| Sun intensity <br><code>light.sunIntensity</code> | 0–20 | 5 | Film 0; Daylight 4; Golden hour 6; Neon night 0.8; Whales 4.5; Pulse 0.8 | Directional light intensity. Film: 0. |
| Sun colour <br><code>light.sunColor</code> | color | #ffa58c | Daylight #ffffff; Golden hour #ff9a4a; Neon night #a8bcff; Whales #ffc78a; Pulse #a8bcff | Colour of the directional light. Has an effect with Sun intensity above 0 or Sky on or Volumetric light on or God rays on. |
| Sky light <br><code>light.skyColor</code> | color | #9aaef0 | Daylight #7eabef; Golden hour #ffb27a; Neon night #1b2747; Whales #f6d6b8; Pulse #1b2747 | Hemisphere light colour from above. Has an effect with Sky on or Ambient intensity above 0. |
| Ground light <br><code>light.groundColor</code> | color | #2a2430 | Daylight #6b6e72; Golden hour #3a2a2e; Neon night #08090d; Whales #3a2e28; Pulse #08090d | Hemisphere light colour from below. Has an effect with Sky on or Ambient intensity above 0. |
| Ambient intensity <br><code>light.ambient</code> | 0–5 | 1.6 | Film 0; Daylight 1.1; Golden hour 0.35; Neon night 0.5; Whales 0.5; Pulse 0.5 | Hemisphere (sky and ground) light intensity. Film: 0. Has an effect with Albedo above 0. |
| Rim light <br><code>light.rim</code> | 0–5 | 0.35 | Film 0; Daylight 0; Neon night 0.8 | Fresnel rim light that outlines peaks against the background. Film: 0. |
| Rim colour <br><code>light.rimColor</code> | color | #8fb8ff | Neon night #ff5ad9; Pulse #b8c0cc | Colour of the rim light. Has an effect with Rim light above 0. |
| Emissive strength <br><code>light.emissive</code> | 0–10 | 0.4 | Film 1; Daylight 0.15; Golden hour 0.25; Neon night 0.9; Pulse 0.25 | Self-illumination by the palette colour. Emissive 1 with albedo 0 shows the unlit palette colour (Film). |
| Albedo <br><code>light.albedo</code> | 0–1 | 0.85 | Film 0; Daylight 0.95; Golden hour 0.9; Neon night 0.15; Pulse 0.5 | Diffuse reflectance as a fraction of the palette colour. Film: 0. |
| Roughness <br><code>light.roughness</code> | 0–1 | 0.65 | Daylight 0.8 | Surface roughness of the terrain material. |
| Metalness <br><code>light.metalness</code> | 0–1 | 0.05 | — | Metalness of the terrain material. |
| Floor reflection <br><code>light.floorReflection</code> | 0–1 | 0 | — | Makes the ground (empty cells) a mirror through screen-space reflections (Effects > SSR); without SSR it only turns the ground dark and glossy. 0 = off. |
| Shadows <br><code>light.shadows</code> | bool | on | Film off; Performance off | rebuilds shadows. Sun shadows through cascaded shadow maps. Film: off. Has an effect with Sun intensity above 0. |
| Cascades <br><code>light.cascades</code> | 1–4 | 3 | Performance 2; Balanced 2; Extreme 4 | rebuilds shadows. Cascaded shadow map splits. Has an effect with Shadows on. |
| Shadow map size <br><code>light.shadowMapSize</code> | 1024, 2048, 4096 | 2048 | Performance 1024; Ultra 4096; Extreme 4096 | rebuilds shadows. Resolution of each cascade. Has an effect with Shadows on. |
| Shadow filter <br><code>light.shadowFilter</code> | basic, pcf, vsm, pcss | pcf | — | rebuilds shadows. Shadow filtering. PCSS softens shadows with distance from the occluder (custom filter node; measured about +10 ms per frame at 4K on the M4 Max). Has an effect with Shadows on or Volumetric light on. |
| Softness <br><code>light.shadowSoftness</code> | 0–10 | 1 | Daylight 0.6; Golden hour 1.2; Extreme 1.5 | Filter radius (shadow.radius); light size for PCSS. Has an effect with Shadows on. |
| Bias <br><code>light.shadowBias</code> | -0.01–0.01 | -0.0005 | — | Depth bias against shadow acne. Has an effect with Shadows on. |
| Fog density <br><code>light.fogDensity</code> | 0–0.05 (log) | 0.002 | Film 0; Golden hour 0.008; Neon night 0; Pulse 0 | Fog density per world unit; 0 = no fog. Film: 0. |
| Fog height falloff <br><code>light.fogHeightFalloff</code> | 0–1 (log) | 0.05 | Golden hour 0.02 | Fog thins with height: density * exp(-falloff * y). 0 = uniform fog. Has an effect with Fog density above 0. |
| Volumetric light <br><code>light.volumetric</code> | bool | off | Ultra on; Extreme on | rebuilds post. Ray-marched height-fog volume lit by the sun with its own shadow map, so peaks cast shafts through the haze; rendered at half resolution and smoothed. Density follows Fog density and Fog height falloff. Has an effect with Sun intensity above 0. |
| Volumetric steps <br><code>light.volumetricSteps</code> | 8–256 (log) | 32 | Extreme 64 | Ray-march steps of the half-resolution volumetric pass. Has an effect with Volumetric light on. |
| Volumetric intensity <br><code>light.volumetricIntensity</code> | 0–4 | 1 | — | Scales the scattered light. Has an effect with Volumetric light on. |
| God rays <br><code>light.godRays</code> | bool | off | Golden hour on; Ultra on; Extreme on | rebuilds post. Screen-space light shafts: a half-resolution radial blur of the sky around the sun position on screen, visible when the sun is near or in view. Needs no shadows; shadowed shafts through the haze come from Volumetric light. Has an effect with Sun intensity above 0. |
| God ray intensity <br><code>light.godRaysIntensity</code> | 0–4 | 1 | Golden hour 1.2 | Strength of the light shafts. Has an effect with God rays on. |
| Sky <br><code>light.sky</code> | bool | on | Film off; Neon night off; Pulse off | Sky gradient dome, which covers the background colour. Film: off. |
| Stars <br><code>light.stars</code> | bool | on | Film off; Daylight off; Golden hour off; Whales off; Pulse off | Star field. Film: off. |
| Star density <br><code>light.starDensity</code> | 0–1 | 0.5 | Neon night 0.45 | Fraction of the star field shown. Has an effect with Stars on. |

### Effects

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Ambient occlusion <br><code>fx.ao</code> | off, ssao, gtao | gtao | Film off; Performance off; Balanced ssao | rebuilds post. Screen-space ambient occlusion. Film: off. |
| AO radius <br><code>fx.aoRadius</code> | 0.05–10 (log) world units | 1 | — | Occlusion sampling radius. Has an effect with Ambient occlusion not Off or SSGI on. |
| AO intensity <br><code>fx.aoIntensity</code> | 0–4 | 1 | — | Darkening strength. Has an effect with Ambient occlusion not Off. |
| AO samples <br><code>fx.aoSamples</code> | 4–64 | 16 | Performance 8; Balanced 8; Extreme 32 | rebuilds post. Samples per pixel. Has an effect with Ambient occlusion not Off and SSGI off. |
| SSGI <br><code>fx.ssgi</code> | bool | off | — | WebGPU only, rebuilds post. Screen-space global illumination: indirect light and colour bleeding between peaks. Off while Depth of field is on: the two together froze the page. Has an effect with Depth of field off. |
| SSGI steps <br><code>fx.ssgiSamples</code> | 4–32 | 8 | — | WebGPU only. SSGINode stepCount; slices = ceil(steps / 8); samples per pixel = slices * steps * 2. Has an effect with SSGI on. |
| SSGI intensity <br><code>fx.ssgiIntensity</code> | 0–4 | 1 | — | WebGPU only. Strength of the indirect light. Has an effect with SSGI on. |
| SSR <br><code>fx.ssr</code> | bool | off | Extreme on | rebuilds post. Screen-space reflections. |
| SSR intensity <br><code>fx.ssrIntensity</code> | 0–2 | 1 | — | Reflection strength. Has an effect with SSR on. |
| SSR steps <br><code>fx.ssrSteps</code> | 8–64 | 32 | — | Ray-march steps (SSRNode quality = steps / 64). Has an effect with SSR on. |
| Bloom <br><code>fx.bloom</code> | bool | on | Film off; Daylight off | rebuilds post. Glow around bright pixels. Film: off. |
| Threshold <br><code>fx.bloomThreshold</code> | 0–4 | 0.85 | Golden hour 0.95; Neon night 0.95 | Luminance above which pixels bloom. Has an effect with Bloom on. |
| Strength <br><code>fx.bloomStrength</code> | 0–3 | 0.6 | Golden hour 0.35; Neon night 1.2 | Bloom intensity. Has an effect with Bloom on. |
| Radius <br><code>fx.bloomRadius</code> | 0–1 | 0.4 | Golden hour 0.3; Neon night 0.6 | Bloom spread (0..1). Has an effect with Bloom on. |
| Mip levels <br><code>fx.bloomMips</code> | 1–5 | 5 | Performance 4 | rebuilds post. Narrows the glow by dropping the widest mips. It does not reduce GPU cost: the stock BloomNode always runs 5 passes. Has an effect with Bloom on. |
| Depth of field <br><code>fx.dof</code> | bool | off | — | rebuilds post. Blur outside the focal plane. Turns SSGI off while it is on (the two together froze the page). |
| Auto focus <br><code>fx.dofAutoFocus</code> | bool | on | — | Focus on the terrain at screen centre (the crosshair). Has an effect with Depth of field on. |
| Focus distance <br><code>fx.dofFocus</code> | 0.5–2,000 (log) world units | 100 | — | Focus distance when auto focus is off. Has an effect with Depth of field on and Auto focus off. |
| Aperture <br><code>fx.dofAperture</code> | 0.1–10 (log) | 1 | — | Bigger = shallower focus. Has an effect with Depth of field on. |
| Max blur <br><code>fx.dofMaxBlur</code> | 0–20 | 4 | — | Largest bokeh size. Has an effect with Depth of field on. |
| Motion blur <br><code>fx.motionBlur</code> | bool | off | Extreme on | rebuilds post. Velocity-based blur while the camera or terrain moves. |
| Amount <br><code>fx.motionBlurAmount</code> | 0–2 | 0.5 | — | Velocity scale; 1 = one frame of motion. Has an effect with Motion blur on. |
| Film grain <br><code>fx.grain</code> | 0–1 | 0 | — | Grain intensity; 0 = off. |
| Chromatic aberration <br><code>fx.chromatic</code> | 0–2 | 0 | Neon night 0.3 | Colour fringing towards the edges; 0 = off. |
| Vignette <br><code>fx.vignette</code> | 0–1 | 0 | Golden hour 0.25; Neon night 0.35 | Darkening towards the corners; 0 = off. |

### Camera

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Field of view <br><code>camera.fov</code> | 15–110 deg | 50 | — | personal preference. Vertical field of view. |
| Flight speed <br><code>camera.flySpeed</code> | 0.05–50 (log) x | 1 | — | personal preference. Flight speed multiplier; speed also scales with height above the terrain and the wheel changes it in flight. |
| Mouse sensitivity <br><code>camera.sensitivity</code> | 0.1–5 (log) x | 1 | — | personal preference. Mouse look and orbit sensitivity. |
| Invert Y <br><code>camera.invertY</code> | bool | off | — | personal preference. Invert vertical mouse look in flight mode. In plane mode, pushing up (mouse or stick up, the up arrow) raises the nose; this switches to pulling back, as in flight sims. |
| Damping <br><code>camera.damping</code> | 0–0.95 | 0.2 | — | personal preference. Smoothing of camera motion: 0 = immediate, higher = smoother. |
| Terrain collision <br><code>camera.collision</code> | bool | on | — | personal preference. Keep the camera above the terrain surface. |

### Display

| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |
|---|---|---|---|---|
| Resolution scale <br><code>display.scale</code> | 0.25–2 x | 1 | Performance 0.75 | Render resolution as a multiple of devicePixelRatio (2 = 7680x4320 on a 3840x2160 canvas). |
| Auto scale <br><code>display.autoScale</code> | bool | off | — | personal preference. Adjust the scale between minimum and maximum to hold the target frame rate. A personal preference: presets leave it alone, so turn it off to let Ultra or Extreme load the GPU fully. |
| Target fps <br><code>display.targetFps</code> | 24–240 fps | 60 | — | personal preference. Frame rate auto scale aims for. Has an effect with Auto scale on. |
| Auto minimum <br><code>display.scaleMin</code> | 0.25–2 x | 0.5 | — | personal preference. Lowest scale auto scale may choose. Has an effect with Auto scale on. |
| Auto maximum <br><code>display.scaleMax</code> | 0.25–2 x | 2 | — | personal preference. Highest scale auto scale may choose. Has an effect with Auto scale on. |
| Anti-aliasing <br><code>display.aa</code> | none, fxaa, smaa, traa | traa | Film none; Performance fxaa; Balanced smaa | rebuilds post. Post-process anti-aliasing. Film: none. |
| Supersampling <br><code>display.ssaa</code> | 1, 2, 4 | 1 | Extreme 2 | rebuilds post. Supersamples the scene pass only, at sqrt(N) times the resolution per axis (4 = 2x2), resolved by an exact box downsample. Effects run at output resolution; TRAA is skipped while supersampling is on. |
| Performance overlay <br><code>display.overlay</code> | bool | off | — | personal preference. fps, CPU and GPU ms per pass, triangles, instances, tiles and worker rate. |
| Axis labels <br><code>display.labels</code> | bool | on | — | personal preference. Block, date and amount labels in the scene. |
| Grid <br><code>display.grid</code> | bool | on | Film off; Pulse off | Reference grid lines on the ground. Film: off, because grid lines draw over palette colours. |
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
| 600 blocks/s target from 420,000 to 960,000 (the 10× speed of that build) | 598–599 blocks/s, exact |
| Max (chained exact replay) | 1,154 blocks/s at 630,000, 886 at 840,000, 868 at 960,000 |
| Worker memory | 714 MB (74 tiles), 853 MB (225), 878 MB (400) |

In the app, 1× playback from block 314,000 advanced 602 blocks in 10.03 s without a snapshot shortcut. The totals and 20 sampled cells at the end equalled a fresh seek to the same block. The browser checks in `landscape/tests/shell-browser-checks.mjs` pass 43 of 43 against the full dataset and the native explorer. Among them, the inspector's replay matches the explorer's history index: at block 840,000, for example, one cell holds 3,156 outputs and 7.89260638 BTC in both.

## Limitations

- Every block has the same width, so early eras look sparse next to the film. Horizontal detail stops at 64-block cells, although the HUD, stepping and playback are exact per block.
- Cylinders show each cell's exact colour near the camera; beyond them, the smooth heightfield blends colours between cells. Exact per-cell colours everywhere need stepped cells, which the Film look uses. Cylinder height follows the height curve, not a count of outputs.
- Cylinders cost GPU time in close and middle views (see Cylinders under Looks, quality and measured performance). Column detail 8 px, or Column cells off, trades detail back for frame rate.
- Heat starts empty after a seek, and tiles that load during playback start without heat history.
- Instanced columns, SSGI and automatic exposure need WebGPU. On WebGL2, at most 24 tiles upload per frame, so distant tiles can lag during playback.
- God rays work in screen space and appear only when the sun is near the view; the volumetric option gives shadowed light shafts from any angle. Fewer bloom mips narrow the glow without saving GPU time. PCSS estimates blocker distance approximately.
- SSGI stays off while depth of field is on: the two together froze the page for good (WebGPU, Chrome 155, M4 Max, 2026-10-13, also online). The cause is not known yet. SSGI's indirect light is also too faint to see; its visible effect is its ambient occlusion (see Settings audit).
- Flight-mode and plane-mode pointer lock were checked only through the drag fallback (headless Chrome refuses the lock), and the gamepad mapping only with simulated gamepads. Firefox was not tested; Brave passed the browser checks online. Touch gestures were checked with real multi-touch input in Chrome's phone emulation (390 × 844), not yet on a physical phone or in iOS Safari.
- Locally, the inspector's history section needs the explorer on port 12989, and its cell API shares `/api/pixel`'s rate limit (15 requests/s, burst 40). Online, the Worker answers it with 8 requests/s and a burst of 20 per visitor and Worker instance.
- Online, a seek takes about 1–2 s and 5× or Max playback follows the connection's download speed (see Online). The dataset ends at block 970,658; a newer tip needs a new dataset. `scripts/landscape_r2_publish.py` copies every chunk and snapshot before the old tip inside R2 and uploads only the new ones, about 60 MB of snapshots a day. The first dataset built after snapshots became self-describing still uploads its snapshots once (58 GB, about 36 minutes from here), because the published 970,658 files record that dataset's block count.
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
| `landscape/web/settings.schema.js`, `settings.js`, `settings.quick.js` | Settings schema with looks, quality tiers and needs; the store with saved looks; the quick settings |
| `landscape/web/ui/panel.js`, `ui/quick.js`, `landscape/tools/settings-reference.mjs` | Settings panel, its quick settings, and the generator of the settings reference tables |
| `landscape/web/index.html`, `main.js`, `ui/` | App shell, navigation, playback, timeline, places, minimap, inspector, legend and HUD |
| `landscape/web/ui/online.js` | Online versus local: dataset index, cell API and 2D link, first-visit quality |
| [`cloudflare/utxo-landscape-worker/`](../cloudflare/utxo-landscape-worker/README.md) | The online Worker: static app, dataset from R2, cell API, deploy and publish procedure |
| `scripts/landscape_r2_verify.py`, `scripts/check_landscape_worker.mjs`, `landscape/tools/csp-hash.mjs` | Uploaded-dataset verification, Worker checks, CSP hash of the import map |
| `landscape/tests/` | `node --test landscape/tests/` (196 tests, 4 skipped without a local dataset) and the browser checks, including the `touch` check that drives every gesture with real multi-touch input on an emulated phone, and the settings checks `quick-settings`, `looks`, `user-presets`, `advanced-needs` and the opt-in `settings-audit` (`--audit`) |
| `landscape/tools/browser-check.mjs`, `gpu-util.mjs`, `landscape/web/dev/` | Headless Chrome checker (`--mobile` emulates a phone with touch input), GPU utilisation sampler and development harnesses |

The vendored three.js 0.186.0 and lil-gui 0.17 are MIT licensed ([`vendor/three/README.md`](../landscape/web/vendor/three/README.md)); the fonts keep their OFL licences. The original concept and code are by Martinus ([BitcoinUtxoVisualizer](https://github.com/martinus/BitcoinUtxoVisualizer), MIT).
