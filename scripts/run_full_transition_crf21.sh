#!/bin/bash

# Supervise the full 4K render (smooth epoch slides + 10 BTC split palette)
# using software HEVC at CRF 21 in YUV 4:4:4.
# Existing artifacts are never overwritten. The MKV remains usable if a later
# MP4 remux is interrupted.
set -uo pipefail

WORKSPACE="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
RENDER_DIR="/Volumes/4T Data/buv_render"
RUN_TAG="4k_weighted_topband_splitpalette_transition_crf21"
VIDEO_OUT="$RENDER_DIR/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21.mkv"
FFMPEG_LOG="$RENDER_DIR/ffmpeg_${RUN_TAG}.log"
RENDER_LOG="$RENDER_DIR/render_${RUN_TAG}.log"
SUPERVISOR_LOG="$RENDER_DIR/supervisor_${RUN_TAG}.log"
FFMPEG_PID_FILE="$RENDER_DIR/ffmpeg_${RUN_TAG}.pid"
RENDER_PID_FILE="$RENDER_DIR/render_${RUN_TAG}.pid"

ffmpeg_pid=""
render_pid=""

timestamp() {
    date '+%Y-%m-%d %H:%M:%S %Z'
}

record() {
    echo "$(timestamp) $*" >> "$SUPERVISOR_LOG"
}

stop_children() {
    if [[ -n "$render_pid" ]] && kill -0 "$render_pid" 2>/dev/null; then
        kill -TERM "$render_pid" 2>/dev/null || true
    fi
    if [[ -n "$ffmpeg_pid" ]] && kill -0 "$ffmpeg_pid" 2>/dev/null; then
        kill -TERM "$ffmpeg_pid" 2>/dev/null || true
    fi
}

on_signal() {
    local signal_name="$1"
    record "supervisor received $signal_name; terminating children"
    stop_children
    wait 2>/dev/null || true
    exit 143
}

trap 'on_signal SIGTERM' TERM
trap 'on_signal SIGINT' INT
trap 'on_signal SIGHUP' HUP

if [[ -e "$VIDEO_OUT" ]]; then
    record "refusing to overwrite existing output: $VIDEO_OUT"
    exit 17
fi

: > "$SUPERVISOR_LOG"
: > "$FFMPEG_LOG"
: > "$RENDER_LOG"
record "starting ffmpeg listener: libx265 superfast, CRF 21, yuv444p, full-range BT.709"

ffmpeg -nostdin -hide_banner -stats_period 30 -y \
    -f rawvideo -pixel_format rgb24 -video_size 3840x2160 -framerate 60 \
    -i 'tcp://127.0.0.1:12987?listen' -an \
    -c:v libx265 -preset superfast -crf 21 -pix_fmt yuv444p \
    -x265-params 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:range=full:colormatrix=bt709' \
    -color_range pc -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
    "$VIDEO_OUT" > "$FFMPEG_LOG" 2>&1 < /dev/null &
ffmpeg_pid=$!
echo "$ffmpeg_pid" > "$FFMPEG_PID_FILE"

sleep 3
if ! kill -0 "$ffmpeg_pid" 2>/dev/null; then
    wait "$ffmpeg_pid"
    ffmpeg_rc=$?
    record "ffmpeg listener exited before visualizer startup, rc=$ffmpeg_rc"
    exit "$ffmpeg_rc"
fi

record "starting visualizer"
cd "$WORKSPACE" || exit 1
/usr/bin/caffeinate -i ./build_local/buv -ns -tc=visualizer \
    -cfg=configs/buv_render_full_weighted.json \
    > "$RENDER_LOG" 2>&1 < /dev/null &
render_pid=$!
echo "$render_pid" > "$RENDER_PID_FILE"

wait "$render_pid"
render_rc=$?
record "visualizer exited rc=$render_rc"

wait "$ffmpeg_pid"
ffmpeg_rc=$?
record "ffmpeg exited rc=$ffmpeg_rc"

if [[ "$render_rc" -ne 0 ]]; then
    exit "$render_rc"
fi
exit "$ffmpeg_rc"
