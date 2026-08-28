# CLAUDE.md

Guidance for agents working in this workspace.

**Terminology is defined in [GLOSSARY.md](GLOSSARY.md).** Use its canonical terms
(code identifiers) in code, commits, configs, and docs. This file covers how to
build, run, and operate; the glossary covers what things are called and why.

## Project overview

BitcoinUtxoVisualizer (`buv`) renders Bitcoin's UTXO history as video: satoshi
value on the Y-axis, block height on the X-axis, colored by density and coin age.

The workspace root is the Git repository. Paths below are relative to it unless
stated otherwise.

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel

# Unit tests — prints "SUCCESS!" on pass
./build/buv
```

Requires CMake ≥ 3.13, a C++17 compiler, and OpenCV. Dependencies are Git
submodules, so clone with `--recurse-submodules`.

### Docker

Built from the **repository root**, using the root `Dockerfile` and `configs/`:

```bash
docker build -t buv .
```

The image `ENTRYPOINT` is `buv`, so pass arguments directly:

```bash
docker run --rm --network host \
  -v "$PWD/buv_data:/buv_data" \
  -v "$PWD/configs/buv_update.json:/config/buv.json:ro" \
  buv -ns -tc=utxo_to_change -cfg=/config/buv.json
```

> `buv_deploy/` is a **legacy** source-copy layout and is git-ignored
> (`.gitignore:57`). Do not build from it.

## Running

Both production tasks need `-ns` (they are `doctest::skip()` by default):

```bash
# 1. Build the change file (needs synced Bitcoin Core, rest=1, txindex=1)
./build/buv -ns -tc=utxo_to_change -cfg=configs/buv_update.json

# 2. Render (FFmpeg must already be listening)
./build/buv -ns -tc=visualizer -cfg=configs/buv_4k.json
```

### Render workflow

Start the encoder **first** — it listens; the visualizer connects.

```bash
ffmpeg -y -f rawvideo -pixel_format rgb24 -video_size 3840x2160 -framerate 60 \
  -i 'tcp://127.0.0.1:12987?listen' \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p out.mkv
```

On Apple Silicon, prefer hardware HEVC (`-c:v hevc_videotoolbox -q:v 50`).
H.264 VideoToolbox cannot open an 8K session.

Record to **MKV**, then remux losslessly:

```bash
ffmpeg -i out.mkv -c copy -tag:v hvc1 -movflags +faststart out.mp4
```

`-video_size` must match `imageWidth`/`imageHeight` in the config.

## Architecture

```
Bitcoin Core REST ──> changes.blk1 ──> RGB frames over TCP ──> FFmpeg ──> video
                utxo_to_change    visualizer
```

| File | Purpose |
|---|---|
| `app/utxo_to_change.cpp` | Fetches blocks, extracts UTXO changes, writes the change file |
| `app/Visualizer.cpp` | Frame loop: read changes, update density, emit frames |
| `app/Utxo.h/.cpp` | UTXO set, checkpoint serialization |
| `app/BlockEncoder.h` | `changes.blk1` record format (authoritative) |
| `app/Cfg.h/.cpp` | Config schema and JSON parsing |
| `app/Hud.cpp/.h` | HUD overlay |
| `buv/Density.h` | Density buffer, resampling, flash, flow lines |
| `buv/SatoshiBlockheightToPixel.h` | Axis mapping and `xAxisMode` dispatch |
| `buv/DensityToImage.h` | Density → color |
| `buv/PixelSetWithHistory.h` | Flash/fade tracking |
| `buv/AudioSynthesizer.h` | Optional audio synthesis |
| `buv/SocketStream.cpp` | Raw frame TCP output |

See GLOSSARY.md §3 for what these concepts mean.

## Configuration

Profiles live in `configs/`. Full key reference in GLOSSARY.md §4. Most
load-bearing keys:

- `xAxisMode` — `linear`, `epochLog`, `normalizedGeometric`, `continuousLog`
- `epochBlocks` / `epochRatio` — epoch size and current-epoch share
- `logCompressionFactor` / `resampleEveryNBlocks` — `continuousLog` tuning
- `compressLowSatoshi` — compress the 1–100 sat band
- `startShowAtBlockHeight` / `endShowAtBlockHeight` — rendered range
- `coinjoinFilter`, `audioEnabled` — optional features
- `allowBlkFileTruncate` — **data safety**, default `false`

Generate a config interactively with `python3 scripts/configure.py`.

## Data operations

See `docs/data-update.md` for the full procedure, and GLOSSARY.md §5–6 for
operational vocabulary and pitfalls.

Essentials:

- Run `utxo_to_change` **node-local**, not through an SSH tunnel. Loopback
  fetches are ~140× faster than a forwarded port.
- Prefer a **full rebuild** for production data. Checkpoint resume is faster but
  loses UTXO creation heights, which corrupts age coloring.
- Back up `changes.blk1` and `checkpoint.utxo` **together**; they must agree on
  block height or a resume will gap or duplicate blocks.
- Judge progress by **transaction count**, not block count.

## Tech stack

C++17 · CMake ≥ 3.13 · OpenCV · fmt · cpp-httplib · simdjson · doctest ·
robin-hood-hashing · indicators

## Project rules

- Never modify `changes.blk1` or `checkpoint.utxo` unless explicitly asked;
  verify structure (marker, tail block, clean EOF) before and after.
- Keep `allowBlkFileTruncate` at `false` unless deliberately overwriting.
- The HUD stays on the left side of the frame.
- Test with a small block range before a full run.
- The first ~50,000 blocks have minimal activity; start at 100,000+ to see
  anything meaningful.
- Verify render completion by process exit + `Lsize=` + `ffprobe` duration —
  file size alone proves nothing.
