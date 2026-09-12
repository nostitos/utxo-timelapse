#!/bin/bash
# Wait for the resumable R2 upload, promote it only after verification, then
# switch the local explorer UI to the Cloudflare-served video.
set -euo pipefail

ROOT="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
SOURCE="/Volumes/4T Data/buv_render/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21.mp4"
BUCKET="utxo-video"
KEY="videos/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21.mp4"
ENDPOINT="https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com"
CREDS="$HOME/.config/utxo-r2/credentials"
STATE="$HOME/.local/share/buv-r2/state/transition-crf21.json"
PYTHON="$HOME/.local/share/buv-r2/venv/bin/python"
CDN="https://utxo-cdn.hat39.com/latest-v2/video.mp4"
EXPECTED_SIZE=83926791196
SERVICE="$HOME/.local/share/buv-explorer"
UPLOAD_PID_FILE="$HOME/.local/share/buv-r2/upload.pid"

cd "$ROOT"
echo "$(date -u +%FT%TZ) waiting for multipart upload"
if [ ! -s "$UPLOAD_PID_FILE" ]; then
  echo "missing upload PID file: $UPLOAD_PID_FILE" >&2
  exit 1
fi
upload_pid="$(cat "$UPLOAD_PID_FILE")"
case "$upload_pid" in
  ''|*[!0-9]*) echo "invalid upload PID: $upload_pid" >&2; exit 1 ;;
esac
while kill -0 "$upload_pid" 2>/dev/null; do
  tail -1 "$HOME/.local/share/buv-r2/logs/transition-crf21.log" 2>/dev/null || true
  sleep 60
done

echo "$(date -u +%FT%TZ) uploader exited; verifying and promoting manifest"
"$PYTHON" scripts/r2_multipart_upload.py "$SOURCE" \
  --bucket "$BUCKET" \
  --key "$KEY" \
  --endpoint "$ENDPOINT" \
  --credentials "$CREDS" \
  --state "$STATE" \
  --part-mib 128 --workers 6 \
  --manifest-key manifests/latest.json

export AWS_SHARED_CREDENTIALS_FILE="$CREDS"
remote_size="$(aws --profile default --region auto --endpoint-url "$ENDPOINT" \
  s3api head-object --bucket "$BUCKET" --key "$KEY" \
  --query ContentLength --output text)"
test "$remote_size" = "$EXPECTED_SIZE"
echo "$(date -u +%FT%TZ) R2 size verified: $remote_size bytes"

# The Worker caches the tiny latest manifest for at most 60 seconds. Wait for
# its canonical redirect and range endpoint to become ready.
ready=0
for attempt in $(seq 1 24); do
  status="$(curl -sS -L --max-time 30 --max-filesize 2048 \
    -H 'Origin: https://utxo.aiception.ai' \
    -H 'Range: bytes=0-1023' -o /tmp/utxo-cdn-ready.bin \
    -w '%{http_code}' "$CDN" || true)"
  if [ "$status" = "206" ] && [ "$(stat -f %z /tmp/utxo-cdn-ready.bin 2>/dev/null || echo 0)" = "1024" ]; then
    ready=1
    break
  fi
  echo "$(date -u +%FT%TZ) CDN not ready yet (HTTP ${status:-none}); retrying"
  sleep 10
done
test "$ready" = 1

echo "$(date -u +%FT%TZ) verifying CDN byte ranges against local source"
for start in 0 41963395598 83926790172; do
  end=$((start + 1023))
  remote="/tmp/utxo-cdn-${start}.bin"
  local_sample="/tmp/utxo-local-${start}.bin"
  status="$(curl -sS -L --fail --max-time 60 --max-filesize 2048 \
    -H 'Origin: https://utxo.aiception.ai' \
    -H "Range: bytes=${start}-${end}" -o "$remote" \
    -w '%{http_code}' "$CDN")"
  test "$status" = "206"
  test "$(stat -f %z "$remote")" = "1024"
  "$PYTHON" - "$SOURCE" "$start" "$local_sample" <<'PY'
import pathlib, sys
source, offset, output = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3])
with source.open("rb") as handle:
    handle.seek(offset)
    output.write_bytes(handle.read(1024))
PY
  cmp "$local_sample" "$remote"
  echo "  bytes ${start}-${end}: exact match"
done

echo "$(date -u +%FT%TZ) installing rebuilt explorer"
install -m 755 build_local/buv "$SERVICE/buv.new"
mv "$SERVICE/buv.new" "$SERVICE/buv"
install -m 644 src/cpp/app/explorer_ui/explorer.html \
  "$SERVICE/src/cpp/app/explorer_ui/explorer.html.new"
mv "$SERVICE/src/cpp/app/explorer_ui/explorer.html.new" \
  "$SERVICE/src/cpp/app/explorer_ui/explorer.html"
touch /tmp/utxo_explorer.restart_requested

origin_ready=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 10 http://127.0.0.1:12988/ >/tmp/utxo-origin-index.html 2>/dev/null \
    && grep -q 'https://utxo-cdn.hat39.com/latest-v2/video.mp4' /tmp/utxo-origin-index.html; then
    origin_ready=1
    break
  fi
  sleep 2
done
test "$origin_ready" = 1

curl -fsS --max-time 20 https://utxo.aiception.ai/ >/tmp/utxo-public-index.html
grep -q 'https://utxo-cdn.hat39.com/latest-v2/video.mp4' /tmp/utxo-public-index.html
curl -fsSI --max-time 20 https://utxo.aiception.ai/ \
  >/tmp/utxo-public-headers.txt
grep -qi 'content-security-policy:.*https://utxo-cdn.hat39.com' \
  /tmp/utxo-public-headers.txt

echo "$(date -u +%FT%TZ) CUTOVER COMPLETE"
echo "Explorer: https://utxo.aiception.ai/"
echo "Video:    $CDN"
