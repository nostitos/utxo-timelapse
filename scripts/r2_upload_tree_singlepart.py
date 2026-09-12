#!/usr/bin/env python3
"""Resumably upload a directory to R2 using one PUT per file.

This intentionally does not use boto3's managed transfer helper: that helper
turns medium-sized video segments into multipart objects, and ranged reads of
those objects have proven dramatically slower for this application.
"""

from __future__ import annotations

import argparse
import configparser
import json
import mimetypes
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config


def args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("source", type=Path)
    p.add_argument("--bucket", default="utxo-video")
    p.add_argument("--prefix", required=True)
    p.add_argument("--endpoint", required=True)
    p.add_argument("--credentials", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--include", nargs="*", default=[])
    return p.parse_args()


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def content_type(path: Path) -> str:
    return {
        ".m3u8": "application/vnd.apple.mpegurl",
        ".m4s": "video/iso.segment",
        ".mp4": "video/mp4",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json",
        ".bin": "application/octet-stream",
    }.get(path.suffix.lower(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")


def main() -> int:
    a = args()
    root = a.source.resolve()
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")
    allow = set(a.include)
    files = sorted(
        p for p in root.rglob("*")
        if p.is_file() and (not allow or p.name in allow or p.suffix in allow)
    )
    if not files:
        raise SystemExit("no files selected")
    cfg = configparser.ConfigParser()
    cfg.read(a.credentials)
    section = cfg["default"]
    s3 = boto3.client(
        "s3",
        endpoint_url=a.endpoint,
        aws_access_key_id=section["aws_access_key_id"],
        aws_secret_access_key=section["aws_secret_access_key"],
        region_name="auto",
        config=Config(
            retries={"max_attempts": 10, "mode": "adaptive"},
            max_pool_connections=max(16, a.workers * 2),
            connect_timeout=20,
            read_timeout=600,
        ),
    )
    if a.state.exists():
        state = json.loads(a.state.read_text())
    else:
        state = {"format": "r2-singlepart-tree-v1", "root": str(root), "completed": {}}
    if state.get("root") != str(root):
        raise SystemExit("state belongs to a different source directory")
    lock = threading.Lock()
    total_bytes = sum(p.stat().st_size for p in files)
    already = sum(
        p.stat().st_size
        for p in files
        if f"{a.prefix.rstrip('/')}/{p.relative_to(root).as_posix()}" in state["completed"]
    )
    started = time.monotonic()
    uploaded = already

    def send(path: Path) -> tuple[str, dict]:
        rel = path.relative_to(root).as_posix()
        key = f"{a.prefix.rstrip('/')}/{rel}"
        size = path.stat().st_size
        with path.open("rb") as body:
            response = s3.put_object(
                Bucket=a.bucket,
                Key=key,
                Body=body,
                ContentLength=size,
                ContentType=content_type(path),
                CacheControl="public, max-age=31536000, immutable",
            )
        return key, {"bytes": size, "etag": response["ETag"], "source": rel}

    todo = [
        p for p in files
        if f"{a.prefix.rstrip('/')}/{p.relative_to(root).as_posix()}" not in state["completed"]
    ]
    print(
        f"Uploading {len(todo)}/{len(files)} files; "
        f"{already}/{total_bytes} bytes already complete",
        flush=True,
    )
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures = {pool.submit(send, p): p for p in todo}
        for future in as_completed(futures):
            key, meta = future.result()
            with lock:
                state["completed"][key] = meta
                uploaded += meta["bytes"]
                write_state(a.state, state)
                elapsed = max(0.001, time.monotonic() - started)
                current_bytes = uploaded - already
                rate = current_bytes / elapsed
                remaining = (total_bytes - uploaded) / rate if rate else 0
                print(
                    f"{len(state['completed'])}/{len(files)} "
                    f"{100 * uploaded / total_bytes:.2f}% "
                    f"{rate / 2**20:.1f} MiB/s ETA {remaining / 60:.1f} min",
                    flush=True,
                )
    state["finished"] = True
    write_state(a.state, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
