# Address coverage label catalog

`scripts/address_coverage_labels.py` prepares exact Bitcoin mainnet address evidence
for the local address-coverage analysis. It never discovers wallet clusters or
promotes counterparties into an organisation's ownership. Generated catalogs and
source archives live outside the repository, alongside the separate analysis
dataset.

## Evidence tiers and interpretation

The conservative catalog accepts only reviewed service/organisation disclosures:
the explicitly allowlisted reserve and donation packs in GraphSense, plus archived
primary exchange disclosures. `is_cluster_definer` in an upstream pack does not
trigger clustering. Only the addresses literally present in that pack are read.

An optional second tier uses already-published exact address tags in the
GraphSense WalletExplorer, Chain.info and BitInfoCharts packs. WalletExplorer may
have inferred ownership through its own clustering; the other providers' methods
are not independently verified. This tier is a sensitivity analysis and must be
described as **reported attribution**, not demonstrated ownership. The tool does
not query those providers for further addresses or expand any cluster.

| `evidence_type` | Meaning | Confidence value |
| --- | --- | --- |
| `service_disclosure` | Exact address in a retained primary operator publication | `publicly_reported` |
| `service_disclosure_via_graphsense` | Exact address transcribed from a primary disclosure into the pinned reviewed GraphSense pack | `publicly_reported` |
| `third_party_exact_tag_via_graphsense` | Exact published third-party address tag; provider inference may be involved | `third_party_reported` |

Confidence values describe provenance, not numerical probabilities. A disclosure
at a particular date or block is not proof of continuous control throughout the
analysis window. GraphSense `lastmod` is a collection date, not necessarily the
original publication date. Old disclosures are retained as historical evidence;
they are not asserted to describe current wallets. Primary reserve signatures are
retained, but this analysis does not cryptographically verify them.

Coverage is conditional on these incomplete public catalogs. The direct tier has
no Coinbase addresses and only a few published addresses for several exchanges.
The broader tier adds historical reported seeds, not exhaustive current exchange
wallets. Unlabelled activity therefore does not establish nonexchange activity.
The large BitMEX address count alone says nothing about transaction coverage.

## Reproduction

Python 3.10+ and PyYAML are required. The analysis environment also provides DuckDB
and PyArrow for downstream joins. For the collected 916,828–966,827 experiment:

```sh
'/Volumes/4T Data/buv_coverage/.venv/bin/python' scripts/address_coverage_labels.py \
  --output '/Volumes/4T Data/buv_coverage/916828-966827/labels' \
  --revision 7f9a5d1f93435379cfaed4675fb734fa42848ca5 \
  --include-reported \
  --supplement '/Volumes/4T Data/buv_coverage/916828-966827/labels/research/primary_exchange_supplement.json'
```

Use `--fetch` to fetch that exact revision and record acquisition time. The
default snapshot revision is pinned in the script. All pack bytes are read with
`git show REVISION:path`; local working-tree edits cannot silently change the
catalog. No mutable remote branch is used as the data reference. A missing
repository is cloned into the output's `sources/` directory. Existing chain data,
checkpoints and renderer files are not touched.

The supplemental manifest contains `labels_csv`, `labels_sha256`, and `sources`.
Each source requires a public `url`, ISO `fetched_at`, `sha256`, `license` and
`local_path`. Paths are relative to the manifest. Every CSV row must cite one of
those archived source URLs, and both original source bytes and normalized CSV
bytes must match their recorded hashes. Supplements are reviewed exact-address
extracts; this importer is not an automatic classifier of arbitrary third-party
datasets.

All label CSVs use these columns:

```text
address,entity,source,observed_date,confidence,evidence_type,historical_note
```

Base58Check, Bech32 and Bech32m checksums and mainnet witness constraints are
validated. All-uppercase Bech32 is normalized to lowercase; mixed case is rejected.
Base58 case is preserved. Only documented entity spelling aliases are merged;
for the optional third-party tier, pinned GraphSense actor IDs supply consistent
entity names. Generic unidentified actors are rejected.

