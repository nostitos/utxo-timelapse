# UTXO Timelapse cloud explorer

The production explorer at **https://bitcointimelapse.com/explorer** runs independently of the rendering Mac and Bitcoin node. The legacy **https://utxo.aiception.ai/** address proxies to this Worker and remains an alias. The Worker serves the UI, APIs and video from private R2. The [illustrated guide](https://bitcointimelapse.com/guide/) is published by GitHub Pages and served through this Worker at the public domain.

First-time visits to `/` show the guide. Entering `/explorer` sets the `btl_explorer` preference cookie for one year; subsequent visits to `/` redirect to `/explorer`. `/guide/` always opens the guide. Existing root `?block=…&x=…&y=…` links redirect straight to the explorer, preserving the query. Guide HTML is never shared from a cookie-dependent cache. Run `node --experimental-default-type=module scripts/check_explorer_navigation.mjs` from the repository root to verify routing and cache isolation.

## Current architecture

- Private bucket `utxo-video`, bound as `VIDEO_BUCKET`.
- Ten-second HEVC fragmented-MP4 HLS segments, each uploaded with a single PUT and cached independently. Packaging copies the master video bytes.
- Historical lifecycle records split into 512-creation-block shards, sorted by exact Y row. Queries read the selected row from relevant shards.
- Base history plus immutable later-spend patches and five full replacement/new shards for the September 10 append.
- One [release descriptor](src/release.js) selects the UI namespace and matching history routing. The current video playlist is `/hls/v3/media.m3u8`; old segment objects are reused.
- The renderer, HUD and [cloud mapper](src/mapping.js) agree on integer pixel coordinates, including 120-block smooth transitions.

The original 84 GB multipart MP4 had slow measured ranged reads. Individually uploaded HLS segments made playback and seeking practical. The legacy `/video.mp4` and `/latest-v2/video.mp4` routes remain compatibility paths.

## UI releases

`static/explorer.html`, `static/hls.min.js` and `static/info.json` are uploaded to the immutable namespace in `RELEASE.sitePrefix`. hls.js is vendored at version 1.7.2 with its [license](static/hls.js.LICENSE).

For a UI-only release:

1. Verify the existing `/health`, `/api/info` and source release descriptor. Retain every video/history routing field.
2. Test the local HTML against the current production video and read-only APIs. Keep the native explorer's HTML in sync.
3. Upload the three static assets to a **fresh** `explorer/vN/site` prefix with `scripts/r2_upload_tree_singlepart.py`. Use a separate upload state file for this prefix.
4. Verify the new objects, then change only `sitePrefix` and `version` in `src/release.js`.
5. Deploy the Worker and verify the returned release version, actual video playback, paused block/HUD alignment and a shared pixel query. Retain the prior descriptor for rollback.

Deployment for the maintainer's configured installation:

```sh
cd cloudflare/utxo-video-worker
CLOUDFLARE_API_TOKEN="$(cat ~/.config/utxo-r2/workers-token)" npx wrangler deploy
curl -fsS https://utxo-cdn.hat39.com/health
```

Credentials remain outside Git. The bucket stays private; Worker routing allowlists objects. A deployment does not upload static objects automatically.

## Video and history updates

The [September 10 report](../../docs/video-update-2026-09-10.md) records the verified append and its measurements. [Retained files](../../docs/render-files.md) describes the source/checkpoint pair and next-update requirements.

The update preserves an encoded prefix, re-encodes a short GOP overlap and the new tail, then creates a continuous-timestamp HLS extension. History updates add new outputs and patch later spends without rebuilding every old shard. Old renderer state is still replayed; there is no renderer checkpoint.

| Script | Role |
|---|---|
| `update_video_append.py` | Run-specific node/data update and replay/render orchestration |
| `finalize_video_append.py` | Verify and finalize the encoded append |
| `continuous_hls_append.py` | Build a continuous HLS tail with compatible codec state |
| `publish_continuous_append.py` | Publish the continuous-tail release |
| `r2_upload_tree_singlepart.py` | Resumable single-PUT asset upload |
| `r2_publish_cloud_history.py` | Initial sharded history publisher |
| `r2_publish_history_delta.py` | Publish new history and old-output spend patches |

All paths above are under the root `scripts/` directory. Several scripts are tied to the first append's paths and manifest. Inspect and adapt them before another run; do not overwrite existing release namespaces. A new initial rendition can be packaged with FFmpeg `-c copy -f hls -hls_segment_type fmp4`, but routine appends reuse old segments.

## APIs and verification

```sh
curl -fsSI https://bitcointimelapse.com/
curl -fsS https://bitcointimelapse.com/health
curl -fsS https://bitcointimelapse.com/api/info
curl -fsS https://bitcointimelapse.com/hls/v5/media.m3u8
curl -fsS 'https://bitcointimelapse.com/api/pixel?block=314000&x=3000&y=1525'
```

At the published cutoff, the example pixel has two outputs unspent at block 314,000, totalling 42,430 sat. One was spent at block 520,664; one remains unspent at the cutoff. Compare counts and sums with the local index when changing data routing.

`/api/ranges` gives inverse coordinate bounds; `/api/date` maps a UTC date into block timestamps; `/api/txid` resolves candidate matches by creation block and amount. Compact lifecycle records do not retain full txid/vout identity, so equal-amount matches can be ambiguous. Query-list truncation is reported explicitly. See the [full API and tradeoffs reference](https://nostitos.github.io/utxo-timelapse/technical.html#api).

The high-detail public explorer targets desktop HEVC-capable browsers. A stopped mobile rendition experiment is not a supported playback path. Check actual public playback and seeking; HTTP 200 alone does not prove the film decodes.
