#!/usr/bin/env python3
"""Extract auditable address events from Bitcoin Core, without altering chain data.

Requires pyarrow. Hash BLOBs use the byte order of displayed transaction IDs;
script_id is SHA256 of the complete scriptPubKey bytes. Every vout is an `out`
event and every noncoinbase vin is an `in` event. Missing addresses remain null.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
from datetime import datetime, timezone
from decimal import Decimal
import fcntl
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

import pyarrow as pa
import pyarrow.parquet as pq

SCHEMA_VERSION = 1
EVENT_SCHEMA = pa.schema([
    pa.field("height", pa.uint32(), nullable=False),
    pa.field("tx_index", pa.uint32(), nullable=False),
    pa.field("txid", pa.binary(32), nullable=False),
    pa.field("coinbase", pa.bool_(), nullable=False),
    pa.field("direction", pa.string(), nullable=False),
    pa.field("io_index", pa.uint32(), nullable=False),
    pa.field("outpoint_txid", pa.binary(32), nullable=False),
    pa.field("outpoint_vout", pa.uint32(), nullable=False),
    pa.field("creation_height", pa.uint32(), nullable=False),
    pa.field("script_id", pa.binary(32), nullable=False),
    pa.field("script", pa.binary(), nullable=False),
    pa.field("address", pa.string()),
    pa.field("satoshi", pa.int64(), nullable=False),
])


class ExtractionError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_bytes(value: Any, context: str) -> bytes:
    if not isinstance(value, str) or len(value) != 64:
        raise ExtractionError(f"{context}: expected a full 32-byte hash")
    try:
        result = bytes.fromhex(value)
    except ValueError as exc:
        raise ExtractionError(f"{context}: invalid hash") from exc
    if len(result) != 32:
        raise ExtractionError(f"{context}: invalid hash length")
    return result


def uint(value: Any, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < 2**32:
        raise ExtractionError(f"{context}: expected an unsigned 32-bit integer")
    return value


def satoshi(value: Any) -> int:
    # Binary floats are deliberately rejected: JSON is decoded with Decimal.
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise ExtractionError("amount: expected an exact JSON decimal")
    amount = Decimal(value) * 100_000_000
    if not amount.is_finite() or amount != amount.to_integral_value():
        raise ExtractionError("amount: nonintegral satoshis")
    if not 0 <= amount <= 2_100_000_000_000_000:
        raise ExtractionError("amount: outside Bitcoin money range")
    return int(amount)


def script_fields(value: Any) -> tuple[bytes, bytes, str | None]:
    if not isinstance(value, dict) or not isinstance(value.get("hex"), str):
        raise ExtractionError("scriptPubKey: missing complete script bytes")
    encoded = value["hex"]
    try:
        script = bytes.fromhex(encoded)
    except ValueError as exc:
        raise ExtractionError("scriptPubKey: invalid script hex") from exc
    if len(script) * 2 != len(encoded):
        raise ExtractionError("scriptPubKey: noncanonical script hex")
    address = value.get("address")
    if address is not None and (not isinstance(address, str) or not address):
        raise ExtractionError("scriptPubKey: invalid address")
    return hashlib.sha256(script).digest(), script, address


def load_expected(path: Path, start: int, end: int) -> tuple[dict[int, str], str, str]:
    try:
        raw = path.read_bytes()
        manifest = json.loads(raw)
        entries = manifest["blocks"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ExtractionError("cannot read expected-blocks manifest") from exc
    if manifest.get("schema_version") != 1 or not isinstance(entries, list):
        raise ExtractionError("unsupported expected-blocks manifest")
    expected: dict[int, str] = {}
    for item in entries:
        if not isinstance(item, dict):
            raise ExtractionError("invalid expected-block entry")
        height = uint(item.get("height"), "manifest height")
        block_hash = item.get("hash")
        hash_bytes(block_hash, "manifest hash")
        if height in expected:
            raise ExtractionError(f"duplicate expected height {height}")
        expected[height] = block_hash.lower()
    if any(height not in expected for height in range(start, end + 1)):
        raise ExtractionError("expected manifest does not cover the complete requested range")
    digest = hashlib.sha256(raw).hexdigest()
    fingerprint = hashlib.sha256(f"address-events-v{SCHEMA_VERSION}:{digest}".encode()).hexdigest()
    return expected, digest, fingerprint


class Rpc:
    def __init__(self, url: str, cookie_file: Path, timeout: float = 120):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ExtractionError("RPC URL must be HTTP(S), without embedded credentials")
        self.url, self.cookie_file, self.timeout = url, cookie_file, timeout

    def call(self, method: str, params: list[Any]) -> Any:
        for attempt in range(3):
            try:
                cookie = self.cookie_file.read_text().strip()
                if not cookie or ":" not in cookie:
                    raise ExtractionError("invalid RPC cookie file")
                auth = base64.b64encode(cookie.encode()).decode()
                request = urllib.request.Request(
                    self.url,
                    data=json.dumps({"jsonrpc": "1.0", "id": "address-coverage", "method": method, "params": params}).encode(),
                    headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
                )
                try:
                    with urllib.request.urlopen(request, timeout=self.timeout) as response:
                        raw = response.read()
                except urllib.error.HTTPError as exc:
                    # Core uses HTTP 500 for JSON-RPC errors. Never echo the response.
                    raw = exc.read()
                    try:
                        error = json.loads(raw).get("error")
                    except (ValueError, AttributeError):
                        error = None
                    code = error.get("code") if isinstance(error, dict) else "unavailable"
                    raise ExtractionError(f"RPC {method} failed (HTTP {exc.code}, RPC {code})") from None
                try:
                    response = json.loads(raw, parse_float=Decimal)
                except ValueError as exc:
                    raise ExtractionError(f"RPC {method}: invalid JSON response") from exc
                if not isinstance(response, dict) or "result" not in response:
                    raise ExtractionError(f"RPC {method}: malformed response")
                if response.get("error") is not None:
                    error = response["error"]
                    code = error.get("code") if isinstance(error, dict) else "unavailable"
                    raise ExtractionError(f"RPC {method} failed (RPC {code})")
                return response["result"]
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == 2:
                    raise ExtractionError(f"RPC {method}: transport failed after 3 attempts") from None
                time.sleep(2**attempt)
            except OSError as exc:
                raise ExtractionError(f"RPC {method}: cookie or transport unavailable ({type(exc).__name__})") from None
        raise AssertionError("unreachable")


def block_events(block: dict[str, Any], height: int, expected_hash: str,
                 previous_hash: str | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if block.get("height") != height or block.get("hash", "").lower() != expected_hash:
        raise ExtractionError(f"block {height}: height/hash mismatch")
    if not isinstance(block.get("confirmations"), int) or block["confirmations"] < 1:
        raise ExtractionError(f"block {height}: expected block is not on the active chain")
    if previous_hash is not None and block.get("previousblockhash", "").lower() != previous_hash:
        raise ExtractionError(f"block {height}: previous block hash mismatch")
    transactions = block.get("tx")
    if not isinstance(transactions, list) or not transactions:
        raise ExtractionError(f"block {height}: missing full transactions")
    if block.get("nTx", len(transactions)) != len(transactions):
        raise ExtractionError(f"block {height}: transaction count mismatch")
    events: list[dict[str, Any]] = []
    stats: dict[str, Any] = {"height": height, "hash": expected_hash, "time": uint(block.get("time"), "block time"),
        "transaction_count": len(transactions), "noncoinbase_transaction_count": 0, "coinbase_transaction_count": 0,
        "input_count": 0, "output_count": 0, "input_satoshi": 0, "output_satoshi": 0,
        "coinbase_output_count": 0, "coinbase_output_satoshi": 0}
    seen_txids: set[bytes] = set()
    for tx_index, tx in enumerate(transactions):
        if not isinstance(tx, dict):
            raise ExtractionError(f"block {height}: verbosity 3 transactions required")
        txid = hash_bytes(tx.get("txid"), f"block {height} txid")
        if txid in seen_txids:
            raise ExtractionError(f"block {height}: duplicate transaction ID")
        seen_txids.add(txid)
        inputs, outputs = tx.get("vin"), tx.get("vout")
        if not isinstance(inputs, list) or not inputs or not isinstance(outputs, list) or not outputs:
            raise ExtractionError(f"block {height}: incomplete transaction inputs/outputs")
        coinbase = len(inputs) == 1 and "coinbase" in inputs[0]
        if coinbase != (tx_index == 0) or (not coinbase and any("coinbase" in item for item in inputs)):
            raise ExtractionError(f"block {height}: invalid coinbase position")
        stats["coinbase_transaction_count" if coinbase else "noncoinbase_transaction_count"] += 1
        common = {"height": height, "tx_index": tx_index, "txid": txid, "coinbase": coinbase}
        if not coinbase:
            for io_index, item in enumerate(inputs):
                prevout = item.get("prevout")
                if not isinstance(prevout, dict) or any(key not in prevout for key in ("height", "value", "scriptPubKey")):
                    raise ExtractionError(f"block {height}, transaction {tx_index}, input {io_index}: missing complete prevout")
                creation = uint(prevout["height"], "prevout height")
                if creation > height:
                    raise ExtractionError(f"block {height}: prevout creation height is in the future")
                script_id, script, address = script_fields(prevout["scriptPubKey"])
                amount = satoshi(prevout["value"])
                events.append({**common, "direction": "in", "io_index": io_index,
                    "outpoint_txid": hash_bytes(item.get("txid"), "prevout txid"),
                    "outpoint_vout": uint(item.get("vout"), "prevout index"), "creation_height": creation,
                    "script_id": script_id, "script": script, "address": address, "satoshi": amount})
                stats["input_count"] += 1
                stats["input_satoshi"] += amount
        for io_index, item in enumerate(outputs):
            if item.get("n") != io_index:
                raise ExtractionError(f"block {height}: output indexes are not contiguous")
            script_id, script, address = script_fields(item.get("scriptPubKey"))
            amount = satoshi(item.get("value"))
            events.append({**common, "direction": "out", "io_index": io_index,
                "outpoint_txid": txid, "outpoint_vout": io_index, "creation_height": height,
                "script_id": script_id, "script": script, "address": address, "satoshi": amount})
            stats["output_count"] += 1
            stats["output_satoshi"] += amount
            if coinbase:
                stats["coinbase_output_count"] += 1
                stats["coinbase_output_satoshi"] += amount
    stats["event_count"] = len(events)
    return events, stats


def atomic_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as stream:
            json.dump(data, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def batch_paths(output: Path, start: int, end: int) -> tuple[Path, Path]:
    stem = f"{start}-{end}"
    return output / "events" / f"{stem}.parquet", output / "batches" / f"{stem}.json"


def validate_existing(output: Path, start: int, end: int, expected: dict[int, str], fingerprint: str) -> dict[str, Any] | None:
    parquet_path, metadata_path = batch_paths(output, start, end)
    if not metadata_path.exists():
        # An orphan parquet file after interruption is replaced by a full retry.
        return None
    try:
        metadata = json.loads(metadata_path.read_text())
        if metadata["schema_version"] != SCHEMA_VERSION or metadata["source_fingerprint"] != fingerprint:
            raise ExtractionError(f"batch {start}-{end}: source/schema fingerprint mismatch")
        blocks = metadata["blocks"]
        if metadata["start"] != start or metadata["end"] != end or len(blocks) != end - start + 1:
            raise ExtractionError(f"batch {start}-{end}: incomplete range metadata")
        for height, block in zip(range(start, end + 1), blocks):
            if block["height"] != height or block["hash"] != expected[height]:
                raise ExtractionError(f"batch {start}-{end}: expected block mismatch")
        if metadata["parquet"] != f"events/{start}-{end}.parquet":
            raise ExtractionError(f"batch {start}-{end}: unexpected file path")
        if sha256_file(parquet_path) != metadata["sha256"]:
            raise ExtractionError(f"batch {start}-{end}: parquet checksum mismatch")
        parquet = pq.ParquetFile(parquet_path)
        count = sum(block["event_count"] for block in blocks)
        if count != metadata["event_count"] or count != parquet.metadata.num_rows:
            raise ExtractionError(f"batch {start}-{end}: event count mismatch")
        if not parquet.schema_arrow.equals(EVENT_SCHEMA, check_metadata=False):
            raise ExtractionError(f"batch {start}-{end}: parquet schema mismatch")
        return metadata
    except ExtractionError:
        raise
    except (OSError, ValueError, KeyError, TypeError, pa.ArrowException) as exc:
        raise ExtractionError(f"batch {start}-{end}: invalid or incomplete existing batch ({type(exc).__name__})") from None


def extract_batch(rpc: Rpc, output: Path, start: int, end: int, expected: dict[int, str],
                  fingerprint: str, manifest_sha: str) -> dict[str, Any]:
    parquet_path, metadata_path = batch_paths(output, start, end)
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{start}-{end}.", suffix=".parquet.tmp", dir=parquet_path.parent)
    os.close(handle)
    temporary = Path(temporary_name)
    started = time.monotonic()
    started_at = utc_now()
    blocks: list[dict[str, Any]] = []
    try:
        schema = EVENT_SCHEMA.with_metadata({b"schema_version": str(SCHEMA_VERSION).encode(), b"source_fingerprint": fingerprint.encode()})
        with pq.ParquetWriter(temporary, schema, compression="zstd", compression_level=3,
                use_dictionary=["direction", "address", "script_id", "script"]) as writer:
            for height in range(start, end + 1):
                block = rpc.call("getblock", [expected[height], 3])
                events, stats = block_events(block, height, expected[height], expected.get(height - 1))
                table = pa.Table.from_pylist(events, schema=schema)
                writer.write_table(table)
                blocks.append(stats)
                del block, events, table
        # Recheck the batch tip after reading: no reorg can silently mix chains.
        if rpc.call("getblockhash", [end]) != expected[end]:
            raise ExtractionError(f"batch {start}-{end}: active chain changed during extraction")
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        metadata = {"schema_version": SCHEMA_VERSION, "source_fingerprint": fingerprint,
            "expected_blocks_sha256": manifest_sha, "start": start, "end": end,
            "parquet": f"events/{start}-{end}.parquet", "sha256": sha256_file(temporary),
            "bytes": temporary.stat().st_size, "event_count": sum(item["event_count"] for item in blocks),
            "started_at": started_at, "completed_at": utc_now(),
            "elapsed_seconds": round(time.monotonic() - started, 3), "blocks": blocks}
        os.replace(temporary, parquet_path)
        atomic_json(metadata_path, metadata)
        return metadata
    finally:
        temporary.unlink(missing_ok=True)


_PROCESS_CONTEXT: tuple[Rpc, Path, dict[int, str], str, str] | None = None


def init_process_worker(rpc_url: str, cookie_file: str, timeout: float, output: str,
                        expected: dict[int, str], fingerprint: str, manifest_sha: str) -> None:
    """Create one independent RPC client in each spawned process.

    Send the immutable 50,000-block hash map once per process, not per batch.
    Cookies are read inside the worker and never serialized by the executor.
    """
    global _PROCESS_CONTEXT
    _PROCESS_CONTEXT = (Rpc(rpc_url, Path(cookie_file), timeout), Path(output), expected, fingerprint, manifest_sha)


def extract_process_batch(start: int, end: int) -> dict[str, Any]:
    if _PROCESS_CONTEXT is None:
        raise ExtractionError("process worker has not been initialized")
    rpc, output, expected, fingerprint, manifest_sha = _PROCESS_CONTEXT
    return extract_batch(rpc, output, start, end, expected, fingerprint, manifest_sha)


def write_summary(output: Path, start: int, end: int, batch_size: int, manifest_sha: str,
                  fingerprint: str, completed: list[dict[str, Any]], validated_tip: str | None = None) -> None:
    completed = sorted(completed, key=lambda item: item["start"])
    blocks = [block for item in completed for block in item["blocks"]]
    contiguous = start - 1
    for item in completed:
        if item["start"] != contiguous + 1:
            break
        contiguous = item["end"]
    atomic_json(output / "extraction.json", {"schema_version": SCHEMA_VERSION,
        "source_fingerprint": fingerprint, "expected_blocks_sha256": manifest_sha,
        "requested_start": start, "requested_end": end, "batch_size": batch_size,
        "complete": len(blocks) == end - start + 1 and contiguous == end and validated_tip is not None,
        "updated_at": utc_now(),
        "active_chain_tip_validation": None if validated_tip is None else {"height": end, "hash": validated_tip, "checked_at": utc_now()},
        "completed_block_count": len(blocks), "contiguous_through": contiguous,
        "event_count": sum(item["event_count"] for item in completed),
        "transaction_count": sum(item["transaction_count"] for item in blocks),
        "noncoinbase_transaction_count": sum(item["noncoinbase_transaction_count"] for item in blocks),
        "bytes": sum(item["bytes"] for item in completed),
        "batches": [{key: item[key] for key in ("start", "end", "parquet", "sha256", "event_count", "bytes")} for item in completed]})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument("--cookie-file", required=True, type=Path)
    parser.add_argument("--expected-blocks", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--start", required=True, type=int)
    parser.add_argument("--end", required=True, type=int)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--executor", choices=("thread", "process"), default="thread",
        help="process uses independent spawned workers to parallelize JSON/event normalization")
    parser.add_argument("--limit-batches", type=int, help="maximum new batches in this invocation")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--preflight", action="store_true", help="validate first block and active-chain end; write nothing")
    args = parser.parse_args(argv)
    if args.start < 0 or args.end < args.start or args.batch_size < 1 or args.workers < 1 or args.timeout <= 0:
        parser.error("invalid range, batch size, worker count or timeout")
    if args.limit_batches is not None and args.limit_batches < 1:
        parser.error("--limit-batches must be positive")
    try:
        expected, manifest_sha, fingerprint = load_expected(args.expected_blocks, args.start, args.end)
        rpc = Rpc(args.rpc_url, args.cookie_file, args.timeout)
        if rpc.call("getblockhash", [args.end]) != expected[args.end]:
            raise ExtractionError("requested final block is not on the active chain")
        if args.preflight:
            _, stats = block_events(rpc.call("getblock", [expected[args.start], 3]), args.start,
                expected[args.start], expected.get(args.start - 1))
            print(json.dumps({"preflight": "ok", "source_fingerprint": fingerprint, "first_block": stats}), flush=True)
            return 0
        args.output.mkdir(parents=True, exist_ok=True)
        with (args.output / ".extract.lock").open("a+") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ExtractionError("another extractor holds this output directory") from None
            summary_path = args.output / "extraction.json"
            if summary_path.exists():
                existing_summary = json.loads(summary_path.read_text())
                for key, value in (("source_fingerprint", fingerprint), ("requested_start", args.start),
                        ("requested_end", args.end), ("batch_size", args.batch_size)):
                    if existing_summary.get(key) != value:
                        raise ExtractionError(f"output directory extraction configuration mismatch: {key}")
            completed, pending = [], []
            for start in range(args.start, args.end + 1, args.batch_size):
                end = min(start + args.batch_size - 1, args.end)
                existing = validate_existing(args.output, start, end, expected, fingerprint)
                if existing is None:
                    pending.append((start, end))
                else:
                    completed.append(existing)
            write_summary(args.output, args.start, args.end, args.batch_size, manifest_sha, fingerprint, completed)
            selected = pending[:args.limit_batches] if args.limit_batches else pending
            print(json.dumps({"status": "start", "resumed_batches": len(completed), "new_batches": len(selected),
                "workers": args.workers, "source_fingerprint": fingerprint}), flush=True)
            errors = []
            if args.executor == "process":
                executor = concurrent.futures.ProcessPoolExecutor(max_workers=args.workers,
                    mp_context=multiprocessing.get_context("spawn"), initializer=init_process_worker,
                    initargs=(args.rpc_url, str(args.cookie_file), args.timeout, str(args.output), expected, fingerprint, manifest_sha))
            else:
                executor = concurrent.futures.ThreadPoolExecutor(max_workers=args.workers)
            with executor as pool:
                waiting = iter(selected)
                futures: dict[Any, tuple[int, int]] = {}

                def submit_next() -> bool:
                    bounds = next(waiting, None)
                    if bounds is None:
                        return False
                    start, end = bounds
                    if args.executor == "process":
                        future = pool.submit(extract_process_batch, start, end)
                    else:
                        future = pool.submit(extract_batch, rpc, args.output, start, end, expected, fingerprint, manifest_sha)
                    futures[future] = bounds
                    return True

                for _ in range(args.workers):
                    if not submit_next():
                        break
                while futures:
                    done, _ = concurrent.futures.wait(futures, return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in done:
                        del futures[future]
                        try:
                            metadata = future.result()
                        except Exception as exc:
                            errors.append(exc)
                            continue
                        completed.append(metadata)
                        write_summary(args.output, args.start, args.end, args.batch_size, manifest_sha, fingerprint, completed)
                        print(json.dumps({"status": "batch_complete", **{key: metadata[key] for key in
                            ("start", "end", "event_count", "bytes", "elapsed_seconds", "sha256")}}), flush=True)
                    if not errors:
                        while len(futures) < args.workers and submit_next():
                            pass
            if errors:
                raise errors[0]
            if rpc.call("getblockhash", [args.end]) != expected[args.end]:
                raise ExtractionError("active chain changed before extraction completed")
            write_summary(args.output, args.start, args.end, args.batch_size, manifest_sha, fingerprint,
                completed, validated_tip=expected[args.end])
            print(json.dumps({"status": "finished", "completed_batches": len(completed),
                "remaining_batches": len(pending) - len(selected), "summary": str(summary_path)}), flush=True)
        return 0
    except (RuntimeError, OSError, ValueError, pa.ArrowException) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
