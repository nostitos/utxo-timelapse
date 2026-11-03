# Landscape owner data

The 3D landscape's **Owners** view lights the outputs that pay an exchange's known
addresses at the current block and dims everything else, or hides it with Hide the rest; only
the lit exchanges' spends flash. It follows each output from the
block that created it to the block that spent it, so the highlight stays exact while you
step or play through history. The data is built offline by `scripts/landscape_owners.py`
from exact listed addresses. Nothing is clustered or inferred: an address the evidence does
not name is never followed, and change outputs go dark the moment they leave a listed address.

## Sources and evidence tiers

The entity spec, [`scripts/landscape_owners_entities.json`](../scripts/landscape_owners_entities.json),
names each entity's id, display name, colour, the entity name in the label catalog and the
evidence types it accepts. It contains no addresses. Addresses come from the label catalog
that `scripts/address_coverage_labels.py` builds (see [address-coverage-labels.md](address-coverage-labels.md));
the extraction reads its `labels_extended_resolved.csv`, in which conflicting addresses are already excluded.

| `evidence_type` | Sources | Meaning |
| --- | --- | --- |
| `service_disclosure` | Binance's monthly proof-of-reserves lists, plus the archived September 2026 list in the primary exchange supplement; six of OKX's monthly lists (March to August 2026) in that supplement | Exact address published by the operator |
| `service_disclosure_via_graphsense` | Binance's November 2022 transparency post and OKX's November 2022 announcement, as transcribed in the pinned GraphSense pack | Exact address published by the operator, via a transcription |
| `third_party_exact_tag_via_graphsense` | WalletExplorer, Chain.info and BitInfoCharts tags in the pinned GraphSense snapshot (Binance only) | Exact address reported by a third party; the provider may have inferred it |

`por-binance` downloads `https://public.bnbstatic.com/static/proof-of-reserve/wallet_address_YYYYMM01.zip`
for every month. A 403 or 404 means that month was not published: November 2022 to January 2023
were not, and a month's list appears around its 5th to 7th day. Every archive is kept with its
SHA-256 and fetch time. Every CSV inside is read; it must have `coin`, `network` and `address`
columns (matched without case), and any header containing `custodian` marks custody. Rows with
coin and network both `BTC` and an empty custodian are kept. Rows naming a third-party custodian,
such as Ceffu, are excluded because custody does not establish Binance ownership. Any other layout
fails the step. Archives up to January 2025 hold one reserve wallet list; later ones split it into
hot/cold and deposit lists, and the deposit lists have contained no BTC rows so far.

The catalog built on 2 November 2026 selects 92 Binance addresses: 84 from the reserve lists
(45 months, February 2023 to October 2026), 4 from the transparency post and 9 with third-party
tags, of which 7 have no other evidence. The 1,667 BTC rows in those lists included 91 custodian
rows. The rule applies per row, so one address, `bc1qhnkhmyx43k9uewvftqup259yp8h39wj2ewc50h`, is
included: the August 2026 list names no custodian for it, and September and October name Ceffu.
Five addresses only ever listed as Ceffu custody are excluded.

A listed address counts as the entity's across its whole history, before and after the list that
names it. A snapshot is not proof of control outside it, and customer deposit addresses and wallets
known only by inference are absent, so the highlight shows a lower bound of what the exchange holds.
The app's provenance note says the same.

