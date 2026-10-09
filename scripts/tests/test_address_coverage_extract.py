import copy
from decimal import Decimal
import hashlib
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import address_coverage_extract as ex


def txid(n):
    return f"{n:064x}"


def script(address="address-A", hexvalue="0014" + "11" * 20):
    result = {"hex": hexvalue}
    if address is not None:
        result["address"] = address
    return result


def output(n, value="0.10000001", address="address-A", hexvalue="0014" + "11" * 20):
    return {"n": n, "value": Decimal(value), "scriptPubKey": script(address, hexvalue)}


def block(height=100):
    return {"height": height, "hash": txid(height), "previousblockhash": txid(height - 1),
        "confirmations": 10, "time": 1_750_000_000 + height, "nTx": 3,
        "tx": [
            {"txid": txid(height * 100), "vin": [{"coinbase": "01"}], "vout": [output(0, "3.125")]},
            {"txid": txid(height * 100 + 1), "vin": [
                {"txid": txid(17), "vout": 3, "prevout": {"height": 8, "value": Decimal("0.20000002"),
                    "scriptPubKey": script()}}],
                "vout": [output(0), output(1, "0", None, "6a01ff")]},
            {"txid": txid(height * 100 + 2), "vin": [
                {"txid": txid(height * 100 + 1), "vout": 0, "prevout": {"height": height,
                    "value": Decimal("0.10000001"), "scriptPubKey": script()}}],
                "vout": [output(0, "0.1", "address-B", "0014" + "22" * 20)]},
        ]}


class FakeRpc:
    def __init__(self, blocks):
        self.blocks = blocks
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "getblock":
            return copy.deepcopy(self.blocks[int(params[0], 16)])
        if method == "getblockhash":
            return self.blocks[params[0]]["hash"]
        raise AssertionError(method)


class EventTests(unittest.TestCase):
    def test_exact_amounts_and_rejection(self):
        self.assertEqual(ex.satoshi(Decimal("0.10000001")), 10_000_001)
        self.assertEqual(ex.satoshi(Decimal("1E-8")), 1)
        self.assertEqual(ex.satoshi(0), 0)
        for value in (0.1, True, Decimal("0.000000001"), Decimal("-1"), Decimal("NaN")):
            with self.subTest(value=value), self.assertRaises(ex.ExtractionError):
                ex.satoshi(value)

    def test_full_events_pre_sample_prevout_same_block_and_zero(self):
        events, stats = ex.block_events(block(), 100, txid(100), txid(99))
        self.assertEqual(len(events), 6)
        self.assertEqual(stats["noncoinbase_transaction_count"], 2)
        self.assertEqual(stats["coinbase_transaction_count"], 1)
        self.assertEqual(stats["input_satoshi"], 30_000_003)
        self.assertEqual(stats["output_satoshi"], 332_500_001)
        self.assertEqual(events[1]["creation_height"], 8)
        self.assertEqual(events[4]["creation_height"], 100)
        self.assertEqual(events[4]["outpoint_txid"], events[2]["txid"])
        self.assertEqual(events[3]["satoshi"], 0)
        self.assertIsNone(events[3]["address"])
        self.assertEqual(events[0]["txid"], bytes.fromhex(txid(10_000)))
        self.assertEqual(len(events[0]["txid"]), 32)
        self.assertEqual(events[0]["script_id"], hashlib.sha256(events[0]["script"]).digest())
        self.assertTrue(events[0]["coinbase"])
        self.assertTrue(all(not row["coinbase"] for row in events[1:]))

    def test_missing_prevout_never_skipped(self):
        for key in ("height", "value", "scriptPubKey"):
            fixture = block()
            del fixture["tx"][1]["vin"][0]["prevout"][key]
            with self.subTest(key=key), self.assertRaisesRegex(ex.ExtractionError, "missing complete prevout"):
                ex.block_events(fixture, 100, txid(100))


