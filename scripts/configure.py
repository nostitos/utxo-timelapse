#!/usr/bin/env python3
"""
Interactive CLI wizard for generating buv.json configs.
Uses only Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple


ResolutionPreset = Tuple[str, int, int, List[int]]

PRESETS: List[ResolutionPreset] = [
    ("8K (7680x4320)", 7680, 4320, [0, 20, 7440, 4144]),
    ("4K (Production)", 3840, 2160, [0, 10, 3720, 2072]),
    ("2.5K (2560x1440)", 2560, 1440, [0, 7, 2480, 1382]),
    ("1080p (Testing)", 1920, 1080, [0, 5, 1860, 1036]),
    ("720p (Quick tests)", 1280, 720, [0, 3, 1240, 690]),
    ("Preview (Ultra-fast)", 640, 360, [0, 2, 620, 345]),
]

COLOR_MAPS = ["turbo", "viridis", "plasma", "inferno", "magma", "cividis"]
X_AXIS_MODES = ["linear", "epochLog", "normalizedGeometric", "continuousLog"]


def explain(text: str) -> None:
    print(f"\n{text}")


def prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if default is not None:
            return default


def prompt_int(label: str, default: int, min_value: int | None = None) -> int:
    while True:
        value = prompt_text(label, str(default))
        try:
            parsed = int(value)
        except ValueError:
            print("Please enter a valid integer.")
            continue
        if min_value is not None and parsed < min_value:
            print(f"Value must be >= {min_value}.")
            continue
        return parsed


def prompt_float(label: str, default: float, min_value: float | None = None) -> float:
    while True:
        value = prompt_text(label, str(default))
        try:
            parsed = float(value)
        except ValueError:
            print("Please enter a valid number.")
            continue
        if min_value is not None and parsed < min_value:
            print(f"Value must be >= {min_value}.")
            continue
        return parsed


def prompt_bool(label: str, default: bool) -> bool:
    suffix = "y" if default else "n"
    while True:
        value = prompt_text(f"{label} (y/n)", suffix).lower()
        if value in ("y", "yes"):
            return True
        if value in ("n", "no"):
            return False
        print("Please enter 'y' or 'n'.")


def prompt_choice(label: str, options: List[str], default_index: int = 0) -> str:
    print(f"\n{label}")
    for i, option in enumerate(options, start=1):
        marker = "*" if i - 1 == default_index else " "
        print(f"  {i}. {option} {marker}")
    while True:
        value = prompt_text("Select option", str(default_index + 1))
        try:
            idx = int(value) - 1
        except ValueError:
            print("Please enter a valid number.")
            continue
        if 0 <= idx < len(options):
            return options[idx]
        print("Selection out of range.")


def prompt_rgb(label: str, default: List[int]) -> List[int]:
    while True:
        value = prompt_text(label, ",".join(str(v) for v in default))
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 3:
            print("Please provide 3 comma-separated values.")
            continue
        try:
            rgb = [int(p) for p in parts]
        except ValueError:
            print("RGB values must be integers.")
            continue
        if any(v < 0 or v > 255 for v in rgb):
            print("RGB values must be between 0 and 255.")
            continue
        return rgb


def prompt_graph_rect(default_rect: List[int]) -> List[int]:
    print("\nGraph Rect (x, y, width, height)")
    x = prompt_int("x", default_rect[0], 0)
    y = prompt_int("y", default_rect[1], 0)
    w = prompt_int("width", default_rect[2], 1)
    h = prompt_int("height", default_rect[3], 1)
    return [x, y, w, h]


def build_config() -> Dict[str, Any]:
    print("Bitcoin UTXO Visualizer - Config Wizard\n")

    explain("Bitcoin RPC URL: where buv reads block/tx data from.")
    bitcoin_rpc_url = prompt_text("Bitcoin RPC URL", "http://127.0.0.1:8332")
    explain("blkFile path: preprocessed UTXO change data file (changes.blk1).")
    blk_file = prompt_text("blkFile path", "/buv_data/changes.blk1")
    explain("UTXO processing threads: CPU threads used for preprocessing (utxo_to_change).")
    utxo_threads = prompt_int("UTXO processing threads", 12, 1)
    explain("UTXO processing resources: work-queue resources for preprocessing.")
    utxo_resources = prompt_int("UTXO processing resources", 24, 1)

    explain("Resolution preset: output video size and graph area (graphRect).")
    preset_labels = [p[0] for p in PRESETS] + ["Custom"]
    preset_choice = prompt_choice("Resolution preset", preset_labels, 1)
    if preset_choice == "Custom":
        explain("Custom resolution: width/height in pixels.")
        image_width = prompt_int("Image width", 3840, 1)
        image_height = prompt_int("Image height", 2160, 1)
        explain("Graph rect: area where the chart is drawn. Leaves space for HUD.")
        default_rect = [0, 10, max(1, image_width - 120), max(1, image_height - 88)]
        graph_rect = prompt_graph_rect(default_rect)
    else:
        preset = PRESETS[preset_labels.index(preset_choice)]
        image_width, image_height, graph_rect = preset[1], preset[2], preset[3]

    explain("Min satoshi: smallest value on Y-axis (lower bound).")
    min_satoshi = prompt_int("Min satoshi", 1, 0)
    explain("Max satoshi: largest value on Y-axis (upper bound).")
    max_satoshi = prompt_int("Max satoshi", 1_000_000_000_000, 1)
    explain("Skip blocks: ignore the first N blocks when processing changes.")
    skip_blocks = prompt_int("Skip blocks", 0, 0)
    explain("Start show at block height: process from 0 but only start rendering at this block.")
    start_show = prompt_int("Start show at block height", 0, 0)
    explain("End show at block height: stop rendering after this block (0 = no limit).")
    end_show = prompt_int("End show at block height (0 = no limit)", 0, 0)
    explain("Repeat last block frames: hold the final frame for N frames (e.g., 60 = 1s at 60fps).")
    repeat_last = prompt_int("Repeat last block frames", 60, 0)

    explain("Connection IP: address the visualizer connects to (ffmpeg listener).")
    connection_ip = prompt_text("Connection IP", "127.0.0.1")
    explain("Connection port: TCP port for raw video stream.")
    connection_port = prompt_int("Connection port", 12987, 1)

    explain("Color map: palette used for density visualization.")
    color_map = prompt_choice("Color map", COLOR_MAPS, 0)
    explain("Color upper value limit: normalization cap for density coloring.")
    color_upper = prompt_int("Color upper value limit", 500, 1)
    explain("Color highlight RGB: color for highlighted pixels/labels.")
    color_highlight = prompt_rgb("Color highlight RGB", [255, 255, 255])
    explain("Color background RGB: background color behind the chart.")
    color_background = prompt_rgb("Color background RGB", [0, 0, 0])

    explain("Checkpoint file: path to save/restore UTXO state checkpoints.")
    checkpoint_file = prompt_text("Checkpoint file", "/buv_data/checkpoint.utxo")
    explain("Checkpoint interval blocks: write checkpoint every N blocks.")
    checkpoint_interval = prompt_int("Checkpoint interval blocks", 10000, 1)
    explain("Allow blkFile truncate: refuse to overwrite an existing non-empty changes file unless you opt in.")
    allow_blk_file_truncate = prompt_bool("Allow overwriting an existing blkFile", False)

    explain("X-axis mode: how block height maps to screen width over time.")
    x_axis_mode = prompt_choice("X-axis mode", X_AXIS_MODES, 3)
    epoch_blocks = 210000
    epoch_ratio = 0.33
    log_compression_factor = 4.85
    resample_every = 100

    if x_axis_mode in ("epochLog", "normalizedGeometric"):
        explain("Epoch size: number of blocks per epoch (e.g., 210000 for halvings).")
        epoch_blocks = prompt_int("Epoch size (blocks)", 210000, 1)
    if x_axis_mode == "normalizedGeometric":
        explain("Current epoch ratio: screen % for newest epoch (0-1).")
        epoch_ratio = prompt_float("Current epoch screen ratio (0-1)", 0.33, 0.0)
    if x_axis_mode == "continuousLog":
        explain("Log compression factor: higher compresses older blocks more.")
        log_compression_factor = prompt_float("Log compression factor", 4.85, 0.1)
        explain("Resample every N blocks: how often to re-bin for continuousLog.")
        resample_every = prompt_int("Resample every N blocks", 100, 1)

    explain("Compress low satoshi: compress 1-100 sat range to 1/3 height.")
    compress_low_satoshi = prompt_bool("Compress 1-100 sat range", True)

    explain("CoinJoin filter: only render changes matching common CoinJoin denominations.")
    coinjoin_filter = prompt_bool("Enable CoinJoin denomination filter", False)

    explain("Audio synthesis: optionally write raw 32-bit float mono audio alongside video frames.")
    audio_enabled = prompt_bool("Generate synthesized audio", False)
    audio_output_file = ""
    audio_sample_rate = 48000.0
    audio_samples_per_block = 800
    if audio_enabled:
        explain("Audio output file: raw mono float32 samples written by the visualizer.")
        audio_output_file = prompt_text("Audio output file", "/buv_output/audio.raw")
        explain("Audio sample rate: playback sample rate used when combining the raw audio with video.")
        audio_sample_rate = prompt_float("Audio sample rate", 48000.0, 1.0)
        explain("Samples per block: controls audio duration per rendered block; 800 equals 60 fps at 48 kHz.")
        audio_samples_per_block = prompt_int("Audio samples per block", 800, 1)

    cfg: Dict[str, Any] = {
        "bitcoinRpcUrl": bitcoin_rpc_url,
        "blkFile": blk_file,
        "utxoToChangeNumThreads": utxo_threads,
        "utxoToChangeNumResources": utxo_resources,
        "imageWidth": image_width,
        "imageHeight": image_height,
        "graphRect": graph_rect,
        "minSatoshi": min_satoshi,
        "maxSatoshi": max_satoshi,
        "skipBlocks": skip_blocks,
        "repeatLastBlockTimes": repeat_last,
        "startShowAtBlockHeight": start_show,
        "endShowAtBlockHeight": end_show,
        "connectionIpAddr": connection_ip,
        "connectionSocket": connection_port,
        "colorMap": color_map,
        "colorUpperValueLimit": color_upper,
        "colorHighlightRGB": color_highlight,
        "colorBackgroundRGB": color_background,
        "checkpointFile": checkpoint_file,
        "checkpointIntervalBlocks": checkpoint_interval,
        "allowBlkFileTruncate": allow_blk_file_truncate,
        "xAxisMode": x_axis_mode,
        "epochBlocks": epoch_blocks,
        "epochRatio": epoch_ratio,
        "logCompressionFactor": log_compression_factor,
        "resampleEveryNBlocks": resample_every,
        "compressLowSatoshi": compress_low_satoshi,
        "coinjoinFilter": coinjoin_filter,
        "audioEnabled": audio_enabled,
        "audioOutputFile": audio_output_file,
        "audioSampleRate": audio_sample_rate,
        "audioSamplesPerBlock": audio_samples_per_block,
    }

    return cfg


def print_docker_commands(cfg: Dict[str, Any]) -> None:
    print("\nDocker command helper\n")
    output_name = prompt_text("Output MP4 filename", "buv_output.mp4")
    ffmpeg_preset = prompt_choice("FFmpeg preset", ["ultrafast", "fast", "medium"], 1)
    ffmpeg_crf = prompt_int("FFmpeg CRF", 18, 1)
    framerate = prompt_int("Framerate (fps)", 60, 1)

    config_path = prompt_text("Config file path (on host)", "/home/umbrel/buv_deploy/buv.json")
    data_dir = prompt_text("Data directory (on host)", "/home/umbrel/buv_data")
    output_dir = prompt_text("Output directory (on host)", "/home/umbrel/buv_output")

    print("\nStart FFmpeg (listener):")
    print(
        "sudo docker run --rm -d --name ffmpeg_encoder \\\n"
        "  --network host \\\n"
        f"  -v {output_dir}:/output \\\n"
        "  jrottenberg/ffmpeg:4.4-ubuntu \\\n"
        "  -y -f rawvideo -pixel_format rgb24 \\\n"
        f"  -video_size {cfg['imageWidth']}x{cfg['imageHeight']} -framerate {framerate} \\\n"
        "  -i tcp://127.0.0.1:12987?listen \\\n"
        f"  -c:v libx264 -preset {ffmpeg_preset} -crf {ffmpeg_crf} -pix_fmt yuv420p \\\n"
        f"  /output/{output_name}"
    )

    print("\nStart Visualizer:")
    print(
        "sudo docker run -d --name buv_visualizer \\\n"
        "  --network host \\\n"
        f"  -v {data_dir}:/buv_data \\\n"
        f"  -v {config_path}:/config/buv.json \\\n"
        "  buv /app/build/buv -ns -tc=visualizer -cfg=/config/buv.json"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Interactive buv.json config wizard.")
    parser.add_argument(
        "-o",
        "--output",
        default="buv_cli.json",
        help="Path to write the generated config (default: buv_cli.json)",
    )
    parser.add_argument(
        "--print-docker",
        action="store_true",
        help="Prompt for output filename and print Docker commands.",
    )

    args = parser.parse_args()

    cfg = build_config()
    output_path = os.path.abspath(args.output)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=4)
        f.write("\n")

    print(f"\nConfig written to: {output_path}")

    if args.print_docker:
        print_docker_commands(cfg)

    return 0


if __name__ == "__main__":
    sys.exit(main())
