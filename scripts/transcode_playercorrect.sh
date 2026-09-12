#!/bin/bash

# Transcode the bit-exact gbrp master into a player-correct yuv444p stream.
#
# The gbrp master stores Green/Blue/Red planes tagged colorspace=gbr. That is
# bit-exact but most players push those planes through a YUV->RGB matrix, which
# renders black as green and white as pink. This converts once to conventional
# BT.709 yuv444p so every player shows the intended colors.
#
# Usage: transcode_playercorrect.sh <crf|lossless> <output-name>
set -uo pipefail

RENDER_DIR="/Volumes/4T Data/buv_render"
SRC="$RENDER_DIR/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_flashvaluefix_crisp_exactrgb.mkv"
MODE="${1:-crf16}"
OUT_NAME="${2:-utxo_4k_playercorrect_$MODE}"
OUT="$RENDER_DIR/$OUT_NAME.mkv"
LOG="$RENDER_DIR/$OUT_NAME.log"
STATUS="$RENDER_DIR/$OUT_NAME.status"

timestamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
record() { echo "$(timestamp) $*" >> "$STATUS"; }

if [[ ! -f "$SRC" ]]; then
    echo "Missing source master: $SRC" >&2
    exit 1
fi
for path in "$OUT" "$LOG" "$STATUS"; do
    if [[ -e "$path" ]]; then
        echo "Refusing to overwrite existing artifact: $path" >&2
        exit 17
    fi
done

COLOR=(-color_range pc -colorspace bt709 -color_primaries bt709 -color_trc bt709)
case "$MODE" in
    lossless)
        ENC=(-c:v libx265 -preset superfast -pix_fmt yuv444p
             -x265-params 'lossless=1:keyint=60:min-keyint=60:scenecut=0:open-gop=0:range=full:colormatrix=bt709')
        ;;
    crf12|crf16|crf18)
        CRF="${MODE#crf}"
        ENC=(-c:v libx265 -preset medium -pix_fmt yuv444p -crf "$CRF"
             -x265-params 'keyint=120:min-keyint=60:range=full:colormatrix=bt709')
        ;;
    *)
        echo "Unknown mode: $MODE (expected lossless, crf12, crf16, crf18)" >&2
        exit 2
        ;;
esac

: > "$STATUS"
record "source: $SRC"
record "mode: $MODE"
record "output: $OUT"

start=$(date +%s)
ffmpeg -nostdin -hide_banner -n -i "$SRC" -map 0:v:0 -an "${ENC[@]}" "${COLOR[@]}" \
    "$OUT" > "$LOG" 2>&1 < /dev/null
rc=$?
end=$(date +%s)

record "ffmpeg exit code: $rc"
record "elapsed seconds: $((end-start))"
echo "transcode_exit_code=$rc" >> "$STATUS"

if [[ $rc -ne 0 ]]; then
    record "FAILED - preserving partial output and log for inspection"
    exit "$rc"
fi

bytes=$(stat -f%z "$OUT")
record "output bytes: $bytes"
record "SUCCESS"
