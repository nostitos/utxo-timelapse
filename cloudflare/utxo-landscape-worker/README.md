# UTXO Timelapse Landscape online

**https://3d.bitcointimelapse.com/** serves the 3D landscape (`landscape/web`) to any WebGPU browser. This Worker, `utxo-landscape`, is separate from the 2D explorer's Worker (`../utxo-video-worker`); it reads the same private R2 bucket and reuses the explorer's history query code. See [`docs/landscape.md`](../../docs/landscape.md) for the app itself.

## What the Worker serves

| Path | Source |
|---|---|
| `/` and the app files | Workers Static Assets from `landscape/web`; `landscape/web/.assetsignore` leaves out `dev/`. |
| `/dataset/index.json` | Names the current dataset (`src/release.js`). The app reads it on startup. |
| `/dataset/<id>/<file>` | R2 objects `landscape/<id>/<file>`, only for the ids in `src/release.js` and the dataset's file names. Single byte ranges, ETag and 304, immutable caching, CORS `*`, and an edge cache for whole objects and ranges up to 8 MiB. |
| `/api/landscape/cell?block&col&row` | The inspector's history index: the lifecycle of one landscape cell from the 2D explorer's history shards, through the shared `lifecycleJson` in `../utxo-video-worker/src/history.js`. Satoshi ranges come from the dataset's `rows.bin`, the compiled row table, so they equal the native explorer's on every row. Rate limit 8 requests/s, burst 20, per IP and isolate; cached 24 h per release. |
| `/health`, `/robots.txt` | Liveness and crawler rules (`/dataset/` and `/api/` disallowed). |

Every response carries a Content Security Policy that allows the inline import map by hash (`importMapHash` in `src/release.js`), `data:` fonts (lil-gui embeds its icon font that way) and Cloudflare's analytics beacon, plus `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and frame denial. Changing the import map in `index.html` requires a new hash: `node landscape/tools/csp-hash.mjs` prints it and `--check` compares it with `release.js`.

Cloudflare Web Analytics is switched on for the `bitcointimelapse.com` zone, so the edge injects its beacon (`static.cloudflareinsights.com/beacon.min.js`) into every HTML page, this site's and the 2D explorer's alike, and the beacon reports to `cloudflareinsights.com`. Both sites' policies allow exactly those two hosts, so visits to `3d.` appear in the zone's Web Analytics next to the 2D explorer and the guide. The beacon loads with CORS (`crossorigin` plus `Access-Control-Allow-Origin: *`), which cross-origin isolation requires.

Hostnames: `https://utxo-landscape.nostisos.workers.dev` and the route `3d.bitcointimelapse.com/*` on the `bitcointimelapse.com` zone (added 2026-10-08, failure mode "fail closed"). The route is more specific than the 2D explorer's wildcard route on that zone, so it takes `3d.` requests while the apex and every other subdomain still reach `utxo-video-cdn`. The Workers token in `~/.config/utxo-r2/workers-token` cannot read or edit zone routes, so the route lives in the dashboard of the account that owns the zone (Workers & Pages → utxo-landscape → Domains) and `wrangler.toml` declares none: a deploy leaves it in place. Deleting the route there returns `3d.` to the 2D explorer.

## Deploy

```sh
node landscape/tools/csp-hash.mjs --check
node --experimental-default-type=module scripts/check_landscape_worker.mjs
node --test landscape/tests/
cd cloudflare/utxo-landscape-worker
CLOUDFLARE_API_TOKEN="$(cat ~/.config/utxo-r2/workers-token)" npx wrangler@4.86.0 deploy
curl -fsS https://3d.bitcointimelapse.com/health
curl -fsS https://3d.bitcointimelapse.com/dataset/index.json
```

A deploy uploads the working tree's `landscape/web` and bundles `../utxo-video-worker/src/history.js`, `mapping.js` and that Worker's `release.js`, so the cell API follows the history routing current at deploy time. Responses carry `X-Worker-Version`; bump `version` in `src/release.js` for every release. Roll back with `npx wrangler@4.86.0 rollback`.

