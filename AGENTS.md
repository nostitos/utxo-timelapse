# Working on UTXO Timelapse

The root is the Git repository. The C++ executable remains named `buv`; the public project is **UTXO Timelapse**. Use [GLOSSARY.md](GLOSSARY.md) for canonical terms and [docs/README.md](docs/README.md) for build/operations commands.

## Architecture

Bitcoin Core REST → `utxo_to_change` → `changes.blk1`, then two paths:

- `visualizer` → raw RGB24 over TCP → FFmpeg → HEVC master → segmented HLS.
- `utxo_history` / `utxo_history_update` → historical lifecycle records → cloud shards and spend patches.

The native explorer and the Cloudflare Worker query the same coordinate model. The public guide is static `site/`, deployed by GitHub Pages. Public URLs: `https://utxo.aiception.ai/` and `https://nostitos.github.io/utxo-timelapse/`.

## Key sources

| Source | Role |
|---|---|
| `src/cpp/app/Cfg.cpp` | Authoritative parser defaults and required fields |
| `src/cpp/app/Utxo.cpp` | UTX3 checkpoints, creation heights and zero-output preservation |
| `src/cpp/app/Visualizer.cpp` | Frame loop and historical state replay |
| `src/cpp/buv/Density.h` | Double density, alive ledger, activity and flow lines |
| `src/cpp/buv/SatoshiBlockheightToPixel.h` | X/Y geometry and smooth transitions |
| `src/cpp/buv/DensityToImage.h` | Palette and logarithmic transfer |
| `src/cpp/app/UtxoHistory.h` | Offset-based BUVHIST1 layout |
| `cloudflare/utxo-video-worker/src/` | Cloud mapping, history queries, release and request handling |
| `site/technical.html` | Complete technical reference and configuration table |

## Build and test

Clone submodules. CMake ≥3.13, C++17, OpenCV and TBB are needed. See `docs/README.md` for the tested AppleClang warning/TBB flags.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3'
python3 scripts/check_site.py
node --experimental-default-type=module scripts/check_site_mapping.mjs
```

A bare `buv` invocation can run zero cases on macOS because the broad legacy unit directory is excluded. Read the case count. Build Docker from the root, never ignored legacy `buv_deploy/` source copies. Start the encoder before the renderer. Test a short meaningful range before a full run.

## Correctness and data rules

- Preserve unrelated dirty work and local artifacts.
- Do not modify/delete chain data, checkpoints or full renders unless that operation is requested. Keep `allowBlkFileTruncate=false` for routine updates.
- v3 checkpoints preserve original creation heights and zero-satoshi outputs; resume requires the matching BLK size, tail and chain hash. Legacy caveats are historical, not current behavior.
- A node checkpoint does not save renderer state. A later start frame still requires replay.
- Epoch-mode remapping rebuilds exact surviving contributions from the alive ledger. Do not replace this with raster averaging. Renderer, HUD, cloud inverse mapping and the guide demonstration must agree at integer pixels.
- Persistent weighted density uses `max(1, amount/5 BTC)`; flashes use actual BTC moved without a per-output minimum. Keep these distinct.
- The HUD stays at the left. Do not claim pixel identity based on a lossy encode or claim a full outpoint from the compact lifecycle index.
- Read section offsets from BUVHIST1; incremental updates can move arrays after records.
- Verify process exits, final FFmpeg summary, frame counts, decoded boundary samples, and live playback. File growth alone is not success.

## Presentation and releases

The guide uses real rendered frames and actual interface screenshots. Label upstream material and development comparisons. Preserve Martinus's MIT copyright and clearly credit the original concept/code; use this project's identity throughout current presentation.

Keep local and cloud explorer HTML behavior/branding consistent. UI-only releases use a fresh immutable `sitePrefix` and release version while retaining video/history fields. GitHub Pages publishes only `site/`. Do not commit source datasets, full videos, private node config, credentials, diagnostics, `.wrangler/` or legacy deployment copies.

`site/assets/manifest.json` records curated preview provenance. `scripts/build_site_media.py` extracts from an existing master by integer frame index; it must not rerender or mutate the source. See `site/README.md` for budgets and screenshot provenance. Self-host fonts and preserve their licenses.

Run-specific append/publish scripts require fresh paths, ranges and manifests; inspect them before use. Historical run reports belong in `docs/history/`. Current operational files are described in `docs/render-files.md`.
