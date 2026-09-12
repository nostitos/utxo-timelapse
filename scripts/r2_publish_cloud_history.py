#!/usr/bin/env python3
"""Build and publish a Worker-friendly UTXO history index to Cloudflare R2.

The desktop explorer mmaps one ~58 GB file whose records are ordered by block.
That layout is unsuitable for a Worker: one pixel query only needs one Y row,
but would otherwise have to download and scan every output in its block range.

This publisher keeps the source-of-truth record intact while regrouping each
512-block shard by graph-local Y row.  Every shard remains a *single-part* R2
object (currently <= 84 MiB), which is important for low-latency ranged reads.
The Worker first reads the small row-offset table and then fetches only the
selected row's records.
"""

from __future__ import annotations

import argparse
import configparser
import json
import math
import os
import struct
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

import boto3
import numpy as np
from botocore.config import Config


HISTORY_HEADER = struct.Struct("<8sQQQQQ16s")
SHARD_HEADER = struct.Struct("<8sIIIIQ")
RECORD_DTYPE = np.dtype(
    [("creationHeight", "<u4"), ("spendHeight", "<u4"), ("satoshi", "<i8")]
)
SHARD_MAGIC = b"BUVSHD1\0"
UNSPENT = 0xFFFFFFFF


def arguments() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("history", type=Path)
    p.add_argument("--bucket", default="utxo-video")
    p.add_argument("--prefix", default="explorer/v1/history")
    p.add_argument("--endpoint", required=True)
    p.add_argument("--credentials", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--shard-blocks", type=int, default=512)
    p.add_argument("--rows", type=int, default=2072)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--dry-run-shard", type=int)
    return p.parse_args()


def load_credentials(path: Path) -> tuple[str, str]:
    cfg = configparser.ConfigParser()
    cfg.read(path)
    section = cfg["default"]
    return section["aws_access_key_id"], section["aws_secret_access_key"]


def save_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def satoshi_rows(satoshi: np.ndarray, rows: int) -> np.ndarray:
    """Exact vector form of SatoshiBlockheightToPixel's three-zone Y map."""
    amounts = np.abs(satoshi.astype(np.float64, copy=False))
    log_value = np.log(amounts)
    log_100 = math.log(100.0)
    log_top = math.log(1e12)
    log_max = math.log(1e13)
    total_height = float(rows)
    low_height = ((log_100 / log_max) * total_height) / 3.0
    decade_unit = (total_height - low_height) / 10.15
    mid_height = 10.0 * decade_unit
    top_height = 0.15 * decade_unit

    pixel = np.empty(log_value.shape, dtype=np.float64)
    at_top = log_value >= log_max
    upper = (log_value >= log_top) & ~at_top
    middle = (log_value > log_100) & (log_value < log_top)
    low = ~(at_top | upper | middle)

    pixel[at_top] = 0.0
    pixel[upper] = top_height * (
        1.0 - (log_value[upper] - log_top) / (log_max - log_top)
    )
    pixel[middle] = top_height + mid_height * (
        1.0 - (log_value[middle] - log_100) / (log_top - log_100)
    )
    pixel[low] = total_height - low_height * (log_value[low] / log_100)

    # C++ casts positive doubles to size_t (truncate toward zero), then clamps.
    return np.clip(pixel.astype(np.int64), 0, rows - 1).astype(np.uint16)


def build_shard(
    records: np.memmap,
    height_index: np.memmap,
    shard_number: int,
    shard_blocks: int,
    num_blocks: int,
    rows: int,
) -> tuple[bytes, dict]:
    start_height = shard_number * shard_blocks
    end_height = min(start_height + shard_blocks, num_blocks)
    first = int(height_index[start_height])
    last = int(height_index[end_height])
    source = records[first:last]
    y = satoshi_rows(source["satoshi"], rows)
    counts = np.bincount(y, minlength=rows).astype("<u8", copy=False)
    offsets = np.empty(rows + 1, dtype="<u8")
    offsets[0] = 0
    np.cumsum(counts, out=offsets[1:])
    order = np.argsort(y, kind="stable")
    ordered = source[order]
    header = SHARD_HEADER.pack(
        SHARD_MAGIC, 1, rows, start_height, end_height, len(source)
    )
    payload = header + offsets.tobytes(order="C") + ordered.tobytes(order="C")
    meta = {
        "shard": shard_number,
        "startHeight": start_height,
        "endHeight": end_height,
        "records": len(source),
        "bytes": len(payload),
    }
    return payload, meta


def main() -> int:
    args = arguments()
    with args.history.open("rb") as f:
        raw = f.read(HISTORY_HEADER.size)
    magic, num_blocks, num_records, times_off, index_off, records_off, _ = (
        HISTORY_HEADER.unpack(raw)
    )
    if magic != b"BUVHIST1":
        raise SystemExit("not a BUVHIST1 file")
    file_size = args.history.stat().st_size
    if records_off + num_records * RECORD_DTYPE.itemsize > file_size:
        raise SystemExit("history record section extends past end of file")

    block_times = np.memmap(
        args.history, dtype="<u4", mode="r", offset=times_off, shape=(num_blocks,)
    )
    height_index = np.memmap(
        args.history,
        dtype="<u8",
        mode="r",
        offset=index_off,
        shape=(num_blocks + 1,),
    )
    records = np.memmap(
        args.history,
        dtype=RECORD_DTYPE,
        mode="r",
        offset=records_off,
        shape=(num_records,),
    )
    shard_count = math.ceil(num_blocks / args.shard_blocks)

    if args.dry_run_shard is not None:
        payload, meta = build_shard(
            records,
            height_index,
            args.dry_run_shard,
            args.shard_blocks,
            num_blocks,
            args.rows,
        )
        meta["first16"] = payload[:16].hex()
        print(json.dumps(meta, indent=2))
        return 0

    access, secret = load_credentials(args.credentials)
    s3 = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
        config=Config(
            retries={"max_attempts": 10, "mode": "adaptive"},
            max_pool_connections=max(16, args.workers * 2),
            connect_timeout=20,
            read_timeout=300,
        ),
    )
    if args.state.exists():
        state = json.loads(args.state.read_text())
    else:
        state = {
            "format": "buv-cloud-history-publish-v1",
            "source": str(args.history.resolve()),
            "sourceSize": file_size,
            "sourceMtimeNs": args.history.stat().st_mtime_ns,
            "completed": {},
        }
    expected_identity = (
        str(args.history.resolve()),
        file_size,
        args.history.stat().st_mtime_ns,
    )
    if (
        state.get("source"),
        state.get("sourceSize"),
        state.get("sourceMtimeNs"),
    ) != expected_identity:
        raise SystemExit("state belongs to a different history file")
    state_lock = threading.Lock()
    started = time.monotonic()

    def upload(key: str, body: bytes, content_type: str) -> dict:
        response = s3.put_object(
            Bucket=args.bucket,
            Key=key,
            Body=body,
            ContentLength=len(body),
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )
        return {"bytes": len(body), "etag": response["ETag"]}

    # Small immutable chain-time table used by info, date and result formatting.
    times_key = f"{args.prefix}/block_times.bin"
    times_body = block_times.tobytes(order="C")
    if times_key not in state["completed"]:
        state["completed"][times_key] = upload(
            times_key, times_body, "application/octet-stream"
        )
        save_json(args.state, state)

    pending = set()
    completed_shards = sum(
        1
        for n in range(shard_count)
        if f"{args.prefix}/shards/{n:05d}.bin" in state["completed"]
    )

    def finish(done_set) -> None:
        nonlocal completed_shards
        for future in done_set:
            key, meta = future.result()
            with state_lock:
                state["completed"][key] = meta
                completed_shards += 1
                save_json(args.state, state)
                elapsed = max(0.001, time.monotonic() - started)
                print(
                    f"{completed_shards}/{shard_count} shards "
                    f"({100 * completed_shards / shard_count:.1f}%) "
                    f"{completed_shards / elapsed:.2f} shard/s",
                    flush=True,
                )

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for shard_number in range(shard_count):
            key = f"{args.prefix}/shards/{shard_number:05d}.bin"
            if key in state["completed"]:
                continue
            while len(pending) >= args.workers:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                finish(done)
            payload, shard_meta = build_shard(
                records,
                height_index,
                shard_number,
                args.shard_blocks,
                num_blocks,
                args.rows,
            )

            def send(k=key, b=payload, m=shard_meta):
                result = upload(k, b, "application/octet-stream")
                result.update(m)
                return k, result

            pending.add(pool.submit(send))
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            finish(done)

    manifest = {
        "format": "buv-cloud-history-v1",
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "numBlocks": num_blocks,
        "numRecords": num_records,
        "rows": args.rows,
        "recordBytes": RECORD_DTYPE.itemsize,
        "shardBlocks": args.shard_blocks,
        "shardCount": shard_count,
        "shardHeaderBytes": SHARD_HEADER.size,
        "shardIndexBytes": (args.rows + 1) * 8,
        "blockTimesKey": times_key,
        "shardKeyPattern": f"{args.prefix}/shards/%05d.bin",
        "unspentValue": UNSPENT,
    }
    manifest_key = f"{args.prefix}/manifest.json"
    manifest_body = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
    manifest_meta = upload(manifest_key, manifest_body, "application/json")
    state["completed"][manifest_key] = manifest_meta
    state["manifest"] = manifest
    state["finishedAt"] = datetime.now(timezone.utc).isoformat()
    save_json(args.state, state)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
