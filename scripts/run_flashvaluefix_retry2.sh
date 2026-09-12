#!/bin/bash

# Supervise the full 4K flash-value-fix render independently of an interactive
# terminal. The listener starts first; both exit codes and any received signal
# are recorded so an interrupted run has an attributable failure mode.
set -uo pipefail

WORKSPACE="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
RENDER_DIR="/Volumes/4T Data/buv_render"
VIDEO_OUT="$RENDER_DIR/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_flashvaluefix_retry2.mkv"
FFMPEG_LOG="$RENDER_DIR/ffmpeg_4k_weighted_topband_flashvaluefix_retry2.log"
RENDER_LOG="$RENDER_DIR/render_4k_weighted_topband_flashvaluefix_retry2.log"
SUPERVISOR_LOG="$RENDER_DIR/supervisor_4k_weighted_topband_flashvaluefix_retry2.log"
FFMPEG_PID_FILE="$RENDER_DIR/ffmpeg_4k_weighted_topband_flashvaluefix_retry2.pid"
RENDER_PID_FILE="$RENDER_DIR/render_4k_weighted_topband_flashvaluefix_retry2.pid"

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
record "starting ffmpeg listener"

ffmpeg -y -f rawvideo -pixel_format rgb24 -video_size 3840x2160 \
    -framerate 60 -i 'tcp://127.0.0.1:12987?listen' \
    -c:v hevc_videotoolbox -q:v 50 -tag:v hvc1 -pix_fmt yuv420p \
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
