#!/usr/bin/env python3
"""Disk-backed, address-level Bitcoin activity coverage analysis.

The input is the event Parquet dataset produced by address_coverage_extract.py.
There is deliberately no ownership clustering: a counterparty is an address on
the opposite side of a seed transaction, which may include change or a CoinJoin
participant. Input and output values are gross activity, not economic volume.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any


DEFAULT_START = 916828
DEFAULT_END = 966827
THRESHOLDS = (2, 5, 10, 100)
CATEGORIES = ("known_only", "reused_only", "both", "counterparty_only", "uncovered")
LABEL_COLUMNS = ("address", "entity", "source", "observed_date", "confidence",
                 "evidence_type", "historical_note")
DIRECT_EVIDENCE_TYPES = ("service_disclosure_via_graphsense", "service_disclosure")


def _literal(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda:handle.read(8*1024*1024),b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepared_binding(data_dir: str | Path, start: int, end: int,
                     verification: dict[str,Any]) -> dict[str,Any]:
    """Bind prepared roles to previously verified immutable input file identities."""
    import duckdb

    source = Path(data_dir).resolve()
    events = source / "events" if (source / "events").is_dir() else source
    identities = sorted([[str(path.relative_to(source)),path.stat().st_size,path.stat().st_mtime_ns]
                         for path in events.rglob("*.parquet")])
    extraction = source / "extraction.json"
    return dict(version=1,role_schema_version=1,duckdb_version=duckdb.__version__,data_dir=str(source),start=start,end=end,
        source_fingerprint=verification.get("source_fingerprint"),
        expected_blocks_sha256=verification.get("expected_blocks_sha256"),
        extraction_manifest_sha256=_sha256(extraction) if extraction.is_file() else None,
        input_files_fingerprint=hashlib.sha256(json.dumps(identities,separators=(',',':')).encode()).hexdigest())


def save_prepared_binding(connection: Any, binding: dict[str,Any],
                          verification: dict[str,Any]) -> None:
    """Commit only after the caller has validated complete transaction/role tables."""
    connection.execute("CREATE OR REPLACE TABLE analysis_prepared(binding_json VARCHAR,verification_json VARCHAR)")
    connection.execute("INSERT INTO analysis_prepared VALUES (?,?)",
                       [json.dumps(binding,sort_keys=True),json.dumps(verification,sort_keys=True)])
    connection.execute("CHECKPOINT")


def _load_prepared_binding(connection: Any) -> tuple[dict[str,Any],dict[str,Any]]:
    exists = connection.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='analysis_prepared'").fetchone()[0]
    if not exists:
        raise ValueError("No completed prepared-table binding; refusing to adopt unbound tables")
    rows = connection.execute("SELECT binding_json,verification_json FROM analysis_prepared").fetchall()
    if len(rows)!=1:
        raise ValueError("Invalid prepared-table binding")
    return json.loads(rows[0][0]),json.loads(rows[0][1])


def _tx_chunks(start: int, end: int, blocks: int = 1000):
    for low in range(start,end+1,blocks):
        high = min(low+blocks-1,end)
        yield low,high,(low << 32),((high+1) << 32)


def _table_range(connection: Any) -> tuple[int,int]:
    low,high = connection.execute("SELECT min(tx_key)>>32,max(tx_key)>>32 FROM transactions").fetchone()
    return int(low),int(high)


def _aggregate_addresses(connection: Any, output: Path, binding: dict[str,Any],
                         partitions: int) -> None:
    """One physical repartition pass, followed by bounded address hash tables."""
    import shutil

    directory = output / "address_role_partitions"
    descriptor = dict(version=1,partitions=partitions,binding=binding)
    manifest_path = directory / "manifest.json"
    if directory.exists():
        if not manifest_path.is_file() or json.loads(manifest_path.read_text())!=descriptor:
            raise ValueError("Existing address role partitions have a different or incomplete binding")
    else:
        staging = output / "address_role_partitions.staging"
        if staging.exists():
            shutil.rmtree(staging)
        _log(f"Repartition address roles into {partitions} bounded address buckets")
        connection.execute(f"""COPY (SELECT *, (hash(address)%{partitions})::USMALLINT AS address_partition
            FROM address_roles) TO {_literal(staging)}
            (FORMAT PARQUET,PARTITION_BY(address_partition),COMPRESSION ZSTD,ROW_GROUP_SIZE 65536)""")
        (staging / "manifest.json").write_text(json.dumps(descriptor,sort_keys=True)+"\n")
        staging.rename(directory)
    exists = connection.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='address_stats_progress'").fetchone()[0]
    if not exists:
        connection.execute("""CREATE OR REPLACE TABLE address_stats (
            address VARCHAR,receiving_transactions UBIGINT,spending_transactions UBIGINT,
            involved_transactions UBIGINT,input_events HUGEINT,output_events HUGEINT,
            input_satoshi HUGEINT,output_satoshi HUGEINT,address_partition USMALLINT)""")
        connection.execute("CREATE TABLE address_stats_progress(address_partition USMALLINT)")
    done = {row[0] for row in connection.execute("SELECT address_partition FROM address_stats_progress").fetchall()}
    for partition in range(partitions):
        if partition in done:
            continue
        files = list((directory/f"address_partition={partition}").glob("*.parquet"))
        _log(f"Aggregate address rankings bucket {partition+1}/{partitions}")
        connection.execute("BEGIN")
        try:
            if files:
                connection.execute(f"""INSERT INTO address_stats SELECT address,
                    count(*) FILTER(WHERE output_events>0),count(*) FILTER(WHERE input_events>0),
                    count(*) FILTER(WHERE NOT coinbase),sum(input_events),sum(output_events),
                    sum(input_satoshi),sum(output_satoshi),{partition}
                    FROM read_parquet({_literal(directory/f'address_partition={partition}'/'*.parquet')})
                    GROUP BY address""")
            connection.execute("INSERT INTO address_stats_progress VALUES (?)",[partition])
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
    totals = ",".join(f"coalesce(sum({column}),0)" for column in
                      ("input_events","output_events","input_satoshi","output_satoshi"))
    expected = connection.execute(f"SELECT {totals} FROM address_roles").fetchone()
    actual = connection.execute(f"SELECT {totals} FROM address_stats").fetchone()
    if actual!=expected:
        raise ValueError(f"Address aggregate counts/values do not reconcile with prepared roles: {actual} != {expected}")
    _log("Address aggregate event/value totals reconcile with prepared roles")
    connection.execute("CHECKPOINT")


def _rows(connection: Any, sql: str) -> list[dict[str, Any]]:
    cursor = connection.execute(sql)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def _csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields or list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def _copy(connection: Any, query: str, target: Path) -> None:
    connection.execute(f"COPY ({query}) TO {_literal(target)} (FORMAT CSV, HEADER true)")


def _pct(numerator: int, denominator: int) -> float:
    return 100.0 * numerator / denominator if denominator else 0.0


def _log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {message}", flush=True)


def _load_labels(connection: Any, labels_csv: Path | None) -> None:
    if labels_csv is None:
        connection.execute("CREATE OR REPLACE TABLE labels_raw (" +
                           ", ".join(f"{name} VARCHAR" for name in LABEL_COLUMNS) + ")")
    else:
        with labels_csv.open(newline="") as handle:
            actual = csv.DictReader(handle).fieldnames or []
        missing = set(LABEL_COLUMNS) - set(actual)
        if missing:
            raise ValueError(f"Label CSV missing columns: {sorted(missing)}")
        columns = ", ".join(f"trim(coalesce({name}, '')) AS {name}" for name in LABEL_COLUMNS)
        connection.execute(f"""CREATE OR REPLACE TABLE labels_raw AS
            SELECT {columns} FROM read_csv({_literal(labels_csv)}, header=true,
                all_varchar=true, sample_size=-1)
            WHERE nullif(trim(address), '') IS NOT NULL
              AND nullif(trim(entity), '') IS NOT NULL""")
    connection.execute("""CREATE OR REPLACE TABLE label_resolution AS
        SELECT address, count(DISTINCT entity) AS entity_count,
               CASE WHEN count(DISTINCT entity)=1 THEN min(entity) END AS entity,
               string_agg(DISTINCT source, ' | ' ORDER BY source) AS sources,
               string_agg(DISTINCT observed_date, ' | ' ORDER BY observed_date) AS observed_dates,
               string_agg(DISTINCT confidence, ' | ' ORDER BY confidence) AS confidences,
               string_agg(DISTINCT evidence_type, ' | ' ORDER BY evidence_type) AS evidence_types,
               string_agg(DISTINCT historical_note, ' | ' ORDER BY historical_note) AS historical_notes
        FROM labels_raw GROUP BY address""")
    connection.execute("""CREATE OR REPLACE VIEW known_labels AS
        SELECT * FROM label_resolution WHERE entity_count=1""")


def _prepare(connection: Any, event_glob: str, start: int, end: int,
             window_blocks: int, validate: bool) -> None:
    connection.execute(f"""CREATE OR REPLACE VIEW events AS
        SELECT *, ((height::UBIGINT << 32) | tx_index::UBIGINT) AS tx_key
        FROM read_parquet({_literal(event_glob)}, union_by_name=true)
        WHERE height BETWEEN {start} AND {end}""")
    if validate:
        invalid = connection.execute("""SELECT count(*) FROM events WHERE
            direction NOT IN ('in','out') OR direction IS NULL OR satoshi IS NULL
            OR satoshi<0 OR creation_height IS NULL OR creation_height>height
            OR (coinbase AND direction='in') OR txid IS NULL OR octet_length(txid)<>32
            OR (direction='in' AND (outpoint_txid IS NULL OR octet_length(outpoint_txid)<>32))
            OR coinbase IS NULL""").fetchone()[0]
        if invalid:
            raise ValueError(f"Invalid or unresolved events: {invalid}")
    connection.execute("""CREATE OR REPLACE TABLE transactions (
        tx_key UBIGINT, coinbase BOOLEAN, input_events UINTEGER, output_events UINTEGER,
        input_satoshi BIGINT, output_satoshi BIGINT)""")
    connection.execute("""CREATE OR REPLACE TABLE address_roles (
        tx_key UBIGINT, coinbase BOOLEAN, address VARCHAR,
        input_events UINTEGER, output_events UINTEGER,
        input_satoshi BIGINT, output_satoshi BIGINT)""")
    # Bound intermediate hash groups independently of the 5,000-block report
    # windows. A full reporting window can contain tens of millions of roles.
    aggregation_blocks = min(window_blocks, 1000)
    for low in range(start, end + 1, aggregation_blocks):
        high = min(low + aggregation_blocks - 1, end)
        _log(f"Aggregate transaction/address roles: {low}-{high}")
        if validate:
            duplicate = connection.execute(f"""SELECT height,tx_index,direction,io_index
                FROM events WHERE height BETWEEN {low} AND {high}
                GROUP BY ALL HAVING count(*)>1 LIMIT 1""").fetchone()
            if duplicate:
                raise ValueError(f"Duplicate event key: {duplicate}")
            invalid_tx = connection.execute(f"""SELECT tx_key FROM events
                WHERE height BETWEEN {low} AND {high} GROUP BY tx_key
                HAVING count(DISTINCT coinbase)<>1 OR count(DISTINCT txid)<>1 LIMIT 1""").fetchone()
            if invalid_tx:
                raise ValueError(f"Inconsistent transaction identity: {invalid_tx[0]}")
        totals = """count(*) FILTER (WHERE direction='in'),
            count(*) FILTER (WHERE direction='out'),
            coalesce(sum(satoshi) FILTER (WHERE direction='in'),0),
            coalesce(sum(satoshi) FILTER (WHERE direction='out'),0)"""
        connection.execute(f"""INSERT INTO transactions SELECT tx_key,coinbase,{totals}
            FROM events WHERE height BETWEEN {low} AND {high} GROUP BY tx_key,coinbase""")
        connection.execute(f"""INSERT INTO address_roles SELECT tx_key,coinbase,address,{totals}
            FROM events WHERE height BETWEEN {low} AND {high}
                AND address IS NOT NULL AND address<>'' GROUP BY tx_key,coinbase,address""")
    observed = connection.execute("SELECT count(DISTINCT tx_key >> 32) FROM transactions").fetchone()[0]
    if observed != end - start + 1:
        raise ValueError(f"Expected {end-start+1} populated blocks, found {observed}")
    bad_coinbase = connection.execute("""SELECT tx_key >> 32 AS height FROM transactions
        GROUP BY height HAVING count(*) FILTER (WHERE coinbase)<>1 LIMIT 1""").fetchone()
    if bad_coinbase:
        raise ValueError(f"Block must contain exactly one coinbase: {bad_coinbase[0]}")
    connection.execute(f"""CREATE OR REPLACE MACRO period_of(k) AS
        (((k >> 32)::BIGINT - {start}) // {window_blocks})::INTEGER""")


def _periods(start: int, end: int, window_blocks: int) -> list[dict[str, int]]:
    return [{"period": -1, "start_height": start, "end_height": end}] + [
        {"period": index, "start_height": low, "end_height": min(low+window_blocks-1,end)}
        for index, low in enumerate(range(start, end+1, window_blocks))]


def _denominators(connection: Any, periods: list[dict[str, int]]) -> list[dict[str, Any]]:
    result = _rows(connection, """SELECT coalesce(period_of(tx_key),-1) AS period,
        coinbase,count(*) AS transactions,sum(input_events) AS input_events,
        sum(output_events) AS output_events,sum(input_satoshi) AS input_satoshi,
        sum(output_satoshi) AS output_satoshi FROM transactions
        GROUP BY GROUPING SETS ((period_of(tx_key),coinbase),(coinbase))""")
    observed = {(row["period"],row["coinbase"]):row for row in result}
    result = []
    for period in periods:
        for coinbase in (False,True):
            row = dict(**period,coinbase=coinbase,transactions=0,input_events=0,
                output_events=0,input_satoshi=0,output_satoshi=0)
            row.update(observed.get((period["period"],coinbase),{}))
            result.append(row)
    for row in result:
        row["gross_satoshi"] = row["input_satoshi"] + row["output_satoshi"]
        row["events"] = row["input_events"] + row["output_events"]
    return sorted(result, key=lambda row: (row["period"], row["coinbase"]))


def _known_evidence_tiers(connection: Any, periods: list[dict[str,int]],
                          denominators: list[dict[str,Any]], output: Path) -> list[dict[str,Any]]:
    """One direct-address sensitivity check, independent of reuse thresholds."""
    results = []
    start,end = _table_range(connection)
    den = {row["period"]:row for row in denominators if not row["coinbase"]}
    direct_predicate = "r.evidence_type IN (" + ",".join(map(_literal,DIRECT_EVIDENCE_TYPES)) + ")"
    for tier,predicate in (("direct_service_disclosures",direct_predicate),
                           ("all_public_labels","true")):
        connection.execute(f"""CREATE OR REPLACE TEMP TABLE tier_addresses AS
            SELECT DISTINCT l.address FROM known_labels l JOIN labels_raw r USING(address,entity)
            WHERE {predicate}""")
        label_count = connection.execute("SELECT count(*) FROM tier_addresses").fetchone()[0]
        observed_count = connection.execute("""SELECT count(*) FROM tier_addresses
            JOIN address_stats USING(address)""").fetchone()[0]
        connection.execute("""CREATE OR REPLACE TEMP TABLE tier_transactions (
            tx_key UBIGINT,input_events HUGEINT,output_events HUGEINT,
            input_satoshi HUGEINT,output_satoshi HUGEINT)""")
        for low,high,first,stop in _tx_chunks(start,end):
            connection.execute(f"""INSERT INTO tier_transactions
                SELECT r.tx_key,sum(r.input_events),sum(r.output_events),
                    sum(r.input_satoshi),sum(r.output_satoshi)
                FROM address_roles r JOIN tier_addresses a USING(address)
                WHERE NOT r.coinbase AND r.tx_key>={first} AND r.tx_key<{stop}
                GROUP BY r.tx_key""")
        aggregates = _rows(connection,"""SELECT coalesce(period_of(tx_key),-1) AS period,
            count(*) AS transactions,count(*) FILTER(WHERE input_events>0 AND output_events=0)
                AS spending_from_only,count(*) FILTER(WHERE output_events>0 AND input_events=0)
                AS sending_to_only,count(*) FILTER(WHERE input_events>0 AND output_events>0)
                AS both_directions,sum(input_events) AS input_events,sum(output_events) AS output_events,
            sum(input_satoshi) AS input_satoshi,sum(output_satoshi) AS output_satoshi
            FROM tier_transactions GROUP BY GROUPING SETS ((period_of(tx_key)),())""")
        observed = {row["period"]:row for row in aggregates}
        for period in periods:
            row = dict(tier=tier,**period,label_addresses=label_count,
                observed_addresses=observed_count,transactions=0,spending_from_only=0,
                sending_to_only=0,both_directions=0,input_events=0,output_events=0,
                input_satoshi=0,output_satoshi=0)
            row.update({key:value or 0 for key,value in observed.get(period["period"],{}).items()})
            row["events"] = row["input_events"] + row["output_events"]
            row["gross_satoshi"] = row["input_satoshi"] + row["output_satoshi"]
            for measure in ("transactions","input_events","output_events","events",
                            "input_satoshi","output_satoshi","gross_satoshi"):
                denominator = den[period["period"]][measure]
                row[f"denominator_{measure}"] = denominator
                row[f"{measure}_pct"] = _pct(row[measure],denominator)
            results.append(row)
    _csv(output / "known_evidence_tiers.csv",results)
    return results


def _rankings(connection: Any, output: Path, denominator: int,
              ranking_limit: int) -> list[dict[str, Any]]:
    start,end = _table_range(connection)
    connection.execute(f"""CREATE OR REPLACE TABLE reused_ranks AS
        SELECT address,receiving_transactions,
            row_number() OVER (ORDER BY receiving_transactions DESC,address) AS address_rank
        FROM (SELECT address,receiving_transactions FROM address_stats WHERE receiving_transactions>=2
              ORDER BY receiving_transactions DESC,address LIMIT {max(ranking_limit,1000)})""")
    _copy(connection, f"""SELECT r.address_rank,a.* EXCLUDE(address_partition),
        CASE WHEN l.entity_count=1 THEN l.entity END AS entity,
        coalesce(l.entity_count>1,false) AS label_conflict,l.sources,l.observed_dates,
        l.confidences,l.evidence_types,l.historical_notes
        FROM reused_ranks r JOIN address_stats a USING(address)
        LEFT JOIN label_resolution l USING(address) ORDER BY r.address_rank LIMIT {ranking_limit}""",
        output / "ranked_reused_addresses.csv")
    _copy(connection, f"""SELECT row_number() OVER
        (ORDER BY a.involved_transactions DESC,a.address) AS activity_rank,a.* EXCLUDE(address_partition),l.entity,
        l.sources,l.observed_dates,l.confidences,l.evidence_types,l.historical_notes
        FROM address_stats a JOIN known_labels l USING(address)
        ORDER BY activity_rank LIMIT {ranking_limit}""", output / "ranked_known_addresses.csv")
    connection.execute("""CREATE OR REPLACE TABLE entity_transactions (
        tx_key UBIGINT,entity VARCHAR,input_events HUGEINT,output_events HUGEINT,
        input_satoshi HUGEINT,output_satoshi HUGEINT)""")
    for low,high,first,stop in _tx_chunks(start,end):
        connection.execute(f"""INSERT INTO entity_transactions
            SELECT r.tx_key,l.entity,sum(r.input_events),sum(r.output_events),
                sum(r.input_satoshi),sum(r.output_satoshi)
            FROM address_roles r JOIN known_labels l USING(address)
            WHERE NOT r.coinbase AND r.tx_key>={first} AND r.tx_key<{stop}
            GROUP BY r.tx_key,l.entity""")
    connection.execute("""CREATE OR REPLACE TABLE entity_ranks AS
        SELECT *,row_number() OVER(ORDER BY involved_transactions DESC,entity) AS entity_rank
        FROM (SELECT entity,count(*) AS involved_transactions,
            count(*) FILTER(WHERE input_events>0) AS spending_transactions,
            count(*) FILTER(WHERE output_events>0) AS receiving_transactions,
            sum(input_events) AS input_events,sum(output_events) AS output_events,
            sum(input_satoshi) AS input_satoshi,sum(output_satoshi) AS output_satoshi
            FROM entity_transactions GROUP BY entity)""")
    _copy(connection, """SELECT e.*,s.sources,s.observed_dates,s.confidences,
        s.evidence_types,s.historical_notes FROM entity_ranks e LEFT JOIN
        (SELECT entity,string_agg(DISTINCT source,' | ' ORDER BY source) AS sources,
            string_agg(DISTINCT observed_date,' | ' ORDER BY observed_date) AS observed_dates,
            string_agg(DISTINCT confidence,' | ' ORDER BY confidence) AS confidences,
            string_agg(DISTINCT evidence_type,' | ' ORDER BY evidence_type) AS evidence_types,
            string_agg(DISTINCT historical_note,' | ' ORDER BY historical_note) AS historical_notes
         FROM labels_raw JOIN known_labels USING(address,entity) GROUP BY entity) s USING(entity)
        ORDER BY entity_rank""", output / "ranked_entities.csv")
    curves = []
    for kind, query, rank_column, rank_table, checkpoints in (
        ("reused_address", """SELECT min(s.address_rank) AS first_rank FROM address_roles r
            JOIN reused_ranks s USING(address) WHERE s.address_rank<=1000 AND NOT r.coinbase
                AND r.tx_key>={first} AND r.tx_key<{stop}
            GROUP BY r.tx_key""", "address_rank", "reused_ranks", (10,100,1000)),
        ("known_entity", """SELECT min(s.entity_rank) AS first_rank FROM entity_transactions t
            JOIN entity_ranks s USING(entity) WHERE s.entity_rank<=20
                AND t.tx_key>={first} AND t.tx_key<{stop} GROUP BY t.tx_key""",
            "entity_rank", "entity_ranks", (5,10,20)),
    ):
        histogram: dict[int,int] = {}
        for low,high,first,stop in _tx_chunks(start,end):
            bounded = query.format(first=first,stop=stop)
            for rank,count in connection.execute(f"SELECT first_rank,count(*) FROM ({bounded}) GROUP BY first_rank").fetchall():
                histogram[rank] = histogram.get(rank,0)+count
        available = connection.execute("SELECT count(*) FROM address_stats WHERE receiving_transactions>=2"
            if kind=="reused_address" else f"SELECT count(*) FROM {rank_table}").fetchone()[0]
        cumulative = 0
        for rank in range(1, max(checkpoints)+1):
            cumulative += histogram.get(rank,0)
            if rank<=available or rank in checkpoints:
                curves.append(dict(kind=kind,top_n=rank,selected_count=min(rank,available),
                    transactions=cumulative,denominator_transactions=denominator,
                    transaction_pct=_pct(cumulative,denominator),checkpoint=rank in checkpoints))
    _csv(output / "concentration_curves.csv", curves)
    return curves


def _threshold(connection: Any, threshold: int, periods: list[dict[str, int]],
               denominators: list[dict[str, Any]], output: Path,
               address_partitions: int = 64) -> dict[str, Any]:
    """Bound every large join/group by an address or transaction partition.

    Address partitions are read by explicit path, rather than applying a hash
    predicate to a full role-table scan. Shuffles carry only identifiers and
    flags; gross event/value measurements come from the original role files.
    """
    import shutil

    _log(f"Coverage at reuse threshold {threshold}: bounded partition passes")
    if address_partitions < 1:
        raise ValueError("Address partition count must be positive")
    start, end = periods[0]["start_height"], periods[0]["end_height"]
    transaction_blocks = 1000
    transaction_buckets = (end-start)//transaction_blocks + 1
    role_root = output / "address_role_partitions"
    manifest_path = role_root / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if manifest["partitions"] != address_partitions:
            raise ValueError("Address role partition count does not match analysis")
    work = output / "_threshold_work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    annotated_root, candidate_root, flag_root = (work/name for name in
                                                ("annotated", "candidates", "flags"))
    tx_bucket = f"(((tx_key >> 32)::BIGINT-{start}) // {transaction_blocks})::INTEGER"
    den = {row["period"]:row for row in denominators if not row["coinbase"]}
    measures = ("input_events", "output_events", "input_satoshi", "output_satoshi")
    conditions = {
        "known":"coalesce(s.known,false)", "reused":"coalesce(s.reused,false)",
        "known_or_reused":"s.address IS NOT NULL", "counterparty":"c.address IS NOT NULL",
        "known_or_reused_or_counterparty":"s.address IS NOT NULL OR c.address IS NOT NULL",
    }
    direction_columns = {
        "known":("known_in","known_out"), "reused":("reused_in","reused_out"),
        "known_or_reused":("(known_in OR reused_in)","(known_out OR reused_out)"),
        "counterparty":("counterparty_in","counterparty_out"),
        "known_or_reused_or_counterparty":("(known_in OR reused_in OR counterparty_in)",
                                            "(known_out OR reused_out OR counterparty_out)"),
    }
    directions_names = ("spending_from_only", "sending_to_only", "both_directions")
    coverage_totals: dict[tuple[int,str],dict[str,int]] = {}
    matched_totals: dict[tuple[int,str],dict[str,int]] = {}
    direction_totals: dict[tuple[int,str,str],int] = {}

    def parquet(paths: list[Path]) -> str:
        return "read_parquet([" + ",".join(_literal(path) for path in paths) + \
            "], hive_partitioning=false)"

    def role_files(partition: int) -> list[Path]:
        return sorted((role_root/f"address_partition={partition}").glob("*.parquet"))

    def shuffled(root: Path, key: str, bucket: int) -> list[Path]:
        return sorted(root.glob(f"source_*/{key}={bucket}/*.parquet"))

    def write_partitioned(query: str, target: Path, column: str) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        connection.execute(f"COPY ({query}) TO {_literal(target)} "
            f"(FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY ({column}))")

    def local_seeds(partition: int) -> None:
        connection.execute(f"""CREATE OR REPLACE TEMP TABLE _threshold_seeds AS
            SELECT address,known,reused FROM seeds WHERE address_partition={partition}""")

    # Release previous threshold intermediates before allocating the next pass.
    for name in ("seed_transactions", "counterparty_transactions", "seeds", "counterparties"):
        connection.execute(f"DROP TABLE IF EXISTS {name}")
    connection.execute("CHECKPOINT")
    connection.execute("""CREATE OR REPLACE TABLE seeds (
        address VARCHAR,known BOOLEAN,reused BOOLEAN,address_partition UINTEGER)""")
    connection.execute("""CREATE OR REPLACE TABLE counterparties (
        address VARCHAR,address_partition UINTEGER)""")
    connection.execute("""CREATE OR REPLACE TABLE seed_transactions (
        tx_key UBIGINT,known_in BOOLEAN,known_out BOOLEAN,reused_in BOOLEAN,reused_out BOOLEAN)""")
    connection.execute("""CREATE OR REPLACE TABLE counterparty_transactions (
        tx_key UBIGINT,counterparty_in BOOLEAN,counterparty_out BOOLEAN)""")
    connection.execute("""CREATE OR REPLACE TEMP TABLE _threshold_rank_candidates (
        address VARCHAR,receiving_transactions UBIGINT,spending_transactions UBIGINT,
        involved_transactions UBIGINT)""")
    try:
        # First pass: each build-side seed map is restricted to one address
        # bucket. Annotated roles are shuffled once into chronological buckets.
        for partition in range(address_partitions):
            paths = role_files(partition)
            if not paths:
                continue
            if partition % 8 == 0:
                _log(f"Threshold {threshold}: annotate address partition {partition}/{address_partitions}")
            connection.execute(f"""CREATE OR REPLACE TEMP TABLE _threshold_seeds AS
                SELECT a.address,l.address IS NOT NULL AS known,
                    a.receiving_transactions>={threshold} AS reused
                FROM (SELECT address,receiving_transactions FROM address_stats
                      WHERE address_partition={partition}) a
                LEFT JOIN known_labels l USING(address)
                WHERE l.address IS NOT NULL OR a.receiving_transactions>={threshold}""")
            connection.execute(f"INSERT INTO seeds SELECT *,{partition} FROM _threshold_seeds")
            write_partitioned(f"""SELECT r.tx_key,r.address,
                coalesce(s.known,false) AS known,coalesce(s.reused,false) AS reused,
                r.input_events>0 AS has_input,r.output_events>0 AS has_output,
                {tx_bucket} AS tx_bucket FROM {parquet(paths)} r
                LEFT JOIN _threshold_seeds s USING(address) WHERE NOT r.coinbase""",
                annotated_root/f"source_{partition}","tx_bucket")

        # Every transaction's roles now meet in one bounded group. Counterparty
        # candidates are emitted without a large DISTINCT; the next address
        # partition pass performs that deduplication exactly once.
        for bucket in range(transaction_buckets):
            paths = shuffled(annotated_root,"tx_bucket",bucket)
            if not paths:
                continue
            if bucket % 10 == 0:
                _log(f"Threshold {threshold}: identify counterparties in transaction bucket {bucket}/{transaction_buckets}")
            connection.execute(f"""CREATE OR REPLACE TEMP VIEW _threshold_annotated AS
                SELECT * FROM {parquet(paths)}""")
            connection.execute("""CREATE OR REPLACE TEMP TABLE _threshold_seed_transactions AS
                SELECT tx_key,bool_or(known AND has_input) AS known_in,
                    bool_or(known AND has_output) AS known_out,
                    bool_or(reused AND has_input) AS reused_in,
                    bool_or(reused AND has_output) AS reused_out
                FROM _threshold_annotated WHERE known OR reused GROUP BY tx_key""")
            connection.execute("INSERT INTO seed_transactions SELECT * FROM _threshold_seed_transactions")
            write_partitioned(f"""SELECT r.address,
                (hash(r.address)%{address_partitions})::UINTEGER AS address_partition
                FROM _threshold_annotated r JOIN _threshold_seed_transactions t USING(tx_key)
                WHERE NOT (r.known OR r.reused) AND
                    (((t.known_in OR t.reused_in) AND r.has_output)
                      OR ((t.known_out OR t.reused_out) AND r.has_input))""",
                candidate_root/f"source_{bucket}","address_partition")
            connection.execute("DROP VIEW _threshold_annotated")
            for path in paths:
                path.unlink()

        matched_select = [
            f"coalesce(sum(r.{metric}) FILTER(WHERE {condition}),0) AS {scope}__{metric}"
            for scope,condition in conditions.items() for metric in measures]
        # Second address pass: bounded deduplication, matched event/value totals,
        # and a compact shuffle of counterparty transaction flags.
        for partition in range(address_partitions):
            paths = role_files(partition)
            if not paths:
                continue
            if partition % 8 == 0:
                _log(f"Threshold {threshold}: measure address partition {partition}/{address_partitions}")
            candidates = shuffled(candidate_root,"address_partition",partition)
            if candidates:
                connection.execute(f"""CREATE OR REPLACE TEMP TABLE _threshold_counterparties AS
                    SELECT DISTINCT address FROM {parquet(candidates)}""")
            else:
                connection.execute("""CREATE OR REPLACE TEMP TABLE _threshold_counterparties
                    (address VARCHAR)""")
            connection.execute(f"INSERT INTO counterparties SELECT address,{partition} FROM _threshold_counterparties")
            local_seeds(partition)
            for raw in _rows(connection,f"""SELECT coalesce(period_of(r.tx_key),-1) AS period,
                    {','.join(matched_select)} FROM {parquet(paths)} r
                    LEFT JOIN _threshold_seeds s USING(address)
                    LEFT JOIN _threshold_counterparties c USING(address) WHERE NOT r.coinbase
                    GROUP BY GROUPING SETS ((period_of(r.tx_key)),())"""):
                for scope in conditions:
                    totals = matched_totals.setdefault((raw["period"],scope),
                                                       {metric:0 for metric in measures})
                    for metric in measures:
                        totals[metric] += raw[f"{scope}__{metric}"] or 0
            write_partitioned(f"""SELECT r.tx_key,r.input_events>0 AS counterparty_in,
                r.output_events>0 AS counterparty_out,{tx_bucket} AS tx_bucket
                FROM {parquet(paths)} r JOIN _threshold_counterparties c USING(address)
                WHERE NOT r.coinbase""",flag_root/f"source_{partition}","tx_bucket")
            if threshold == 2:
                connection.execute(f"""INSERT INTO _threshold_rank_candidates
                    SELECT c.address,a.receiving_transactions,a.spending_transactions,
                        a.involved_transactions FROM _threshold_counterparties c
                    JOIN (SELECT address,receiving_transactions,spending_transactions,
                        involved_transactions FROM address_stats
                        WHERE address_partition={partition}) a USING(address)
                    ORDER BY a.involved_transactions DESC,c.address LIMIT 10000""")
            for path in candidates:
                path.unlink()

        direction_select = []
        for scope,(incoming,outgoing) in direction_columns.items():
            expressions = (f"{incoming} AND NOT {outgoing}",
                           f"{outgoing} AND NOT {incoming}",f"{incoming} AND {outgoing}")
            for direction,expression in zip(directions_names,expressions):
                direction_select.append(f"count(*) FILTER(WHERE {expression}) AS {scope}__{direction}")
        associated = tuple(f"associated_{metric}" for metric in measures)
        # Last pass: predicates constrain both sides of every transaction join.
        # Only small grouped totals leave this loop.
        for bucket in range(transaction_buckets):
            low = start+bucket*transaction_blocks
            high = min(end+1,low+transaction_blocks)
            minimum,maximum = low << 32, high << 32
            paths = shuffled(flag_root,"tx_bucket",bucket)
            if paths:
                connection.execute(f"""CREATE OR REPLACE TEMP TABLE _threshold_counterparty_transactions AS
                    SELECT tx_key,bool_or(counterparty_in) AS counterparty_in,
                        bool_or(counterparty_out) AS counterparty_out
                    FROM {parquet(paths)} GROUP BY tx_key""")
            else:
                connection.execute("""CREATE OR REPLACE TEMP TABLE _threshold_counterparty_transactions
                    (tx_key UBIGINT,counterparty_in BOOLEAN,counterparty_out BOOLEAN)""")
            connection.execute("INSERT INTO counterparty_transactions SELECT * FROM _threshold_counterparty_transactions")
            connection.execute(f"""CREATE OR REPLACE TEMP TABLE _threshold_classified AS
                SELECT t.*,coalesce(s.known_in,false) AS known_in,
                    coalesce(s.known_out,false) AS known_out,coalesce(s.reused_in,false) AS reused_in,
                    coalesce(s.reused_out,false) AS reused_out,
                    coalesce(c.counterparty_in,false) AS counterparty_in,
                    coalesce(c.counterparty_out,false) AS counterparty_out,
                    CASE WHEN (s.known_in OR s.known_out) AND (s.reused_in OR s.reused_out) THEN 'both'
                         WHEN s.known_in OR s.known_out THEN 'known_only'
                         WHEN s.reused_in OR s.reused_out THEN 'reused_only'
                         WHEN c.tx_key IS NOT NULL THEN 'counterparty_only' ELSE 'uncovered' END AS category
                FROM (SELECT * FROM transactions WHERE tx_key>={minimum} AND tx_key<{maximum}
                      AND NOT coinbase) t
                LEFT JOIN (SELECT * FROM seed_transactions
                           WHERE tx_key>={minimum} AND tx_key<{maximum}) s USING(tx_key)
                LEFT JOIN _threshold_counterparty_transactions c USING(tx_key)""")
            for raw in _rows(connection,"""SELECT coalesce(period_of(tx_key),-1) AS period,
                    category,count(*) AS transactions,sum(input_events) AS associated_input_events,
                    sum(output_events) AS associated_output_events,
                    sum(input_satoshi) AS associated_input_satoshi,
                    sum(output_satoshi) AS associated_output_satoshi
                    FROM _threshold_classified
                    GROUP BY GROUPING SETS ((period_of(tx_key),category),(category))"""):
                totals = coverage_totals.setdefault((raw["period"],raw["category"]),
                                                    {metric:0 for metric in ("transactions",*associated)})
                for metric in totals:
                    totals[metric] += raw[metric] or 0
            for raw in _rows(connection,f"""SELECT coalesce(period_of(tx_key),-1) AS period,
                    {','.join(direction_select)} FROM _threshold_classified
                    GROUP BY GROUPING SETS ((period_of(tx_key)),())"""):
                for scope in direction_columns:
                    for direction in directions_names:
                        key = (raw["period"],scope,direction)
                        direction_totals[key] = direction_totals.get(key,0) + (raw[f"{scope}__{direction}"] or 0)
            for path in paths:
                path.unlink()
            if bucket % 10 == 0:
                _log(f"Threshold {threshold}: classified transaction bucket {bucket}/{transaction_buckets}")

        coverage, directions, matched = [], [], []
        for period in periods:
            index = period["period"]
            denominator = den[index]["transactions"]
            for category in CATEGORIES:
                row = dict(threshold=threshold,**period,category=category,
                    transactions=0,**{metric:0 for metric in associated})
                row.update(coverage_totals.get((index,category),{}))
                row.update(denominator_transactions=denominator,
                           transaction_pct=_pct(row["transactions"],denominator))
                coverage.append(row)
            if sum(row["transactions"] for row in coverage if row["period"]==index) != denominator:
                raise AssertionError("Transaction categories do not reconcile")
            for scope in direction_columns:
                for direction in directions_names:
                    count = direction_totals.get((index,scope,direction),0)
                    directions.append(dict(threshold=threshold,period=index,scope=scope,
                        direction=direction,transactions=count,denominator_transactions=denominator,
                        transaction_pct=_pct(count,denominator)))
            for scope in conditions:
                row = dict(threshold=threshold,period=index,scope=scope,
                           **{metric:0 for metric in measures})
                row.update(matched_totals.get((index,scope),{}))
                row["events"] = row["input_events"]+row["output_events"]
                row["gross_satoshi"] = row["input_satoshi"]+row["output_satoshi"]
                for metric in (*measures,"events","gross_satoshi"):
                    row[f"denominator_{metric}"] = den[index][metric]
                    row[f"{metric}_pct"] = _pct(row[metric],den[index][metric])
                matched.append(row)
        counts = connection.execute("""SELECT count(*) FILTER(WHERE known),
            count(*) FILTER(WHERE reused),count(*) FILTER(WHERE known AND reused),count(*) FROM seeds""").fetchone()
        address_counts = dict(known=counts[0],reused=counts[1],both=counts[2],known_or_reused=counts[3],
            counterparties=connection.execute("SELECT count(*) FROM counterparties").fetchone()[0])
        if threshold == 2:
            _copy(connection,"""SELECT * FROM _threshold_rank_candidates
                ORDER BY involved_transactions DESC,address LIMIT 10000""",
                output/"ranked_counterparty_addresses.csv")
        return dict(threshold=threshold,address_counts=address_counts,coverage=coverage,
                    directions=directions,matched_activity=matched)
    finally:
        for name in ("_threshold_seeds","_threshold_seed_transactions","_threshold_counterparties",
                     "_threshold_counterparty_transactions","_threshold_classified","_threshold_rank_candidates"):
            connection.execute(f"DROP TABLE IF EXISTS {name}")
        connection.execute("DROP VIEW IF EXISTS _threshold_annotated")
        shutil.rmtree(work)