class RpcTests(unittest.TestCase):
    def test_rpc_json_decimals_stay_exact_and_cookie_is_not_in_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            cookie = Path(temporary) / "cookie"
            cookie.write_text("user:fixture-secret")
            with patch.object(ex.urllib.request, "urlopen") as opener:
                opener.return_value.__enter__.return_value.read.return_value = b'{"result":{"value":0.10000001},"error":null}'
                result = ex.Rpc("http://127.0.0.1:8332", cookie).call("getblock", [txid(100), 3])
                self.assertEqual(result["value"], Decimal("0.10000001"))
                self.assertNotIn(b"fixture-secret", opener.call_args.args[0].data)

    def test_rpc_failure_does_not_expose_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            cookie = Path(temporary) / "cookie"
            cookie.write_text("user:fixture-secret")
            with patch.object(ex.urllib.request, "urlopen") as opener:
                opener.return_value.__enter__.return_value.read.return_value = b'{"result":null,"error":{"code":-5,"message":"sensitive payload"}}'
                with self.assertRaises(ex.ExtractionError) as caught:
                    ex.Rpc("http://127.0.0.1:8332", cookie).call("getblock", [])
                self.assertIn("-5", str(caught.exception))
                self.assertNotIn("sensitive", str(caught.exception))

    def test_credentials_are_not_accepted_in_url(self):
        with self.assertRaises(ex.ExtractionError):
            ex.Rpc("http://user:secret@127.0.0.1:8332", Path("cookie"))

    def test_wrong_or_stale_block(self):
        for field, value in (("hash", txid(101)), ("height", 101), ("confirmations", -1), ("previousblockhash", txid(98))):
            fixture = block()
            fixture[field] = value
            with self.subTest(field=field), self.assertRaises(ex.ExtractionError):
                ex.block_events(fixture, 100, txid(100), txid(99))

    def test_invalid_event_data_rejected(self):
        fixtures = []
        fixture = block(); fixture["tx"][1]["vin"][0]["prevout"]["height"] = 101; fixtures.append(fixture)
        fixture = block(); fixture["tx"][1]["vout"][0]["n"] = 7; fixtures.append(fixture)
        fixture = block(); fixture["tx"][1]["vout"][0]["scriptPubKey"]["hex"] = "zz"; fixtures.append(fixture)
        fixture = block(); fixture["tx"][1]["txid"] = "abcd"; fixtures.append(fixture)
        fixture = block(); fixture["nTx"] = 4; fixtures.append(fixture)
        for fixture in fixtures:
            with self.subTest(fixture=fixture), self.assertRaises(ex.ExtractionError):
                ex.block_events(fixture, 100, txid(100))


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.expected = {100: txid(100), 101: txid(101)}
        self.manifest = self.root / "expected.json"
        self.manifest.write_text(json.dumps({"schema_version": 1, "start": 100, "end": 101,
            "blocks": [{"height": h, "hash": value} for h, value in self.expected.items()]}))
        self.expected, self.manifest_sha, self.fingerprint = ex.load_expected(self.manifest, 100, 101)
        self.output = self.root / "output"
        self.rpc = FakeRpc({100: block(100), 101: block(101)})

    def test_atomic_parquet_and_validated_resume(self):
        metadata = ex.extract_batch(self.rpc, self.output, 100, 101, self.expected, self.fingerprint, self.manifest_sha)
        self.assertEqual(metadata["event_count"], 12)
        table = ex.pq.read_table(self.output / metadata["parquet"])
        self.assertEqual(table.num_rows, 12)
        self.assertTrue(table.schema.equals(ex.EVENT_SCHEMA, check_metadata=False))
        self.assertEqual(ex.validate_existing(self.output, 100, 101, self.expected, self.fingerprint), metadata)
        self.assertEqual(list(self.output.rglob("*.tmp")), [])
        ex.write_summary(self.output, 100, 101, 100, self.manifest_sha, self.fingerprint, [metadata])
        self.assertFalse(json.loads((self.output / "extraction.json").read_text())["complete"])
        ex.write_summary(self.output, 100, 101, 100, self.manifest_sha, self.fingerprint, [metadata], validated_tip=txid(101))
        summary = json.loads((self.output / "extraction.json").read_text())
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["noncoinbase_transaction_count"], 4)
        self.assertEqual(summary["active_chain_tip_validation"]["hash"], txid(101))

    def test_failed_batch_has_no_committed_part(self):
        del self.rpc.blocks[101]["tx"][1]["vin"][0]["prevout"]
        with self.assertRaises(ex.ExtractionError):
            ex.extract_batch(self.rpc, self.output, 100, 101, self.expected, self.fingerprint, self.manifest_sha)
        self.assertFalse((self.output / "events/100-101.parquet").exists())
        self.assertFalse((self.output / "batches/100-101.json").exists())
        self.assertEqual(list(self.output.rglob("*.tmp")), [])

    def test_corruption_or_other_source_refuses_resume(self):
        metadata = ex.extract_batch(self.rpc, self.output, 100, 101, self.expected, self.fingerprint, self.manifest_sha)
        with self.assertRaisesRegex(ex.ExtractionError, "fingerprint"):
            ex.validate_existing(self.output, 100, 101, self.expected, "other")
        path = self.output / metadata["parquet"]
        with path.open("ab") as stream:
            stream.write(b"corruption")
        with self.assertRaisesRegex(ex.ExtractionError, "checksum"):
            ex.validate_existing(self.output, 100, 101, self.expected, self.fingerprint)

    def test_missing_part_refuses_resume_but_orphan_part_can_retry(self):
        metadata = ex.extract_batch(self.rpc, self.output, 100, 101, self.expected, self.fingerprint, self.manifest_sha)
        (self.output / metadata["parquet"]).unlink()
        with self.assertRaises(ex.ExtractionError):
            ex.validate_existing(self.output, 100, 101, self.expected, self.fingerprint)
        (self.output / "batches/100-101.json").unlink()
        self.assertIsNone(ex.validate_existing(self.output, 100, 101, self.expected, self.fingerprint))

    def test_manifest_incomplete_or_duplicate_rejected(self):
        self.manifest.write_text(json.dumps({"schema_version": 1, "blocks": [{"height": 100, "hash": txid(100)}]}))
        with self.assertRaisesRegex(ex.ExtractionError, "complete requested range"):
            ex.load_expected(self.manifest, 100, 101)
        self.manifest.write_text(json.dumps({"schema_version": 1, "blocks": [{"height": 100, "hash": txid(100)}] * 2}))
        with self.assertRaisesRegex(ex.ExtractionError, "duplicate"):
            ex.load_expected(self.manifest, 100, 100)

    def test_limit_and_idempotent_resume_cli(self):
        args = ["--rpc-url", "http://127.0.0.1:8332", "--cookie-file", str(self.root / "cookie"),
            "--expected-blocks", str(self.manifest), "--output", str(self.output), "--start", "100", "--end", "101",
            "--batch-size", "1", "--workers", "2", "--limit-batches", "1"]
        with patch.object(ex, "Rpc", return_value=self.rpc), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(ex.main(args), 0)
            self.assertFalse(json.loads((self.output / "extraction.json").read_text())["complete"])
            self.assertEqual(ex.main(args), 0)
            self.assertTrue(json.loads((self.output / "extraction.json").read_text())["complete"])
            before = len([call for call in self.rpc.calls if call[0] == "getblock"])
            self.assertEqual(ex.main(args), 0)
            after = len([call for call in self.rpc.calls if call[0] == "getblock"])
            self.assertEqual(before, after)

    def test_preflight_writes_nothing(self):
        args = ["--rpc-url", "http://127.0.0.1:8332", "--cookie-file", str(self.root / "cookie"),
            "--expected-blocks", str(self.manifest), "--output", str(self.output), "--start", "100", "--end", "101", "--preflight"]
        with patch.object(ex, "Rpc", return_value=self.rpc), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(ex.main(args), 0)
        self.assertFalse(self.output.exists())

    def test_spawn_process_executor_writes_resumable_batches(self):
        fixture_rpc = self.rpc

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                result = fixture_rpc.call(request["method"], request["params"])
                response = json.dumps({"result": result, "error": None}, default=float).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        service = threading.Thread(target=server.serve_forever, daemon=True)
        service.start()
        cookie = self.root / "cookie"
        cookie.write_text("fixture:secret")
        args = ["--rpc-url", f"http://127.0.0.1:{server.server_address[1]}", "--cookie-file", str(cookie),
            "--expected-blocks", str(self.manifest), "--output", str(self.output), "--start", "100", "--end", "101",
            "--batch-size", "1", "--workers", "2", "--executor", "process"]
        try:
            with patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(ex.main(args), 0)
                summary = json.loads((self.output / "extraction.json").read_text())
                self.assertTrue(summary["complete"])
                self.assertEqual(summary["event_count"], 12)
                for height in (100, 101):
                    metadata = ex.validate_existing(self.output, height, height, self.expected, self.fingerprint)
                    self.assertEqual(metadata["event_count"], 6)
                before = len([call for call in fixture_rpc.calls if call[0] == "getblock"])
                # The same parts resume with the default thread executor.
                self.assertEqual(ex.main(args[:-2]), 0)
                after = len([call for call in fixture_rpc.calls if call[0] == "getblock"])
                self.assertEqual(before, after)
        finally:
            server.shutdown()
            server.server_close()
            service.join()


if __name__ == "__main__":
    unittest.main()
