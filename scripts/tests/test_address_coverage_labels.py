#!/usr/bin/env python3
import csv
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "address_coverage_labels", Path(__file__).parents[1] / "address_coverage_labels.py")
labels = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(labels)

ADDRESS = "1Archive1n2C579dMsAu3iC6tWzuQJz8dN"


def evidence(**changes):
    return dict(address=ADDRESS, entity="Internet Archive", source="https://archive.org/donate/cryptocurrency",
                observed_date="2021-11-12", confidence="publicly_reported",
                evidence_type="service_disclosure", historical_note=labels.HISTORICAL_NOTE, **changes)


class AddressValidationTests(unittest.TestCase):
    def test_base58_checksum_and_network(self):
        self.assertEqual(labels.normalize_address(" " + ADDRESS + " "), ADDRESS)
        self.assertEqual(labels.normalize_address("34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo"),
                         "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo")
        for value in (ADDRESS[:-1] + "M", ADDRESS.lower(), "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
                      "0x0000000000000000000000000000000000000000", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                labels.normalize_address(value)

    def test_official_bip350_mainnet_valid_vectors(self):
        # https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
        for value in (
            "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
            "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
            "BC1SW50QGDZ25J", "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
        ):
            with self.subTest(value=value):
                self.assertEqual(labels.normalize_address(value), value.lower())

    def test_official_bip350_invalid_vectors_and_other_network(self):
        for value in (
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
            "BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL",
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
            "bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4",
            "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
            "bc1pw5dgrnzv",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav",
            "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
            "bc1gmk9yu", "bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                labels.normalize_address(value)


class EvidenceTests(unittest.TestCase):
    def test_aliases_do_not_create_conflicts_but_other_entities_do(self):
        original = evidence()
        alias = {**original, "entity": "  internet_archive  ", "source": "https://archive.org/another-publication"}
        all_rows, resolved, conflicts = labels.resolve_rows([original, alias, original])
        self.assertEqual(len(all_rows), 2)
        self.assertEqual(len(resolved), 2)
        self.assertFalse(conflicts)
        competing = {**original, "entity": "Another Organisation"}
        all_rows, resolved, conflicts = labels.resolve_rows([original, alias, competing])
        self.assertEqual(len(all_rows), 3)
        self.assertFalse(resolved)
        self.assertEqual(len(conflicts), 3)

    def test_requires_complete_provenance(self):
        for key, value in (("source", "local-file"), ("observed_date", "2026-02-30"),
                           ("confidence", ""), ("historical_note", ""), ("evidence_type", "")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                labels.normalize_row({**evidence(), key: value})

    def test_pack_inheritance_mainnet_filter_and_explicit_addresses_only(self):
        raw = f"""actor: internet_archive
currency: BTC
source: https://archive.org/donate/cryptocurrency
lastmod: 2021-11-12
is_cluster_definer: true
tags:
- address: {ADDRESS}
- address: another_chain
  currency: ETH
- address: bad_btc
""".encode()
        rows, rejected, decision = labels.parse_pack("demo.yaml", raw)
        self.assertEqual([row["address"] for row in rows], [ADDRESS])
        self.assertEqual(len(rejected), 1)
        self.assertEqual(decision["non_btc_rows"], 1)
        self.assertTrue(decision["is_cluster_definer_ignored"])
        with self.assertRaises(ValueError):
            labels.parse_pack("demo.yaml", raw.replace(b"archive.org", b"walletexplorer.com"))
        with self.assertRaises(ValueError):
            labels.parse_pack("walletexplorer.yaml", raw)

    def test_supplement_checks_source_and_normalized_csv_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.csv"
            source.write_text("direct source document")
            labels.write_csv(root / "labels.csv", [evidence()])
            manifest = dict(labels_csv="labels.csv", labels_sha256=labels.sha256(root / "labels.csv"),
                sources=[dict(url=evidence()["source"], fetched_at="2026-09-18T00:00:00Z",
                    sha256=labels.sha256(source), license="Published facts; source license not specified",
                    local_path="source.csv")])
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest))
            rows, result = labels.load_supplement(path)
            self.assertEqual(rows[0]["address"], ADDRESS)
            self.assertEqual(result["manifest_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            source.write_text("changed source document")
            with self.assertRaisesRegex(ValueError, "source checksum"):
                labels.load_supplement(path)

    def test_reported_tier_is_explicit_and_unknown_actor_is_rejected(self):
        raw = f"""currency: BTC
lastmod: 2021-11-11
tags:
- address: {ADDRESS}
  source: https://www.walletexplorer.com/address/{ADDRESS}
  actor: internet_archive
- address: {ADDRESS}
  source: https://www.walletexplorer.com/address/{ADDRESS}
  label: unidentified wallet
""".encode()
        rows, rejected, decision = labels.parse_reported_pack("walletexplorer.yaml", raw,
            {"internet_archive": "Internet Archive"})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["confidence"], "third_party_reported")
        self.assertIn("inferred", rows[0]["historical_note"])
        self.assertEqual(len(rejected), 1)
        self.assertEqual(decision["decision"], "optional_reported_tier_only")
        with self.assertRaises(ValueError):
            labels.parse_reported_pack("walletexplorer.yaml",
                raw.replace(b"www.walletexplorer.com", b"unreviewed.example"), {})


if __name__ == "__main__":
    unittest.main()