def analyze(data_dir: str | Path, labels_csv: str | Path | None, output_dir: str | Path,
            start: int = DEFAULT_START, end: int = DEFAULT_END,
            memory_limit: str = "8GB", threads: int = 2, window_blocks: int = 5000,
            thresholds: tuple[int,...] = THRESHOLDS, ranking_limit: int = 10000,
            validate: bool = True, require_manifest: bool = True,
            expected_blocks: str | Path | None = None, resume_prepared: bool = False,
            prepare_only: bool = False, address_partitions: int = 64,
            max_temp_directory_size: str = "32GiB") -> dict[str,Any]:
    """Analyze a complete inclusive block range and return small report metadata.

    Address reuse includes coinbase receipts; transaction coverage and event/value
    coverage exclude coinbase. Every range/window must contain its coinbase even
    if it has no other transactions. Label conflicts never create known seeds.
    """
    import duckdb

    if start<0 or end<start or window_blocks<1 or threads<1 or ranking_limit<1 or not 1<=address_partitions<=65535:
        raise ValueError("Invalid range or resource setting")
    if not thresholds or any(value<2 for value in thresholds):
        raise ValueError("Reuse thresholds must be at least 2")
    source = Path(data_dir).resolve()
    output = Path(output_dir).resolve()
    output.mkdir(parents=True,exist_ok=True)
    events_dir = source / "events" if (source / "events").is_dir() else source
    files = list(events_dir.rglob("*.parquet"))
    if not files:
        raise ValueError(f"No event Parquet files in {events_dir}")
    extraction_path = source / "extraction.json"
    verification: dict[str,Any] = dict(complete=False,reason="Explicit unmanifested fixture input")
    saved_binding = None
    if resume_prepared:
        if not (output/"analysis.duckdb").is_file():
            raise ValueError("No existing analysis database to resume")
        probe = duckdb.connect(str(output/"analysis.duckdb"),read_only=True)
        try:
            saved_binding,verification = _load_prepared_binding(probe)
        finally:
            probe.close()
        current_binding = prepared_binding(source,start,end,verification)
        if saved_binding != current_binding:
            raise ValueError("Prepared tables do not match current extraction files/source/range")
        if require_manifest and not verification.get("complete"):
            raise ValueError("Prepared tables lack completed input verification")
        if verification.get("complete"):
            expected_path = Path(expected_blocks).resolve() if expected_blocks else next(
                (candidate for candidate in (source/"expected-blocks.json",source.parent/"expected-blocks.json")
                 if candidate.is_file()),source/"expected-blocks.json")
            if _sha256(expected_path)!=verification["expected_blocks_sha256"]:
                raise ValueError("Expected block manifest changed since prepared input verification")
        _log("Resume verified prepared tables; unchanged file sizes/mtimes and manifest bindings")
    elif require_manifest or extraction_path.exists():
        from address_coverage_verify import verify

        if not extraction_path.is_file():
            raise ValueError(f"Missing extraction manifest: {extraction_path}")
        extraction = json.loads(extraction_path.read_text())
        expected_path = Path(expected_blocks).resolve() if expected_blocks else next(
            (candidate for candidate in (source/"expected-blocks.json",source.parent/"expected-blocks.json")
             if candidate.is_file()),source/"expected-blocks.json")
        _log("Verify complete extraction, block bindings, schemas and Parquet checksums")
        verification = verify(source,expected_path,start,end,extraction["batch_size"])
    temporary = output / "duckdb_tmp"
    temporary.mkdir(exist_ok=True)
    connection = duckdb.connect(str(output / "analysis.duckdb"))
    try:
        connection.execute(f"SET memory_limit={_literal(memory_limit)}")
        connection.execute(f"SET temp_directory={_literal(temporary)}")
        connection.execute(f"SET max_temp_directory_size={_literal(max_temp_directory_size)}")
        connection.execute(f"SET threads={threads}")
        connection.execute("SET preserve_insertion_order=false")
        connection.execute("SET enable_progress_bar=false")
        # Keep every active partition writer open: a cap below the number of
        # buckets repeatedly closes/reopens writers, creating tiny files.
        connection.execute("SET partitioned_write_flush_threshold=524288")
        writer_limit = max(1024,threads*max(address_partitions,(end-start)//1000+1)*2)
        connection.execute(f"SET partitioned_write_max_open_files={writer_limit}")
        labels_path = Path(labels_csv).resolve() if labels_csv else None
        labels_sha256 = _sha256(labels_path) if labels_path else None
        _load_labels(connection,labels_path)
        if not resume_prepared:
            _prepare(connection,str(events_dir / "**" / "*.parquet"),start,end,window_blocks,validate)
        connection.execute(f"""CREATE OR REPLACE MACRO period_of(k) AS
            (((k >> 32)::BIGINT - {start}) // {window_blocks})::INTEGER""")
        periods = _periods(start,end,window_blocks)
        denominators = _denominators(connection,periods)
        if verification.get("complete"):
            global_rows = [row for row in denominators if row["period"]==-1]
            actual = dict(event_count=sum(row["events"] for row in global_rows),
                transaction_count=sum(row["transactions"] for row in global_rows),
                noncoinbase_transaction_count=sum(row["transactions"] for row in global_rows
                                                  if not row["coinbase"]))
            for metric,value in actual.items():
                if value != verification[metric]:
                    raise ValueError(f"Analyzed {metric} does not match verified extraction")
        binding = saved_binding or prepared_binding(source,start,end,verification)
        if not resume_prepared:
            save_prepared_binding(connection,binding,verification)
        _aggregate_addresses(connection,output,binding,address_partitions)
        if prepare_only:
            _log("Prepared transaction roles and bounded address aggregates are complete")
            return dict(prepared=True,binding=binding,input_verification=verification)
        _csv(output / "denominators.csv",denominators)
        evidence_tiers = _known_evidence_tiers(connection,periods,denominators,output)
        _copy(connection,"""SELECT r.*,s.entity_count=1 AS resolved,
            s.entity_count>1 AS conflicting FROM labels_raw r
            JOIN label_resolution s USING(address) ORDER BY r.address,r.entity,r.source""",
            output / "label_evidence.csv")
        total = next((r["transactions"] for r in denominators
                      if r["period"]==-1 and not r["coinbase"]),0)
        curves = _rankings(connection,output,total,ranking_limit)
        analyses = [_threshold(connection,n,periods,denominators,output,address_partitions=address_partitions)
                    for n in thresholds]
        for key,filename in (("coverage","transaction_coverage.csv"),
            ("directions","transaction_directions.csv"),("matched_activity","matched_activity.csv")):
            _csv(output / filename,[row for result in analyses for row in result[key]])
        label_counts = connection.execute("""SELECT count(*),
            count(*) FILTER(WHERE entity_count=1),count(*) FILTER(WHERE entity_count>1)
            FROM label_resolution""").fetchone()
        observed_addresses = connection.execute("SELECT count(*) FROM address_stats").fetchone()[0]
        receiving_addresses = connection.execute("SELECT count(*) FROM address_stats WHERE receiving_transactions>0").fetchone()[0]
        summary = dict(schema_version=1,generated_at=datetime.now(timezone.utc).isoformat(),
            start_height=start,end_height=end,window_blocks=window_blocks,
            data_dir=str(source),input_parquet_files=len(files),
            input_verification=verification,
            source_fingerprint=verification.get("source_fingerprint"),
            expected_blocks_sha256=verification.get("expected_blocks_sha256"),
            labels_csv=str(Path(labels_csv).resolve()) if labels_csv else None,
            labels_csv_sha256=labels_sha256,
            labels=dict(addresses=label_counts[0],resolved=label_counts[1],conflicting=label_counts[2]),
            observed_addresses=observed_addresses,observed_receiving_addresses=receiving_addresses,ranking_csv_limit=ranking_limit,
            known_evidence_tiers=[row for row in evidence_tiers if row["period"]==-1],
            direct_evidence_types=list(DIRECT_EVIDENCE_TYPES),
            denominators=denominators,concentration_checkpoints=[r for r in curves if r["checkpoint"]],
            thresholds=[dict(threshold=r["threshold"],address_counts=r["address_counts"],
                coverage=[v for v in r["coverage"] if v["period"]==-1],
                directions=[v for v in r["directions"] if v["period"]==-1],
                matched_activity=[v for v in r["matched_activity"] if v["period"]==-1]) for r in analyses],
            definitions=dict(reuse="Distinct receiving transactions across the full sample, including coinbase receipts; retrospective.",
                known="Unambiguous published address labels; evidence dates do not prove historical control.",
                counterparty="Opposite-side addresses in a transaction spending from or sending to K union R; exclude seeds; exactly one expansion.",
                transactions="All noncoinbase transactions; each counted once per set or category.",
                matched_activity="Only creation/spend events whose own address matches the named set; coinbase excluded.",
                associated_activity="All events in transactions belonging to a coverage category, including unmatched addresses and nonaddress scripts.",
                value="Integer satoshis, summing absolute input prevout and output amounts; gross activity, not economic transfer volume or brightness.",
                attribution="Counterparty association may include change, batching or CoinJoin and never establishes common ownership."))
        (output / "summary.json").write_text(json.dumps(summary,indent=2)+"\n")
        connection.execute("CHECKPOINT")
        _log(f"Complete: {output / 'summary.json'}")
        return summary
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir",required=True,type=Path)
    parser.add_argument("--labels-csv",type=Path)
    parser.add_argument("--output-dir",required=True,type=Path)
    parser.add_argument("--start",type=int,default=DEFAULT_START)
    parser.add_argument("--end",type=int,default=DEFAULT_END)
    parser.add_argument("--memory-limit",default="8GB")
    parser.add_argument("--threads",type=int,default=2)
    parser.add_argument("--window-blocks",type=int,default=5000)
    parser.add_argument("--ranking-limit",type=int,default=10000)
    parser.add_argument("--resume-prepared",action="store_true",
        help="Reuse source-bound complete transaction/address roles and address partition progress")
    parser.add_argument("--prepare-only",action="store_true",
        help="Stop after transaction/address roles and bounded address statistics are committed")
    parser.add_argument("--address-partitions",type=int,default=64)
    parser.add_argument("--max-temp-directory-size",default="32GiB")
    parser.add_argument("--expected-blocks",type=Path)
    parser.add_argument("--allow-unmanifested-input",dest="require_manifest",action="store_false",
        help="Only for controlled fixtures: allow absent extraction.json and flag results unverified")
    arguments = parser.parse_args()
    analyze(**vars(arguments))


if __name__ == "__main__":
    main()