## Outputs

| File | Contents |
| --- | --- |
| `labels.csv` | Conservative direct-disclosure evidence, preserving multiple sources/dates |
| `labels_resolved.csv` | Conservative evidence excluding every address with conflicting entities |
| `labels_conflicts.csv` | All competing conservative evidence rows for unresolved addresses |
| `labels_reported.csv` | Separate optional third-party evidence tier |
| `labels_extended.csv` | Union of both evidence tiers; all evidence and conflicts retained |
| `labels_extended_resolved.csv` | Combined evidence excluding every conflicting address |
| `labels_extended_conflicts.csv` | All competing evidence rows from the combined catalog |
| `labels_rejected.csv` | Invalid addresses or unidentified actor tags, with rejection reasons |
| `sources_manifest.json` | Counts, source selection decisions, snapshot revision, acquisition time, licenses and checksums |

For the main reported-coverage analysis, use the combined catalog while resolving
conflicts before building the known-address set. Repeated evidence rows for the
same address do not create extra addresses, transactions or events. For the
direct-only comparison, filter the resolved combined catalog to the two
`service_disclosure*` evidence types so conflicts cannot be silently reintroduced.

## Collected snapshot and primary sources

The collected catalog contains **344,939 direct-disclosure addresses across 12
entities**, and **535 third-party-tagged addresses**, of which 532 are additional.
The combined catalog has **345,471 addresses across 283 entities**, with no
conflicting entity labels. Three generic or missing-actor tags were rejected;
accepted address checksums all validate.

The direct addresses comprise BitMEX (336,208), OKX (8,404), CheckSig (247), Binance
(51), Deribit (7), Crypto.com (6), Bybit (4), KuCoin (4), Huobi (3), Bitfinex (3),
Internet Archive (1), and Proton Mail (1). These are catalog sizes, not measured
activity. Old and fresh disclosures overlap, so counts must be computed by union.

- [GraphSense public TagPacks](https://github.com/graphsense/graphsense-tagpacks/tree/7f9a5d1f93435379cfaed4675fb734fa42848ca5): pinned source, MIT license retained in `sources/GRAPHSENSE_LICENSE.txt`; attribution to Iknaio Cryptoasset Analytics GmbH and AIT Austrian Institute of Technology is preserved. Underlying publication terms can differ.
- [OKX official reserve downloads](https://www.okx.com/en-gb/proof-of-reserves/download): six explicitly published snapshots dated 2026-03-03, 04-20, 05-07, 06-19, 07-07 and 08-11, covering snapshot heights 939,123–961,893. These add an 8,402-address union before merging older GraphSense disclosures.
- [Binance official September 2026 archive](https://public.bnbstatic.com/static/proof-of-reserve/wallet_address_20260901.zip): 50 exact BTC-mainnet addresses from snapshot height 964,957. Four entries explicitly marked as Ceffu custody were excluded from Binance attribution. The raw archive and their exclusion records are preserved.
- [Bitfinex published wallets](https://github.com/bitfinexcom/pub/blob/main/wallets.txt): primary disclosure behind the reviewed GraphSense Bitfinex pack.

The current primary exchange archives have no explicit redistribution license
identified. They are retained locally for verification. Do not commit raw source
archives or generated catalogs to the repository.

## Validation

```sh
'/Volumes/4T Data/buv_coverage/.venv/bin/python' -m unittest \
  scripts/tests/test_address_coverage_labels.py -v
```

Tests include official BIP350 valid/invalid address vectors, network and checksum
rejection, alias normalization, conflicting entity exclusion, repeated evidence
preservation, required provenance, primary-pack metadata inheritance, external
source/actor rejection, supplementary source hash validation, and explicit
third-party-tier treatment. All seven primary reserve extracts were additionally
compared against their original archived CSVs by coin, network and custodian;
the selected address sets matched exactly.
