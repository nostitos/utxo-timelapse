# Bitcoin UTXO Visualizer

`buv` turns Bitcoin's UTXO history into a video. It preprocesses a fully indexed
Bitcoin Core chain into a compact `changes.blk1` stream, renders RGB frames, and
sends those frames over TCP to FFmpeg or FFplay.

This repository is based on
[Martinus' BitcoinUtxoVisualizer](https://github.com/martinus/BitcoinUtxoVisualizer)
and contains the newer code previously deployed on an Umbrel node.

![Bitcoin UTXO visualization](doc/animation_small.gif)

## Added capabilities

- Render an explicit block range.
- Resume UTXO preprocessing from an experimental checkpoint.
- Four X-axis layouts: `linear`, `epochLog`, `normalizedGeometric`, and
  `continuousLog`.
- Geometric epoch compression, including 210,000-block halving epochs.
- Optional low-satoshi Y-axis compression.
- Periodic density resampling for continuously changing layouts.
- Optional common-denomination CoinJoin filter.
- Optional synthesized raw audio based on spending activity.
- 720p, 1080p, 2.5K, 4K, and 8K configuration presets.
- Interactive configuration wizard with an explanation for each option.

## Architecture

```text
Bitcoin Core REST API
        |
        |  buv -tc=utxo_to_change
        v
  changes.blk1  (+ optional checkpoint.utxo)
        |
        |  buv -tc=visualizer
        v
 raw RGB24 frames over TCP -----> FFmpeg/FFplay -----> MKV or MP4
```

The BLK data, checkpoints, videos, and raw audio are generated artifacts. They
are intentionally excluded from Git.

## Clone and build

The dependencies are Git submodules, so clone recursively:

```bash
git clone --recurse-submodules https://github.com/nostitos/BitcoinUtxoVisualizer.git
cd BitcoinUtxoVisualizer
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/buv
```

The native build requires:

- CMake 3.13 or newer
- A C++17 compiler
- OpenCV development libraries
- pthreads and TBB

On Ubuntu/Debian:

```bash
sudo apt-get install build-essential cmake libopencv-dev libtbb-dev
```

On macOS with Homebrew:

```bash
brew install cmake opencv tbb
```

## Docker build

After cloning with submodules:

```bash
docker build -t buv .
```

The container entry point is `buv`. Mount your data and configuration when
running it.

## 1. Generate or update blockchain data

Bitcoin Core must be fully synchronized with REST and `txindex` enabled. Start
with `configs/buv_update.json`, then run:

```bash
./build/buv -ns -tc=utxo_to_change -cfg=configs/buv_update.json
```

Read [`docs/data-update.md`](docs/data-update.md) before using checkpoint resume.
The current checkpoint format has important visualization-correctness and memory
caveats. For exact production output, a full genesis replay is currently safest.

## 2. Choose a render configuration

Ready-made profiles are under [`configs/`](configs/). To create one
interactively:

```bash
python3 scripts/configure.py --output configs/my-render.json --print-docker
```

The wizard explains every setting before asking for its value.

### X-axis modes

| Mode | Behavior |
|---|---|
| `linear` | Maps the complete block range linearly across the graph. |
| `epochLog` | Gives each newer epoch more width than older epochs. |
| `normalizedGeometric` | Gives the current epoch `epochRatio` of the screen and geometrically compresses all previous epochs leftward. |
| `continuousLog` | Uses a smooth power-law mapping and periodically resamples accumulated pixels. |

For the “new epoch takes half, all previous epochs compress into the other half”
layout, use:

```json
{
  "xAxisMode": "normalizedGeometric",
  "epochBlocks": 210000,
  "epochRatio": 0.5
}
```

## 3. Encode video

Start FFmpeg first; it listens for the visualizer's raw RGB stream. An MKV output
is recommended during long runs because it is more tolerant of interruption.

Example: 4K at 60 fps using software H.264:

```bash
ffmpeg -y \
  -f rawvideo -pixel_format rgb24 -video_size 3840x2160 -framerate 60 \
  -i 'tcp://127.0.0.1:12987?listen' \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  output.mkv
```

Then start the visualizer:

```bash
./build/buv -ns -tc=visualizer -cfg=configs/buv_4k.json
```

Remux a completed MKV to MP4 without re-encoding:

```bash
ffmpeg -i output.mkv -c copy -movflags +faststart output.mp4
```

The visualizer normally emits one frame per rendered block. Changing FFmpeg from
60 to 30 fps therefore doubles playback duration without changing the number of
rendered frames.

### Apple Silicon 8K

Apple's H.264 VideoToolbox encoder commonly rejects 8K. Use HEVC VideoToolbox:

```bash
ffmpeg -y \
  -f rawvideo -pixel_format rgb24 -video_size 7680x4320 -framerate 30 \
  -i 'tcp://127.0.0.1:12987?listen' \
  -c:v hevc_videotoolbox -allow_sw 1 -q:v 65 -tag:v hvc1 \
  -pix_fmt yuv420p output-8k.mkv
```

At 8K, one RGB24 frame is about 99.5 MB. Rendering, full-frame memory copies,
socket throughput, and encoding all become significant bottlenecks.

## Important configuration fields

| Field | Meaning |
|---|---|
| `blkFile` | Preprocessed `changes.blk1` input/output path. |
| `startShowAtBlockHeight` | Process history but begin emitting frames at this height. |
| `endShowAtBlockHeight` | Last rendered block; `0` means the BLK file's end. |
| `repeatLastBlockTimes` | Number of final hold/fade frames. |
| `graphRect` | Graph area as `[x, y, width, height]`. |
| `colorUpperValueLimit` | Density value at which the color map saturates. |
| `checkpointFile` | Optional preprocessing checkpoint path. |
| `coinjoinFilter` | Show only changes matching common CoinJoin denominations. |
| `audioEnabled` | Write synthesized mono float32 audio. |
| `audioSamplesPerBlock` | Audio duration per rendered block; 800 is 60 fps at 48 kHz. |

## Repository layout

```text
configs/       Render and preprocessing profiles
scripts/       Interactive configuration tool
src/cpp/app/   Preprocessor, renderer, HUD, and configuration
src/cpp/buv/   Density, axis mapping, socket, and audio implementation
docs/          Operational documentation
doc/           Original screenshots and animation
```

## Operational warnings

- Generating the BLK file and high-resolution video is resource intensive.
- Keep Bitcoin Core REST/RPC private.
- Do not commit credentials, `changes.blk1`, checkpoints, videos, raw audio, or
  build directories.
- Long MP4 recordings can be unplayable if FFmpeg is killed before writing the
  `moov` atom. Record to MKV and remux after completion.
- Test a short block range before starting a multi-hour render.

## License and attribution

The project remains under the original [MIT license](LICENSE). Original work by
[Martinus](https://github.com/martinus); subsequent deployment and visualization
changes are maintained in this fork.
