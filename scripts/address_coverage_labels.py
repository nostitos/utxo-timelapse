#!/usr/bin/env python3
"""Prepare conservative, exact-address public Bitcoin attribution evidence.

No blockchain clustering is performed. GraphSense's is_cluster_definer metadata
does not cause expansion: only the listed addresses of allowlisted disclosure
packs are considered. Python >=3.10 and PyYAML are required.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

import yaml

YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

REPOSITORY = "https://github.com/graphsense/graphsense-tagpacks.git"
DEFAULT_REVISION = "7f9a5d1f93435379cfaed4675fb734fa42848ca5"
FIELDS = ("address", "entity", "source", "observed_date", "confidence",
          "evidence_type", "historical_note")
BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
HISTORICAL_NOTE = (
    "Reported association only; publication/collection date is not a control "
    "interval. Historical control throughout the analysed blocks is unverified. "
    "No ownership clustering or counterparty attribution is applied."
)

# An explicit reviewable allowlist, not a name/confidence heuristic. The pack's
# actor and source must also match, including every per-tag override.
PACKS = {
    "exchange-wallets-binance.yaml": ("Binance", "binance", ("www.binance.com",)),
    "exchange-wallets-bitfinexcom.yaml": ("Bitfinex", "bitfinex", ("github.com",)),
    "exchange-wallets-bybit.yaml": ("Bybit", "bybit", ("blog.bybit.com", "www.bybithelp.com")),
    "exchange-wallets-cryptocom.yaml": ("Crypto.com", "cryptocom", ("twitter.com",)),
    "exchange-wallets-deribit.yaml": ("Deribit", "deribit", ("insights.deribit.com",)),
    "exchange-wallets-huobi.yaml": ("Huobi", "huobi", ("www.huobi.com",)),
    "exchange-wallets-kucoin.yaml": ("KuCoin", "kucoin", ("www.kucoin.com",)),
    "exchange-wallets-okx.yaml": ("OKX", "okex", ("twitter.com",)),
    "service-wallets-checksig.yaml": ("CheckSig", None, ("www.checksig.com",)),
    "demo.yaml": ("Internet Archive", "internet_archive", ("archive.org",)),
    "protonmail.yaml": ("Proton Mail", None, ("protonmail.com",)),
    **{f"exchange-wallets-bitmex_{i}.yaml": (
        "BitMEX", "bitmex", ("s3-eu-west-1.amazonaws.com",)) for i in range(7)},
}
ALIASES = {
    "binance": "Binance", "bitfinex": "Bitfinex", "bitmex": "BitMEX",
    "bybit": "Bybit", "crypto.com": "Crypto.com", "cryptocom": "Crypto.com",
    "deribit": "Deribit", "huobi": "Huobi", "kucoin": "KuCoin",
    "okx": "OKX", "okex": "OKX", "checksig": "CheckSig",
    "internet_archive": "Internet Archive", "internet archive": "Internet Archive",
    "protonmail": "Proton Mail", "proton mail": "Proton Mail",
}
REPORTED_PACKS = {
    "walletexplorer.yaml": ("www.walletexplorer.com", "wallet-clustering provider; underlying ownership may be inferred"),
    "chaininfo.yaml": ("chain.info", "third-party cold-wallet attribution; method not verified"),
    "richest_addresses.yaml": ("bitinfocharts.com", "third-party richlist attribution; method not verified"),
}


def normalize_address(value: str) -> str:
    """Validate Base58Check or BIP173/BIP350 mainnet address; canonicalise case."""
    value = str(value).strip()
    if value.lower().startswith("bc1"):
        if value != value.lower() and value != value.upper():
            raise ValueError("mixed-case Bech32 address")
        value = value.lower()
        if len(value) > 90 or len(value) < 14:
            raise ValueError("invalid Bech32 address length")
        try:
            data = [BECH32.index(c) for c in value[3:]]
        except ValueError as exc:
            raise ValueError("invalid Bech32 character") from exc
        checksum = 1
        generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
        for digit in [3, 3, 0, 2, 3] + data:  # HRP expansion of 'bc'.
            high = checksum >> 25
            checksum = ((checksum & 0x1FFFFFF) << 5) ^ digit
            for bit, generator in enumerate(generators):
                if (high >> bit) & 1:
                    checksum ^= generator
        payload = data[:-6]
        if not payload or payload[0] > 16:
            raise ValueError("invalid witness version")
        version = payload[0]
        if checksum != (1 if version == 0 else 0x2BC830A3):
            raise ValueError("invalid Bech32/Bech32m checksum")
        accumulator = bits = 0
        program = bytearray()
        for digit in payload[1:]:
            accumulator = ((accumulator << 5) | digit) & 0xFFF
            bits += 5
            if bits >= 8:
                bits -= 8
                program.append((accumulator >> bits) & 255)
        if bits >= 5 or (accumulator << (8 - bits)) & 255:
            raise ValueError("invalid witness padding")
        if not 2 <= len(program) <= 40 or (version == 0 and len(program) not in (20, 32)):
            raise ValueError("invalid witness program length")
        return value
    if not 26 <= len(value) <= 35 or value[0:1] not in ("1", "3"):
        raise ValueError("not a Bitcoin mainnet address")
    number = 0
    try:
        for char in value:
            number = number * 58 + BASE58.index(char)
    except ValueError as exc:
        raise ValueError("invalid Base58 character") from exc
    decoded = b"\0" * (len(value) - len(value.lstrip("1"))) + number.to_bytes(
        (number.bit_length() + 7) // 8, "big")
    if len(decoded) != 25 or decoded[0] not in (0, 5):
        raise ValueError("invalid Base58 mainnet payload")
    if hashlib.sha256(hashlib.sha256(decoded[:-4]).digest()).digest()[:4] != decoded[-4:]:
        raise ValueError("invalid Base58Check checksum")
    return value


def normalize_entity(entity: str) -> str:
    entity = " ".join(str(entity).split())
    if not entity:
        raise ValueError("empty entity")
    return ALIASES.get(entity.lower(), entity)


def normalize_row(row: dict) -> dict[str, str]:
    result = {key: str(row.get(key, "")).strip() for key in FIELDS}
    result["address"] = normalize_address(result["address"])
    result["entity"] = normalize_entity(result["entity"])
    parsed = urlparse(result["source"])
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError("missing public source URL")
    if not result["observed_date"]:
        raise ValueError("missing evidence observation date")
    dt.date.fromisoformat(result["observed_date"])
    for required in ("confidence", "evidence_type", "historical_note"):
        if not result[required]:
            raise ValueError(f"missing {required}")
    return result


def resolve_rows(rows: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """Retain independent evidence; exclude every conflicting address from seeds."""
    unique = {tuple(row[key] for key in FIELDS): row for row in map(normalize_row, rows)}
    ordered = [unique[key] for key in sorted(unique)]
    entities = defaultdict(set)
    for row in ordered:
        entities[row["address"]].add(row["entity"])
    conflicts = {address for address, names in entities.items() if len(names) > 1}
    return (ordered, [row for row in ordered if row["address"] not in conflicts],
            [row for row in ordered if row["address"] in conflicts])


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args])


def parse_pack(name: str, raw: bytes) -> tuple[list[dict], list[dict], dict]:
    if name not in PACKS:
        raise ValueError(f"pack is not reviewed: {name}")
    data = yaml.load(raw, Loader=YAML_LOADER)
    entity, actor, domains = PACKS[name]
    rows, rejected = [], []
    non_btc = 0
    for index, tag in enumerate(data["tags"]):
        metadata = {**data, **tag}
        if metadata.get("currency") != "BTC":
            non_btc += 1
            continue
        source = str(metadata.get("source", ""))
        host = urlparse(source).hostname
        if host not in domains or metadata.get("actor") != actor:
            raise ValueError(f"{name} tag {index}: source/actor outside reviewed policy")
        if host == "github.com" and not urlparse(source).path.startswith("/bitfinexcom/pub/"):
            raise ValueError(f"{name}: not a Bitfinex publication")
        if host == "s3-eu-west-1.amazonaws.com" and not urlparse(source).path.startswith("/public.bitmex.com/data/porl/"):
            raise ValueError(f"{name}: not a BitMEX publication")
        if host == "twitter.com" and not urlparse(source).path.startswith(
                "/okx/status/" if entity == "OKX" else "/kris/status/"):
            raise ValueError(f"{name}: not the reviewed publisher account")
        row = dict(address=metadata.get("address", ""), entity=entity, source=source,
                   observed_date=str(metadata.get("lastmod", "")),
                   confidence="publicly_reported",
                   evidence_type="service_disclosure_via_graphsense",
                   historical_note="GraphSense lastmod is a collection date. " + HISTORICAL_NOTE)
        try:
            rows.append(normalize_row(row))
        except ValueError as exc:
            rejected.append(dict(row, reason=str(exc), pack=name, tag_index=index))
    decision = dict(pack=name, entity=entity, decision="included_exact_addresses_only",
                    listed_tags=len(data["tags"]), accepted_btc_rows=len(rows),
                    rejected_btc_rows=len(rejected), non_btc_rows=non_btc,
                    upstream_confidence=data.get("confidence"),
                    is_cluster_definer_ignored=data.get("is_cluster_definer"),
                    primary_urls=sorted({row["source"] for row in rows}),
                    upstream_lastmod=str(data.get("lastmod", "")))
    return rows, rejected, decision


def parse_reported_pack(name: str, raw: bytes, actors: dict[str, str]) -> tuple[list[dict], list[dict], dict]:
    """Separate sensitivity tier, using existing exact tags and no new expansion."""
    host, method = REPORTED_PACKS[name]
    data = yaml.load(raw, Loader=YAML_LOADER)
    rows, rejected = [], []
    for index, tag in enumerate(data["tags"]):
        metadata = {**data, **tag}
        if metadata.get("currency") != "BTC":
            continue
        source = str(metadata.get("source", ""))
        if urlparse(source).hostname != host:
            raise ValueError(f"{name}: source outside reviewed reported-tier policy")
        actor = str(metadata.get("actor", ""))
        # Unidentified generic names ('original', 'chatbot') are not entities.
        if not actor or actor not in actors:
            rejected.append(dict(address=metadata.get("address", ""), source=source,
                entity=metadata.get("label", ""), reason="no identified GraphSense actor",
                pack=name, tag_index=index))
            continue
        entity = ALIASES.get(actor, normalize_entity(actors[actor]))
        row = dict(address=metadata.get("address", ""), entity=entity, source=source,
            observed_date=str(metadata.get("lastmod", "")), confidence="third_party_reported",
            evidence_type="third_party_exact_tag_via_graphsense",
            historical_note=f"Provider method: {method}. Existing exact listed address only; "
                "GraphSense lastmod is a collection date. " + HISTORICAL_NOTE)
        try:
            rows.append(normalize_row(row))
        except ValueError as exc:
            rejected.append(dict(row, reason=str(exc), pack=name, tag_index=index))
    return rows, rejected, dict(pack=name, decision="optional_reported_tier_only",
        method=method, listed_tags=len(data["tags"]), accepted_btc_rows=len(rows),
        rejected_btc_rows=len(rejected), primary_urls=sorted({row["source"] for row in rows}),
        upstream_lastmod=str(data.get("lastmod", "")))


def write_csv(path: Path, rows: list[dict], fields=FIELDS) -> None:
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_supplement(path: Path) -> tuple[list[dict], dict]:
    """A supplemental manifest binds an already-reviewed CSV to source bytes."""
    manifest = json.loads(path.read_text())
    csv_path = path.parent / manifest["labels_csv"]
    if sha256(csv_path) != manifest["labels_sha256"]:
        raise ValueError(f"supplement CSV checksum mismatch: {path}")
    for source in manifest["sources"]:
        if not all(source.get(key) for key in ("url", "fetched_at", "sha256", "license", "local_path")):
            raise ValueError("supplement source requires URL, fetch time, checksum, license and local path")
        if sha256(path.parent / source["local_path"]) != source["sha256"]:
            raise ValueError(f"supplement source checksum mismatch: {source['local_path']}")
    if not manifest["sources"]:
        raise ValueError("supplement requires original source evidence")
    with csv_path.open(newline="", encoding="utf-8") as stream:
        rows = [normalize_row(row) for row in csv.DictReader(stream)]
    source_urls = {source["url"] for source in manifest["sources"]}
    if any(row["source"] not in source_urls for row in rows):
        raise ValueError("supplement label source has no archived provenance")
    return rows, dict(manifest, manifest_path=str(path.resolve()), manifest_sha256=sha256(path))


def build_catalog(repo: Path, revision: str, output: Path, supplements: list[Path],
                  fetch: bool = False, include_reported: bool = False) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("revision must be a complete pinned Git SHA")
    output.mkdir(parents=True, exist_ok=True)
    acquisition = output / "sources" / "graphsense_acquisition.json"
    acquisition.parent.mkdir(parents=True, exist_ok=True)
    if not repo.exists():
        subprocess.run(["git", "clone", "--no-checkout", "--filter=blob:none", REPOSITORY, str(repo)], check=True)
        fetch = True
    if fetch:
        git(repo, "fetch", "--depth", "1", "origin", revision)
        acquisition.write_text(json.dumps(dict(repository=REPOSITORY, revision=revision,
            fetched_at=dt.datetime.now(dt.timezone.utc).isoformat()), indent=2) + "\n")
    fetched = json.loads(acquisition.read_text()) if acquisition.exists() else None
    if fetched and fetched["revision"] != revision:
        fetched = None
    # git show reads pinned blobs, never mutable working-tree copies.
    git(repo, "cat-file", "-e", revision + "^{commit}")
    files = git(repo, "ls-tree", "-r", "--name-only", revision, "packs/").decode().splitlines()
    license_bytes = git(repo, "show", f"{revision}:LICENSE")
    (output / "sources" / "GRAPHSENSE_LICENSE.txt").write_bytes(license_bytes)
    rows, rejected, decisions, reported = [], [], [], []
    actors = {}
    actors_sha256 = None
    if include_reported:
        actor_bytes = git(repo, "show", f"{revision}:actors/graphsense.actorpack.yaml")
        actors_sha256 = hashlib.sha256(actor_bytes).hexdigest()
        actors = {str(actor["id"]): str(actor["label"]) for actor in
            yaml.load(actor_bytes, Loader=YAML_LOADER)["actors"]}
    for relative in files:
        name = relative.removeprefix("packs/")
        if name not in PACKS and not (include_reported and name in REPORTED_PACKS):
            reason = ("cluster-derived or attribution method not accepted" if name in (
                "walletexplorer.yaml", "miners.yaml", "miners_additional.yaml", "chaininfo.yaml", "richest_addresses.yaml")
                else "third-party attribution without reviewed direct disclosure" if name in (
                    "exchange-wallets-swissborg.yaml", "binance.yaml", "BITB_etf.yaml")
                else "outside the reviewed service/organisation direct-disclosure allowlist")
            decisions.append(dict(pack=name, decision="excluded", reason=reason))
            continue
        raw = git(repo, "show", f"{revision}:{relative}")
        if name in PACKS:
            pack_rows, pack_rejected, decision = parse_pack(name, raw)
            rows.extend(pack_rows)
        else:
            pack_rows, pack_rejected, decision = parse_reported_pack(name, raw, actors)
            reported.extend(pack_rows)
        rejected.extend(pack_rejected)
        decision.update(sha256=hashlib.sha256(raw).hexdigest(),
                        pinned_url=f"https://raw.githubusercontent.com/graphsense/graphsense-tagpacks/{revision}/{relative}",
                        license="MIT (GraphSense snapshot); underlying source terms may differ")
        decisions.append(decision)
    missing = set(PACKS) - {decision["pack"] for decision in decisions}
    if missing:
        raise ValueError(f"pinned snapshot is missing reviewed packs: {sorted(missing)}")
    supplement_manifests = []
    for path in supplements:
        supplemental_rows, manifest = load_supplement(path)
        rows.extend(supplemental_rows)
        supplement_manifests.append(manifest)
    all_rows, resolved, conflicts = resolve_rows(rows)
    for name, table in (("labels.csv", all_rows), ("labels_resolved.csv", resolved), ("labels_conflicts.csv", conflicts)):
        write_csv(output / name, table)
    reported_rows, _, _ = resolve_rows(reported)
    extended_rows, extended_resolved, extended_conflicts = resolve_rows(all_rows + reported_rows)
    for name, table in (("labels_reported.csv", reported_rows),
                        ("labels_extended.csv", extended_rows),
                        ("labels_extended_resolved.csv", extended_resolved),
                        ("labels_extended_conflicts.csv", extended_conflicts)):
        write_csv(output / name, table)
    write_csv(output / "labels_rejected.csv", rejected, (*FIELDS, "reason", "pack", "tag_index"))
    per_entity = Counter({entity: len({row["address"] for row in resolved if row["entity"] == entity})
                          for entity in {row["entity"] for row in resolved}})
    counts = dict(evidence_rows=len(all_rows), unique_addresses=len({row["address"] for row in all_rows}),
                  resolved_addresses=len({row["address"] for row in resolved}),
                  conflicting_addresses=len({row["address"] for row in conflicts}),
                  rejected_rows=len(rejected), entities=len(per_entity),
                  addresses_by_entity=dict(per_entity.most_common()))
    counts["optional_reported_tier"] = dict(enabled=include_reported,
        evidence_rows=len(reported_rows), unique_addresses=len({r["address"] for r in reported_rows}),
        extended_resolved_addresses=len({r["address"] for r in extended_resolved}),
        extended_conflicting_addresses=len({r["address"] for r in extended_conflicts}),
        extended_entities=len({r["entity"] for r in extended_resolved}))
    manifest = dict(schema_version=1, generated_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                    network="bitcoin-mainnet", counts=counts,
                    policy=dict(ownership_clustering=False, direct_tier_inferred_labels=False,
                        reported_tier="Optional exact third-party tags; may contain provider-inferred attribution; no expansion by this tool",
                        conflicts="exclude all competing rows from resolved seed catalog",
                        temporal_note=HISTORICAL_NOTE,
                        confidence="publicly_reported is evidence provenance, not probability of control"),
                    graphsense=dict(repository=REPOSITORY, revision=revision,
                        commit_date=git(repo, "show", "-s", "--format=%cI", revision).decode().strip(),
                        acquisition=fetched,
                        license="MIT", license_sha256=hashlib.sha256(license_bytes).hexdigest(),
                        actorpack_sha256=actors_sha256, selection=decisions),
                    aliases=ALIASES, alias_basis="Reviewed pack actor/title and publisher identity; spelling variants only",
                    supplements=supplement_manifests,
                    outputs={name: sha256(output / name) for name in (
                        "labels.csv", "labels_resolved.csv", "labels_conflicts.csv", "labels_rejected.csv",
                        "labels_reported.csv", "labels_extended.csv", "labels_extended_resolved.csv",
                        "labels_extended_conflicts.csv")})
    (output / "sources_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tagpacks-dir", type=Path)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--fetch", action="store_true", help="Fetch the pinned revision and record acquisition time")
    parser.add_argument("--supplement", type=Path, action="append", default=[])
    parser.add_argument("--include-reported", action="store_true", help="Also emit a separate third-party sensitivity catalog")
    args = parser.parse_args()
    repo = args.tagpacks_dir or args.output / "sources" / "graphsense-tagpacks"
    print(json.dumps(build_catalog(repo, args.revision, args.output, args.supplement, args.fetch,
                                  args.include_reported), indent=2))


if __name__ == "__main__":
    main()
