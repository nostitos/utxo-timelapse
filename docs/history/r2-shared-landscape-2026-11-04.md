# R2: shared 3D landscape files — November 4, 2026

Every 3D update had stored a complete copy of the landscape dataset, about 77 GB, although it changed
only 0.1–0.4 GB. Five retained datasets held **383.86 GB** of snapshots and chunks whose distinct content
is **77.42 GB**. [PR #66](https://github.com/nostitos/utxo-timelapse/pull/66), merged as `30f796c`, stores
each snapshot and chunk once at `landscape/blobs/<sha256>`, under the SHA-256 in the dataset's
`manifest.json` and `chunks.json`. The `utxo-video` bucket went from **633.6 GB** to **327.15 GB**, and a
dataset update now stores only its new files.

## Steps

1. **Copy (02:30–02:36 UTC, November 5).** For each retained dataset, the dataset's own `manifest.json`
   and `chunks.json` were downloaded from R2, and `landscape_r2_publish.py --copy-from landscape/<id>` copied
   missing content inside R2. `d974481-20261103` copied 5,560 files (77.07 GB) in 267 s. The four older
   datasets copied 2 files each, their own last chunks (about 88 MB each). Total: 5,568 objects, 77,418,792,929 bytes.
2. **Check before the deploy.** All 27,725 table entries of the five datasets had a shared copy with the
   legacy object's size and single-part MD5 ETag.
3. **Deploy.** `landscape-20261104-shared-1`, Cloudflare version `05a44d4f-0de4-4e00-86a7-487eb2cd8030`, from
   `origin/master` `30f796c`. No static asset changed. `scripts/check_live_release.mjs` confirmed all eight
   hostnames of both Workers.
4. **Delete.** The audited list of 27,725 legacy keys (`landscape/<id>/snapshots/` and `chunks/` of the five
   datasets, 383,863,697,679 bytes) was deleted in 28 batches of up to 1,000 keys. The run first checked
   every key and its shared copy against a fresh listing. Before each batch, it checked that
   bitcoinlandscape.com served the new version. Every deletion was confirmed, with no errors. No wildcard
   or prefix deletion was used.

## Verification

- After the deploy, 75 public samples passed: 7 files from each dataset on two hostnames, including each
  dataset's own last two chunks, compared with the manifest's SHA-256, plus a range request per dataset.
  After the deletion, 45 new random samples on a third hostname passed.
- After the deletion, the five prefixes hold only `manifest.json`, `chunks.json`, `rows.bin` and
  `blocktimes.bin` (about 5 MB each). `landscape/blobs/` holds 5,568 objects (77.42 GB).
- Real Chrome against https://bitcoinlandscape.com/: startup, inspector, hover, playback,
  keys-inputs-scrub and column-counts all passed. On the first run, column-counts hit the known WebGPU
  readback error inside three.js, and one hover check failed. Both passed on an immediate re-run.
  Startup and playback passed again after the deletion.
- The new version served 1,088 requests in its first minutes with no errors. The 99th-percentile CPU time
  was 16.9 ms and the maximum 22.5 ms, including the one-time read of a dataset's tables in each new
  Worker instance.
- Locally: 19 Worker checks, the publisher and verifier tests, 275 landscape tests (one skipped) and the
  CSP hash.

The 2D video, history and the original MP4 were not touched.

Evidence: `~/.config/utxo-r2/landscape-shared-20261104/`, including `run.log`, `delete-keys.json`,
`deleted-keys.jsonl`, the downloaded tables, the one-off check and delete scripts, and browser logs and screenshots.
