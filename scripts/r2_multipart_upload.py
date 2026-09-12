#!/usr/bin/env python3
"""Resumable multipart upload of large immutable media files to Cloudflare R2."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def human_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.2f} {unit}"
        value /= 1024
    raise AssertionError("unreachable")


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--part-mib", type=int, default=128)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--content-type", default="video/mp4")
    parser.add_argument(
        "--cache-control", default="public, max-age=31536000, immutable"
    )
    parser.add_argument(
        "--manifest-key",
        default="",
        help="After verification, atomically point this small JSON object at the upload",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source does not exist: {source}")
    if args.part_mib < 5:
        raise SystemExit("R2 multipart parts must be at least 5 MiB")
    if args.workers < 1 or args.workers > 16:
        raise SystemExit("workers must be in [1, 16]")

    # A multipart upload can safely resume, but two writers using the same
    # checkpoint at once can race when updating part ETags. Keep an advisory
    # lock for the entire process; the kernel releases it after a crash.
    lock_path = args.state.with_suffix(args.state.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_handle = lock_path.open("a+")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(f"Another uploader already owns {lock_path}")
    os.chmod(lock_path, 0o600)

    file_stat = source.stat()
    file_size = file_stat.st_size
    part_size = args.part_mib * 1024 * 1024
    part_count = math.ceil(file_size / part_size)
    if part_count > 10_000:
        raise SystemExit(f"{part_count} parts exceeds R2's 10,000-part limit")

    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = str(args.credentials.resolve())
    session = boto3.Session(profile_name="default", region_name="auto")
    client = session.client(
        "s3",
        endpoint_url=args.endpoint,
        config=Config(
            retries={"max_attempts": 10, "mode": "adaptive"},
            connect_timeout=15,
            read_timeout=180,
            max_pool_connections=max(8, args.workers * 2),
        ),
    )

    identity = {
        "source": str(source),
        "source_size": file_size,
        "source_mtime_ns": file_stat.st_mtime_ns,
        "bucket": args.bucket,
        "key": args.key,
        "endpoint": args.endpoint,
        "part_size": part_size,
        "part_count": part_count,
        "content_type": args.content_type,
        "cache_control": args.cache_control,
    }

    def promote_latest(head: dict) -> None:
        if not args.manifest_key:
            return
        manifest = {
            "key": args.key,
            "size": file_size,
            "etag": head.get("ETag"),
            "contentType": args.content_type,
            "cacheControl": args.cache_control,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        client.put_object(
            Bucket=args.bucket,
            Key=args.manifest_key,
            Body=(json.dumps(manifest, separators=(",", ":")) + "\n").encode(),
            ContentType="application/json",
            CacheControl="no-store",
        )
        print(
            f"PROMOTED s3://{args.bucket}/{args.manifest_key} -> {args.key}",
            flush=True,
        )

    if not args.state.exists():
        try:
            existing = client.head_object(Bucket=args.bucket, Key=args.key)
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if status != 404:
                raise
        else:
            existing_size = int(existing["ContentLength"])
            if existing_size == file_size:
                promote_latest(existing)
                print(
                    f"ALREADY COMPLETE s3://{args.bucket}/{args.key} "
                    f"({human_bytes(existing_size)}, ETag {existing.get('ETag')})",
                    flush=True,
                )
                return 0
            raise SystemExit(
                f"Remote object already exists with size {existing_size}, "
                f"expected {file_size}; choose another key"
            )

    if args.state.exists():
        state = json.loads(args.state.read_text())
        for key, expected in identity.items():
            if state.get(key) != expected:
                raise SystemExit(
                    f"Checkpoint mismatch for {key}: "
                    f"{state.get(key)!r} != {expected!r}"
                )
        upload_id = state["upload_id"]
        print(f"Resuming multipart upload {upload_id}", flush=True)
    else:
        created = client.create_multipart_upload(
            Bucket=args.bucket,
            Key=args.key,
            ContentType=args.content_type,
            CacheControl=args.cache_control,
        )
        upload_id = created["UploadId"]
        state = {
            **identity,
            "upload_id": upload_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "completed": {},
        }
        save_json(args.state, state)
        print(f"Created multipart upload {upload_id}", flush=True)

    remote_parts: dict[int, dict] = {}
    marker = 0
    while True:
        response = client.list_parts(
            Bucket=args.bucket,
            Key=args.key,
            UploadId=upload_id,
            PartNumberMarker=marker,
        )
        for part in response.get("Parts", []):
            remote_parts[int(part["PartNumber"])] = {
                "ETag": part["ETag"],
                "Size": int(part["Size"]),
            }
        if not response.get("IsTruncated"):
            break
        marker = int(response["NextPartNumberMarker"])

    state["completed"] = {str(k): v for k, v in sorted(remote_parts.items())}
    save_json(args.state, state)

    def expected_size(part_number: int) -> int:
        offset = (part_number - 1) * part_size
        return min(part_size, file_size - offset)

    for number, remote in remote_parts.items():
        if remote["Size"] != expected_size(number):
            raise SystemExit(
                f"Remote part {number} has unexpected size {remote['Size']}"
            )

    missing = [n for n in range(1, part_count + 1) if n not in remote_parts]
    resumed_bytes = sum(part["Size"] for part in remote_parts.values())
    print(
        f"Source: {human_bytes(file_size)} in {part_count} parts; "
        f"already present: {human_bytes(resumed_bytes)}; "
        f"remaining: {len(missing)} parts",
        flush=True,
    )

    lock = threading.Lock()
    started = time.monotonic()
    uploaded_this_run = 0

    def upload_part(part_number: int) -> tuple[int, str, int]:
        offset = (part_number - 1) * part_size
        size = expected_size(part_number)
        with source.open("rb", buffering=0) as handle:
            handle.seek(offset)
            payload = handle.read(size)
        if len(payload) != size:
            raise IOError(f"Short read for part {part_number}: {len(payload)} != {size}")
        result = client.upload_part(
            Bucket=args.bucket,
            Key=args.key,
            UploadId=upload_id,
            PartNumber=part_number,
            Body=payload,
        )
        return part_number, result["ETag"], size

    if missing:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(upload_part, n): n for n in missing}
            for future in as_completed(futures):
                number, etag, size = future.result()
                with lock:
                    uploaded_this_run += size
                    remote_parts[number] = {"ETag": etag, "Size": size}
                    state["completed"] = {
                        str(k): v for k, v in sorted(remote_parts.items())
                    }
                    state["updated_at"] = datetime.now(timezone.utc).isoformat()
                    save_json(args.state, state)
                    elapsed = max(0.001, time.monotonic() - started)
                    rate = uploaded_this_run / elapsed
                    total_done = resumed_bytes + uploaded_this_run
                    eta = (file_size - total_done) / rate if rate else 0
                    print(
                        f"part {number:04d}/{part_count} complete | "
                        f"{100 * total_done / file_size:6.2f}% | "
                        f"{human_bytes(rate)}/s | ETA {eta / 60:.1f} min",
                        flush=True,
                    )

    parts = [
        {"PartNumber": number, "ETag": remote_parts[number]["ETag"]}
        for number in range(1, part_count + 1)
    ]
    completed = client.complete_multipart_upload(
        Bucket=args.bucket,
        Key=args.key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )
    head = client.head_object(Bucket=args.bucket, Key=args.key)
    if int(head["ContentLength"]) != file_size:
        raise SystemExit(
            f"Remote size mismatch: {head['ContentLength']} != {file_size}"
        )
    promote_latest(head)
    finished_state = args.state.with_suffix(args.state.suffix + ".completed")
    state.update(
        {
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "remote_etag": completed.get("ETag"),
            "verified_content_length": int(head["ContentLength"]),
        }
    )
    save_json(finished_state, state)
    args.state.unlink()
    print(
        f"COMPLETE s3://{args.bucket}/{args.key} "
        f"({human_bytes(file_size)}, ETag {completed.get('ETag')})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; rerun the same command to resume.", file=sys.stderr)
        raise SystemExit(130)
