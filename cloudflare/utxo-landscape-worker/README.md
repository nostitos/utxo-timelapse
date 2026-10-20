# UTXO Timelapse Landscape online

**https://bitcoinlandscape.com/** serves the 3D landscape (`landscape/web`) to any WebGPU browser, also available at https://www.bitcoinlandscape.com/ and https://3d.bitcointimelapse.com/. This Worker, `utxo-landscape`, is separate from the 2D explorer's Worker (`../utxo-video-worker`); it reads the same private R2 bucket and reuses the explorer's history query code. See [`docs/landscape.md`](../../docs/landscape.md) for the app itself.

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

On 2026-10-12, the `bitcoinlandscape.com` zone was added to the same Cloudflare account with routes `bitcoinlandscape.com/*` and `www.bitcoinlandscape.com/*`, both to `utxo-landscape` with failure mode "fail closed". Registration stays at Porkbun; authoritative nameservers are `bjorn.ns.cloudflare.com` and `opal.ns.cloudflare.com`. The existing Porkbun MX and SPF records were imported. These routes are also managed in the dashboard and survive Wrangler deploys; the same deployed app and immutable R2 dataset serve all three public landscape hostnames.

## Deploy

```sh
node landscape/tools/csp-hash.mjs --check
node scripts/check_landscape_worker.mjs
node --test landscape/tests/*.test.mjs
git switch master && git pull --ff-only   # deploy what master holds, after the PR merges
cd cloudflare/utxo-landscape-worker
CLOUDFLARE_API_TOKEN="$(cat ~/.config/utxo-r2/workers-token)" npx wrangler@4.86.0 deploy
cd ../..
node scripts/check_live_release.mjs --wait 120
curl -fsS https://bitcoinlandscape.com/dataset/index.json
```

A deploy uploads the working tree's `landscape/web` and bundles `../utxo-video-worker/src/history.js`, `mapping.js` and that Worker's `release.js`, so the cell API follows the history routing current at deploy time. Deploy only from master after the change has merged: a deploy from a branch that lacks another merged release rolls that release back. Responses carry `X-Worker-Version`; bump `version` in `src/release.js` for every release. `scripts/check_live_release.mjs` fails unless the checkout is the fetched `origin/master` and every hostname of both Workers answers with the version in its `release.js` (`--wait` gives aliases time to catch up). Roll back with `npx wrangler@4.86.0 rollback`.

## Publish a dataset

Datasets are immutable: each one gets a new prefix `landscape/d<tip>-<yyyymmdd>`. The upload scripts need boto3 (`python3 -m venv /tmp/landscape_r2_venv && /tmp/landscape_r2_venv/bin/pip install boto3`). The checksum variables keep every upload a plain single PUT whose ETag is the file's MD5.

1. Build and verify the dataset locally (`landscape_build`, `landscape_verify`; see `docs/landscape.md`).
2. Upload everything except the manifest. `scripts/landscape_r2_publish.py` copies every file whose SHA-256 and size match the previous dataset (the chunks and snapshots before the old tip) inside R2 and uploads only the rest. The previous dataset directory needs only its `manifest.json` and `chunks.json`, which can be downloaded from `/dataset/<old-id>/`:
   ```sh
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
   /tmp/landscape_r2_venv/bin/python scripts/landscape_r2_publish.py "/Volumes/4T Data/buv_render/landscape_<tip>" \
     "/Volumes/4T Data/buv_render/landscape_<old-tip>" --prefix landscape/<id> --old-prefix landscape/<old-id> \
     --state ~/.config/utxo-r2/landscape-<id>-publish.json --no-manifest
   ```
   On October 9, 2026 it copied 4,382 chunks (18.3 GB) in about 3 minutes; the 1,101 snapshots still had to be uploaded (57.8 GB, 36 minutes at 27 MB/s), because their headers recorded the grid size of the dataset. Snapshots now describe their own grid: the first dataset built with that format, `d971587-20261015` on October 15, copied 4,416 chunks (18.5 GB) and uploaded its 1,103 snapshots once more with the new chunks (58.0 GB in 52 minutes at about 19 MB/s); later datasets copy every snapshot before the old tip. On October 18, `d972052-20261018` copied 5,527 files (76.4 GB) inside R2 and uploaded 10 (195 MB) in 8 minutes. For a first publication, upload everything:
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
6. Keep the current edition and its immediate predecessor for rollback. After older editions have
   had a grace period of a few days, remove their ids from `retainedDatasetIds`, deploy and verify
   both supported editions, then delete only their retired prefixes:
   ```sh
   AWS_SHARED_CREDENTIALS_FILE=~/.config/utxo-r2/credentials aws s3 rm s3://utxo-video/landscape/<old-id>/ --recursive \
     --endpoint-url https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com
   ```

   Server-side copies still occupy a full dataset's storage. Do not accumulate every old edition.
   Retention of the 2D stream and history follows object references in the supported playlists and
   per-shard catalogues: a prefix's age does not establish that its contents are obsolete. Preserve
   current local manifests, the publication catalogue, checkpoints and append ledgers for updates.

## Verify

```sh
curl -fsSI https://3d.bitcointimelapse.com/
curl -fsS -H 'Range: bytes=0-127' https://3d.bitcointimelapse.com/dataset/<id>/snapshots/0966827.bin | xxd | head -2
curl -fsS 'https://3d.bitcointimelapse.com/api/landscape/cell?block=314000&col=4287&row=1515'
~/.nvm/versions/node/v22.23.2/bin/node landscape/tests/shell-browser-checks.mjs --url https://3d.bitcointimelapse.com/ --explorer https://3d.bitcointimelapse.com
```

The example cell returns 1 live output of 21,236 sat and 3 spent before block 314,000, the same as the native explorer. Check real playback in a browser; HTTP 200 alone does not prove the replay works.

Storage is about 76 GB per dataset (1,104 snapshots and 4,430 chunks at block 972,052), roughly 1.1 USD a month in R2. Egress is free; browsers read with ranges, and the edge cache absorbs repeated ranges.
