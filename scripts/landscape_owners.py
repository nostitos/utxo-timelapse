#!/usr/bin/env python3
"""Owner highlight data for the 3D landscape (docs/landscape-owners.md).

  por-binance  Binance's monthly proof-of-reserves lists -> exact-address label supplement
  extract      every output paying the spec's exact addresses, from Fulcrum history and
               Bitcoin Core REST transactions, verified against Fulcrum's listunspent
  build        records cut at a landscape tip -> owner dataset read by the replay worker

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
import io
import json
import os
import queue
import re
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import address_coverage_labels as labels  # noqa: E402

POR_URL = "https://public.bnbstatic.com/static/proof-of-reserve/wallet_address_{}01.zip"
POR_LANDING = "https://www.binance.com/en/proof-of-reserves"
SHORT_LIFE = 4032
MAGIC = b"BUVOWN1\0"
MAX_SATS = 2_100_000_000_000_000
MAX_ENTITIES = 254
PAGE_ITEMS = 30_000        # ~3 MB of JSON per history page, well under Fulcrum's 10 MB client buffer
MAX_SPAN = 16_128          # blocks per page; bounds a page that runs from sparse into dense history
REORG_DEPTH = 6            # cached history this close to the previous tip is fetched again
REST_RETRY_SECONDS = 900   # long enough to restart a dropped tunnel
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


# --- Binance proof-of-reserves lists -------------------------------------------------

def month_list(first: str, last: str) -> list[str]:
    """Inclusive YYYY-MM range as YYYYMM strings."""
    year, month = map(int, first.split("-"))
    end = tuple(map(int, last.split("-")))
    months = []
    while (year, month) <= end:
        months.append(f"{year:04d}{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def por_rows(path: Path, url: str, observed: str) -> tuple[list[dict], dict]:
    """BTC rows on the BTC network without a third-party custodian, from every CSV in one archive."""
    rows, lists = [], {}
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")
                 and not name.startswith("__MACOSX/") and not Path(name).name.startswith("._")]
        if not names:
            raise ValueError(f"{path.name}: archive has no lists")
        for name in names:
            lower = Path(name).name.lower()
            if not lower.endswith(".csv"):
                raise ValueError(f"{path.name}: unrecognised file {name}")
            kind = "deposit" if "deposit" in lower else "hot/cold" if "hotcold" in lower else "reserve wallet"
            with archive.open(name) as raw:
                reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                header = [field.strip().lower() for field in next(reader, [])]
                if not {"coin", "network", "address"} <= set(header):
                    raise ValueError(f"{path.name}/{name}: unrecognised layout {header}")
                coin, network, address = (header.index(key) for key in ("coin", "network", "address"))
                custodians = [index for index, field in enumerate(header) if "custodian" in field]
                height = header.index("height") if "height" in header else None
                btc = excluded = 0
                for record in reader:
                    if not record:
                        continue
                    if len(record) != len(header):
                        raise ValueError(f"{path.name}/{name} line {reader.line_num}: "
                                         f"{len(record)} fields under a {len(header)}-field header")
                    if record[coin].strip().upper() != "BTC" or record[network].strip().upper() != "BTC":
                        continue
                    btc += 1
                    if any(record[index].strip() for index in custodians):
                        excluded += 1
                        continue
                    at = f" (BTC height {record[height].strip()})" if height is not None and record[height].strip() else ""
                    rows.append(dict(
                        address=labels.normalize_address(record[address]), entity="Binance", source=url,
                        observed_date=observed, confidence="publicly_reported", evidence_type="service_disclosure",
                        historical_note=(f"Binance proof-of-reserves {kind} list, snapshot {observed}{at}. "
                                         "Rows naming a third-party custodian (such as Ceffu) are excluded. "
                                         "A snapshot is not proof of continuous control before or after it.")))
                lists[name] = dict(kind=kind, btc_rows=btc, custodian_rows_excluded=excluded)
    return rows, lists


def download(url: str, path: Path) -> int:
    """Fetch url into path; return the HTTP status (403 and 404 mean not published)."""
    request = urllib.request.Request(url, headers={"User-Agent": "utxo-landscape-owners/1"})
    for attempt in range(4):
        try:
            # A short timeout: the CDN name resolves to some addresses that never answer, and
            # each is tried in turn for this long.
            with urllib.request.urlopen(request, timeout=20) as response, path.open("wb") as stream:
                shutil.copyfileobj(response, stream, 1 << 20)
            return 200
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 404):
                return exc.code
            problem = exc
        except (OSError, http.client.HTTPException) as exc:
            problem = exc
        time.sleep(2 ** attempt)
    raise RuntimeError(f"{url}: {problem}")


def por_binance(out: Path, months: list[str], fetch=download) -> dict:
    """Archive each monthly list and write a supplement CSV plus the manifest load_supplement reads."""
    out.mkdir(parents=True, exist_ok=True)
    rows, sources, missing = {}, [], []
    for month in months:
        url = POR_URL.format(month)
        local = out / Path(urllib.parse.urlsplit(url).path).name
        observed = f"{month[:4]}-{month[4:]}-01"
        fetched_at = dt.datetime.now(dt.timezone.utc).isoformat()
        status = fetch(url, local)
        if status != 200:
            missing.append(dict(month=observed[:7], url=url, status=status, checked_at=fetched_at))
            log(f"{observed[:7]} not published (HTTP {status})")
            continue
        found, lists = por_rows(local, url, observed)
        for row in found:
            rows[tuple(row[key] for key in labels.FIELDS)] = row
        sources.append(dict(url=url, fetched_at=fetched_at, sha256=labels.sha256(local), license="not stated",
                            local_path=local.name, month=observed[:7], bytes=local.stat().st_size,
                            addresses=len({row["address"] for row in found}), lists=lists))
        log(f"{observed[:7]} {sources[-1]['addresses']} BTC addresses, "
            f"{sum(item['custodian_rows_excluded'] for item in lists.values())} custodian rows excluded")
    if not sources:
        raise ValueError("no Binance reserve list was published in the requested months")
    csv_path = out / "binance_por_labels.csv"
    labels.write_csv(csv_path, [rows[key] for key in sorted(rows)])
    counts = dict(published_months=len(sources), missing_months=len(missing), evidence_rows=len(rows),
                  unique_addresses=len({key[0] for key in rows}))
    write_json(out / "binance_por_supplement.json", dict(
        labels_csv=csv_path.name, labels_sha256=labels.sha256(csv_path), sources=sources, missing=missing,
        landing_page=POR_LANDING, generated_at=dt.datetime.now(dt.timezone.utc).isoformat(), counts=counts,
        policy=("coin == BTC and network == BTC from every CSV in each monthly archive; rows naming a "
                "third-party custodian are excluded; exact listed addresses only.")))
    return counts


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


def update_history(client, folder: Path, address: str, sh: str, end: int) -> tuple[list[tuple[int, str]], int | None]:
    """Cached confirmed history below end; only blocks the cache lacks are fetched."""
    meta_path, items_path = folder / f"{sh}.json", folder / f"{sh}.tsv"
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
    por = commands.add_parser("por-binance", help="archive Binance's monthly reserve lists as a label supplement")
    por.add_argument("--out", type=Path, required=True)
    por.add_argument("--from", dest="first", default="2022-11", help="first month, YYYY-MM")
    por.add_argument("--to", dest="last", default=f"{dt.date.today():%Y-%m}", help="last month, YYYY-MM")
    ext = commands.add_parser("extract", help="trace every output paying the spec's addresses")
    ext.add_argument("--spec", type=Path, required=True)
    ext.add_argument("--labels", type=Path, required=True, help="resolved catalog CSV, e.g. labels_extended_resolved.csv")
    ext.add_argument("--fulcrum", required=True, help="host:port of a plaintext Fulcrum server")
    ext.add_argument("--rest", required=True, help="Bitcoin Core REST base URL")
    ext.add_argument("--work", type=Path, required=True)
    # The node is disk-bound: more parallel reads only queue in bitcoind's work queue.
    ext.add_argument("--concurrency", type=int, default=12, help="parallel REST requests (default 12)")
    bld = commands.add_parser("build", help="cut the records at a landscape tip into an owner dataset")
    bld.add_argument("--work", type=Path, required=True)
    bld.add_argument("--tip", type=int, required=True)
    bld.add_argument("--rest", required=True)
    bld.add_argument("--out-root", type=Path, required=True)
    bld.add_argument("--id", help="dataset id; default o<tip>-<today>")
    args = parser.parse_args(argv)
    if args.command == "por-binance":
        print(json.dumps(por_binance(args.out, month_list(args.first, args.last)), indent=2))
        return 0
    return extract(args) if args.command == "extract" else build(args)


if __name__ == "__main__":
    sys.exit(main())

