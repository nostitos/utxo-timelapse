# Address coverage analysis

This standalone pipeline measures address reuse, publicly labelled activity and
one expansion through transaction counterparties. It does not infer common
ownership, render video, change the existing chain datasets or publish a release.
The first requested window is **916,828–966,827 inclusive (50,000 blocks)**.

## Definitions

An address is reused after receiving outputs in at least two distinct
transactions **within the entire sample**. Multiple outputs in one transaction
count once. Receiving once and spending later is not reuse. The same analysis is
repeated with thresholds 5, 10 and 100. Reuse includes coinbase receipts, but all
transaction/event/value coverage percentages exclude coinbase; coinbase has its
own denominators. Nonaddress scripts remain in applicable event/value totals.

Known addresses have unambiguous published labels. The catalog separates direct
operator disclosures from fixed third-party tags; see
[label sources and provenance](address-coverage-labels.md). A label's evidence
date is not proof of historical control. Conflicting entity labels are excluded.
The pipeline never expands a provider's wallet cluster.

For each threshold, seeds are the union of known and reused addresses. A direct
transaction spends a prevout belonging to a seed or creates an output paying a
seed. Counterparties are nonseed output addresses when a seed is on the input
side, and nonseed input addresses when a seed is on the output side. Only their
other transactions are added; no second expansion occurs. Change, batching and
collaborative transactions can make this association broad.

The five mutually exclusive transaction categories are known only, reused only,
both, counterparty only and uncovered. Counts use transaction unions, not sums
of address activity. Matched event/value coverage measures only the addresses'
own creation/spend events. Associated transaction activity includes every event
in each classified transaction. Gross input-plus-output BTC is neither economic
transfer volume nor rendered brightness.

## Setup and extraction

Use Python 3.12+ with `scripts/address_coverage_requirements.txt`; the node-side
extractor only requires PyArrow. Keep artifacts outside the repository. Examples
use `COVERAGE_PYTHON`, `COVERAGE_RUN`, `COVERAGE_BLK` and `COVERAGE_COOKIE` as
operator-selected absolute paths; the RPC cookie must remain private.

```sh
"$COVERAGE_PYTHON" scripts/address_coverage_manifest.py \
  --source "$COVERAGE_BLK" --start 916828 --end 966827 \
  --output "$COVERAGE_RUN/expected-blocks.json"

"$COVERAGE_PYTHON" scripts/address_coverage_extract.py \
  --rpc-url http://127.0.0.1:8332 --cookie-file "$COVERAGE_COOKIE" \
  --expected-blocks "$COVERAGE_RUN/expected-blocks.json" \
  --output "$COVERAGE_RUN" --start 916828 --end 966827 --preflight

"$COVERAGE_PYTHON" scripts/address_coverage_extract.py \
  --rpc-url http://127.0.0.1:8332 --cookie-file "$COVERAGE_COOKIE" \
  --expected-blocks "$COVERAGE_RUN/expected-blocks.json" \
  --output "$COVERAGE_RUN" --start 916828 --end 966827 \
  --executor process --workers 8 --batch-size 100
```

Run extraction beside Bitcoin Core. `getblock(hash,3)` must return complete
historical prevouts, including those created before the analysis window. The
extractor checks each expected block and active-chain membership, preserves
full outpoints/scripts and parses satoshis exactly. It does not call node update,
rescan, pruning or wallet mutation operations. `--limit-batches 1` provides a
bounded benchmark before the full run.

Each batch is an atomically published Parquet file plus a JSON receipt containing
source binding, SHA-256 and per-block event/transaction/value totals. Rerunning
the same command verifies and reuses complete batches. Partial temporary files
are not accepted. `extraction.json.complete` becomes true only after the full
window and final active-chain verification succeed. Copy only completed files
when transferring; retain `events/`, `batches/`, `extraction.json` and the expected
block manifest together.

## Analysis and report

Prepare labels with the reproducible commands in the label-source document.
Use `labels_extended.csv` for combined published evidence, with direct-disclosure
coverage reported separately in `known_evidence_tiers.csv`.

```sh
"$COVERAGE_PYTHON" scripts/address_coverage_verify.py \
  --data-dir "$COVERAGE_RUN" --expected-blocks "$COVERAGE_RUN/expected-blocks.json"

"$COVERAGE_PYTHON" scripts/address_coverage_analyze.py \
  --data-dir "$COVERAGE_RUN" \
  --labels-csv "$COVERAGE_RUN/labels/labels_extended.csv" \
  --output-dir "$COVERAGE_RUN/analysis" --memory-limit 20GB --threads 8

"$COVERAGE_PYTHON" scripts/address_coverage_report.py \
  --output-dir "$COVERAGE_RUN/analysis" \
  --verification-file "$COVERAGE_RUN/verification.json"
```

The DuckDB database and spill files remain on the artifact volume. Report
generation requires complete, matching source verification and reconciled
transaction/event totals. The report includes threshold coverage, concentration
curves, evidence, and CSV links. Temporal CSVs use ten consecutive 5,000-block
windows with fixed full-sample seed sets; this is retrospective analysis.

Optional interpretation of highly reused addresses can be supplied as
`analysis/top_address_context.json`, using the retained research evidence schema.
The report checks its sample range, ranks, exact addresses and receiving/spending/
involved transaction counts against `ranked_reused_addresses.csv`; mismatches stop
report generation. This source-linked context never modifies the frozen label
catalog or coverage metrics. Shared protocol scripts and published behavioral
patterns must not be presented as identified owners or exchange concentration.

An optional `analysis/top10_flash_relevance.json` can add the separately verified
noncoinbase event/value comparison for the ten most reused addresses. Rendering
requires matching source hashes, sample range, exact ranked event/value totals,
the top-ten transaction-union checkpoint and the current denominators, together
with the supplement's verified zero-coinbase-role check. This comparison measures
gross BTC activity, not rendered flash brightness.

Ranked CSVs retain the top 10,000 addresses by default; the database contains
complete address statistics. Concentration measures exact transaction unions
for top 10/100/1,000 reused addresses and top 5/10/20 entities. All conclusions
must distinguish published identification, unnamed reuse and mere connection.

For large windows, address roles are physically divided into 64 hash partitions
before computing full-period address statistics. Subsequent address joins use
those same partitions, and transaction grouping uses bounded block ranges.
This keeps the exact counting rules while avoiding one in-memory hash table for
every address in the sample. Intermediate partitions are analysis artifacts;
the original events and existing render inputs remain separate.

If an analysis is interrupted after transaction/address roles have been prepared,
repeat its command with `--resume-prepared`. The saved preparation binds the
source manifest, verified event-file identities, range and schema. A mismatch
refuses reuse. Address-statistic partitions record transactional completion, so
finished partitions are not duplicated. `--prepare-only` can validate and finish
this preparation without running coverage queries. Use a fresh output directory
for a different source dataset. On a node with limited spare RAM, use
`--memory-limit 8GB --threads 2`; the full run's original 6GB global address
grouping exceeded its memory limit, motivating the bounded partition path.

## Validation

```sh
"$COVERAGE_PYTHON" -m unittest discover -s scripts/tests -p 'test_address_coverage*.py' -v
```

Fixtures cover receiving deduplication, overlap/self-transfers, old and same-block
prevouts, zero-satoshi/nonaddress outputs, exactly one expansion, conflicting
labels, missing data, checksum-bound resume, process workers and report binding.
Generated datasets, label snapshots, reports and local credentials are not source
files to commit.
