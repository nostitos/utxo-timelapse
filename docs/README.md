# Operations and source guide

Start with the [illustrated guide](https://nostitos.github.io/utxo-timelapse/) to understand the picture, or the [technical reference](https://nostitos.github.io/utxo-timelapse/technical.html) for the complete rendering/configuration/API model.

## Build and verify

Clone with `--recurse-submodules`. Install a C++17 compiler, CMake ≥3.13, OpenCV and TBB development packages. On Debian/Ubuntu: `build-essential cmake libopencv-dev libtbb-dev`. On macOS: `brew install cmake opencv tbb`.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3'
```

The current AppleClang build was checked with:

```sh
cmake -S . -B build_local -DCMAKE_BUILD_TYPE=Release \
  -DOpenCV_DIR="$(brew --prefix opencv)/lib/cmake/opencv4" \
  -DCMAKE_EXE_LINKER_FLAGS="-L$(brew --prefix tbb)/lib" \
  -DCMAKE_CXX_FLAGS='-Wno-error=sign-compare -Wno-error=bitwise-instead-of-logical -Wno-error=deprecated-builtins -Wno-error=deprecated-declarations'
cmake --build build_local --parallel 6
./build_local/buv -ns '-tc=density_palette,epoch_transition_mapping,checkpoint_v3'
```

These targeted cases passed **1,965 assertions** during the presentation release. On Apple platforms, CMake excludes the legacy `src/cpp/unit` directory. A bare `./build/buv` can report success with **zero cases**; inspect the case count. The named production tasks use doctest's skip mechanism and need `-ns`.

Build Docker from the repository root: `docker build -t buv .`. The entry point is `buv`; pass task arguments directly. Ignored `buv_deploy/` directories are legacy snapshots.

## Follow the pipeline

| Operation | Entry point / documentation |
|---|---|
| Extract or resume chain changes | [`data-update.md`](data-update.md), `utxo_to_change` |
| Configure a render | Copy [`buv_render_full_weighted.json`](../configs/buv_render_full_weighted.json); adapt paths. [`configure.py`](../scripts/configure.py) is a wizard for its supported subset. |
| Encode a short range | Start FFmpeg listening first, then `buv -ns -tc=visualizer -cfg=…`; [commands and explanation](https://nostitos.github.io/utxo-timelapse/technical.html#running) |
| Build or extend history | `utxo_history` / `utxo_history_update`, [`UtxoHistory.h`](../src/cpp/app/UtxoHistory.h) |
| Inspect locally | `utxo_explorer`, adapted [`buv_explorer.json`](../configs/buv_explorer.json) |
| Retained files / next update | [`render-files.md`](render-files.md) |
| Last measured video append | [`video-update-2026-09-10.md`](video-update-2026-09-10.md) |
| Publish the explorer | [Video Worker README](../cloudflare/utxo-video-worker/README.md) |
| Publish the guide | [`site/README.md`](../site/README.md) |

The September 10 append/publish scripts are **run-specific operational records**. They contain paths, release names and ranges for that installation. In particular, `update_video_append.py` expects local private configuration and the maintainer's node/runtime. They are not portable one-command installers. Read each script, prepare a new manifest, and adapt source/range/credential locations before a future run. Never commit private configuration.

## Repository map

- `src/cpp/app/`: tasks, configuration, UTXO/checkpoint implementation, renderer loop and native explorer.
- `src/cpp/buv/`: axis mapping, density, palette transfer, activity effects, audio and TCP output.
- `configs/`: current and experimental rendering profiles; machine paths must be adapted.
- `cloudflare/`: production video/history Worker, static explorer assets and public-domain proxy.
- `scripts/`: configuration, encoding, incremental updates and cloud/media publishing.
- `site/`: GitHub Pages guide and technical reference, with curated media only.
- `docs/history/`: dated investigations and cleanup evidence, retained as history.
- `src/third_party/`: pinned third-party dependencies (see [`.gitmodules`](../.gitmodules)).

[Historical notes](history/README.md) record earlier states. Current behavior is defined by code, the technical reference, and the latest release report. Old reports may mention retired files or superseded methods.
