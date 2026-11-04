# Owner highlight published — November 4, 2026

## Result

The 3D landscape's **Owners** view is live. Release `landscape-20261104-1` (Worker version `3f2b1bcc-12e4-4eeb-a62a-b3d8069206dc`) names the owner data `o974481-20261104` for the unchanged dataset `d974481-20261103`: 185 exchanges, 33,386,146 output records, Binance in its logo yellow `#F0B90B` (Flipster took the magenta it left, `#FF2BD6`, and Coinomat a free green, `#78D050`). At block 974,481 Binance's known wallets hold 8,551 outputs and 661,551.02 BTC, OKX's 412,346 outputs and 168,047.12 BTC. It shipped as [#61](https://github.com/nostitos/utxo-timelapse/pull/61) with [#62](https://github.com/nostitos/utxo-timelapse/pull/62) merged into it.

## How it ran

1. **Extraction.** `extract` reran over the 687,047 addresses of `labels-20261103` with the recoloured spec (a colour reaches `build` through the extraction summary). It froze Fulcrum's tip at 974,517, read every history in 27 minutes, fetched 7,497 new transactions and wrote 34,911,432 records; `listunspent` matched every address. 54 minutes in all, peaking at 21 GB.
2. **Build.** `build --tip 974481` wrote `o974481-20261104`: `long.bin` holds 11,183,991 records (81,120,242 bytes), with 194 short chunks; 241 MB.
3. **Check.** `owners-check` against `landscape_974481` matched 64,620,559 events in 629,103 of the 901,210 blocks from 73,272, the tip hash and 179,772 owned cells (109 s).
4. **Upload.** `r2_upload_tree_singlepart.py` wrote the 196 files to `landscape/owners/o974481-20261104/`; the listing matches `owners.json` file for file and byte for byte.
5. **Release.** #62 merged into `codex/landscape-owners`, #61 into master (`26c27c6`), and Wrangler 4.86.0 deployed from a clean worktree at `origin/master`.

## Verification

- Release candidate, served locally (`landscape_974481` and `o974481-20261104`): `owners`, `owners-group`, `owners-flat`, `share`, `hash-export-import`, `hover` and `startup` pass (82 checks). Unit tests: 275 pass, 1 skipped; `check_landscape_worker` 18 of 18; Python 49.
- `scripts/check_live_release.mjs`: all four landscape hostnames serve `landscape-20261104-1`, and the 2D hostnames still serve `append-974310-20261102`. `/owners/index.json` names `o974481-20261104` on all four, and the live `long.bin` has the `bytes` and `sha256` of `files.long` (`0f30d9ad…`).
- Live browser checks: `startup`, `hover` and `owners-group` pass. `owners` and `owners-flat` pass with `startup=high` (turning the view off restores the image exactly; columns at widths 1 and 2.5 cover 143,901 and 200,569 owner pixels; 83 near columns keep 67% of the terrain's blue). An online first visit starts at Balanced with automatic resolution (`ui/online.js`), where only 3 columns stand near the camera and two of `owners`' pixel comparisons do not hold (3.72 mean RGB after turning it off; 140,199 → 142,604 pixels); the local release candidate with `startup=adaptive` gives the same numbers, so both checks now pin `startup=high`.
- In the default look (AgX) Binance's yellow renders as a pale gold; Khronos Neutral shows it saturated. Screenshots of the live view are in `/Volumes/4T Data/buv_owners/live-20261104/`.

## State retained for the next update

- `/Volumes/4T Data/buv_owners/extract` is complete at Fulcrum tip 974,517 (`extract.json`, `records.csv.gz`). The next landscape update reruns `extract`, then `build --tip` its new tip, `owners-check` and the steps in `cloudflare/utxo-landscape-worker/README.md` (Publish owner data), moving `o974481-20261104` to `retainedOwnersIds`.
- Logs: `extract-20261104.log` and `build-974481.log` in the same folder; the node tunnel runs from `tunnel.py`.
