#!/usr/bin/env python3
"""Verify an uploaded landscape dataset in R2 against the local copy.

Every local dataset file (manifest.json, rows.bin, blocktimes.bin, chunks.json, chunks/*.bin,
snapshots/*.bin) must exist under the prefix with the same size, a single-part ETag and that
ETag equal to the local MD5; nothing else may exist under the prefix. The local copy is first
checked against its own manifest and chunk table. Exits 1 on any difference.

  python scripts/landscape_r2_verify.py "/Volumes/4T Data/buv_render/landscape_966827" \
    --prefix landscape/d966827-20261008 [--no-manifest]

--no-manifest verifies the first upload pass, in which manifest.json must not be uploaded yet.
Needs boto3 (python3 -m venv /tmp/landscape_r2_venv && /tmp/landscape_r2_venv/bin/pip install boto3).
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config

ENDPOINT = "https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com"


def args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("dataset", type=Path)
    p.add_argument("--prefix", required=True)
    p.add_argument("--bucket", default="utxo-video")
    p.add_argument("--endpoint", default=ENDPOINT)
    p.add_argument("--credentials", type=Path, default=Path.home() / ".config/utxo-r2/credentials")
    p.add_argument("--no-manifest", action="store_true")
    p.add_argument("--workers", type=int, default=8)
    return p.parse_args()


def local_files(root: Path, include_manifest: bool) -> dict[str, Path]:
    manifest = json.loads((root / "manifest.json").read_text())
    chunks = json.loads((root / "chunks.json").read_text())["chunks"]
    files = {"rows.bin": root / "rows.bin", "blocktimes.bin": root / "blocktimes.bin", "chunks.json": root / "chunks.json"}
    if include_manifest:
        files["manifest.json"] = root / "manifest.json"
    for c in chunks:
        files[c["file"]] = root / c["file"]
    for s in manifest["snapshots"]:
        files[s["file"]] = root / s["file"]
    on_disk = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and not p.name.startswith(".")}
    expected = set(files) | ({"manifest.json"} if not include_manifest else set())
    if on_disk != expected:
        raise SystemExit(f"local dataset differs from its manifest: extra {sorted(on_disk - expected)[:5]}, missing {sorted(expected - on_disk)[:5]}")
    for rel, path in files.items():
        if rel.startswith("snapshots/"):
            entry = next(s for s in manifest["snapshots"] if s["file"] == rel)
            if path.stat().st_size != entry["bytes"]:
                raise SystemExit(f"{rel}: size {path.stat().st_size} != manifest {entry['bytes']}")
    return files


def md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        while block := f.read(8 << 20):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    a = args()
    root = a.dataset.resolve()
    prefix = a.prefix.rstrip("/") + "/"
    files = local_files(root, include_manifest=not a.no_manifest)
    cfg = configparser.ConfigParser()
    cfg.read(a.credentials)
    s3 = boto3.client(
        "s3", endpoint_url=a.endpoint, region_name="auto",
        aws_access_key_id=cfg["default"]["aws_access_key_id"], aws_secret_access_key=cfg["default"]["aws_secret_access_key"],
        config=Config(retries={"max_attempts": 8, "mode": "adaptive"}),
    )
    remote: dict[str, dict] = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=a.bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            remote[o["Key"][len(prefix):]] = {"size": o["Size"], "etag": o["ETag"].strip('"')}
    problems: list[str] = []
    bad: set[str] = set()
    for rel in sorted(set(remote) - set(files)):
        problems.append(f"unexpected remote object {rel}")
    for rel in sorted(set(files) - set(remote)):
        problems.append(f"missing remote object {rel}")
    started = time.monotonic()
    common = sorted(set(files) & set(remote))
    total = sum(files[rel].stat().st_size for rel in common)
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        digests = dict(zip(common, pool.map(lambda rel: md5(files[rel]), common)))
    for rel in common:
        size = files[rel].stat().st_size
        r = remote[rel]
        if r["size"] != size:
            problems.append(f"{rel}: remote size {r['size']} != local {size}")
            bad.add(rel)
        elif "-" in r["etag"]:
            problems.append(f"{rel}: multipart ETag {r['etag']}")
            bad.add(rel)
        elif r["etag"] != digests[rel]:
            problems.append(f"{rel}: remote MD5 {r['etag']} != local {digests[rel]}")
            bad.add(rel)
    seconds = time.monotonic() - started
    summary = {
        "prefix": prefix, "expected": len(files), "remote": len(remote), "verified": len(common) - len(bad),
        "bytes": total, "md5Seconds": round(seconds, 1), "snapshots": sum(1 for r in files if r.startswith("snapshots/")),
        "chunks": sum(1 for r in files if r.startswith("chunks/")), "manifest": "manifest.json" in remote, "problems": len(problems),
    }
    for p in problems[:50]:
        print("PROBLEM", p)
    print(json.dumps(summary, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
