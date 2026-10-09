import csv
import hashlib
from functools import partial
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import address_coverage_analyze as coverage

analyze = partial(coverage.analyze, require_manifest=False)


class CoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.data = cls.root / "data" / "events"
        cls.data.mkdir(parents=True)
        cls.events = []

        def transaction(height, index, inputs, outputs, coinbase=False):
            txid = hashlib.sha256(f"{height}:{index}".encode()).digest()
            for direction, items in (("in", inputs), ("out", outputs)):
                for io_index, item in enumerate(items):
                    address, value, creation = item
                    script = (address or "nonaddress").encode()
                    cls.events.append(dict(height=height,tx_index=index,txid=txid,
                        coinbase=coinbase,direction=direction,io_index=io_index,
                        outpoint_txid=txid if direction=="out" else bytes([io_index+1])*32,
                        outpoint_vout=io_index,creation_height=creation,
                        script_id=hashlib.sha256(script).digest(),script=script,
                        address=address,satoshi=value))

        for height in range(100,105):
            transaction(height,0,[],[(f"miner-{height}",50,height)],True)
        # Two outputs to R in a single transaction are one receiving transaction.
        transaction(100,1,[("X",20,90)],[("K",10,100),("R",5,100),("R",3,100)])
        # Repeated inputs and same-block prevouts; R both receives and spends.
        transaction(100,2,[("K",10,100),("R",5,100),("R",3,100)],[("P",10,100),("R",7,100)])
        transaction(101,1,[("A",12,80)],[("R",10,101),("Z0",0,101),(None,1,101)])
        # P is a direct counterparty; Q must not become a recursive counterparty.
        transaction(101,2,[("P",10,100)],[("Q",9,101)])
        transaction(102,1,[("Q",9,101)],[("V",8,102)])
        # Receiving once then spending later is not reuse.
        transaction(102,2,[("U",6,60)],[("W",5,102)])
        transaction(103,1,[("W",5,102)],[("X2",4,103)])
        transaction(103,2,[("D",5,60)],[("B",4,103)])
        transaction(104,1,[("Z",5,30)],[("R",4,104),("R",0,104)])
        transaction(104,2,[("K",5,80)],[("N",4,104)])
        pq.write_table(pa.Table.from_pylist(cls.events),cls.data / "100-104.parquet")
        cls.labels = cls.root / "labels.csv"
        with cls.labels.open("w",newline="") as handle:
            writer = csv.DictWriter(handle,fieldnames=coverage.LABEL_COLUMNS)
            writer.writeheader()
            for address,entity,source in (("K","Exchange","published-proof"),
                ("K","Exchange","second-source"),("B","First","source-a"),
                ("B","Second","source-b"),("absent","Exchange","outside-range")):
                writer.writerow(dict(address=address,entity=entity,source=source,
                    observed_date="2026-09-17",confidence="published",evidence_type="service_disclosure",
                    historical_note="Historical control not established"))
        cls.output = cls.root / "analysis"
        cls.summary = analyze(cls.data.parent,cls.labels,cls.output,
            start=100,end=104,window_blocks=1,memory_limit="512MB",threads=1)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def result(self,threshold=2):
        return next(row for row in self.summary["thresholds"] if row["threshold"]==threshold)

    def test_exclusive_categories_and_single_counterparty_expansion(self):
        counts = {row["category"]:row["transactions"] for row in self.result()["coverage"]}
        self.assertEqual(counts,dict(known_only=1,reused_only=2,both=2,counterparty_only=1,uncovered=4))
        self.assertAlmostEqual(sum(row["transaction_pct"] for row in self.result()["coverage"]),100)
        connection = duckdb.connect(str(self.output / "analysis.duckdb"),read_only=True)
        # Threshold 100 is retained on disk: only known K is a seed, so R is now
        # a counterparty. Q is still excluded despite sharing a transaction with P.
        counterparties = {row[0] for row in connection.execute("SELECT address FROM counterparties").fetchall()}
        self.assertEqual(counterparties,{"X","P","R","N"})
        connection.close()

    def test_reuse_deduplicates_receipts_and_does_not_count_spend_as_reuse(self):
        connection = duckdb.connect(str(self.output / "analysis.duckdb"),read_only=True)
        counts = dict(connection.execute("SELECT address,receiving_transactions FROM address_stats").fetchall())
        self.assertEqual(counts["R"],4)
        self.assertEqual(counts["W"],1)
        self.assertEqual(self.result()["address_counts"]["reused"],1)
        for threshold in (5,10,100):
            self.assertEqual(self.result(threshold)["address_counts"]["reused"],0)
        connection.close()

    def test_known_labels_keep_evidence_and_exclude_conflicts(self):
        self.assertEqual(self.summary["labels"],dict(addresses=3,resolved=2,conflicting=1))
        self.assertEqual(self.result()["address_counts"]["known"],1)
        with (self.output / "label_evidence.csv").open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows),5)
        self.assertTrue(all(row["conflicting"]=="true" for row in rows if row["address"]=="B"))
        with (self.output / "ranked_entities.csv").open(newline="") as handle:
            entities = list(csv.DictReader(handle))
        self.assertEqual(len(entities),1)
        self.assertEqual(int(entities[0]["involved_transactions"]),3)
        self.assertIn("second-source",entities[0]["sources"])

    def test_directions_count_self_transfers_once(self):
        directions = {(row["scope"],row["direction"]):row["transactions"]
                      for row in self.result()["directions"]}
        self.assertEqual(directions[("reused","both_directions")],1)
        self.assertEqual(directions[("reused","sending_to_only")],3)
        self.assertEqual(directions[("reused","spending_from_only")],0)
        self.assertEqual(directions[("known","spending_from_only")],2)
        self.assertEqual(directions[("known","sending_to_only")],1)

    def test_matched_events_are_separate_from_whole_transaction_activity(self):
        known = next(row for row in self.result()["matched_activity"] if row["scope"]=="known")
        self.assertEqual(known["input_events"],2)
        self.assertEqual(known["output_events"],1)
        self.assertEqual(known["gross_satoshi"],25)
        reused = next(row for row in self.result()["matched_activity"] if row["scope"]=="reused")
        self.assertEqual(reused["input_events"],2)
        self.assertEqual(reused["output_events"],6)
        self.assertEqual(reused["gross_satoshi"],37)
        whole = sum(row["associated_input_satoshi"]+row["associated_output_satoshi"]
                    for row in self.result()["coverage"] if row["category"] in ("known_only","both"))
        self.assertGreater(whole,known["gross_satoshi"])
        self.assertGreater(reused["denominator_output_events"],reused["output_events"])

    def test_coinbase_denominators_and_temporal_reconciliation(self):
        global_rows = [row for row in self.summary["denominators"] if row["period"]==-1]
        counts = {row["coinbase"]:row["transactions"] for row in global_rows}
        self.assertEqual(counts,{True:5,False:10})
        with (self.output / "transaction_coverage.csv").open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows),4*6*5)
        for threshold in coverage.THRESHOLDS:
            for period in range(5):
                selected = [row for row in rows if int(row["threshold"])==threshold and int(row["period"])==period]
                self.assertEqual(sum(int(row["transactions"]) for row in selected),2)

    def test_concentration_uses_transaction_unions(self):
        address = [row for row in self.summary["concentration_checkpoints"] if row["kind"]=="reused_address"]
        self.assertEqual([row["transactions"] for row in address],[4,4,4])
        entity = [row for row in self.summary["concentration_checkpoints"] if row["kind"]=="known_entity"]
        self.assertEqual([row["transactions"] for row in entity],[3,3,3])
        self.assertEqual(json.loads((self.output/"summary.json").read_text())["schema_version"],1)

    def test_overlapping_seeds_entities_and_evidence_tiers(self):
        data = self.root / "overlap"
        data.mkdir()
        events = [dict(event) for event in self.events]
        extra = dict(next(event for event in events if event["height"]==100
            and event["tx_index"]==1 and event["direction"]=="out"))
        extra.update(io_index=3,outpoint_vout=3,address="W",satoshi=0,
            script=b"W",script_id=hashlib.sha256(b"W").digest())
        events.append(extra)
        pq.write_table(pa.Table.from_pylist(events),data/"events.parquet")
        with self.labels.open(newline="") as handle:
            labels = list(csv.DictReader(handle))
        for address,entity,evidence in (("R","Exchange","third_party_exact_tag_via_graphsense"),
                                        ("W","Other","service_disclosure")):
            labels.append(dict(address=address,entity=entity,source="published",
                observed_date="2026-09-17",confidence="published",evidence_type=evidence,
                historical_note="Historical control not established"))
        label_path = data / "labels.csv"
        with label_path.open("w",newline="") as handle:
            writer = csv.DictWriter(handle,fieldnames=coverage.LABEL_COLUMNS)
            writer.writeheader();writer.writerows(labels)
        result = analyze(data,label_path,self.root/"overlap-output",
            start=100,end=104,window_blocks=1,memory_limit="512MB",threads=1)
        checkpoints = {(row["kind"],row["top_n"]):row["transactions"]
                       for row in result["concentration_checkpoints"]}
        self.assertEqual(checkpoints[("reused_address",10)],6)  # 4+3-1 shared tx.
        self.assertEqual(checkpoints[("known_entity",5)],7)  # 5+3-1 shared tx.
        known_tiers = {row["tier"]:row["transactions"] for row in result["known_evidence_tiers"]}
        self.assertEqual(known_tiers,dict(direct_service_disclosures=5,all_public_labels=7))
        threshold = result["thresholds"][0]
        self.assertEqual(threshold["address_counts"]["both"],2)
        matched = {row["scope"]:row["gross_satoshi"] for row in threshold["matched_activity"]}
        self.assertEqual(matched["known"],matched["known_or_reused"])

    def test_coinbase_reuse_and_fully_nonaddress_transaction(self):
        data = self.root / "coinbase-reuse"
        data.mkdir()
        events = [dict(event) for event in self.events]
        for event in events:
            if event["coinbase"] and event["height"] in (100,101):
                event.update(address="RepeatedMiner",script=b"RepeatedMiner",
                    script_id=hashlib.sha256(b"RepeatedMiner").digest())
        txid = hashlib.sha256(b"nonaddress-transaction").digest()
        for direction,satoshi in (("in",9),("out",8)):
            events.append(dict(height=104,tx_index=3,txid=txid,coinbase=False,
                direction=direction,io_index=0,outpoint_txid=txid,outpoint_vout=0,
                creation_height=104 if direction=="out" else 90,script_id=bytes(32),
                script=b"nonstandard",address=None,satoshi=satoshi))
        pq.write_table(pa.Table.from_pylist(events),data/"events.parquet")
        result = analyze(data,self.labels,self.root/"coinbase-reuse-output",
            start=100,end=104,window_blocks=1,memory_limit="512MB",threads=1)
        threshold = result["thresholds"][0]
        self.assertEqual(threshold["address_counts"]["reused"],2)
        counts = {row["category"]:row["transactions"] for row in threshold["coverage"]}
        self.assertEqual(counts["uncovered"],5)
        denominator = next(row for row in result["denominators"]
                           if row["period"]==-1 and not row["coinbase"])
        self.assertEqual(denominator["transactions"],11)
        reused = next(row for row in threshold["matched_activity"] if row["scope"]=="reused")
        self.assertEqual(reused["gross_satoshi"],37)  # Miner subsidy excluded.

    def test_coinbase_only_range_has_zero_denominators(self):
        data = self.root / "coinbase-only"
        data.mkdir()
        pq.write_table(pa.Table.from_pylist([event for event in self.events if event["coinbase"]]),
                       data/"events.parquet")
        result = analyze(data,None,self.root/"coinbase-only-output",
            start=100,end=104,window_blocks=1,memory_limit="512MB",threads=1)
        for denominator in result["denominators"]:
            if not denominator["coinbase"]:
                self.assertEqual(denominator["transactions"],0)
        for row in result["thresholds"][0]["coverage"]:
            self.assertEqual(row["transactions"],0)
            self.assertEqual(row["transaction_pct"],0)

    def test_counterparties_deduplicate_across_transaction_buckets(self):
        data = self.root / "cross-bucket-data"
        data.mkdir()
        events = []

        def transaction(height, index, source, destination, coinbase=False):
            txid = hashlib.sha256(f"cross:{height}:{index}".encode()).digest()
            directions = [("out", destination, 9, height)]
            if not coinbase:
                directions.insert(0, ("in", source, 10, height-1))
            for direction, address, value, creation in directions:
                script = address.encode()
                events.append(dict(height=height, tx_index=index, txid=txid,
                    coinbase=coinbase, direction=direction, io_index=0,
                    outpoint_txid=txid if direction=="out" else bytes([1])*32,
                    outpoint_vout=0, creation_height=creation,
                    script_id=hashlib.sha256(script).digest(), script=script,
                    address=address, satoshi=value))

        for height in range(100,2104):
            transaction(height,0,None,f"cross-miner-{height}",True)
        # C is independently discovered in two chronological buckets. Its
        # activity in the third bucket must count once; D remains a second hop.
        for height,source,destination in ((100,"K","C"),(1100,"K","C"),
            (1101,"C","D"),(2100,"C","E"),(2101,"D","Z"),
            (2102,"F","K"),(2103,"F","C")):
            transaction(height,1,source,destination)
        pq.write_table(pa.Table.from_pylist(events),data/"events.parquet")
        output = self.root / "cross-bucket-output"
        result = coverage.analyze(data,self.labels,output,start=100,end=2103,
            window_blocks=1000,thresholds=(100,),memory_limit="512MB",threads=1,
            require_manifest=False)["thresholds"][0]
        self.assertEqual(result["address_counts"],dict(known=1,reused=0,both=0,
            known_or_reused=1,counterparties=2))
        self.assertEqual({row["category"]:row["transactions"] for row in result["coverage"]},
            dict(known_only=3,reused_only=0,both=0,counterparty_only=3,uncovered=1))
        directions = {(row["scope"],row["direction"]):row["transactions"]
                      for row in result["directions"]}
        self.assertEqual(directions[("counterparty","spending_from_only")],3)
        self.assertEqual(directions[("counterparty","sending_to_only")],2)
        self.assertEqual(directions[("counterparty","both_directions")],1)
        matched = next(row for row in result["matched_activity"] if row["scope"]=="counterparty")
        self.assertEqual((matched["input_events"],matched["output_events"],matched["gross_satoshi"]),
                         (4,3,67))
        connection = duckdb.connect(str(output/"analysis.duckdb"),read_only=True)
        try:
            self.assertEqual(connection.execute("SELECT count(*),count(DISTINCT address) FROM counterparties").fetchone(),(2,2))
            self.assertEqual({row[0] for row in connection.execute("SELECT address FROM counterparties").fetchall()},{"C","F"})
            self.assertEqual(connection.execute("SELECT count(*) FROM counterparty_transactions").fetchone()[0],6)
        finally:
            connection.close()
        self.assertFalse((output/"_threshold_work").exists())

    def test_rejects_duplicate_event(self):
        data = self.root / "duplicate"
        data.mkdir()
        pq.write_table(pa.Table.from_pylist(self.events+[self.events[-1]]),data/"events.parquet")
        with self.assertRaisesRegex(ValueError,"Duplicate event"):
            analyze(data,None,self.root/"duplicate-output",start=100,end=104,
                             memory_limit="512MB",threads=1)

    def test_rejects_missing_prevout(self):
        data = self.root / "missing"
        data.mkdir()
        events = [dict(event) for event in self.events]
        next(event for event in events if event["direction"]=="in")["outpoint_txid"] = None
        pq.write_table(pa.Table.from_pylist(events),data/"events.parquet")
        with self.assertRaisesRegex(ValueError,"Invalid or unresolved"):
            analyze(data,None,self.root/"missing-output",start=100,end=104,
                             memory_limit="512MB",threads=1)

    def test_rejects_incomplete_range(self):
        with self.assertRaisesRegex(ValueError,"Expected 6 populated blocks"):
            analyze(self.data,None,self.root/"incomplete-output",start=100,end=105,
                             memory_limit="512MB",threads=1)

    def test_requires_extraction_manifest_by_default(self):
        with self.assertRaisesRegex(ValueError,"Missing extraction manifest"):
            coverage.analyze(self.data,None,self.root/"no-manifest-output",start=100,end=104)

    def test_resume_prepared_skips_roles_and_preserves_results(self):
        target = self.root/"resume-output"
        prepared = analyze(self.data,self.labels,target,start=100,end=104,window_blocks=1,
            memory_limit="512MB",threads=1,address_partitions=4,prepare_only=True)
        self.assertTrue(prepared["prepared"])
        with patch.object(coverage,"_prepare",side_effect=AssertionError("must not rebuild roles")):
            resumed = analyze(self.data,self.labels,target,start=100,end=104,window_blocks=1,
                memory_limit="512MB",threads=1,address_partitions=4,resume_prepared=True)
        self.assertEqual(resumed["thresholds"],self.summary["thresholds"])
        self.assertEqual(resumed["concentration_checkpoints"],self.summary["concentration_checkpoints"])
        self.assertEqual(resumed["known_evidence_tiers"],self.summary["known_evidence_tiers"])
        connection = duckdb.connect(str(target/"analysis.duckdb"),read_only=True)
        self.assertEqual(connection.execute("SELECT count(*) FROM address_stats_progress").fetchone()[0],4)
        self.assertEqual(connection.execute("SELECT count(*) FROM address_stats").fetchone()[0],
                         self.summary["observed_addresses"])
        connection.close()

    def test_resume_rejects_changed_source_identity(self):
        target = self.root/"resume-changed-output"
        data = self.root/"resume-changed-input"
        data.mkdir()
        pq.write_table(pa.Table.from_pylist(self.events),data/"events.parquet")
        analyze(data,self.labels,target,start=100,end=104,window_blocks=1,
            memory_limit="512MB",threads=1,address_partitions=4,prepare_only=True)
        pq.write_table(pa.Table.from_pylist(self.events),data/"events.parquet")
        with self.assertRaisesRegex(ValueError,"do not match current extraction"):
            analyze(data,self.labels,target,start=100,end=104,window_blocks=1,
                memory_limit="512MB",threads=1,address_partitions=4,resume_prepared=True)

    def test_resume_restarts_only_missing_address_partition(self):
        target = self.root/"resume-partition-output"
        prepared = analyze(self.data,self.labels,target,start=100,end=104,window_blocks=1,
            memory_limit="512MB",threads=1,address_partitions=4,prepare_only=True)
        connection = duckdb.connect(str(target/"analysis.duckdb"))
        baseline = connection.execute("SELECT * FROM address_stats ORDER BY address").fetchall()
        connection.execute("DELETE FROM address_stats WHERE address_partition=0")
        connection.execute("DELETE FROM address_stats_progress WHERE address_partition=0")
        coverage._aggregate_addresses(connection,target,prepared["binding"],4)
        self.assertEqual(connection.execute("SELECT * FROM address_stats ORDER BY address").fetchall(),baseline)
        connection.close()

    def test_parallel_partition_copy_does_not_churn_small_files(self):
        data = self.root/"writer-input"
        data.mkdir()
        source = duckdb.connect()
        source.execute(f"""COPY (
            SELECT 100::UINTEGER AS height,i::UINTEGER AS tx_index,
                from_hex(sha256(i::VARCHAR)) AS txid,i=0 AS coinbase,direction,
                0::UINTEGER AS io_index,from_hex(sha256(i::VARCHAR)) AS outpoint_txid,
                0::UINTEGER AS outpoint_vout,
                (CASE WHEN direction='in' THEN 99 ELSE 100 END)::UINTEGER AS creation_height,
                from_hex(sha256(i::VARCHAR||direction)) AS script_id,
                encode('script-'||i::VARCHAR||direction) AS script,
                'bc1q'||substr(sha256(i::VARCHAR||direction),1,38) AS address,
                1::BIGINT AS satoshi
            FROM range(100001) t(i) CROSS JOIN (VALUES('in'),('out')) d(direction)
            WHERE i>0 OR direction='out'
        ) TO '{data/'events.parquet'}' (FORMAT PARQUET)""")
        source.close()
        target = self.root/"writer-output"
        analyze(data,None,target,start=100,end=100,memory_limit="1GB",threads=2,
            address_partitions=64,prepare_only=True)
        files = list((target/"address_role_partitions").rglob("*.parquet"))
        self.assertEqual(len({path.parent for path in files}),64)
        self.assertLessEqual(len(files),128)  # At most one retained writer per partition/thread.
        connection = duckdb.connect(str(target/"analysis.duckdb"),read_only=True)
        self.assertEqual(connection.execute("SELECT sum(input_events+output_events) FROM address_stats").fetchone()[0],200001)
        connection.close()

    def test_address_aggregate_reconciliation_detects_corruption(self):
        target = self.root/"stats-reconciliation-output"
        prepared = analyze(self.data,self.labels,target,start=100,end=104,window_blocks=1,
            memory_limit="512MB",threads=1,address_partitions=4,prepare_only=True)
        connection = duckdb.connect(str(target/"analysis.duckdb"))
        connection.execute("UPDATE address_stats SET input_satoshi=input_satoshi+1 WHERE address='R'")
        with self.assertRaisesRegex(ValueError,"do not reconcile with prepared roles"):
            coverage._aggregate_addresses(connection,target,prepared["binding"],4)
        connection.close()

    def test_verified_manifest_rejects_removed_whole_transaction(self):
        import address_coverage_extract as extract

        data = self.root / "verified"
        (data/"events").mkdir(parents=True)
        (data/"batches").mkdir()
        expected = data/"expected-blocks.json"
        expected.write_text(json.dumps(dict(schema_version=1,blocks=[dict(height=height,
            hash=hashlib.sha256(str(height).encode()).hexdigest()) for height in range(100,105)])))
        hashes,manifest_sha,fingerprint = extract.load_expected(expected,100,104)
        parquet = data/"events"/"100-104.parquet"
        pq.write_table(pa.Table.from_pylist(self.events,schema=extract.EVENT_SCHEMA),parquet)
        blocks = []
        for height in range(100,105):
            events = [event for event in self.events if event["height"]==height]
            blocks.append(dict(height=height,hash=hashes[height],time=height,
                event_count=len(events),transaction_count=len({e["tx_index"] for e in events}),
                noncoinbase_transaction_count=len({e["tx_index"] for e in events if not e["coinbase"]})))
        batch = dict(schema_version=1,source_fingerprint=fingerprint,expected_blocks_sha256=manifest_sha,
            start=100,end=104,blocks=blocks,parquet="events/100-104.parquet",
            sha256=extract.sha256_file(parquet),bytes=parquet.stat().st_size,event_count=len(self.events))
        (data/"batches"/"100-104.json").write_text(json.dumps(batch))
        extract.write_summary(data,100,104,5,manifest_sha,fingerprint,[batch],validated_tip=hashes[104])
        result = coverage.analyze(data,self.labels,self.root/"verified-output",start=100,end=104,
            memory_limit="512MB",threads=1,window_blocks=1)
        self.assertTrue(result["input_verification"]["complete"])
        self.assertEqual(result["source_fingerprint"],fingerprint)
        self.assertEqual(result["labels_csv_sha256"],extract.sha256_file(self.labels))
        dropped = [event for event in self.events if not (event["height"]==100 and event["tx_index"]==1)]
        pq.write_table(pa.Table.from_pylist(dropped,schema=extract.EVENT_SCHEMA),parquet)
        with self.assertRaisesRegex(extract.ExtractionError,"checksum mismatch"):
            coverage.analyze(data,self.labels,self.root/"corrupt-output",start=100,end=104,
                             memory_limit="512MB",threads=1)


if __name__ == "__main__":
    unittest.main()
