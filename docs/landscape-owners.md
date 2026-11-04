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
evidence types it accepts. Every exchange accepts all the types the catalog holds for it: its own
disclosures and the addresses others attribute to it (the reported tier), so suspected addresses are
lit too and the app says which kind each count is. Eight historic exchanges that GraphSense files
under services (AllCoin, BitNZ, BitoEX, BtcExchange.ro, Coin-Swap, Cryptorush, HaoBTC, MPEx) were
added by name. The spec contains no addresses. Addresses come
from the label catalog that `scripts/address_coverage_labels.py` builds (see
[address-coverage-labels.md](address-coverage-labels.md)); the extraction reads its
`labels_extended_resolved.csv`, in which conflicting addresses are already excluded.

| `evidence_type` | Tier | Meaning |
| --- | --- | --- |
| `service_disclosure` | operator | Exact address in a file the operator published, archived from the operator or, when it no longer serves the file, from the Wayback Machine |
| `service_disclosure_via_graphsense` | operator | An operator disclosure as transcribed in the pinned GraphSense packs |
| `service_disclosure_via_aggregator` | operator | DefiLlama's list for an exchange whose cited wallet page is the operator's own, when the operator publishes a list |
| `third_party_exact_tag` | reported | An exact tag from another provider: DefiLlama citing another page or none, and the BitcoinTemporalGraph dataset |
| `third_party_exact_tag_via_graphsense` | reported | WalletExplorer, Chain.info and BitInfoCharts tags in the pinned GraphSense snapshot |

The sources are listed in [`scripts/landscape_owners_sources.json`](../scripts/landscape_owners_sources.json),
one entry per source: id, canonical entity, how its files are found (`fetch`) and read (`parse`), URL
or pattern, cadence, evidence type, stated licence, the hosts that count as the operator's own,
status and a note. Exchanges with no usable list stay in it with the reason, as `no_public_list`,
`reported_only`, `blocked_login`, `blocked_antibot` or `deferred` (Bitget: public, but 10 rows per
request). `fetch-sources` ([`landscape_owners_sources.py`](../scripts/landscape_owners_sources.py)) runs
the active ones. Each archives every file it reads under `research/<id>/` with its URL, fetch time,
SHA-256 and licence, keeps Bitcoin mainnet rows only, and writes `<id>_labels.csv`,
`<id>_rejected.csv` and `<id>_supplement.json`, the manifest the label script loads. A file without a
recognisable address table fails its source; `fetch_report.json` records every outcome and the other
sources still run.

