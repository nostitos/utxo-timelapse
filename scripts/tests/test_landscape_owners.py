#!/usr/bin/env python3
import csv
import gzip
import hashlib
import itertools
import json
import math
import re
import struct
import sys
import tempfile
import threading
import unittest
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import address_coverage_labels as labels  # noqa: E402
import landscape_owners as owners  # noqa: E402

# Block 170: the first person-to-person payment (legacy, two P2PK outputs).
LEGACY = ("0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402"
          "204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4"
          "acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b"
          "13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1ba"
          "ded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482e"
          "cad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000")
# Block 974,244: a P2WPKH spend paying Binance's bc1qm34l... hot wallet.
SEGWIT = ("02000000000101902c57207cc003bdeb210ed4c8815990dd4715dbf98fcfdecb49a35c79eee4180100000000ffffff"
          "ff012b18000000000000160014dc6bf86354105de2fcd9868a2b0376d6731cb92f0247304402203a88a42d24af2078"
          "23716ee80617f7f5bb4038ca740388a144788c8bf5feb51802200fc6e5f28634b83e1870b72fa5957ba8306ca8fdc9"
          "d0375692c1a2aef4641bbf0121020e92a4445a14272553ed00a5f1dcac7b1e3f2898ee798a7500eb12f06915116900"
          "000000")
GOLDEN = ("4255564f574e3100010000000300000064050100000080e497d01200c801c01f80809dd085bedd0301")
A = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"
B = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
OTHER = b"\x51"
MIN_COLOUR_GAP = 11.9  # CIELAB distance between any two entity colours; 177 colours cannot all be far apart


