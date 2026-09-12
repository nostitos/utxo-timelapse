#!/bin/bash
# Lossless MP4 remux of the smooth-transition full render (hvc1 + faststart).
set -u
RENDER_DIR="/Volumes/4T Data/buv_render"
BASE="utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21"
MKV="$RENDER_DIR/$BASE.mkv"
MP4="$RENDER_DIR/$BASE.mp4"
LOG="$RENDER_DIR/remux_4k_weighted_topband_splitpalette_transition_crf21.log"
# Only ever replace an incomplete stub (an aborted earlier attempt); never a real file.
if [[ -e "$MP4" && $(stat -f %z "$MP4") -gt 1048576 ]]; then
  echo "refusing to overwrite existing MP4 ($MP4)" | tee -a "$LOG"; exit 17
fi
ffmpeg -nostdin -hide_banner -stats_period 30 -y -i "$MKV" -map 0:v:0 -c copy -tag:v hvc1 -movflags +faststart "$MP4" > "$LOG" 2>&1
echo "remux rc=$?" >> "$LOG"
