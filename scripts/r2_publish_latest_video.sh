#!/bin/bash
# Upload (or resume) one MP4 under an immutable R2 key and promote it as latest.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/render.mp4" >&2
  exit 2
fi

ROOT="/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer"
SOURCE="$(python3 - "$1" <<'PY'
import pathlib, sys
print(pathlib.Path(sys.argv[1]).expanduser().resolve())
PY
)"
if [ ! -f "$SOURCE" ]; then
  echo "video not found: $SOURCE" >&2
  exit 1
fi
case "$SOURCE" in
  *.mp4) ;;
  *) echo "expected an .mp4 file: $SOURCE" >&2; exit 1 ;;
esac

name="$(basename "$SOURCE" .mp4)"
safe_name="$(printf '%s' "$name" | tr -cs 'A-Za-z0-9._-' '_')"
size="$(stat -f %z "$SOURCE")"
mtime="$(stat -f %m "$SOURCE")"
version="${size}-${mtime}"
key="videos/${safe_name}-${version}.mp4"
state="$HOME/.local/share/buv-r2/state/${safe_name}-${version}.json"

echo "Publishing: $SOURCE"
echo "R2 key:    $key"
exec "$HOME/.local/share/buv-r2/venv/bin/python" \
  "$ROOT/scripts/r2_multipart_upload.py" "$SOURCE" \
  --bucket utxo-video \
  --key "$key" \
  --endpoint 'https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com' \
  --credentials "$HOME/.config/utxo-r2/credentials" \
  --state "$state" \
  --part-mib 128 --workers 16 \
  --manifest-key manifests/latest.json