def cielab(rgb):
    """CIE L*a*b* (D65) of an sRGB colour, where distance follows perceived difference."""
    def linear(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = map(linear, rgb)
    x, y, z = ((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b,
               (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116  # noqa: E731
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def tx(inputs, outputs, tag=0):
    """A serialized legacy transaction; the locktime tag keeps equal transactions distinct."""
    raw = struct.pack("<I", 1) + bytes([len(inputs)])
    for prev, vout in inputs:
        raw += bytes.fromhex(prev)[::-1] + struct.pack("<I", vout) + b"\x00\xff\xff\xff\xff"
    raw += bytes([len(outputs)])
    for sats, script in outputs:
        raw += struct.pack("<Q", sats) + bytes([len(script)]) + script
    return raw + struct.pack("<I", tag)


def decode(data):
    """Independent reader of an owner record file: [(created, life, sats, entity)]."""
    assert data[:8] == b"BUVOWN1\0"
    version, count = struct.unpack("<II", data[8:16])
    assert version == 1
    pos, previous, records = 16, 0, []

    def read():
        nonlocal pos
        value = shift = 0
        while True:
            byte = data[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if byte < 0x80:
                return value
    for _ in range(count):
        created = previous + read()
        records.append((created, read(), read(), read()))
        previous = created
    assert pos == len(data)
    return records


def chain():
    """Synthetic transactions -> {txid: (height, raw)} and the txids by name."""
    a, b = labels.address_script(A), labels.address_script(B)
    raws = {}
    raws["P"] = (100, tx([("11" * 32, 0)], [(5000, a), (1, OTHER), (0, a)]))
    raws["V"] = (120, tx([("22" * 32, 0)], [(900, b)]))
    P = owners.parse_tx(raws["P"][1])[0]
    raws["S"] = (150, tx([(P, 0)], [(4000, b)]))         # spends A's output, pays B
    raws["Q"] = (200, tx([("33" * 32, 0)], [(700, a)]))
    Q = owners.parse_tx(raws["Q"][1])[0]
    raws["R"] = (200, tx([(Q, 0)], [(650, OTHER)]))      # spent in the block that created it
    S = owners.parse_tx(raws["S"][1])[0]
    raws["U"] = (300, tx([(S, 0)], [(3900, OTHER)]))     # after the tip
    ids = {name: owners.parse_tx(raw)[0] for name, (_, raw) in raws.items()}
    return {ids[name]: value for name, value in raws.items()}, ids


class FakeChain:
    """Fulcrum and Bitcoin Core REST over synthetic transactions."""
    HEADER = bytes(range(80))

    def __init__(self, txs, tip):
        self.txs, self.tip_height, self.rest_calls, self.extra = txs, tip, 0, []
        self.lock = threading.Lock()
        self.history, self.outputs, self.spent = defaultdict(list), {}, {}
        for txid, (height, raw) in sorted(txs.items(), key=lambda item: item[1][0]):
            _, inputs, outs = owners.parse_tx(raw)
            for prev, vout in inputs:
                if (prev, vout) in self.outputs:
                    self.spent[(prev, vout)] = height
                    self.history[owners.scripthash(self.outputs[(prev, vout)][1])].append((height, txid))
            for vout, (sats, script) in enumerate(outs):
                self.outputs[(txid, vout)] = (height, script, sats)
                if (height, txid) not in self.history[owners.scripthash(script)]:
                    self.history[owners.scripthash(script)].append((height, txid))

    def tip(self):
        return self.tip_height, hashlib.sha256(hashlib.sha256(self.HEADER).digest()).digest()[::-1].hex()

    def call(self, method, *params):
        return self.request(method, *params)

    def request(self, method, *params):
        if method == "blockchain.scripthash.get_first_use":
            items = self.history.get(params[0])
            return dict(height=min(items)[0]) if items else None
        if method == "blockchain.scripthash.get_history":
            sh, lo, hi = params if len(params) == 3 else (*params, 0, 10 ** 9)
            return [dict(height=h, tx_hash=t) for h, t in sorted(self.history[sh]) if lo <= h < hi]
        if method == "blockchain.scripthash.listunspent":
            utxos = [dict(tx_hash=t, tx_pos=n, height=h, value=sats)
                     for (t, n), (h, script, sats) in self.outputs.items()
                     if owners.scripthash(script) == params[0] and h <= self.tip_height
                     and self.spent.get((t, n), self.tip_height + 1) > self.tip_height]
            return utxos + [item for item in self.extra if item[0] == params[0] for item in [item[1]]]
        if method == "blockchain.scripthash.get_mempool":
            return []
        if method == "blockchain.block.header":
            return self.HEADER.hex()
        raise AssertionError(method)

    def get(self, path, missing_ok=False):
        if path.startswith("/rest/blockhashbyheight/"):
            return b"cd" * 32 + b"\n"
        with self.lock:
            self.rest_calls += 1
        return self.txs[path.split("/")[-1].split(".")[0]][1]


def write_labels(path, rows):
    labels.write_csv(path, [dict(address=address, entity=entity, source="https://example.com/list",
                                 observed_date=date, confidence="publicly_reported", evidence_type=kind,
                                 historical_note="note") for address, entity, kind, date in rows])


class TransactionTests(unittest.TestCase):
    def test_real_legacy_transaction(self):
        txid, inputs, outputs = owners.parse_tx(bytes.fromhex(LEGACY))
        self.assertEqual(txid, "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16")
        self.assertEqual(inputs, [("0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9", 0)])
        self.assertEqual([sats for sats, _ in outputs], [1_000_000_000, 4_000_000_000])
        self.assertEqual([script.hex() for _, script in outputs], [
            "4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1"
            "b7303b8a0626f1baded5c72a704f7e6cd84cac",
            "410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e16"
            "0bfa9b8b64f9d4c03f999b8643f656b412a3ac"])

    def test_real_segwit_transaction(self):
        txid, inputs, outputs = owners.parse_tx(bytes.fromhex(SEGWIT))
        self.assertEqual(txid, "bd07e7eddd157a3b0ff5630d8caa780f7bd55ed9a411a098c76b6269e7cdfd04")
        self.assertEqual(inputs, [("18e4ee795ca349cbdecf8ff9db1547dd905981c8d40e21ebbd03c07c20572c90", 1)])
        self.assertEqual(outputs, [(6187, labels.address_script("bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"))])
        with self.assertRaises(ValueError):
            owners.parse_tx(bytes.fromhex(SEGWIT)[:-1])

    def test_cache_entry_keeps_only_listed_outputs_and_history_inputs(self):
        raw = bytes.fromhex(SEGWIT)
        script = labels.address_script("bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h")
        txid = owners.parse_tx(raw)[0]
        entry = owners.cache_entry(txid, 974244, raw, {script: 3}, {})
        self.assertEqual((entry["o"], entry["i"], entry["g"]), ([[0, 6187, 3]], [], 1))
        prev = "18e4ee795ca349cbdecf8ff9db1547dd905981c8d40e21ebbd03c07c20572c90"
        self.assertEqual(owners.cache_entry(txid, 974244, raw, {}, {prev: 1})["i"], [[prev, 1]])
        with self.assertRaisesRegex(ValueError, "REST returned"):
            owners.cache_entry("00" * 32, 1, raw, {}, {})


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.txs, self.ids = chain()
        a, b = labels.address_script(A), labels.address_script(B)
        self.scripts_list = [dict(address=A, script=a.hex()), dict(address=B, script=b.hex())]
        self.selected = {A: dict(entity="one"), B: dict(entity="two")}
        fake = FakeChain(self.txs, 250)
        self.history = {A: sorted(fake.history[owners.scripthash(a)]), B: sorted(fake.history[owners.scripthash(b)])}
        height_of = {txid: height for txid, (height, _) in self.txs.items()}
        self.cache = {}
        for txid, (height, raw) in self.txs.items():
            entry = owners.cache_entry(txid, height, raw, {a: 0, b: 1}, height_of)
            self.cache[txid] = owners.compact(entry)

    def test_records_from_synthetic_histories(self):
        records, problems = owners.build_records(self.history, self.cache, self.scripts_list, self.selected, 250)
        self.assertEqual(problems, [])
        i = self.ids
        self.assertEqual(sorted(records), sorted([
            (i["P"], 0, A, "one", 100, 150, 5000),   # spent by a transaction that also pays B
            (i["P"], 2, A, "one", 100, None, 0),     # zero-sat output is kept until the build
            (i["V"], 0, B, "two", 120, None, 900),   # unspent
            (i["S"], 0, B, "two", 150, None, 4000),  # spent after the tip, so unspent at it
            (i["Q"], 0, A, "one", 200, 200, 700),    # spent in its creation block
        ]))

    def test_spend_missing_from_the_spent_address_history_is_a_problem(self):
        self.history[A] = [item for item in self.history[A] if item[1] != self.ids["S"]]
        _, problems = owners.build_records(self.history, self.cache, self.scripts_list, self.selected, 250)
        self.assertTrue(any("missing from its history" in problem for problem in problems))

    def test_unfetched_transaction_is_a_problem(self):
        del self.cache[self.ids["V"]]
        _, problems = owners.build_records(self.history, self.cache, self.scripts_list, self.selected, 250)
        self.assertEqual(problems, [f"{self.ids['V']} was never fetched"])


class FakeFulcrum:
    def __init__(self, heights, limit):
        self.items = [dict(height=h, tx_hash=f"{n:064x}") for n, h in enumerate(heights)]
        self.limit, self.calls = limit, []

    def request(self, method, sh, lo, hi):
        page = [item for item in self.items if lo <= item["height"] < hi]
        ok = len(page) <= self.limit
        self.calls.append((lo, hi, len(page), ok))
        if not ok:  # a big page drops the connection; a medium one gets an error reply
            raise ConnectionError("closed") if len(page) > 2 * self.limit else owners.FulcrumError("too large")
        return page + [dict(height=0, tx_hash="ff" * 32)]  # mempool entries are ignored


class PagingTests(unittest.TestCase):
    def test_adaptive_pages_cover_the_range_once_and_shrink_on_buffer_errors(self):
        heights = list(range(1, 50_000, 997)) + [50_000 + n // 20 for n in range(10_000)] + list(range(51_000, 120_000, 991))
        fake = FakeFulcrum(heights, limit=300)
        pages = []
        with mock.patch.object(owners, "PAGE_ITEMS", 100), mock.patch.object(owners, "MAX_SPAN", 4000), \
                mock.patch.object(owners.time, "sleep"), mock.patch.object(owners, "log"):
            owners.fetch_history(fake, "sh", 0, 120_000, lambda hi, page: pages.append(page))
        got = [item for page in pages for item in page]
        self.assertEqual(got, [(item["height"], item["tx_hash"]) for item in fake.items])
        done = [(lo, hi, count) for lo, hi, count, ok in fake.calls if ok]
        self.assertEqual([lo for lo, _, _ in done], [0] + [hi for _, hi, _ in done[:-1]])
        self.assertEqual(done[-1][1], 120_000)
        self.assertTrue(all(count <= 300 for _, _, count in done))
        self.assertTrue(any(not ok for *_, ok in fake.calls))
        spans = [hi - lo for lo, hi, _ in done]
        self.assertTrue(any(later == 2 * earlier for earlier, later in itertools.pairwise(spans)))
        self.assertTrue(all(hi - lo <= 4000 for lo, hi, _, _ in fake.calls))

    def test_a_single_block_that_never_fits_fails(self):
        fake = FakeFulcrum([5] * 50, limit=10)
        with mock.patch.object(owners.time, "sleep"), mock.patch.object(owners, "log"), \
                self.assertRaisesRegex(RuntimeError, "keeps failing"):
            owners.fetch_history(fake, "sh", 0, 100, lambda hi, page: None)


class Recorder:
    """A client that records calls and can refuse whole-history requests, as Fulcrum does for big ones."""

    def __init__(self, inner, refuse=False):
        self.inner, self.refuse, self.calls = inner, refuse, []

    def request(self, method, *params):
        self.calls.append((method.rsplit(".", 1)[1], len(params)))
        if self.refuse and method.endswith("get_history") and len(params) == 1:
            raise owners.FulcrumError("history too large")
        return self.inner.request(method, *params)

    call = request


class HistoryTests(unittest.TestCase):
    def test_an_uncached_history_takes_one_request_and_falls_back_to_pages(self):
        txs, _ = chain()
        fake = FakeChain(txs, 250)
        sh = owners.scripthash(labels.address_script(A))
        expected = sorted(item for item in fake.history[sh] if item[0] <= 250)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(owners, "log"):
            whole, paged = Path(tmp) / "whole", Path(tmp) / "paged"
            whole.mkdir()
            paged.mkdir()
            client = Recorder(fake)
            self.assertEqual(owners.update_history(client, whole, A, sh, 251), (expected, 100))
            self.assertEqual(client.calls, [("get_history", 1)])
            self.assertEqual(json.loads((whole / f"{sh}.json").read_text())["through"], 251)
            client.calls.clear()
            self.assertEqual(owners.update_history(client, whole, A, sh, 260)[0], expected)
            self.assertEqual(client.calls, [("get_history", 3)])  # the cache is extended by range
            refused = Recorder(fake, refuse=True)
            self.assertEqual(owners.update_history(refused, paged, A, sh, 251), (expected, 100))
            self.assertEqual(refused.calls[:2], [("get_history", 1), ("get_first_use", 1)])
            self.assertTrue(all(call == ("get_history", 3) for call in refused.calls[2:]))
            self.assertEqual((paged / f"{sh}.tsv").read_text(), (whole / f"{sh}.tsv").read_text())


class PreflightTests(unittest.TestCase):
    def test_preflight_caches_new_histories_without_touching_scripts_or_transactions(self):
        txs, ids = chain()
        fake = FakeChain(txs, 250)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(dict(entities=[
                dict(id="one", name="One", color="#F0B90B", catalogEntity="One", evidenceTypes=["service_disclosure"]),
                dict(id="two", name="Two", color="#00AAFF", catalogEntity="Two", evidenceTypes=["service_disclosure"])])))
            write_labels(root / "labels.csv", [(A, "One", "service_disclosure", "2024-01-01"),
                                               (B, "Two", "service_disclosure", "2024-02-01")])
            work = root / "owners" / "extract"
            work.mkdir(parents=True)
            known = [dict(address=A, script=labels.address_script(A).hex())]
            (work / "scripts.json").write_text(json.dumps(known))
            cached = json.dumps(dict(t=ids["V"], h=120, g=1, o=[], i=[]), separators=(",", ":")) + "\n"
            (work / "txs.jsonl").write_text(cached)
            args = SimpleNamespace(spec=spec_path, labels=root / "labels.csv", fulcrum="fake:1", work=work,
                                   out=root / "preflight.json", fulcrum_connections=2)
            with mock.patch.object(owners, "running_jobs", lambda folder: ["extract.pid (1)"]), \
                    self.assertRaisesRegex(SystemExit, "running"):
                owners.preflight(args)
            with mock.patch.object(owners, "running_jobs", lambda folder: []), \
                    mock.patch.object(owners, "Fulcrum", lambda address: fake), mock.patch.object(owners, "log"):
                self.assertEqual(owners.preflight(args), 0)
            result = json.loads(args.out.read_text())
            self.assertEqual((result["totals"]["new"], result["totals"]["cached"], result["totals"]["historyItems"]), (1, 1, 2))
            self.assertEqual((result["totals"]["transactions"], result["totals"]["transactionsInCache"]), (2, 1))
            self.assertEqual((result["entities"]["two"]["calls"], result["entities"]["one"]["new"]), (1, 0))
            sh = owners.scripthash(labels.address_script(B))
            self.assertEqual(len((work / "history" / f"{sh}.tsv").read_text().splitlines()), 2)
            self.assertEqual((json.loads((work / "scripts.json").read_text()), (work / "txs.jsonl").read_text()), (known, cached))


class ExtractTests(unittest.TestCase):
    def run_extract(self, fake, work, label_path, spec_path):
        args = SimpleNamespace(spec=spec_path, labels=label_path, fulcrum="fake:1", rest="http://fake",
                               work=work, concurrency=4, fulcrum_connections=2)
        with mock.patch.object(owners, "Fulcrum", lambda address: fake), \
                mock.patch.object(owners, "Rest", lambda base: fake), mock.patch.object(owners, "log"):
            return owners.extract(args)

    def test_extract_verifies_resumes_and_fails_on_listunspent_mismatch(self):
        txs, ids = chain()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(dict(entities=[
                dict(id="one", name="One", color="#F0B90B", catalogEntity="One", evidenceTypes=["service_disclosure"]),
                dict(id="two", name="Two", color="#00AAFF", catalogEntity="Two", evidenceTypes=["service_disclosure"])])))
            write_labels(root / "labels.csv", [(A, "One", "service_disclosure", "2024-01-01"),
                                               (B, "Two", "service_disclosure", "2024-02-01"),
                                               (B, "Two", "third_party_exact_tag_via_graphsense", "2021-01-01")])
            fake = FakeChain(txs, 250)
            work = root / "work"
            self.assertEqual(self.run_extract(fake, work, root / "labels.csv", spec_path), 0)
            with gzip.open(work / "records.csv.gz", "rt", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(len(rows), 5)
            self.assertEqual({(row["txid"], row["vout"], row["spent"]) for row in rows if row["txid"] == ids["S"]},
                             {(ids["S"], "0", "")})
            info = json.loads((work / "extract.json").read_text())
            self.assertTrue(info["totals"]["verified"])
            self.assertEqual(info["fulcrumTip"], 250)
            self.assertEqual([item["evidence"] for item in info["addresses"] if item["address"] == B],
                             [[dict(type="service_disclosure", source="https://example.com/list", observed="2024-02-01")]])
            fetched = fake.rest_calls
            self.assertEqual(fetched, 5)  # every history transaction at or below the tip, once

            fake.extra.append((owners.scripthash(labels.address_script(A)),
                               dict(tx_hash="ee" * 32, tx_pos=0, height=240, value=1)))
            self.assertEqual(self.run_extract(fake, work, root / "labels.csv", spec_path), 1)
            self.assertEqual(fake.rest_calls, fetched)  # the rerun fetched nothing new
            failure = json.loads((work / "verify-failures.json").read_text())
            self.assertEqual(failure["mismatches"][0]["listunspentNotInRecords"], ["ee" * 32 + ":0"])
            fake.extra.clear()
            original = fake.request
            fake.request = lambda method, *params: (  # the tip's block was replaced during the run
                bytes(80).hex() if method == "blockchain.block.header" else original(method, *params))
            self.assertEqual(self.run_extract(fake, work, root / "labels.csv", spec_path), 1)
            fake.request = original

            out = root / "datasets"
            with mock.patch.object(owners, "Rest", lambda base: fake), mock.patch.object(owners, "log"):
                self.assertEqual(owners.main(["build", "--work", str(work), "--tip", "250", "--rest", "http://fake",
                                              "--out-root", str(out), "--id", "o250-20261102"]), 0)
                with self.assertRaises(SystemExit):
                    owners.main(["build", "--work", str(work), "--tip", "250", "--rest", "http://fake",
                                 "--out-root", str(out), "--id", "../o250"])
            manifest = json.loads((out / "o250-20261102" / "owners.json").read_text())
            self.assertEqual(manifest["tipHash"], "cd" * 32)
            self.assertEqual([entity["records"] for entity in manifest["entities"]], [1, 2])
            self.assertEqual(manifest["entities"][1]["evidence"][0]["sources"], ["example.com"])

    def test_verify_explains_only_spends_after_the_tip(self):
        records = [("aa" * 32, 0, A, "one", 100, None, 5000), ("bb" * 32, 1, A, "one", 110, None, 7000)]
        sh = {A: "sha"}
        spend = tx([("bb" * 32, 1)], [(6000, OTHER)])
        spend_id = owners.parse_tx(spend)[0]

        class Client:
            def __init__(self, utxos, later=(), mempool=()):
                self.utxos, self.later, self.mempool = utxos, later, mempool

            def call(self, method, *params):
                if method.endswith("listunspent"):
                    return self.utxos
                if method.endswith("get_history"):
                    assert params[1:] == (251, 2 ** 31 - 1)
                    return [dict(tx_hash=txid, height=300) for txid in self.later]
                return [dict(tx_hash=txid, height=0) for txid in self.mempool]

        class Rest:
            def get(self, path, missing_ok=False):
                return spend

        listed = [dict(tx_hash="aa" * 32, tx_pos=0, height=100, value=5000)]
        later = [dict(tx_hash="cc" * 32, tx_pos=0, height=251, value=1)]  # created above the tip: ignored
        for client in (Client(listed + later, later=[spend_id]), Client(listed, mempool=[spend_id])):
            results, mismatches = owners.verify(client, Rest(), records, sh, 250)
            self.assertEqual((mismatches, results[A]["spentAfterTip"]), ([], 1))
        _, mismatches = owners.verify(Client(listed), Rest(), records, sh, 250)
        self.assertEqual(mismatches[0]["recordsNotInListunspent"], ["bb" * 32 + ":1"])
        _, mismatches = owners.verify(Client([dict(listed[0], value=4999)], later=[spend_id]), Rest(), records, sh, 250)
        self.assertEqual(mismatches[0]["amountDiffers"], ["aa" * 32 + ":0"])
        _, mismatches = owners.verify(Client([], later=[spend_id]), Rest(), records, sh, 250)
        self.assertEqual(mismatches[0]["recordsNotInListunspent"], ["aa" * 32 + ":0"])


class DatasetTests(unittest.TestCase):
    def test_golden_vector(self):
        data = owners.encode_records([(300, 1, 2_100_000_000_000_000, 4032), (100, 0, 5_000_000_000, 0), (100, 0, 1, 5)])
        self.assertEqual(data.hex(), GOLDEN)
        self.assertEqual(decode(data), [(100, 5, 1, 0), (100, 0, 5_000_000_000, 0), (300, 4032, 2_100_000_000_000_000, 1)])
        for bad in ((1, 0, 0, 1), (1, 254, 1, 1), (1, 0, owners.MAX_SATS + 1, 1)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                owners.encode_records([bad])

    def test_cut_at_tip_and_life_buckets(self):
        rows = [
            ("t1", 0, A, "one", 10, 20, 5),            # short chunk 0
            ("t2", 0, A, "one", 4031, 8063, 6),        # life exactly 4032: short chunk 0
            ("t3", 0, A, "one", 4032, 8065, 7),        # life 4033: long
            ("t4", 0, A, "one", 5000, None, 8),        # unspent: long
            ("t5", 0, B, "two", 6000, 9000, 9),        # spent after the tip: unspent at it, long
            ("t6", 0, A, "one", 8600, None, 10),       # created after the tip: dropped
            ("t7", 0, A, "one", 7000, 7000, 11),       # spent in its creation block: dropped
            ("t8", 0, A, "one", 7100, None, 0),        # zero sats: dropped
            ("t9", 0, B, "two", 8064, 8100, 12),       # short chunk 2
        ]
        info = dict(entities=[dict(id="one", name="One", color="#F0B90B", evidenceTypes=["service_disclosure"]),
                              dict(id="two", name="Two", color="#00AAFF", evidenceTypes=["service_disclosure"])],
                    addresses=[dict(address=A, entity="one", evidence=[dict(type="service_disclosure",
                                                                            source="https://a.example/x", observed="2024-01-01")])],
                    fulcrumTip=9999, labels=dict(file="labels.csv", sha256="00" * 32))
        with tempfile.TemporaryDirectory() as tmp:
            out = owners.write_dataset(iter(rows), info, 8500, "ab" * 32, "o8500-test", Path(tmp))
            self.assertEqual(decode((out / "long.bin").read_bytes()), [(4032, 4033, 7, 0), (5000, 0, 8, 0), (6000, 0, 9, 1)])
            self.assertEqual(decode((out / "short/0000.bin").read_bytes()), [(10, 10, 5, 0), (4031, 4032, 6, 0)])
            self.assertEqual(decode((out / "short/0002.bin").read_bytes()), [(8064, 36, 12, 1)])
            self.assertFalse((out / "short/0001.bin").exists())
            manifest = json.loads((out / "owners.json").read_text())
            self.assertEqual((manifest["format"], manifest["tip"], manifest["shortLife"]), ("utxo-landscape-owners-1", 8500, 4032))
            self.assertEqual([item["chunk"] for item in manifest["files"]["short"]], [0, 2])
            self.assertEqual(manifest["files"]["long"]["bytes"], (out / "long.bin").stat().st_size)
            self.assertEqual([(e["records"], e["unspent"], e["unspentSats"], e["addresses"]) for e in manifest["entities"]],
                             [(4, 1, 8, 1), (2, 1, 9, 0)])
            self.assertEqual(manifest["entities"][0]["evidence"], [dict(type="service_disclosure", addresses=1,
                             sources=["a.example"], firstObserved="2024-01-01", lastObserved="2024-01-01")])
            with self.assertRaises(SystemExit):
                owners.write_dataset(iter(rows), info, 8500, "ab" * 32, "o8500-test", Path(tmp))
            self.assertEqual([path.name for path in Path(tmp).iterdir()], ["o8500-test"])


class SpecTests(unittest.TestCase):
    def test_committed_spec_and_address_selection(self):
        entities = owners.load_spec(Path(__file__).resolve().parents[1] / "landscape_owners_entities.json")
        self.assertEqual([(e["id"], e["name"], e["color"]) for e in entities[:2]],
                         [("binance", "Binance", "#FF2BD6"), ("okx", "OKX", "#22D3EE")])
        types = {"service_disclosure", "service_disclosure_via_graphsense", "service_disclosure_via_aggregator",
                 "third_party_exact_tag", "third_party_exact_tag_via_graphsense"}
        for entity in entities:
            self.assertTrue(set(entity["evidenceTypes"]) <= types, entity["id"])
        self.assertEqual(len({e["catalogEntity"] for e in entities}), len(entities))
        rgb = lambda value: tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))  # noqa: E731
        schema = (Path(__file__).resolve().parents[2] / "landscape/web/settings.schema.js").read_text()
        flashes = {rgb(value) for value in re.findall(r"'color\.heat'[^#\n]*'(#[0-9a-fA-F]{6})'", schema)}
        self.assertIn((255, 233, 196), flashes)  # the default warm-white flash is among them
        colours = [rgb(e["color"]) for e in entities]
        for colour in colours[2:]:  # white marks shared cells, and spend flashes must stay visible over owners
            self.assertGreaterEqual(math.dist(colour, (255, 255, 255)), 120)
            self.assertGreaterEqual(min(math.dist(colour, flash) for flash in flashes), 60)
        perceived = [cielab(colour) for colour in colours]
        self.assertGreaterEqual(min(math.dist(a, b) for n, a in enumerate(perceived) for b in perceived[n + 1:]), MIN_COLOUR_GAP)
        # The app lights its small owners together in one grey (ui/owners-menu.js), which must stand apart.
        menu = (Path(__file__).resolve().parents[2] / "landscape/web/ui/owners-menu.js").read_text()
        other = rgb(re.search(r"OTHER_OWNERS = Object\.freeze\(\{[^}]*color: '(#[0-9A-Fa-f]{6})'", menu).group(1))
        self.assertGreaterEqual(math.dist(other, (255, 255, 255)), 120)
        self.assertGreaterEqual(min(math.dist(other, flash) for flash in flashes), 60)
        self.assertGreaterEqual(min(math.dist(cielab(other), colour) for colour in perceived), 25)
        okx = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "labels.csv"
            write_labels(path, [(A, "Binance", "service_disclosure", "2023-02-01"),
                                (A, "Binance", "service_disclosure", "2023-03-01"),
                                (B, "Binance", "unreviewed_type", "2023-02-01"),
                                (B, "Kraken", "service_disclosure", "2023-02-01"),
                                (okx, "OKX", "service_disclosure", "2026-03-03"),
                                (okx, "OKX", "third_party_exact_tag_via_graphsense", "2021-11-09")])
            selected = owners.select_addresses(entities, path)
        self.assertEqual(sorted(selected), sorted([A, okx]))
        self.assertEqual(len(selected[A]["evidence"]), 2)
        self.assertEqual(selected[okx]["entity"], "okx")
        self.assertEqual([e["type"] for e in selected[okx]["evidence"]], ["service_disclosure"])
        for change in (dict(id="Bad Id"), dict(color="yellow")):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "spec.json"
                path.write_text(json.dumps(dict(entities=[{**entities[0], **change}])))
                with self.assertRaises(ValueError):
                    owners.load_spec(path)


if __name__ == "__main__":
    unittest.main()

