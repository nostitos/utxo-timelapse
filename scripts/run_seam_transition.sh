#!/bin/bash
# Seam validation clip for smooth epoch transitions (blocks 195k-225k, 1080p).
# Lossless FFV1 so frames can be compared pixel-exactly against the cut-mode
# control clip. Usage: run_seam_transition.sh <transition|cut>
set -u

MODE="${1:-transition}"
RENDER_DIR="/Volumes/4T Data/buv_render"
WORKSPACE="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
TAG="seam_${MODE}_195k_225k_1080p"
OUT="$RENDER_DIR/${TAG}.mkv"
CFG="configs/buv_seam_${MODE}.json"

for p in "$OUT" "$RENDER_DIR/ffmpeg_${TAG}.log" "$RENDER_DIR/render_${TAG}.log"; do
  if [[ -e "$p" ]]; then echo "refusing to overwrite $p" >&2; exit 17; fi
done

cd "$RENDER_DIR" || exit 1
ffmpeg -nostdin -hide_banner -stats_period 15 -y -f rawvideo -pixel_format rgb24 -video_size 1920x1080 \
  -framerate 60 -i 'tcp://127.0.0.1:12987?listen' \
  -c:v ffv1 -level 3 -pix_fmt rgb24 \
  "$OUT" > "$RENDER_DIR/ffmpeg_${TAG}.log" 2>&1 < /dev/null &
ffmpeg_pid=$!
sleep 3
if ! kill -0 "$ffmpeg_pid" 2>/dev/null; then echo "ffmpeg died early" >&2; exit 1; fi

cd "$WORKSPACE" || exit 1
./build_local/buv -ns -tc=visualizer -cfg="$CFG" \
  > "$RENDER_DIR/render_${TAG}.log" 2>&1 < /dev/null
render_rc=$?
wait "$ffmpeg_pid"
ffmpeg_rc=$?
echo "render rc=$render_rc ffmpeg rc=$ffmpeg_rc" >> "$RENDER_DIR/render_${TAG}.log"
exit $(( render_rc != 0 ? render_rc : ffmpeg_rc ))