- Every published snapshot is read: monthly patterns (Binance, Bybit), every link on OKX's download
  page and its Wayback captures, APIs that list files (Okcoin, KuCoin), every version of a file in Git
  (HTX, Bitfinex, SwissBorg), daily lists (Korbit), every page (Bitstamp) and every Wayback capture
  of pages edited in place (NBX, BingX, CEX.IO, Deribit, Coinbase's cbBTC reserves). A 403 or 404 is
  recorded as not published. Files an operator withdrew come from the Wayback Machine: BitMEX's
  2021 reserves (the exchange closed in 2026), Gemini's Trust Center list and Deribit's page.
- Rows naming a third-party custodian, such as Ceffu, are excluded and listed, as is WOO X's only
  disclosed BTC address, which a custodian holds. BTC on other networks (BEP20, TRC20, Lightning,
  layer 2s) is counted and dropped. Strings that are not Bitcoin mainnet addresses are rejected with
  the reason.
- Each address keeps the rows of the first and last files of a source that list it, and the note says
  how many files did; the manifest lists every file. This keeps OKX's lists, which name 20,000 to
  135,000 BTC addresses each, from multiplying the catalog.
- Labels from paid analytics platforms are never used: DefiLlama entries whose wallet page or list is
  on Arkham or Nansen (Coinsquare, CoinDCX) are excluded, as is GraphSense's Nansen-sourced SwissBorg pack.

A listed address counts as the entity's across its whole history, before and after the list that
names it. A snapshot is not proof of control outside it, and customer deposit addresses and wallets
known only by inference are absent, so the highlight shows a lower bound of what the exchange holds.
The app's provenance note says the same. `coverage-report` writes the per-entity summary of a built
catalog (addresses by evidence type, operator and reported counts, observed dates, snapshot months
and gaps, script types and sources) with its conflicts, rejections, custodian exclusions and the
candidates that have no usable public addresses. `fetch-sources --discover` archives the candidate
seed lists (DefiLlama, CoinGecko, CoinMarketCap, GraphSense exchange actors, Glassnode's documented
exchanges and the current catalog) into `research/candidates.json`.

Binance's main hot wallet, `bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h`, went quiet around block
973,750 (late October 2026). Its successor is in no published list yet, so the newest hot-wallet
activity stays dark until a monthly list names it.

## Requirements

- **Fulcrum** 2.x over plaintext TCP, with ranged history,
  `blockchain.scripthash.get_history(scripthash, from_height, to_height)` (items with
  from ≤ height < to), and `blockchain.scripthash.get_first_use`. Binance's hot wallets hold
  ~2.37 million (`bc1qm34l…`) and ~1.19 million (`1NDy…`) history items, so Fulcrum's history cap
  must be at least 5,000,000. On Umbrel set it in the Fulcrum app's settings as the custom environment
  variable `MAX_HISTORY=5000000`; the `max-history` lines in `fulcrum.conf` are ignored because
  Umbrel starts Fulcrum from environment settings. Fulcrum's client buffer is 10 MB. The first request
  for an address the cache lacks asks for its whole confirmed history: most histories are small, and
  one request replaces a page per 16,128 blocks. Fulcrum refuses or drops it when the reply would not
  fit (a big hot wallet), and that address is then read in height pages of at most 30,000 items and
  16,128 blocks. A page that fails or times out is halved, and pages grow again where history is
  sparse. Cached addresses are only extended by range. Do not subscribe to hot-wallet scripthashes.
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
- Python 3.10+ with PyYAML, which the label script needs: `'/Volumes/4T Data/buv_coverage/.venv/bin/python'`,
  and `pdftotext` (Poppler) for KuCoin's PDF reports.
- **Memory**: `extract` holds every history, the transaction cache and the records at once. A pass over
  the 687,047 addresses selected from `labels-20261103` (29.1 million transactions, 41.5 million history
  items) needs about 24 GB at its peak, while it builds the records, estimated from the measured 366 bytes
  per cached transaction and 64 per history item. Check `memory_pressure` first and quit large apps:
  macOS moves what does not fit to swap on the startup disk.

## Commands

Run from the repository root; `PY` is the coverage Python, `DATE` the build date.

```sh
PY='/Volumes/4T Data/buv_coverage/.venv/bin/python'
OWNERS='/Volumes/4T Data/buv_owners'

# 1. Every active registry source -> one supplement each, reusing archives an earlier run recorded.
#    Reruns fetch only new or changed files; --source <id> runs one source.
"$PY" scripts/landscape_owners.py fetch-sources --out "$OWNERS/labels-$DATE/research" \
  $(for d in "$OWNERS/labels-<previous date>/research"/*/; do printf -- '--reuse %q ' "$d"; done)
"$PY" scripts/landscape_owners.py fetch-sources --discover --out "$OWNERS/labels-$DATE/research" \
  --tagpacks-dir '/Volumes/4T Data/buv_coverage/916828-966827/labels/sources/graphsense-tagpacks' \
  --catalog "$OWNERS/labels-<previous date>"

# 2. The label catalog, with the reported tier, the older primary supplement and every new one,
#    then its coverage report.
"$PY" scripts/address_coverage_labels.py --output "$OWNERS/labels-$DATE" \
  --tagpacks-dir '/Volumes/4T Data/buv_coverage/916828-966827/labels/sources/graphsense-tagpacks' \
  --include-reported \
  --supplement '/Volumes/4T Data/buv_coverage/916828-966827/labels/research/primary_exchange_supplement.json' \
  $(for f in "$OWNERS/labels-$DATE"/research/*/*_supplement.json; do printf -- '--supplement %q ' "$f"; done)
"$PY" scripts/landscape_owners.py coverage-report --labels "$OWNERS/labels-$DATE" \
  --research "$OWNERS/labels-$DATE/research" --out "$OWNERS/labels-$DATE/coverage_report.json"

# 2b. History of the addresses new to the extraction, into its cache, and the work left (Fulcrum
#     only; refuses to start while another owner job runs).
"$PY" scripts/landscape_owners.py preflight --spec scripts/landscape_owners_entities.json \
  --labels "$OWNERS/labels-$DATE/labels_extended_resolved.csv" --fulcrum 192.168.8.234:50002 \
  --work "$OWNERS/extract" --out "$OWNERS/labels-$DATE/preflight.json"

# 3. Every output paying the selected addresses, verified at Fulcrum's tip (about 12 hours for the 687,047
#    addresses of labels-20261103, 21.5 million transactions at 330 to 655 a second).
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

`extract` freezes Fulcrum's tip, reads every address's confirmed history up to it (as above, over
`--fulcrum-connections` connections, default 8, since each request costs about one network round
trip), and fetches each history transaction once. Its append-only cache keeps, per transaction, its
height, the outputs paying listed scripts (vout, sats, script index) and the inputs that spend any
history transaction. It builds one record per output at that tip: txid, vout, address, entity,
created, spent (empty when unspent) and sats, in `records.csv.gz`. A run over hundreds of thousands
of addresses outlasts several blocks, so it does not chase the tip; rerun it to move forward.

`build --tip T` keeps records created at or below T with more than 0 sats, drops records spent in
the block that created them, and counts outputs spent after T as unspent. It reads T's hash from
`/rest/blockhashbyheight/T.hex` and writes `o<T>-<YYYYMMDD>` (or `--id`): `owners.json`, `long.bin`
for outputs unspent at T or alive longer than 4,032 blocks, and `short/NNNN.bin` for the rest, grouped
by `floor(created / 4032)`. Empty chunks are omitted. The record format is in
[landscape/SPEC.md](../landscape/SPEC.md) §4 (owner files). An existing non-empty output directory is
never overwritten; files are written into a staging directory that is renamed when complete.

The app downloads `long.bin` whole as soon as any owner is lit, and the short chunks around the
current block. For `o974310-20261104` that is an 81 MB file of 11.2 million records, and the tab holds about
470 MB more while owners are lit (measured in Chrome), whichever owners they are.

## Verification

- Every transaction's txid is recomputed from the bytes REST returned.
- Each address's history must equal the set of transactions that pay it or spend its outputs.
  A transaction seen at two heights, an outpoint spent twice or a transaction never fetched
  stops the run with `extract-problems.json`.
- Each address's unspent records at the frozen tip must equal its confirmed `listunspent`, read
  afterwards, exactly: same outpoints, same amounts. Outputs confirmed above the tip are ignored,
  and a record missing from `listunspent` must be spent by a transaction in that address's history
  above the tip or in its mempool. Any other difference writes `verify-failures.json` and exits
  with status 1, as does a tip block that was reorganised during the run.
- `extract.json` records, per address, its evidence, history size, first use, records, unspent
  outputs and sats, and whether it verified, plus the totals, both tips and the label file's SHA-256.
- `owners-check.mjs` matches every owner creation and spend against that block's landscape
  changes, the tip hash against the dataset, and every owned cell against the cell's own totals.

Tests: `"$PY" -m unittest scripts/tests/test_landscape_owners.py scripts/tests/test_address_coverage_labels.py`.

## Updating with each site update

1. Run `fetch-sources` into a new `labels-$DATE/research` with `--reuse` pointing at the previous run's
   research folders (it reads every `*.json` manifest there), so archived files are linked instead of
   downloaded and only new months, new captures and changed live lists are fetched. Sources whose
   file names cannot be listed from here need their new files added to the registry: CoinEx and MEXC
   refuse connections from Canada, and Phemex names its script bundle per deployment.
2. Rebuild the catalog into `labels-$DATE` and write its coverage report.
3. Run `preflight`, then `extract` with the same `--work`. It fetches only history pages newer than each
   address's cached height, from six blocks before it to allow for reorganisations, and only new
   transactions. A newly listed address gets its whole history, and every transaction in it is
   fetched again so outputs paying it are recorded.
4. `build --tip` the new landscape tip, run `owners-check`, then publish.

## Adding an exchange

1. Get its exact addresses into the label catalog: a registry entry using an existing `fetch` and
   `parse`, or a new parser in `landscape_owners_sources.py` with a test on a trimmed layout of the real
   file. Add its spelling variants to `ALIASES` in `address_coverage_labels.py`.
2. Append an entity to the spec: `id` (`[a-z0-9-]{1,32}`, used in links as `#own=<id>`), `name`,
   `color` (`#RRGGBB`), `catalogEntity` and `evidenceTypes` (every type the catalog holds for it).
   Up to 254 entities fit the record format; the spec's order is the entity index, so new entities go
   at the end. Pick a colour far from the others, from white (shared cells) and from every look's
   spend-flash colour (warm white, gold, red in Paper), and from the grey the app lights its small
   owners in together (Other exchanges, landscape/SPEC.md §8); the spec test checks the distances. `build`
   copies the colours from the extraction summary, so a colour change needs `extract` (which then
   fetches nothing new) before `build`.
3. Rerun `preflight` and `extract` with the same work directory, then `build`. An address whose history
   exceeds Fulcrum's history cap fails loudly; raise the cap rather than skipping it.

## Publishing and rollback

Follow "Publish owner data" in [cloudflare/utxo-landscape-worker/README.md](../cloudflare/utxo-landscape-worker/README.md).

## Files

| Path | Contents |
| --- | --- |
| `<work>/scripts.json` | Address and scriptPubKey list; append-only so cached script indexes stay valid |
| `<work>/history/<scripthash>.tsv`, `.json` | Confirmed history (height, txid), and the height it is complete through |
| `<work>/txs.jsonl` | Transaction cache: `t` txid, `h` height, `g` script count when parsed, `o` listed outputs, `i` history inputs |
| `<work>/records.csv.gz`, `extract.json` | One row per output, and the extraction summary |
| `labels-<date>/research/<id>/` | One source's archives, `fetch_state.json`, `<id>_labels.csv`, `<id>_rejected.csv` and `<id>_supplement.json` |
| `labels-<date>/research/fetch_report.json`, `candidates.json` | Each source's last outcome; the candidate exchanges and their seed lists |
| `labels-<date>/coverage_report.json`, `.md`, `preflight.json` | Per-entity coverage of the catalog; the node work left for the new addresses |
| `o<tip>-<date>/` | `owners.json`, `long.bin` and `short/NNNN.bin` (230 MB for `o974310-20261104`: 185 exchanges, 33.4 million records) |

Generated data lives under `/Volumes/4T Data/buv_owners/` and is never committed.
