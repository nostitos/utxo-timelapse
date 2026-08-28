#!/bin/bash
# Launch the local 4K render: ffmpeg listener first, then the visualizer.
# Both are detached with nohup + disown so they survive the launching shell.
set -u

RENDER_DIR="/Volumes/4T Data/buv_render"
WORKSPACE="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
OUT="$RENDER_DIR/utxo_4k_epoch105k_60fps_exactledger.mkv"
CFG="buv_data/buv_render_full.json"

cd "$RENDER_DIR" || exit 1

nohup ffmpeg -y -f rawvideo -pixel_format rgb24 -video_size 3840x2160 \
  -framerate 60 -i 'tcp://127.0.0.1:12987?listen' \
  -c:v hevc_videotoolbox -q:v 50 -tag:v hvc1 -pix_fmt yuv420p \
  "$OUT" > "$RENDER_DIR/ffmpeg_exactledger.log" 2>&1 < /dev/null &
echo $! > "$RENDER_DIR/ffmpeg_exactledger.pid"
disown

sleep 4

cd "$WORKSPACE" || exit 1
nohup ./build_local/buv -ns -tc=visualizer -cfg="$CFG" \
  > "$RENDER_DIR/render_exactledger.log" 2>&1 < /dev/null &
echo $! > "$RENDER_DIR/render_exactledger.pid"
disown

echo "ffmpeg pid $(cat "$RENDER_DIR/ffmpeg_exactledger.pid")"
echo "buv pid $(cat "$RENDER_DIR/render_exactledger.pid")"