The same catalog selects 8,404 OKX addresses, from six of OKX's monthly proof-of-reserves lists
(March to August 2026, archived with their SHA-256 in the primary exchange supplement) and its
November 2022 announcement. OKX names its lists `https://static.okx.com/cdn/okx/por/chain/por_csv_<YYYYMMDDHH>_V<n>.zip`,
with an hour and a version that cannot be guessed, so they are found on its download page
(https://www.okx.com/en-gb/proof-of-reserves/download). Its lists before March 2026 are not fetched
yet, so OKX wallets emptied before then are missing.

Binance's main hot wallet, `bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h`, went quiet around block
973,750 (late October 2026). It had about 1,400 history items every 250 blocks before then and 14
in the 585 blocks after. Its successor is in no published list yet, so the newest hot-wallet
activity stays dark until a monthly list names it.

## Requirements

- **Fulcrum** 2.x over plaintext TCP, with ranged history,
  `blockchain.scripthash.get_history(scripthash, from_height, to_height)` (items with
  from ≤ height < to), and `blockchain.scripthash.get_first_use`. Binance's hot wallets hold
  ~2.37 million (`bc1qm34l…`) and ~1.19 million (`1NDy…`) history items, so Fulcrum's history cap
  must be at least 5,000,000. On Umbrel set it in the Fulcrum app's settings as the custom environment
  variable `MAX_HISTORY=5000000`; the `max-history` lines in `fulcrum.conf` are ignored because
  Umbrel starts Fulcrum from environment settings. Fulcrum's client buffer is 10 MB, so history is
  read in height pages of at most 30,000 items and 16,128 blocks. A page that fails or times out is
  halved, and pages grow again where history is sparse. Never ask for a whole hot-wallet history at
  once, and do not subscribe to hot-wallet scripthashes.
- **Bitcoin Core REST** with `txindex`, through a dedicated tunnel at `http://127.0.0.1:18352`.
  Transactions are fetched as `/rest/tx/<txid>.bin` over 12 keep-alive connections (`--concurrency`),
  about 440 per second, so a first extraction of Binance's 3.57 million transactions takes a little
  over two hours. The node's disk is the limit: at 48 connections its load average rose from 2.5 to
  11.6 with 76% iowait for only about 20% more throughput, so keep the default. 503 replies and
  dropped connections are retried for up to 15 minutes, which leaves time to restart the tunnel:
  ```sh
  python3 '/Volumes/4T Data/buv_owners/daemon.py' '/Volumes/4T Data/buv_owners/tunnel.log' \
    '/Volumes/4T Data/buv_owners/tunnel.pid' '/Volumes/4T Data/buv_owners' -- \
    python3 '/Volumes/4T Data/buv_owners/tunnel.py' -C
  ```
- Python 3.10+ with PyYAML, which the label script needs: `'/Volumes/4T Data/buv_coverage/.venv/bin/python'`.

## Commands

Run from the repository root; `PY` is the coverage Python, `DATE` the build date.

```sh
PY='/Volumes/4T Data/buv_coverage/.venv/bin/python'
OWNERS='/Volumes/4T Data/buv_owners'

# 1. Binance's monthly reserve lists -> a label supplement (about 1.4 GB of archives).
"$PY" scripts/landscape_owners.py por-binance --out "$OWNERS/labels-$DATE/research/binance_por"

# 2. The label catalog, with the reported tier and both supplements.
"$PY" scripts/address_coverage_labels.py --output "$OWNERS/labels-$DATE" \
  --tagpacks-dir '/Volumes/4T Data/buv_coverage/916828-966827/labels/sources/graphsense-tagpacks' \
  --include-reported \
  --supplement '/Volumes/4T Data/buv_coverage/916828-966827/labels/research/primary_exchange_supplement.json' \
  --supplement "$OWNERS/labels-$DATE/research/binance_por/binance_por_supplement.json"

# 3. Every output paying the selected addresses, verified at Fulcrum's tip (about two hours the first time).
"$PY" scripts/landscape_owners.py extract --spec scripts/landscape_owners_entities.json \
  --labels "$OWNERS/labels-$DATE/labels_extended_resolved.csv" \
  --fulcrum 192.168.8.234:50002 --rest http://127.0.0.1:18352 --work "$OWNERS/extract"

# 4. The owner dataset at the landscape release's tip, then its check against that dataset.
"$PY" scripts/landscape_owners.py build --work "$OWNERS/extract" --tip <tip> \
  --rest http://127.0.0.1:18352 --out-root "$OWNERS"
node landscape/tools/owners-check.mjs --data "/Volumes/4T Data/buv_render/landscape_<tip>" \
  --owners "$OWNERS/o<tip>-$DATE"
```

Run the extraction detached so it outlives the shell, for example with
`python3 "$OWNERS/daemon.py" "$OWNERS/extract.log" "$OWNERS/extract.pid" "$PWD" -- "$PY" scripts/landscape_owners.py extract …`.

`extract` freezes Fulcrum's tip, pages every address's confirmed history from its first use, and
fetches each history transaction once. Its append-only cache keeps, per transaction, its height,
the outputs paying listed scripts (vout, sats, script index) and the inputs that spend any history
transaction. It then brings everything up to Fulcrum's latest tip and builds one record per output:
txid, vout, address, entity, created, spent (empty when unspent) and sats, in `records.csv.gz`.

`build --tip T` keeps records created at or below T with more than 0 sats, drops records spent in
the block that created them, and counts outputs spent after T as unspent. It reads T's hash from
`/rest/blockhashbyheight/T.hex` and writes `o<T>-<YYYYMMDD>` (or `--id`): `owners.json`, `long.bin`
for outputs unspent at T or alive longer than 4,032 blocks, and `short/NNNN.bin` for the rest, grouped
by `floor(created / 4032)`. Empty chunks are omitted. The record format is in
[landscape/SPEC.md](../landscape/SPEC.md) §4 (owner files). An existing non-empty output directory is
never overwritten; files are written into a staging directory that is renamed when complete.

## Verification

- Every transaction's txid is recomputed from the bytes REST returned.
- Each address's history must equal the set of transactions that pay it or spend its outputs.
  A transaction seen at two heights, an outpoint spent twice or a transaction never fetched
  stops the run with `extract-problems.json`.
- At the final Fulcrum tip, each address's unspent records must equal its confirmed
  `listunspent` exactly: same outpoints, same amounts. The only exception is an outpoint spent by
  one of that address's own mempool transactions. If a block arrives during the check, the run
  updates and checks again. Any mismatch writes `verify-failures.json` and exits with status 1.
- `extract.json` records, per address, its evidence, history size, first use, records, unspent
  outputs and sats, and whether it verified, plus the totals, both tips and the label file's SHA-256.
- `owners-check.mjs` matches every owner creation and spend against that block's landscape
  changes, the tip hash against the dataset, and every owned cell against the cell's own totals.

Tests: `"$PY" -m unittest scripts/tests/test_landscape_owners.py scripts/tests/test_address_coverage_labels.py`.

## Updating with each site update

1. Fetch the newly published months into a new folder, for example
   `por-binance --from 2026-11 --to 2026-12 --out "$OWNERS/labels-$DATE/research/binance_por_2026-11"`,
   and add its manifest as one more `--supplement` to the catalog build. Keep the earlier
   supplements, because each manifest only covers the months it fetched.
2. Rebuild the catalog into `labels-$DATE`.
3. Rerun `extract` with the same `--work`. It fetches only history pages newer than each
   address's cached height, from six blocks before it to allow for reorganisations, and only new
   transactions. A newly listed address gets its whole history, and every transaction in it is
   fetched again so outputs paying it are recorded.
4. `build --tip` the new landscape tip, run `owners-check`, then publish.

## Adding an exchange

1. Get its exact addresses into the label catalog: a reviewed GraphSense pack in the allowlist, or
   a supplement with archived sources (see [address-coverage-labels.md](address-coverage-labels.md)).
2. Append an entity to the spec: `id` (`[a-z0-9-]{1,32}`, used in links as `#own=<id>`),
   `name`, `color` (`#RRGGBB`), `catalogEntity` and `evidenceTypes`. Up to 254 entities fit
   the record format; the spec's order is the entity index. Pick a colour far from the others and
   from every look's spend-flash colour (warm white and gold, red in Paper): Binance is magenta
   `#FF2BD6` and OKX cyan `#22D3EE`. `build` copies the colours from the extraction summary, so
   a colour change needs `extract` (which then fetches nothing new) before `build`.
3. Rerun `extract` with the same work directory, then `build`. No code changes. An address whose
   history exceeds Fulcrum's history cap fails loudly; raise the cap rather than skipping it.

## Publishing and rollback

Follow "Publish owner data" in [cloudflare/utxo-landscape-worker/README.md](../cloudflare/utxo-landscape-worker/README.md).

## Files

| Path | Contents |
| --- | --- |
| `<work>/scripts.json` | Address and scriptPubKey list; append-only so cached script indexes stay valid |
| `<work>/history/<scripthash>.tsv`, `.json` | Confirmed history (height, txid), and the height it is complete through |
| `<work>/txs.jsonl` | Transaction cache: `t` txid, `h` height, `g` script count when parsed, `o` listed outputs, `i` history inputs |
| `<work>/records.csv.gz`, `extract.json` | One row per output, and the extraction summary |
| `labels-<date>/research/binance_por/` | Monthly archives, `binance_por_labels.csv` and `binance_por_supplement.json` |
| `o<tip>-<date>/` | `owners.json`, `long.bin` and `short/NNNN.bin` (25 MB for `o974310-20261102`) |

Generated data lives under `/Volumes/4T Data/buv_owners/` and is never committed.
