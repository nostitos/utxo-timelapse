# Cloudflare-hosted UTXO Pixel Explorer

The production explorer is independent of the rendering Mac. A Cloudflare
Worker serves the UI and APIs; private R2 stores the immutable UI assets,
HLS video segments, block timestamps, and row-indexed UTXO history shards.

## Why the video is HLS

The source 4K MP4 is about 84 GB. It is legal to store that as one multipart R2
object, but measured ranged reads from that multipart object were too slow for
reliable playback. The production path remuxes the same HEVC bytes (no
transcoding or quality loss) into ten-second fragmented-MP4 HLS segments. Each
segment is uploaded with one `PutObject`, can be cached independently at the
Cloudflare edge, and makes aggressive timeline seeking cheap.

The legacy `/latest-v2/video.mp4` endpoint remains available for compatibility.
The web app uses `/hls/v1/media.m3u8`.

## Worker deployment

The scoped deploy token is outside the repository at
`~/.config/utxo-r2/workers-token` (mode `0600`).

```bash
cd cloudflare/utxo-video-worker
CLOUDFLARE_API_TOKEN="$(cat ~/.config/utxo-r2/workers-token)" npx wrangler deploy
curl -fsS https://utxo-cdn.hat39.com/health
```

The Worker binds private bucket `utxo-video` as `VIDEO_BUCKET`. Do not make the
bucket public; all object names are allowlisted by the Worker.

## Publish the HLS rendition (no transcode)

```bash
mkdir -p '/Volumes/4T Data/buv_render/utxo_hls_crf21'
ffmpeg -hide_banner -y -i /absolute/path/to/render.mp4 \
  -map 0:v:0 -c copy -f hls -hls_time 10 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_flags independent_segments \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename '/Volumes/4T Data/buv_render/utxo_hls_crf21/segment_%05d.m4s' \
  '/Volumes/4T Data/buv_render/utxo_hls_crf21/media.m3u8'

~/.local/share/buv-r2/venv/bin/python scripts/r2_upload_tree_singlepart.py \
  '/Volumes/4T Data/buv_render/utxo_hls_crf21' \
  --bucket utxo-video --prefix hls/v1 \
  --endpoint 'https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com' \
  --credentials ~/.config/utxo-r2/credentials \
  --state ~/.config/utxo-r2/hls-v1-upload-state.json \
  --workers 6 --include .m3u8 .m4s .mp4
```

`r2_upload_tree_singlepart.py` is resumable. It deliberately avoids boto3's
managed transfer helper, which would make the segments multipart objects.

## Publish the cloud query index

The desktop `utxo_history.bin` is about 58 GB and cannot be mmapped by a Worker.
The publisher creates 512-block R2 shards, grouping records in every shard by
their exact graph Y row. A pixel query downloads only the selected row from the
relevant shards, not the full history.

```bash
~/.local/share/buv-r2/venv/bin/python scripts/r2_publish_cloud_history.py \
  '/Volumes/4T Data/buv_render/utxo_history.bin' \
  --bucket utxo-video --prefix explorer/v1/history \
  --endpoint 'https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com' \
  --credentials ~/.config/utxo-r2/credentials \
  --state ~/.config/utxo-r2/cloud-history-v1-state.json \
  --shard-blocks 512 --rows 2072 --workers 4
```

The final manifest is uploaded only after every shard succeeds. The state file
allows a stopped run to resume without regenerating completed shards.

## Static assets

`static/explorer.html`, `static/hls.min.js`, and `static/info.json` are stored at
`explorer/v1/site/`. Hls.js is vendored at version 1.7.2 with its license.

## Verification

```bash
curl -fsSI https://utxo-cdn.hat39.com/
curl -fsS https://utxo-cdn.hat39.com/api/info
curl -fsS https://utxo-cdn.hat39.com/hls/v1/media.m3u8 | head
curl -fsS 'https://utxo-cdn.hat39.com/api/txid?height=0&satoshi=5000000000'
curl -fsS 'https://utxo-cdn.hat39.com/api/pixel?block=100000&x=1760&y=500'
```

Expected genesis txid: `4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b`.
