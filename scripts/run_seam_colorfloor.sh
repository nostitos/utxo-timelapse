#!/bin/bash
# Seam validation clip for the amount-color-floor feature (blocks 195k-225k, 1080p).
set -u

RENDER_DIR="/Volumes/4T Data/buv_render"
WORKSPACE="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
OUT="$RENDER_DIR/seam_colorfloor_195k_225k_1080p.mkv"
CFG="configs/buv_seam_colorfloor.json"

cd "$RENDER_DIR" || exit 1

nohup ffmpeg -y -f rawvideo -pixel_format rgb24 -video_size 1920x1080 \
  -framerate 60 -i 'tcp://127.0.0.1:12987?listen' \
  -c:v hevc_videotoolbox -q:v 50 -tag:v hvc1 -pix_fmt yuv420p \
  "$OUT" > "$RENDER_DIR/ffmpeg_seam_colorfloor.log" 2>&1 < /dev/null &
echo $! > "$RENDER_DIR/ffmpeg_seam_colorfloor.pid"
disown

sleep 4

cd "$WORKSPACE" || exit 1
nohup ./build_local/buv -ns -tc=visualizer -cfg="$CFG" \
  > "$RENDER_DIR/render_seam_colorfloor.log" 2>&1 < /dev/null &
echo $! > "$RENDER_DIR/render_seam_colorfloor.pid"
disown

echo "ffmpeg pid $(cat "$RENDER_DIR/ffmpeg_seam_colorfloor.pid")"
echo "buv pid $(cat "$RENDER_DIR/render_seam_colorfloor.pid")"
