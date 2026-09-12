#!/bin/bash
# Run on the render Mac. Does not modify the original or publish an incomplete playlist.
set -euo pipefail
cd "$(dirname "$0")/.."
SOURCE='/Volumes/4T Data/buv_render/utxo_4k_epoch105k_60fps_transition_crf21_to_966360.mp4'
OUT='/Volumes/4T Data/buv_render/mobile-966360'
mkdir -p "$OUT"
if [[ ! -f "$OUT/encode-verified" ]]; then
  ffmpeg -hide_banner -nostdin -y -i "$SOURCE" -map 0:v:0 -an \
    -vf scale=2560:1440 -c:v h264_videotoolbox -pix_fmt yuv420p \
    -b:v 8M -maxrate 12M -bufsize 16M -g 120 -tag:v avc1 -fps_mode passthrough \
    -progress "$OUT/progress.txt" \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_flags independent_segments+temp_file -hls_fmp4_init_filename init.mp4 \
    -hls_segment_filename "$OUT/segment_%05d.m4s" "$OUT/media.m3u8"
  python3 - "$OUT" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); s=(p/'media.m3u8').read_text()
assert '#EXT-X-ENDLIST' in s
seconds=sum(float(line.split(':')[1].rstrip(',')) for line in s.splitlines() if line.startswith('#EXTINF:'))
assert abs(seconds-966661/60)<0.05, seconds
for line in s.splitlines():
 if line and not line.startswith('#'): assert (p/line).stat().st_size>0
(p/'encode-verified').write_text(str(seconds))
PY
fi
# Upload media first, playlist last. Fresh immutable release prefix.
PYTHON="$HOME/.local/share/buv-r2/venv/bin/python"
ARGS=(--bucket utxo-video --prefix hls/mobile966360 --endpoint https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com --credentials "$HOME/.config/utxo-r2/credentials" --workers 4)
"$PYTHON" scripts/r2_upload_tree_singlepart.py "$OUT" "${ARGS[@]}" --state "$OUT/upload-media.json" --include .mp4 .m4s
"$PYTHON" scripts/r2_upload_tree_singlepart.py "$OUT" "${ARGS[@]}" --state "$OUT/upload-playlist.json" --include .m3u8
touch "$OUT/upload-complete"
echo 'MOBILE UPLOAD COMPLETE: ready for player activation and browser verification'
