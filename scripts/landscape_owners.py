#!/usr/bin/env python3
"""Owner highlight data for the 3D landscape (docs/landscape-owners.md).

  fetch-sources    exchanges' published address lists -> exact-address label supplements
                   (landscape_owners_sources.py, registry landscape_owners_sources.json)
  coverage-report  a built label catalog summarised per entity
  preflight        history of addresses new to the extraction, cached, and the work still to do
  extract          every output paying the spec's exact addresses, from Fulcrum history and
                   Bitcoin Core REST transactions, verified against Fulcrum's listunspent
  build            records cut at a landscape tip -> owner dataset read by the replay worker

No clustering: only the listed addresses are followed. Standard library only, apart
from the address decoding shared with address_coverage_labels.py (which needs PyYAML).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import http.client
import json
import os
import queue
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import address_coverage_labels as labels  # noqa: E402
import landscape_owners_sources as sources  # noqa: E402

SHORT_LIFE = 4032
MAGIC = b"BUVOWN1\0"
MAX_SATS = 2_100_000_000_000_000
MAX_ENTITIES = 254
PAGE_ITEMS = 30_000        # ~3 MB of JSON per history page, well under Fulcrum's 10 MB client buffer
MAX_SPAN = 16_128          # blocks per page; bounds a page that runs from sparse into dense history
REORG_DEPTH = 6            # cached history this close to the previous tip is fetched again
REST_RETRY_SECONDS = 900   # long enough to restart a dropped tunnel
FLAG_ITEMS = 4_000_000     # histories this long approach Fulcrum's MAX_HISTORY of 5,000,000
RECORD_FIELDS = ("txid", "vout", "address", "entity", "created", "spent", "sats")
METHOD = ("Exact listed addresses only, no clustering. Every output paying them is traced from "
          "Fulcrum's address history and Bitcoin Core's transactions, and the unspent set is "
          "checked against Fulcrum's listunspent.")


def log(message: str) -> None:
    print(f"{dt.datetime.now():%H:%M:%S} {message}", flush=True)


def write_json(path: Path, value) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


# --- Fulcrum and Bitcoin Core REST -----------------------------------------------------

class FulcrumError(RuntimeError):
    """An error reply; the connection stays usable."""


class Fulcrum:
    """Electrum protocol over plain TCP, one request at a time."""

    def __init__(self, address: str, timeout: float = 180):
        host, _, port = address.rpartition(":")
        self.address, self.timeout = (host, int(port)), timeout
        self.sock = self.stream = None
        self.next_id = 0

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = self.stream = None

    def request(self, method: str, *params):
        """One call; a dropped connection raises OSError or ValueError and is reopened next time."""
        try:
            if self.stream is None:
                self.sock = socket.create_connection(self.address, timeout=self.timeout)
                self.stream = self.sock.makefile("rwb")
                self._exchange("server.version", ["utxo-landscape-owners", "1.6"])
            return self._exchange(method, list(params))
        except (OSError, ValueError):
            self.close()
            raise

    def _exchange(self, method: str, params: list):
        self.next_id += 1
        self.stream.write(json.dumps(dict(jsonrpc="2.0", id=self.next_id, method=method,
                                          params=params)).encode() + b"\n")
        self.stream.flush()
        while True:
            line = self.stream.readline()
            if not line.endswith(b"\n"):
                raise ConnectionError("Fulcrum closed the connection")
            reply = json.loads(line)
            if reply.get("id") == self.next_id:  # subscription notifications carry no id
                break
        if reply.get("error"):
            raise FulcrumError(f"{method}: {reply['error']}")
        return reply["result"]

    def call(self, method: str, *params):
        """request(), reconnecting after dropped connections."""
        for attempt in range(8):
            try:
                return self.request(method, *params)
            except (OSError, ValueError) as exc:
                if attempt == 7:
                    raise
                log(f"Fulcrum {method}: {exc!r}; reconnecting")
                time.sleep(min(60, 2 ** attempt))

    def tip(self) -> tuple[int, str]:
        header = self.call("blockchain.headers.subscribe")
        raw = bytes.fromhex(header["hex"])
        return header["height"], hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()


class Rest:
    """Bitcoin Core REST with one keep-alive connection per thread."""

    def __init__(self, base: str):
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme != "http" or not parsed.hostname:
            raise ValueError("--rest must look like http://127.0.0.1:18352")
        self.host, self.port, self.prefix = parsed.hostname, parsed.port or 80, parsed.path.rstrip("/")
        self.local = threading.local()

    def get(self, path: str, missing_ok: bool = False) -> bytes | None:
        """Body of a 200 reply; retries 503s and connection errors for up to REST_RETRY_SECONDS."""
        delay, deadline = 0.1, time.monotonic() + REST_RETRY_SECONDS
        while True:
            connection = getattr(self.local, "connection", None)
            if connection is None:
                connection = self.local.connection = http.client.HTTPConnection(self.host, self.port, timeout=60)
            try:
                connection.request("GET", self.prefix + path)
                response = connection.getresponse()
                body = response.read()
            except (OSError, http.client.HTTPException) as exc:
                connection.close()
                self.local.connection = None
                problem = repr(exc)
            else:
                if response.status == 200:
                    return body
                if response.status == 404 and missing_ok:
                    return None
                if response.status != 503:
                    raise RuntimeError(f"REST {path}: HTTP {response.status} {body[:200]!r}")
                problem = "HTTP 503"
            if time.monotonic() > deadline:
                raise RuntimeError(f"REST {path}: still failing after {REST_RETRY_SECONDS} s ({problem})")
            time.sleep(delay)
            delay = min(delay * 2, 10)


def read_varint(raw: bytes, pos: int) -> tuple[int, int]:
    first = raw[pos]
    if first < 0xFD:
        return first, pos + 1
    size = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    return int.from_bytes(raw[pos + 1:pos + 1 + size], "little"), pos + 1 + size


def parse_tx(raw: bytes) -> tuple[str, list[tuple[str, int]], list[tuple[int, bytes]]]:
    """(txid, inputs as (previous txid, vout), outputs as (sats, scriptPubKey)) of a serialized transaction."""
    segwit = len(raw) > 6 and raw[4] == 0 and raw[5] != 0
    pos = 6 if segwit else 4
    count, pos = read_varint(raw, pos)
    inputs = []
    for _ in range(count):
        inputs.append((raw[pos:pos + 32][::-1].hex(), int.from_bytes(raw[pos + 32:pos + 36], "little")))
        length, pos = read_varint(raw, pos + 36)
        pos += length + 4
    count, pos = read_varint(raw, pos)
    outputs = []
    for _ in range(count):
        sats = int.from_bytes(raw[pos:pos + 8], "little")
        length, pos = read_varint(raw, pos + 8)
        outputs.append((sats, raw[pos:pos + length]))
        pos += length
    body_end = pos
    if segwit:
        for _ in inputs:
            items, pos = read_varint(raw, pos)
            for _ in range(items):
                length, pos = read_varint(raw, pos)
                pos += length
    if pos + 4 != len(raw):
        raise ValueError("transaction length does not match its contents")
    stripped = raw[:4] + raw[6:body_end] + raw[pos:] if segwit else raw
    return hashlib.sha256(hashlib.sha256(stripped).digest()).digest()[::-1].hex(), inputs, outputs


def cache_entry(txid: str, height: int, raw: bytes, scripts: dict[bytes, int], history: dict) -> dict:
    """What the records need from one transaction: outputs paying listed scripts, inputs spending history txs."""
    parsed, inputs, outputs = parse_tx(raw)
    if parsed != txid:
        raise ValueError(f"REST returned transaction {parsed} for {txid}")
    return dict(t=txid, h=height, g=len(scripts),
                o=[[vout, sats, scripts[script]] for vout, (sats, script) in enumerate(outputs) if script in scripts],
                i=[[prev, vout] for prev, vout in inputs if prev in history])


# --- extraction ------------------------------------------------------------------------

def load_spec(path: Path) -> list[dict]:
    entities = json.loads(path.read_text())["entities"]
    if not 1 <= len(entities) <= MAX_ENTITIES:
        raise ValueError(f"the spec needs 1 to {MAX_ENTITIES} entities")
    seen = set()
    for entity in entities:
        if not re.fullmatch(r"[a-z0-9-]{1,32}", entity["id"]) or entity["id"] in seen:
            raise ValueError(f"bad or repeated entity id {entity['id']!r}")
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", entity["color"]):
            raise ValueError(f"{entity['id']}: color must be #RRGGBB")
        if not (entity["name"] and entity["catalogEntity"] and entity["evidenceTypes"]):
            raise ValueError(f"{entity['id']}: name, catalogEntity and evidenceTypes are required")
        seen.add(entity["id"])
    return entities


def select_addresses(entities: list[dict], labels_csv: Path) -> dict[str, dict]:
    """Catalog rows matching a spec entity and one of its evidence types, with their evidence."""
    wanted = {(entity["catalogEntity"], kind): entity["id"] for entity in entities for kind in entity["evidenceTypes"]}
    selected = {}
    with labels_csv.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            entity = wanted.get((row["entity"], row["evidence_type"]))
            if entity is None:
                continue
            address = labels.normalize_address(row["address"])
            item = selected.setdefault(address, dict(address=address, entity=entity, evidence=[]))
            if item["entity"] != entity:
                raise ValueError(f"{address} is listed for both {item['entity']} and {entity}")
            evidence = dict(type=row["evidence_type"], source=row["source"], observed=row["observed_date"])
            if evidence not in item["evidence"]:
                item["evidence"].append(evidence)
    return selected


def scripthash(script: bytes) -> str:
    return hashlib.sha256(script).digest()[::-1].hex()


def fetch_history(client, sh: str, start: int, end: int, on_page) -> None:
    """Confirmed history with start <= height < end, in height pages that adapt to its density."""
    lo, span = start, max(1, min(end - start, MAX_SPAN))
    while lo < end:
        hi = min(end, lo + span)
        try:
            items = client.request("blockchain.scripthash.get_history", sh, lo, hi)
        except (FulcrumError, OSError, ValueError) as exc:
            if hi - lo == 1:
                raise RuntimeError(f"history of {sh} at block {lo} keeps failing: {exc!r}") from exc
            span = (hi - lo) // 2
            log(f"history [{lo}, {hi}) failed ({exc!r}); retrying with {span} blocks")
            if not isinstance(exc, FulcrumError):
                time.sleep(1)
            continue
        page = [(item["height"], item["tx_hash"]) for item in items if item["height"] > 0]
        if any(not lo <= height < hi for height, _ in page):
            raise RuntimeError(f"Fulcrum returned history outside [{lo}, {hi}) for {sh}")
        on_page(hi, page)
        lo = hi
        if len(page) > PAGE_ITEMS:
            span = max(1, span * PAGE_ITEMS // len(page))
        elif len(page) < PAGE_ITEMS // 2:
            span = min(MAX_SPAN, span * 2)


def whole_history(client, address: str, sh: str, end: int) -> list[tuple[int, str]] | None:
    """An uncached address's confirmed history below end from one unranged request, or None when
    Fulcrum refuses or drops it (a history too big for its client buffer), so it is paged instead."""
    try:
        reply = client.request("blockchain.scripthash.get_history", sh)
    except (FulcrumError, OSError, ValueError) as exc:
        log(f"{address}: whole history refused ({exc!r}); paging it")
        return None
    return sorted((item["height"], item["tx_hash"]) for item in reply if 0 < item["height"] < end)


def update_history(client, folder: Path, address: str, sh: str, end: int) -> tuple[list[tuple[int, str]], int | None]:
    """Cached confirmed history below end; only blocks the cache lacks are fetched."""
    meta_path, items_path = folder / f"{sh}.json", folder / f"{sh}.tsv"
    if not meta_path.exists():  # most histories are small: one request instead of a page per 16,128 blocks
        whole = whole_history(client, address, sh, end)
        if whole is not None:
            with items_path.open("w") as stream:
                stream.writelines(f"{height}\t{txid}\n" for height, txid in whole)
            first = whole[0][0] if whole else None
            write_json(meta_path, dict(address=address, firstUse=first, through=end))
            return whole, first
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else dict(address=address, firstUse=None, through=0)
    if meta["firstUse"] is None:
        first = client.call("blockchain.scripthash.get_first_use", sh)
        if first and first.get("height", 0) > 0:
            meta["firstUse"] = first["height"]
    start = min(end, max(meta["through"] - REORG_DEPTH, meta["firstUse"] if meta["firstUse"] is not None else end))
    # Lines at or above start are fetched again: recent blocks may reorganise, and an
    # interrupted page can leave lines past the recorded "through" height.
    items, rewrite = [], False
    if items_path.exists():
        with items_path.open() as stream:
            for line in stream:
                height, txid = line.split()
                if int(height) < min(start, meta["through"]):
                    items.append((int(height), txid))
                else:
                    rewrite = True
    if rewrite:
        with items_path.open("w") as stream:
            stream.writelines(f"{height}\t{txid}\n" for height, txid in items)
    meta["through"] = start
    write_json(meta_path, meta)
    pages = [0]

    def on_page(hi: int, page: list) -> None:
        with items_path.open("a") as stream:
            stream.writelines(f"{height}\t{txid}\n" for height, txid in page)
        items.extend(page)
        meta["through"] = hi
        write_json(meta_path, meta)
        pages[0] += 1

    fetch_history(client, sh, start, end, on_page)
    meta["through"] = end
    write_json(meta_path, meta)
    if pages[0] > 1:
        log(f"{address}: {len(items)} history items ({pages[0]} pages)")
    return items, meta["firstUse"]


def load_cache(path: Path) -> dict[str, tuple]:
    """txid -> (script generation, outputs, inputs); a line cut off by an interrupted run is dropped."""
    cache = {}
    if not path.exists():
        return cache
    with path.open("rb+") as stream:
        good = 0
        for line in stream:
            if not line.endswith(b"\n"):
                break
            entry = json.loads(line)
            cache[entry["t"]] = (entry["g"], entry["o"], entry["i"])
            good += len(line)
        stream.truncate(good)
    return cache


def fetch_transactions(rest: Rest, wanted: list[tuple[str, int]], concurrency: int, entry_for, write) -> None:
    """Fetch and parse wanted (txid, height) pairs on worker threads; write() runs on this thread."""
    lock, items, stop = threading.Lock(), iter(wanted), threading.Event()
    results = queue.Queue(maxsize=concurrency * 64)

    def worker() -> None:
        try:
            while not stop.is_set():
                with lock:
                    item = next(items, None)
                if item is None:
                    break
                txid, height = item
                results.put(("entry", entry_for(txid, height, rest.get(f"/rest/tx/{txid}.bin"))))
        except BaseException as exc:  # noqa: BLE001 - reported on the main thread
            results.put(("error", exc))
        finally:
            results.put(("done", None))

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, concurrency))]
    for thread in threads:
        thread.start()
    finished = done = 0
    started = last = time.monotonic()
    while finished < len(threads):
        kind, value = results.get()
        if kind == "done":
            finished += 1
        elif kind == "error":
            stop.set()
            raise value
        else:
            write(value)
            done += 1
            now = time.monotonic()
            if now - last >= 30:
                rate = done / (now - started)
                log(f"transactions {done}/{len(wanted)} ({rate:.0f}/s, {(len(wanted) - done) / rate / 60:.1f} min left)")
                last = now


class Extraction:
    """Histories, transaction cache and records for one work directory."""

    def __init__(self, work: Path, selected: dict[str, dict], client, rest, concurrency: int):
        self.work, self.selected, self.client, self.rest, self.concurrency = work, selected, client, rest, concurrency
        (work / "history").mkdir(parents=True, exist_ok=True)
        scripts_path = work / "scripts.json"
        # Append-only so cached script indexes stay valid when addresses are added.
        self.scripts_list = json.loads(scripts_path.read_text()) if scripts_path.exists() else []
        known = {item["address"] for item in self.scripts_list}
        self.scripts_list += [dict(address=address, script=labels.address_script(address).hex())
                              for address in sorted(selected) if address not in known]
        write_json(scripts_path, self.scripts_list)
        self.scripts = {bytes.fromhex(item["script"]): index for index, item in enumerate(self.scripts_list)}
        self.index = {item["address"]: index for index, item in enumerate(self.scripts_list)}
        self.sh = {address: scripthash(labels.address_script(address)) for address in selected}
        self.cache = load_cache(work / "txs.jsonl")
        self.history, self.first_use = {}, {}

    def update(self, tip: int) -> None:
        """Bring every history and the transaction cache up to tip."""
        for address in sorted(self.selected):
            self.history[address], self.first_use[address] = update_history(
                self.client, self.work / "history", address, self.sh[address], tip + 1)
        height_of, required = {}, {}
        for address, items in self.history.items():
            generation = self.index[address] + 1
            for height, txid in items:
                height_of[txid] = height
                required[txid] = max(required.get(txid, 0), generation)
        wanted = sorted(((txid, height_of[txid]) for txid, generation in required.items()
                         if self.cache.get(txid, (0,))[0] < generation), key=lambda item: item[1])
        log(f"tip {tip}: {sum(map(len, self.history.values()))} history items, "
            f"{len(height_of)} transactions, {len(wanted)} to fetch")
        if not wanted:
            return
        with (self.work / "txs.jsonl").open("a") as stream:
            def write(entry: dict) -> None:
                stream.write(json.dumps(entry, separators=(",", ":")) + "\n")
                self.cache[entry["t"]] = (entry["g"], entry["o"], entry["i"])
            fetch_transactions(self.rest, wanted, self.concurrency,
                               lambda txid, height, raw: cache_entry(txid, height, raw, self.scripts, height_of), write)


def build_records(history: dict[str, list], cache: dict[str, tuple], scripts_list: list[dict],
                  selected: dict[str, dict], tip: int) -> tuple[list[tuple], list[str]]:
    """(txid, vout, address, entity, created, spent or None, sats) for every listed output up to tip, plus problems."""
    problems, height_of = [], {}
    for items in history.values():
        for height, txid in items:
            if height <= tip and height_of.setdefault(txid, height) != height:
                problems.append(f"{txid} appears at heights {height_of[txid]} and {height}")
    spender = {}
    for txid in height_of:
        if txid not in cache:
            problems.append(f"{txid} was never fetched")
            continue
        for prev, vout in cache[txid][2]:
            if spender.setdefault((prev, vout), txid) != txid:
                problems.append(f"{prev}:{vout} is spent by {spender[(prev, vout)]} and {txid}")
    if problems:
        return [], problems
    records, explained = [], defaultdict(set)
    for txid, height in height_of.items():
        for vout, sats, index in cache[txid][1]:
            address = scripts_list[index]["address"]
            if address not in selected:
                continue
            spend = spender.get((txid, vout))
            records.append((txid, vout, address, selected[address]["entity"], height,
                            height_of[spend] if spend else None, sats))
            explained[address].add(txid)
            if spend:
                explained[address].add(spend)
    for address, items in history.items():
        listed = {txid for height, txid in items if height <= tip}
        if listed != explained[address]:
            problems.append(f"{address}: {len(listed - explained[address])} history transactions neither pay nor "
                            f"spend it; {len(explained[address] - listed)} of its spends are missing from its history")
    records.sort(key=lambda record: (record[4], record[0], record[1]))
    return records, problems


def verify(client, rest: Rest, records: list[tuple], sh: dict[str, str], tip: int) -> tuple[dict, list[dict], bool]:
    """Compare unspent records with confirmed listunspent at tip. Returns (per address, mismatches, chain moved)."""
    unspent = defaultdict(dict)
    for txid, vout, address, _, _, spent, sats in records:
        if spent is None:
            unspent[address][(txid, vout)] = sats
    results, mismatches, moved = {}, [], False
    for address in sorted(sh):
        listed = {}
        for item in client.call("blockchain.scripthash.listunspent", sh[address]):
            if item["height"] > tip:
                moved = True
            elif item["height"] > 0:
                listed[(item["tx_hash"], item["tx_pos"])] = item["value"]
        ours = unspent[address]
        missing, in_mempool = ours.keys() - listed.keys(), set()
        if missing:
            for entry in client.call("blockchain.scripthash.get_mempool", sh[address]):
                raw = rest.get(f"/rest/tx/{entry['tx_hash']}.bin", missing_ok=True)
                if raw is None:
                    moved = True
                else:
                    in_mempool.update(parse_tx(raw)[1])
        unexplained = sorted(missing - in_mempool)
        extra = sorted(listed.keys() - ours.keys())
        wrong = sorted(key for key in listed.keys() & ours.keys() if listed[key] != ours[key])
        results[address] = dict(verified=not (unexplained or extra or wrong), listunspent=len(listed),
                                spentInMempool=len(missing & in_mempool))
        if unexplained or extra or wrong:
            mismatches.append(dict(address=address,
                                   recordsNotInListunspent=[f"{t}:{n}" for t, n in unexplained[:50]],
                                   listunspentNotInRecords=[f"{t}:{n}" for t, n in extra[:50]],
                                   amountDiffers=[f"{t}:{n}" for t, n in wrong[:50]],
                                   counts=[len(unexplained), len(extra), len(wrong)]))
    return results, mismatches, moved


def extract(args) -> int:
    entities = load_spec(args.spec)
    selected = select_addresses(entities, args.labels)
    if not selected:
        raise SystemExit("no catalog address matches the spec")
    log(f"{len(selected)} addresses from {args.labels.name}")
    client, rest = Fulcrum(args.fulcrum), Rest(args.rest)
    run = Extraction(args.work, selected, client, rest, args.concurrency)
    start = tip, tip_hash = client.tip()
    log(f"Fulcrum tip {tip} {tip_hash}")
    for round_number in range(1, 11):
        run.update(tip)
        now = client.tip()
        if now != (tip, tip_hash):  # blocks arrived while fetching: catch up before verifying
            log(f"the chain moved to {now[0]} while updating")
            tip, tip_hash = now
            continue
        records, problems = build_records(run.history, run.cache, run.scripts_list, selected, tip)
        if problems:
            write_json(args.work / "extract-problems.json", problems)
            log(f"{len(problems)} consistency problems, first: {problems[0]}")
            return 1
        results, mismatches, moved = verify(client, rest, records, run.sh, tip)
        now = client.tip()
        if not moved and now == (tip, tip_hash):
            break
        log(f"the chain moved to {now[0]} during verification; updating")
        tip, tip_hash = now
    else:
        raise RuntimeError("the chain kept moving during verification")
    if mismatches:
        write_json(args.work / "verify-failures.json", dict(tip=tip, mismatches=mismatches))
        log(f"listunspent disagrees for {len(mismatches)} addresses; see verify-failures.json")
        return 1
    with gzip.open(args.work / "records.csv.gz", "wt", newline="", compresslevel=6) as stream:
        writer = csv.writer(stream)
        writer.writerow(RECORD_FIELDS)
        writer.writerows((*record[:5], "" if record[5] is None else record[5], record[6]) for record in records)
    per_address = defaultdict(lambda: dict(records=0, unspent=0, unspentSats=0))
    for _, _, address, _, _, spent, sats in records:
        per_address[address]["records"] += 1
        if spent is None:
            per_address[address]["unspent"] += 1
            per_address[address]["unspentSats"] += sats
    addresses = [dict(address=address, entity=selected[address]["entity"], scripthash=run.sh[address],
                      evidence=selected[address]["evidence"], history=len(run.history[address]),
                      firstUse=run.first_use[address], **per_address[address], **results[address])
                 for address in sorted(selected)]
    totals = dict(addresses=len(addresses), historyItems=sum(item["history"] for item in addresses),
                  transactions=len({txid for items in run.history.values() for _, txid in items}),
                  records=len(records), unspent=sum(item["unspent"] for item in addresses),
                  unspentSats=sum(item["unspentSats"] for item in addresses),
                  verified=all(item["verified"] for item in addresses))
    write_json(args.work / "extract.json", dict(
        format="utxo-landscape-owner-extract-1", createdUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
        startTip=start[0], fulcrumTip=tip, fulcrumTipHash=tip_hash, rounds=round_number,
        labels=dict(file=args.labels.name, path=str(args.labels.resolve()), sha256=labels.sha256(args.labels)),
        entities=entities, totals=totals, addresses=addresses))
    log(f"{totals['records']} records, {totals['unspent']} unspent; listunspent matches every address at {tip}")
    return 0


# --- preflight ---------------------------------------------------------------------------

def running_jobs(folder: Path) -> list[str]:
    """pid files in folder whose process is a live landscape_owners.py run other than this one."""
    alive = []
    for path in sorted(folder.glob("*.pid")):
        try:
            pid = int(path.read_text().split()[0])
        except (ValueError, IndexError):
            continue
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
        if pid != os.getpid() and "landscape_owners.py" in command:
            alive.append(f"{path.name} ({pid})")
    return alive


class CountingClient:
    """A Fulcrum client that counts its calls and the whole-history requests Fulcrum refused."""

    def __init__(self, client):
        self.client, self.calls, self.refused = client, 0, 0

    def request(self, method: str, *params):
        self.calls += 1
        try:
            return self.client.request(method, *params)
        except (FulcrumError, OSError, ValueError):
            self.refused += method == "blockchain.scripthash.get_history" and len(params) == 1
            raise

    def call(self, method: str, *params):
        self.calls += 1
        return self.client.call(method, *params)


def preflight(args) -> int:
    """Cache the history of every spec address the extraction does not know yet and estimate the
    node work left. Fulcrum only: no transactions are fetched and scripts.json is not touched."""
    jobs = running_jobs(args.work.parent)
    if jobs:
        raise SystemExit(f"an owner job is running ({', '.join(jobs)}); leave the node alone until it ends")
    entities = load_spec(args.spec)
    selected = select_addresses(entities, args.labels)
    scripts_path = args.work / "scripts.json"
    known = {item["address"] for item in json.loads(scripts_path.read_text())} if scripts_path.exists() else set()
    cached = set()
    if (args.work / "txs.jsonl").exists():
        with (args.work / "txs.jsonl").open("rb") as stream:  # lines start {"t":"<txid>"; a cut-off last line is skipped
            cached = {int(line[6:22], 16) for line in stream if line.endswith(b"\n")}
    client = CountingClient(Fulcrum(args.fulcrum))
    tip, tip_hash = client.client.tip()
    folder = args.work / "history"
    folder.mkdir(parents=True, exist_ok=True)
    stats = {entity["id"]: dict(addresses=0, cached=0, new=0, empty=0, history=0, calls=0, refused=0,
                                seconds=0.0, pagerCallsBefore=0) for entity in entities}
    flagged, wanted = [], set()
    log(f"tip {tip}: {len(selected)} addresses, {len(set(selected) - known)} new, {len(cached)} cached transactions")
    started = last = time.monotonic()
    for number, address in enumerate(sorted(selected), 1):
        item = stats[selected[address]["entity"]]
        item["addresses"] += 1
        sh = scripthash(labels.address_script(address))
        if address in known:  # the extraction updates these from its cache
            item["cached"] += 1
            lines = (folder / f"{sh}.tsv").stat().st_size // 72 if (folder / f"{sh}.tsv").exists() else 0
            if lines >= FLAG_ITEMS:
                flagged.append(dict(address=address, entity=selected[address]["entity"], history=lines, cached=True))
            continue
        calls, refused, began = client.calls, client.refused, time.monotonic()
        items, first = update_history(client, folder, address, sh, tip + 1)
        item["new"] += 1
        item["empty"] += not items
        item["history"] += len(items)
        item["calls"] += client.calls - calls
        item["refused"] += client.refused - refused
        item["seconds"] += time.monotonic() - began
        if first is not None:  # what the page-per-16,128-blocks pager would have needed
            item["pagerCallsBefore"] += 1 + -(-(tip + 1 - first) // MAX_SPAN)
        if len(items) >= FLAG_ITEMS:
            flagged.append(dict(address=address, entity=selected[address]["entity"], history=len(items)))
        wanted.update(int(txid[:16], 16) for _, txid in items)
        if time.monotonic() - last >= 60:
            last = time.monotonic()
            log(f"{number}/{len(selected)} addresses, {len(wanted)} transactions, {client.calls} calls")
            jobs = running_jobs(args.work.parent)
            if jobs:  # each address's cache files are complete, so a later run resumes here
                raise SystemExit(f"an owner job started ({', '.join(jobs)}); stopped after {number} addresses")
    for item in stats.values():
        item["seconds"] = round(item["seconds"], 1)
    new = sum(item["new"] for item in stats.values())
    history = sum(item["history"] for item in stats.values())
    totals = dict(addresses=len(selected), cached=len(selected) - new, new=new, historyItems=history,
                  transactions=len(wanted), transactionsInCache=len(wanted & cached), calls=client.calls,
                  refusedWholeHistories=client.refused, seconds=round(time.monotonic() - started, 1),
                  pagerCallsBefore=sum(item["pagerCallsBefore"] for item in stats.values()))
    write_json(args.out, dict(
        format="utxo-landscape-owner-preflight-1", createdUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
        tip=tip, tipHash=tip_hash, spec=str(args.spec.resolve()),
        labels=dict(file=args.labels.name, path=str(args.labels.resolve()), sha256=labels.sha256(args.labels)),
        entities=stats, totals=totals, flagged=flagged,
        estimate=dict(
            note=("Every transaction in a new address's history is fetched, cached or not: a cached entry records "
                  "only the outputs paying the addresses known when it was parsed. Addresses already in the "
                  "extraction add only the blocks since its last tip."),
            transactions=len(wanted), hoursAt440=round(len(wanted) / 440 / 3600, 2),
            hoursAt650=round(len(wanted) / 650 / 3600, 2), txCacheBytes=len(wanted) * 190,
            historyCacheBytes=history * 72)))
    log(f"{new} new addresses: {history} history items, {len(wanted)} transactions "
        f"({len(wanted & cached)} already cached), {client.calls} calls in {totals['seconds']} s; "
        f"{len(flagged)} flagged; wrote {args.out}")
    return 0


# --- owner dataset -------------------------------------------------------------------

def varuint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte, value = value & 0x7F, value >> 7
        if not value:
            out.append(byte)
            return bytes(out)
        out.append(byte | 0x80)


def encode_records(records: list[tuple[int, int, int, int]]) -> bytes:
    """Record file bytes for (created, entity, sats, life) tuples, sorted in that order."""
    records = sorted(records)
    out, previous = bytearray(MAGIC + struct.pack("<II", 1, len(records))), 0
    for created, entity, sats, life in records:
        if not (0 < sats <= MAX_SATS and 0 <= entity < MAX_ENTITIES and life >= 0
                and created + life < 0xFFFFFFFF):
            raise ValueError(f"record out of range: {(created, entity, sats, life)}")
        out += varuint(created - previous) + varuint(life) + varuint(sats) + varuint(entity)
        previous = created
    return bytes(out)


def evidence_summary(addresses: list[dict], entity: dict) -> list[dict]:
    summary = {kind: dict(addresses=set(), sources=set(), dates=[]) for kind in entity["evidenceTypes"]}
    for item in addresses:
        if item["entity"] == entity["id"]:
            for evidence in item["evidence"]:
                kind = summary[evidence["type"]]
                kind["addresses"].add(item["address"])
                kind["sources"].add(urllib.parse.urlsplit(evidence["source"]).hostname)
                kind["dates"].append(evidence["observed"])
    return [dict(type=kind, addresses=len(value["addresses"]), sources=sorted(value["sources"]),
                 firstObserved=min(value["dates"]), lastObserved=max(value["dates"]))
            for kind, value in summary.items() if value["dates"]]


def write_dataset(rows, extract_info: dict, tip: int, tip_hash: str, ident: str, out_root: Path) -> Path:
    """Write the owner dataset for (txid, vout, address, entity id, created, spent or None, sats) rows."""
    out = out_root / ident
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} exists and is not empty")
    entities = extract_info["entities"]
    index = {entity["id"]: number for number, entity in enumerate(entities)}
    totals = [dict(records=0, unspent=0, unspentSats=0) for _ in entities]
    long, short = [], defaultdict(list)
    for _, _, _, entity_id, created, spent, sats in rows:
        if spent is not None and spent < created:
            raise ValueError(f"record spent at {spent} before its creation at {created}")
        if created > tip or sats == 0 or spent == created:
            continue
        life = 0 if spent is None or spent > tip else spent - created
        entity = index[entity_id]
        (long if life == 0 or life > SHORT_LIFE else short[created // SHORT_LIFE]).append((created, entity, sats, life))
        totals[entity]["records"] += 1
        if life == 0:
            totals[entity]["unspent"] += 1
            totals[entity]["unspentSats"] += sats
    out_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{ident}.", dir=out_root))
    try:
        staging.chmod(0o755)  # mkdtemp makes it private; the dataset is served and uploaded
        (staging / "short").mkdir()

        def save(name: str, records: list) -> dict:
            data = encode_records(records)
            (staging / name).write_bytes(data)
            return dict(file=name, records=len(records), bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

        files = dict(long=save("long.bin", long),
                     short=[dict(chunk=chunk, **save(f"short/{chunk:04d}.bin", short[chunk])) for chunk in sorted(short)])
        summary = [dict(id=entity["id"], name=entity["name"], color=entity["color"],
                        addresses=sum(item["entity"] == entity["id"] for item in extract_info["addresses"]),
                        **totals[number], evidence=evidence_summary(extract_info["addresses"], entity))
                   for number, entity in enumerate(entities)]
        write_json(staging / "owners.json", dict(
            format="utxo-landscape-owners-1", id=ident,
            createdUtc=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            tip=tip, tipHash=tip_hash, shortLife=SHORT_LIFE, entities=summary, files=files,
            source=dict(fulcrumTip=extract_info["fulcrumTip"],
                        labels=dict(file=extract_info["labels"]["file"], sha256=extract_info["labels"]["sha256"]),
                        method=METHOD)))
        if out.exists():
            out.rmdir()
        staging.rename(out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return out


def read_records(path: Path):
    with gzip.open(path, "rt", newline="") as stream:
        for row in csv.DictReader(stream):
            yield (row["txid"], int(row["vout"]), row["address"], row["entity"], int(row["created"]),
                   int(row["spent"]) if row["spent"] else None, int(row["sats"]))


def build(args) -> int:
    extract_info = json.loads((args.work / "extract.json").read_text())
    if not 0 <= args.tip <= extract_info["fulcrumTip"]:
        raise SystemExit(f"--tip must be at most the extraction tip {extract_info['fulcrumTip']}; rerun extract")
    ident = args.id or f"o{args.tip}-{dt.date.today():%Y%m%d}"
    if not re.fullmatch(r"o\d{1,7}-\d{8}", ident):  # the form landscape/web/replay/owners.js accepts
        raise SystemExit(f"dataset id {ident!r} must look like o<tip>-<YYYYMMDD>")
    tip_hash = Rest(args.rest).get(f"/rest/blockhashbyheight/{args.tip}.hex").decode().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", tip_hash):
        raise SystemExit(f"unexpected block hash reply {tip_hash[:80]!r}")
    out = write_dataset(read_records(args.work / "records.csv.gz"), extract_info, args.tip, tip_hash,
                        ident, args.out_root)
    manifest = json.loads((out / "owners.json").read_text())
    log(f"wrote {out}: long {manifest['files']['long']['records']} records, "
        f"{len(manifest['files']['short'])} short chunks")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("fetch-sources", help="archive exchanges' published address lists as supplements")
    fetch.add_argument("--registry", type=Path, default=sources.REGISTRY)
    fetch.add_argument("--out", type=Path, required=True, help="research folder, e.g. labels-YYYYMMDD/research")
    fetch.add_argument("--source", action="append", default=[], help="source id to run (repeatable; default: all active)")
    fetch.add_argument("--reuse", type=Path, action="append", default=[],
                       help="earlier research folder whose recorded archives are linked instead of downloaded")
    fetch.add_argument("--discover", action="store_true", help="instead, archive the seed lists into candidates.json")
    fetch.add_argument("--tagpacks-dir", type=Path, help="GraphSense checkout, for --discover")
    fetch.add_argument("--catalog", type=Path, help="current catalog folder, for --discover")
    report = commands.add_parser("coverage-report", help="summarise a built label catalog per entity")
    report.add_argument("--labels", type=Path, required=True, help="catalog folder, labels-YYYYMMDD")
    report.add_argument("--registry", type=Path, default=sources.REGISTRY)
    report.add_argument("--research", type=Path, required=True)
    report.add_argument("--out", type=Path, required=True, help="JSON path; the Markdown is written beside it")
    pre = commands.add_parser("preflight", help="cache new addresses' histories and estimate the extraction")
    ext = commands.add_parser("extract", help="trace every output paying the spec's addresses")
    for command in (pre, ext):
        command.add_argument("--spec", type=Path, required=True)
        command.add_argument("--labels", type=Path, required=True,
                             help="resolved catalog CSV, e.g. labels_extended_resolved.csv")
        command.add_argument("--fulcrum", required=True, help="host:port of a plaintext Fulcrum server")
        command.add_argument("--work", type=Path, required=True)
    pre.add_argument("--out", type=Path, required=True, help="preflight JSON")
    ext.add_argument("--rest", required=True, help="Bitcoin Core REST base URL")
    # The node is disk-bound: more parallel reads only queue in bitcoind's work queue.
    ext.add_argument("--concurrency", type=int, default=12, help="parallel REST requests (default 12)")
    bld = commands.add_parser("build", help="cut the records at a landscape tip into an owner dataset")
    bld.add_argument("--work", type=Path, required=True)
    bld.add_argument("--tip", type=int, required=True)
    bld.add_argument("--rest", required=True)
    bld.add_argument("--out-root", type=Path, required=True)
    bld.add_argument("--id", help="dataset id; default o<tip>-<today>")
    args = parser.parse_args(argv)
    if args.command == "fetch-sources" and args.discover:
        print(json.dumps(sources.discover(args.registry, args.out, args.tagpacks_dir, catalog=args.catalog), indent=2))
        return 0
    if args.command == "fetch-sources":
        return sources.fetch_sources(args.registry, args.out, args.source, args.reuse)
    if args.command == "coverage-report":
        print(json.dumps(sources.coverage_report(args.labels, args.registry, args.research, args.out), indent=2))
        return 0
    return dict(preflight=preflight, extract=extract, build=build)[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