## Publish a dataset

Datasets are immutable: each one gets a new prefix `landscape/d<tip>-<yyyymmdd>`. The upload scripts need boto3 (`python3 -m venv /tmp/landscape_r2_venv && /tmp/landscape_r2_venv/bin/pip install boto3`). The checksum variables keep every upload a plain single PUT whose ETag is the file's MD5.

1. Build and verify the dataset locally (`landscape_build`, `landscape_verify`; see `docs/landscape.md`).
2. Upload everything except the manifest. When the previous dataset is still on disk, `scripts/landscape_r2_publish.py` copies every file whose SHA-256 is unchanged (the chunks before the old tip) inside R2 and uploads only the rest:
   ```sh
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
   /tmp/landscape_r2_venv/bin/python scripts/landscape_r2_publish.py "/Volumes/4T Data/buv_render/landscape_<tip>" \
     "/Volumes/4T Data/buv_render/landscape_<old-tip>" --prefix landscape/<id> --old-prefix landscape/<old-id> \
     --state ~/.config/utxo-r2/landscape-<id>-publish.json --no-manifest
   ```
   On October 9, 2026 it copied 4,382 chunks (18.3 GB) in about 3 minutes; the 1,101 snapshots still had to be uploaded (57.8 GB, 36 minutes at 27 MB/s), because each snapshot header records the grid size of its dataset. Without a previous local dataset, upload everything:
   ```sh
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
   /tmp/landscape_r2_venv/bin/python scripts/r2_upload_tree_singlepart.py "/Volumes/4T Data/buv_render/landscape_<tip>" \
     --prefix landscape/<id> --endpoint https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com \
     --credentials ~/.config/utxo-r2/credentials --state ~/.config/utxo-r2/landscape-<id>-state.json \
     --workers 8 --include .bin chunks.json
   ```
3. `/tmp/landscape_r2_venv/bin/python scripts/landscape_r2_verify.py "/Volumes/4T Data/buv_render/landscape_<tip>" --prefix landscape/<id> --no-manifest` checks every object's size and MD5 and that nothing else exists under the prefix.
4. Upload `manifest.json` (`landscape_r2_publish.py` without `--no-manifest`, or `r2_upload_tree_singlepart.py` with `--include manifest.json`), then run step 3 without `--no-manifest`.
5. In `src/release.js`, set `dataset` to the new id and tip, move the previous id to `retainedDatasetIds`, bump `version`, then deploy and verify.
6. After open tabs have moved on (a few days), delete the old prefix, remove its id from `retainedDatasetIds` and deploy:
   ```sh
   AWS_SHARED_CREDENTIALS_FILE=~/.config/utxo-r2/credentials aws s3 rm s3://utxo-video/landscape/<old-id>/ --recursive \
     --endpoint-url https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com
   ```

## Verify

```sh
curl -fsSI https://3d.bitcointimelapse.com/
curl -fsS -H 'Range: bytes=0-127' https://3d.bitcointimelapse.com/dataset/<id>/snapshots/0966827.bin | xxd | head -2
curl -fsS 'https://3d.bitcointimelapse.com/api/landscape/cell?block=314000&col=4287&row=1515'
~/.nvm/versions/node/v22.23.2/bin/node landscape/tests/shell-browser-checks.mjs --url https://3d.bitcointimelapse.com/ --explorer https://3d.bitcointimelapse.com
```

The example cell returns 1 live output of 21,236 sat and 3 spent before block 314,000, the same as the native explorer. Check real playback in a browser; HTTP 200 alone does not prove the replay works.

Storage is about 76 GB per dataset (1,101 snapshots and 4,417 chunks at block 970,658), roughly 1.1 USD a month in R2. Egress is free; browsers read with ranges, and the edge cache absorbs repeated ranges.
