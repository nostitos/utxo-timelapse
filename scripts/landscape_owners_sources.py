#!/usr/bin/env python3
"""Exact-address label supplements from exchanges' published Bitcoin address lists.

landscape_owners.py fetch-sources runs the sources in landscape_owners_sources.json
(docs/landscape-owners.md). Each source archives every file it reads with its URL, fetch time,
SHA-256 and stated licence, keeps the Bitcoin mainnet rows, and writes research/<id>/: the
archives, <id>_labels.csv, <id>_rejected.csv and <id>_supplement.json, which
address_coverage_labels.load_supplement accepts. An address enters only when a retained file
names it; nothing is clustered, expanded or inferred. A layout a parser does not recognise
fails its source. coverage-report summarises a built catalog per entity.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import html
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import address_coverage_labels as labels  # noqa: E402

FORMAT = "utxo-landscape-owner-sources-1"
REGISTRY = Path(__file__).resolve().parent / "landscape_owners_sources.json"
CONFIDENCE = {"service_disclosure": "publicly_reported",
              "service_disclosure_via_aggregator": "publicly_reported",
              "third_party_exact_tag": "third_party_reported"}
OPERATOR_TYPES = ("service_disclosure", "service_disclosure_via_graphsense", "service_disclosure_via_aggregator")
STATUSES = ("active", "reported_only", "no_public_list", "blocked_login", "blocked_antibot", "deferred")
CADENCES = ("monthly", "snapshot", "git", "live", "pinned")
AGENT = "utxo-landscape-owners/1"
BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
DELAY = {"web.archive.org": 3.0, "api.coingecko.com": 6.0}  # seconds between requests to one host, 1 otherwise
PAID = ("arkm.com", "arkhamintelligence.com", "nansen.ai", "chainalysis.com", "glassnode.com")
SNAPSHOT = "A listing is not proof of control before or after it."
ADDRESS_LIKE = re.compile(r"(?<![0-9A-Za-z])(?:bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})"
                          r"(?![0-9A-Za-z])", re.I)
_last_request: dict[str, float] = {}


def log(message: str) -> None:
    print(f"{dt.datetime.now():%H:%M:%S} {message}", flush=True)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path: Path, value) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def month_list(first: str, last: str) -> list[str]:
    """Inclusive YYYY-MM range as YYYYMM strings."""
    year, month = map(int, first.split("-"))
    end = tuple(map(int, last.split("-")))
    months = []
    while (year, month) <= end:
        months.append(f"{year:04d}{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def url_name(url: str) -> str:
    """A file name for url: its last path segment, plus its query."""
    parts = urllib.parse.urlsplit(url)
    name = Path(parts.path).name or parts.hostname or "index"
    if parts.query:
        stem, dot, ext = name.partition(".")
        name = f"{stem}.{re.sub(r'[^A-Za-z0-9]+', '-', parts.query).strip('-')}{dot}{ext}"
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name)[:120]


# --- registry ------------------------------------------------------------------------

def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def load_registry(path: Path) -> list[dict]:
    """Validated registry sources; the registry names sources, never addresses."""
    data = json.loads(path.read_text())
    if data.get("format") != FORMAT:
        raise ValueError(f"{path}: format must be {FORMAT}")
    seen = set()
    for source in data["sources"]:
        ident = source.get("id", "")
        if not re.fullmatch(r"[a-z0-9-]{1,32}", ident) or ident in seen:
            raise ValueError(f"bad or repeated source id {ident!r}")
        seen.add(ident)
        if source.get("status") not in STATUSES or source.get("cadence") not in CADENCES:
            raise ValueError(f"{ident}: status must be one of {STATUSES} and cadence one of {CADENCES}")
        entity = source.get("entity")
        if entity is not None and labels.normalize_entity(entity) != entity:
            raise ValueError(f"{ident}: entity {entity!r} is not the canonical name "
                             f"{labels.normalize_entity(entity)!r}")
        if not source.get("license") or not source.get("landing"):
            raise ValueError(f"{ident}: landing and license are required ('not stated' when none is)")
        if source["status"] != "active":
            continue
        if source.get("parse") not in PARSERS and source.get("parse") not in RUNNERS:
            raise ValueError(f"{ident}: unknown parse {source.get('parse')!r}")
        if source.get("parse") not in RUNNERS and source.get("fetch") not in ENUMERATORS:
            raise ValueError(f"{ident}: unknown fetch {source.get('fetch')!r}")
        if source.get("parse") not in MULTI_ENTITY:
            if entity is None or source.get("evidence_type") not in CONFIDENCE:
                raise ValueError(f"{ident}: entity and an evidence_type in {sorted(CONFIDENCE)} are required")
    for text in strings(data):
        for match in ADDRESS_LIKE.findall(text):
            try:
                labels.normalize_address(match)
            except ValueError:
                continue
            raise ValueError(f"the registry must not contain addresses ({match})")
    return data["sources"]


# --- fetching and archiving ------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the 3xx reaches the caller as an HTTPError


def http_get(url: str, path: Path, headers: dict | None = None, redirects: bool = True) -> tuple[int, dict]:
    """Stream url into path at most once a second per host. 304, 403, 404 and 410 are returned;
    so are redirects when redirects is false. Timeouts, 429 and 5xx are retried; anything else raises."""
    host = urllib.parse.urlsplit(url).hostname or ""
    request = urllib.request.Request(url, headers={"User-Agent": AGENT, **(headers or {})})
    opener = urllib.request.build_opener() if redirects else urllib.request.build_opener(NoRedirect)
    problem = None
    for attempt in range(5):
        pause = _last_request.get(host, 0.0) + DELAY.get(host, 1.0) - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        _last_request[host] = time.monotonic()
        try:
            # A short timeout: CDN names resolve to some addresses that never answer, and each is tried in turn.
            with opener.open(request, timeout=20) as response, path.open("wb") as stream:
                shutil.copyfileobj(response, stream, 1 << 20)
                headers_out = dict(response.headers)
            gzipped = headers_out.get("Content-Encoding", "").lower() == "gzip"
            if gzipped or (host == "web.archive.org" and path.read_bytes()[:2] == b"\x1f\x8b"):  # captures can be stored gzipped
                import gzip
                path.write_bytes(gzip.decompress(path.read_bytes()))
            return response.status, headers_out
        except urllib.error.HTTPError as exc:
            if exc.code in (304, 403, 404, 410) or (not redirects and 300 <= exc.code < 400):
                return exc.code, dict(exc.headers or {})
            if exc.code not in (408, 429, 500, 502, 503, 504):
                raise RuntimeError(f"{url}: HTTP {exc.code}") from exc
            problem = exc
        except (OSError, http.client.HTTPException) as exc:
            problem = exc
        _last_request[host] = time.monotonic() + 5 * 2 ** attempt  # back off this host
    raise RuntimeError(f"{url}: {problem!r}")


def reuse_index(folders) -> dict[str, tuple[Path, dict]]:
    """URL -> (local file, source record) from supplement manifests in earlier research folders."""
    index = {}
    for folder in folders:
        for manifest in sorted(Path(folder).glob("*.json")):
            try:
                data = json.loads(manifest.read_text())
            except ValueError:
                continue
            for source in data.get("sources", []) if isinstance(data, dict) else []:
                if isinstance(source, dict) and all(source.get(key) for key in
                                                    ("url", "sha256", "local_path", "fetched_at")):
                    path = manifest.parent / source["local_path"]
                    if path.is_file():
                        index.setdefault(source["url"], (path, source))
    return index


class Fetcher:
    """Archives responses in one folder. An archived URL is not fetched again unless it is live;
    a live URL is fetched again and a changed response is kept beside the old ones."""

    def __init__(self, folder: Path, reuse=()):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.state_path = folder / "fetch_state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.reuse = reuse_index(reuse)

    def save(self, url: str, record: dict) -> dict:
        self.state[url] = record
        write_json(self.state_path, self.state)
        return dict(record)

    def forget(self, url: str) -> None:
        """Drop an archived response so the next run fetches the URL again."""
        record = self.state.pop(url)
        (self.folder / record["local_path"]).unlink(missing_ok=True)
        write_json(self.state_path, self.state)

    def link(self, url: str, name: str) -> dict | None:
        """Hard-link (or copy) an archive an earlier run recorded for url, if its bytes still match."""
        path, record = self.reuse[url]
        target = self.folder / name
        if not target.exists():
            try:
                os.link(path, target)
            except OSError:
                shutil.copyfile(path, target)
        if labels.sha256(target) != record["sha256"]:
            target.unlink()
            return None
        return self.save(url, dict(url=url, local_path=name, sha256=record["sha256"],
                                   fetched_at=record["fetched_at"], bytes=target.stat().st_size,
                                   reused_from=str(path)))

    def archive(self, url: str, name: str, live: bool = False, headers: dict | None = None,
                redirects: bool = True) -> dict:
        """The source record of url archived as name, or {url, status, checked_at} for 403/404/410."""
        known = self.state.get(url)
        if known and not live and known.get("local_path") and (self.folder / known["local_path"]).exists():
            return dict(known)
        if not live and url in self.reuse:
            record = self.link(url, name)
            if record:
                return record
        conditional = {}
        if known and live:
            if known.get("etag"):
                conditional["If-None-Match"] = known["etag"]
            if known.get("last_modified"):
                conditional["If-Modified-Since"] = known["last_modified"]
        temporary = self.folder / f".{name}.part"
        checked = now()
        status, response = http_get(url, temporary, {**(headers or {}), **conditional}, redirects)
        if status == 304 and known:
            temporary.unlink(missing_ok=True)
            return self.save(url, dict(known, checked_at=checked))
        if status != 200:
            temporary.unlink(missing_ok=True)
            missing = dict(url=url, status=status, checked_at=checked)
            return missing if live else self.save(url, missing)
        digest = labels.sha256(temporary)
        if known and known["sha256"] == digest and (self.folder / known["local_path"]).exists():
            temporary.unlink()
            return self.save(url, dict(known, checked_at=checked))
        target = self.folder / name
        if live or (target.exists() and labels.sha256(target) != digest):  # keep every version
            stem, dot, ext = name.partition(".")
            target = self.folder / f"{stem}.{digest[:12]}{dot}{ext}"
        os.replace(temporary, target)
        return self.save(url, dict(url=url, local_path=target.name, sha256=digest, fetched_at=checked,
                                   bytes=target.stat().st_size, etag=response.get("ETag"),
                                   last_modified=response.get("Last-Modified")))

    def git_blob(self, repo: Path, commit: str, path: str, url: str) -> dict:
        """Archive one file as it was at commit (url names it on the forge)."""
        known = self.state.get(url)
        if known and (self.folder / known["local_path"]).exists():
            return dict(known)
        data = subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:{path}"])
        flat = Path(path.replace("/", "__"))
        name = f"{flat.stem}.{commit[:12]}{flat.suffix}"
        (self.folder / name).write_bytes(data)
        return self.save(url, dict(url=url, local_path=name, sha256=hashlib.sha256(data).hexdigest(),
                                   fetched_at=now(), bytes=len(data), commit=commit, path=path))


def mirror(url: str, folder: Path, commit: str | None = None) -> Path:
    """A blob-less bare clone of url in folder: fetched again each run, or only until commit exists."""
    repo = folder / "repo.git"

    def has() -> bool:
        return bool(commit) and not subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-e", commit + "^{commit}"], capture_output=True).returncode

    if not repo.exists():
        subprocess.run(["git", "clone", "--quiet", "--bare", "--filter=blob:none", url, str(repo)], check=True)
    elif not has():
        subprocess.run(["git", "-C", str(repo), "fetch", "--quiet", "--tags", "--prune", "origin",
                        "+refs/heads/*:refs/heads/*"], check=True)
    if commit and not has():
        subprocess.run(["git", "-C", str(repo), "fetch", "--quiet", "origin", commit], check=True)
    return repo


def cdx(fetcher: Fetcher, key: str, prefix: bool = False, collapse: str | None = None) -> list[tuple[str, str]]:
    """(timestamp, original URL) of the Wayback Machine's 200 captures of key."""
    query = dict(url=key, fl="timestamp,original", filter="statuscode:200")
    if prefix:
        query["matchType"] = "prefix"
    if collapse:
        query["collapse"] = collapse
    url = "https://web.archive.org/cdx/search/cdx?" + urllib.parse.urlencode(query)
    record = fetcher.archive(url, f"cdx-{hashlib.sha256(url.encode()).hexdigest()[:12]}.txt", live=True)
    if "status" in record:
        raise RuntimeError(f"Wayback CDX {key}: HTTP {record['status']}")
    text = (fetcher.folder / record["local_path"]).read_text(errors="replace")
    if text.lstrip().startswith("<"):
        raise RuntimeError(f"Wayback CDX {key}: not a CDX reply")
    return [tuple(line.split()[:2]) for line in text.splitlines() if line.strip()]


def fetch_item(fetcher: Fetcher, source: dict, item: dict) -> dict:
    """Archive an item; when the operator no longer serves it, its latest Wayback Machine copy."""
    options = source.get("options", {})
    known = fetcher.state.get(item["url"], {})
    if "status" in known and item.get("observed") and not item.get("live") and (
            dt.date.fromisoformat(known["checked_at"][:10]) - dt.date.fromisoformat(item["observed"])).days > 92:
        return dict(known)  # still missing three months after its date when last checked: not asked again
    browser = {"User-Agent": BROWSER} if options.get("browser") else None
    record = fetcher.archive(item["url"], item["name"], live=item.get("live", False), headers=browser,
                             redirects=not options.get("no_redirects") or bool(item.get("capture_of")))
    if item.get("capture_of") and "status" not in record:
        return dict(record, capture_of=item["capture_of"])
    if "status" not in record or not item.get("wayback"):
        return record
    if isinstance(item["wayback"], str):  # a capture known to be complete
        timestamp, original = item["wayback"], item["url"]
    else:
        captures = cdx(fetcher, item["url"])
        if not captures:
            return record
        timestamp, original = captures[-1]
    archived = fetcher.archive(f"https://web.archive.org/web/{timestamp}id_/{original}", item["name"])
    if "status" in archived:
        return record
    return dict(archived, original_url=item["url"], original_status=record["status"])


# --- enumerators: which files a source has -------------------------------------------------

def enum_single(source: dict, fetcher: Fetcher):
    """One URL; with options.wayback_history, also every distinct Wayback Machine capture of it."""
    url, items = source["url"], [dict(url=source["url"], name=url_name(source["url"]), live=source["cadence"] == "live")]
    if source.get("options", {}).get("wayback_history"):
        stem, dot, ext = url_name(url).partition(".")
        for timestamp, original in cdx(fetcher, url.split("?")[0], prefix=True, collapse="digest"):
            items.append(dict(url=f"https://web.archive.org/web/{timestamp}id_/{original}", name=f"{stem}.{timestamp}{dot}{ext}",
                              observed=f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}",
                              capture_of=original))
    return items, []


def enum_dates(source: dict, fetcher: Fetcher):
    """One URL per day from options.from to yesterday (UTC), {date} as YYYY-MM-DD."""
    day, last = dt.date.fromisoformat(source["options"]["from"]), dt.datetime.now(dt.timezone.utc).date()
    items = []
    while day < last:
        url = source["url"].replace("{date}", day.isoformat())
        items.append(dict(url=url, name=f"{day.isoformat()}.json", observed=day.isoformat()))
        day += dt.timedelta(days=1)
    return items, []


def enum_api_links(source: dict, fetcher: Fetcher):
    """Files listed by a JSON API (options: list_path, url_key, time_key in epoch milliseconds or, with
    time_seconds, seconds), plus options.files the API no longer lists."""
    options = source["options"]
    record = fetcher.archive(source["url"], url_name(source["url"]) + ".json", live=True)
    if "status" in record:
        raise RuntimeError(f"{source['url']}: HTTP {record['status']}")
    entries = dig(json.loads((fetcher.folder / record["local_path"]).read_bytes()), options["list_path"])
    entries = [entries] if isinstance(entries, dict) else entries  # an API that returns only the latest file
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{source['id']}: unrecognised layout ({options['list_path']!r} is not a list)")
    items = []
    for entry in entries:
        url = entry[options["url_key"]]
        stamp = dt.datetime.fromtimestamp(int(entry[options["time_key"]]) / (1 if options.get("time_seconds") else 1000),
                                          dt.timezone.utc)
        items.append(dict(url=url, name=url_name(url), observed=stamp.date().isoformat(), wayback=True))
    items += enum_list(source, fetcher)[0] if options.get("files") else []
    return items, [dict(url=record["url"], local_path=record["local_path"], sha256=record["sha256"],
                        fetched_at=record["fetched_at"], files=len(items))]


def enum_wp_posts(source: dict, fetcher: Fetcher):
    """WordPress posts found by options.searches whose title matches options.title_pattern."""
    options = source["options"]
    title = re.compile(options["title_pattern"], re.I)
    posts, enumeration = {}, []
    for search in options["searches"]:
        url = f"{source['url']}?" + urllib.parse.urlencode(dict(search=search, per_page=100, _fields="id,date,link,title"))
        record = fetcher.archive(url, f"posts-{re.sub(r'[^a-z0-9]+', '-', search.lower())}.json", live=True)
        if "status" in record:
            raise RuntimeError(f"{url}: HTTP {record['status']}")
        enumeration.append(dict(url=url, local_path=record["local_path"], sha256=record["sha256"]))
        for post in json.loads((fetcher.folder / record["local_path"]).read_bytes()):
            if title.search(post["title"]["rendered"]):
                posts[post["link"]] = post["date"][:10]
    if not posts:
        raise ValueError(f"{source['id']}: no post matches {options['title_pattern']!r}")
    return [dict(url=link, name=f"post-{date}-{url_name(link.rstrip('/'))}.html", observed=date, wayback=True)
            for link, date in sorted(posts.items(), key=lambda item: item[1])], enumeration


def enum_list(source: dict, fetcher: Fetcher):
    """options.files: [{url, observed, wayback, capture_of}]: wayback is a capture timestamp to fall back
    on, or true for the latest; capture_of marks a Wayback capture URL listed directly."""
    return [dict(url=item["url"], name=url_name(item["url"]), observed=item.get("observed"),
                 wayback=item.get("wayback", False), **({"capture_of": item["capture_of"]} if item.get("capture_of") else {}))
            for item in source["options"]["files"]], []


def enum_months(source: dict, fetcher: Fetcher):
    options = source.get("options", {})
    items = []
    for month in month_list(options["from"], options.get("to") or f"{dt.date.today():%Y-%m}"):
        url = source["url"].replace("{YYYYMM}", month)
        items.append(dict(url=url, name=url_name(url), observed=f"{month[:4]}-{month[4:]}-01",
                          month=f"{month[:4]}-{month[4:]}"))
    return items, []


def enum_pages(source: dict, fetcher: Fetcher):
    """Pages 1, 2, ... until one whose options.until_empty value is empty."""
    options = source.get("options", {})
    items = []
    for page in range(1, options.get("max_pages", 300) + 1):
        url = source["url"].replace("{page}", str(page))
        record = fetcher.archive(url, f"page-{page:03d}.json", live=True)
        if "status" in record:
            raise RuntimeError(f"{url}: HTTP {record['status']}")
        if not dig(json.loads((fetcher.folder / record["local_path"]).read_bytes()), options["until_empty"]):
            return items, [dict(url=url, local_path=record["local_path"], sha256=record["sha256"],
                                role="first empty page")]
        items.append(dict(url=url, record=record))
    raise RuntimeError(f"{source['id']}: still listing after {options.get('max_pages', 300)} pages")


def enum_page_links(source: dict, fetcher: Fetcher):
    """Files linked from download pages, from their Wayback Machine captures, and in Wayback prefixes."""
    options = source["options"]
    pattern = re.compile(options["link_pattern"])
    browser = {"User-Agent": BROWSER} if options.get("browser") else None
    found, enumeration = {}, []

    def scan(record: dict, origin: str) -> None:
        if "status" in record:
            enumeration.append(dict(url=record["url"], status=record["status"]))
            return
        text = (fetcher.folder / record["local_path"]).read_text(errors="replace")
        links = sorted({match.group(0) for match in pattern.finditer(text)})
        enumeration.append(dict(url=record["url"], local_path=record["local_path"], sha256=record["sha256"],
                                fetched_at=record["fetched_at"], links=len(links)))
        for link in links:
            found.setdefault("https://" + link, origin)

    for page in options.get("pages") or [source["url"]]:
        scan(fetcher.archive(page, url_name(page) + ".html", live=True, headers=browser), page)
    for key in options.get("wayback_pages", []):
        for timestamp, original in cdx(fetcher, key, collapse="timestamp:6"):
            capture = f"https://web.archive.org/web/{timestamp}id_/{original}"
            scan(fetcher.archive(capture, f"capture-{timestamp}-{url_name(original)}.html"), capture)
    for key in options.get("wayback_prefixes", []):
        for _, original in cdx(fetcher, key, prefix=True, collapse="urlkey"):
            match = pattern.search(original)
            if match:
                found.setdefault("https://" + match.group(0), f"Wayback index of {key}")
    date = re.compile(options["date_pattern"])
    items = []
    for url, origin in found.items():
        match = date.search(url_name(url))
        if not match:
            raise ValueError(f"{source['id']}: no snapshot date in {url}")
        items.append(dict(url=url, name=url_name(url), observed="-".join(match.groups()[:3]),
                          found_in=origin, wayback=True))
    items.sort(key=lambda item: (item["observed"], item["url"]))
    return items, enumeration


def enum_git(source: dict, fetcher: Fetcher):
    """Every version of options.paths (globs) in the repository's history, tags included."""
    options = source["options"]
    repo = mirror(source["url"], fetcher.folder)
    output = subprocess.check_output(
        ["git", "-C", str(repo), "log", "--all", "--format=@%H %ct", "--name-only", "--diff-filter=AM",
         "--", *[f":(glob){path}" for path in options["paths"]]], text=True)
    items, commit, stamp = [], None, None
    for line in output.splitlines():
        if line.startswith("@"):
            commit, stamp = line[1:].split()
        elif line.strip():
            url = f"{source['url'].rstrip('/')}/blob/{commit}/{line}"
            observed = dt.datetime.fromtimestamp(int(stamp), dt.timezone.utc).date().isoformat()
            items.append(dict(url=url, record=fetcher.git_blob(repo, commit, line, url), observed=observed,
                              commit=commit, path=line))
    if not items:
        raise ValueError(f"{source['id']}: no history for {options['paths']}")
    head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    return items, [dict(repository=source["url"], head=head, versions=len(items))]


ENUMERATORS = {"single": enum_single, "list": enum_list, "months": enum_months, "dates": enum_dates,
               "pages": enum_pages, "page_links": enum_page_links, "api_links": enum_api_links,
               "wp_posts": enum_wp_posts, "git_history": enum_git}


# --- parsers: rows from one archived file ---------------------------------------------------

class Context:
    """Label rows, rejections, exclusions and counts read from one archived file."""

    def __init__(self, source: dict, record: dict, observed: str, entities=frozenset()):
        self.source, self.record, self.observed, self.entities = source, record, observed, entities
        self.rows, self.rejected, self.excluded = [], [], []
        self.dropped, self.skipped, self.lists = Counter(), Counter(), {}

    def add(self, value: str, note: str, entity: str | None = None, evidence_type: str | None = None,
            where: str = "") -> bool:
        """Add a row citing this file if value is a Bitcoin mainnet address; reject it otherwise."""
        kind = evidence_type or self.source["evidence_type"]
        value = address_text(value)
        try:
            address = labels.normalize_address(value)
        except ValueError as exc:
            self.rejected.append(dict(value=str(value).strip()[:120], reason=str(exc),
                                      file=self.record["local_path"], where=where))
            return False
        custodian = self.source.get("options", {}).get("custodian")
        if custodian:  # a source whose addresses are all held by a third-party custodian
            self.excluded.append(dict(address=address, custodian=custodian, list=where, observed=self.observed,
                                      source=self.record["url"]))
            return False
        if self.record.get("original_url"):
            note += (f" Wayback Machine copy of {self.record['original_url']}, which answered HTTP "
                     f"{self.record['original_status']}.")
        if self.record.get("capture_of"):
            note += f" Wayback Machine capture of {self.record['capture_of']}."
        self.rows.append(dict(address=address, entity=entity or self.source["entity"], source=self.record["url"],
                              observed_date=self.observed, confidence=CONFIDENCE[kind], evidence_type=kind,
                              historical_note=f"{note} {SNAPSHOT}"))
        return True


def address_text(value) -> str:
    """The address in a cell: itself, or the last path segment of an explorer link."""
    value = str(value).strip()
    if "://" in value:
        value = [part for part in urllib.parse.urlsplit(value).path.split("/") if part][-1:] or [value]
        value = value[0]
    return value


def xlsx_rows(path: Path):
    """Cell values of the first worksheet of an .xlsx file, row by row (shared and inline strings)."""
    import xml.etree.ElementTree as ElementTree
    space = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as book:
        shared = []
        if "xl/sharedStrings.xml" in book.namelist():
            for item in ElementTree.fromstring(book.read("xl/sharedStrings.xml")).findall("m:si", space):
                shared.append("".join(node.text or "" for node in item.iter(f"{{{space['m']}}}t")))
        sheets = sorted(name for name in book.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name))
        if not sheets:
            raise ValueError(f"{path.name}: no worksheet")
        for row in ElementTree.fromstring(book.read(sheets[0])).iter(f"{{{space['m']}}}row"):
            cells = {}
            for cell in row.findall("m:c", space):
                column = re.match(r"[A-Z]+", cell.get("r", "A")).group(0)
                index = sum((ord(char) - 64) * 26 ** power for power, char in enumerate(reversed(column))) - 1
                value = cell.find("m:v", space)
                text = "".join(node.text or "" for node in cell.iter(f"{{{space['m']}}}t")) if value is None else value.text or ""
                cells[index] = shared[int(text)] if cell.get("t") == "s" else text
            yield [cells.get(index, "") for index in range(max(cells) + 1)] if cells else []


def csv_members(path: Path):
    """(name, text stream) for every list in a zip archive, or the file itself."""
    if not zipfile.is_zipfile(path):
        with path.open(encoding="utf-8-sig", newline="") as stream:
            yield path.name, stream
        return
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")
                 and not name.startswith("__MACOSX/") and not Path(name).name.startswith("._")]
        if not names:
            raise ValueError(f"{path.name}: archive has no lists")
        for name in names:
            if not name.lower().endswith(".csv"):
                raise ValueError(f"{path.name}: unrecognised file {name}")
            with archive.open(name) as raw:
                yield name, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")


def btc_elsewhere(coin: str) -> bool:
    """BTC held on another network, by its coin label (BTC-TRC20, BTCB, WBTC, ...)."""
    return coin in ("WBTC", "BTCB", "HBTC", "BTC.B") or bool(re.match(r"BTC[-(_ .]", coin))


def parse_por_csv(path: Path, ctx: Context, item: dict) -> None:
    """Reserve lists (CSV, zipped CSV or XLSX): every section whose header has coin and address
    columns. A network column is optional; any column naming a custodian marks third-party custody."""
    entity = ctx.source["entity"]
    sections = 0
    members = ([(path.name, None)] if path.suffix.lower() == ".xlsx" else csv_members(path))
    for name, stream in members:
        lowered_name = Path(name).name.lower()
        kind = ("deposit" if "deposit" in lowered_name else "hot/cold" if "hotcold" in lowered_name
                else ctx.source.get("options", {}).get("kind", "reserve"))
        also = [column.lower() for column in ctx.source.get("options", {}).get("also_columns", [])]
        mainnet = {coin.upper() for coin in ctx.source.get("options", {}).get("btc_coins", ["BTC"])}
        networks = {name.upper() for name in ctx.source.get("options", {}).get("btc_networks", ["BTC", "BITCOIN"])}
        names = {key.lower(): value.lower() for key, value in ctx.source.get("options", {}).get("header_names", {}).items()}
        stats = Counter()
        reader = csv.reader(stream) if stream is not None else None
        header = title = None
        for number, record in enumerate(reader if reader is not None else xlsx_rows(path), 1):
            cells = [cell.strip() for cell in record]
            lowered = [names.get(cell.lower(), cell.lower()) for cell in cells]
            if "coin" in lowered:  # a section header; only sections listing addresses are read
                header = lowered if "address" in lowered else None
                if header:
                    sections += 1
                    coin, address = header.index("coin"), header.index("address")
                    extra = [header.index(column) for column in also if column in header]
                    network = header.index("network") if "network" in header else None
                    custody = [index for index, field in enumerate(header) if "custodian" in field]
                    height = next((index for index, field in enumerate(header) if "height" in field), None)
                    kinds = header.index("type") if "type" in header else None
                continue
            if len(cells) == 1 and cells[0] and not cells[0].isupper():  # a section title, e.g. 'Hot Wallet'
                header, title = None, cells[0]
                continue
            if header is None or not any(cells):
                continue
            if reader is None:  # spreadsheets drop trailing empty cells
                cells += [""] * (len(header) - len(cells))
            if len(cells) > len(header) and not any(cells[len(header):]):  # stray trailing commas
                cells = cells[:len(header)]
            if len(cells) != len(header):  # another table without a coin column, or a broken row
                if cells[0].upper().startswith("BTC"):
                    ctx.rejected.append(dict(value=",".join(cells)[:120], file=ctx.record["local_path"],
                                             reason=f"{len(cells)} fields under a {len(header)}-field header",
                                             where=f"{name}:{number}"))
                else:
                    ctx.skipped["rows that do not fit their section's header"] += 1
                continue
            label = "BTC" if cells[coin].upper() in mainnet else cells[coin].upper()
            chain = cells[network].upper() if network is not None else None
            if not cells[address].strip("-"):  # totals rows such as 'BTC(All)' carry no address
                stats["rows_without_address"] += 1
                continue
            if label != "BTC" or (chain is not None and chain not in networks):
                if label == "BTC" or btc_elsewhere(label):
                    ctx.dropped[f"{label} on {chain or 'its own network'}"] += 1
                    stats["btc_rows_on_other_networks"] += 1
                continue
            stats["btc_rows"] += 1
            custodian = next((cells[index] for index in custody if cells[index]), "")
            if custodian:
                ctx.excluded.append(dict(address=cells[address], custodian=custodian, list=name,
                                         observed=ctx.observed, source=ctx.record["url"]))
                stats["custodian_rows_excluded"] += 1
                continue
            details = [f"BTC height {cells[height]}" if height is not None and cells[height].isdigit() else "",
                       cells[kinds] if kinds is not None else "",
                       "" if network is not None else "no network column"]
            details = ", ".join(filter(None, details))
            note = (f"{entity} proof-of-reserves {title.lower() if title else kind} list, snapshot {ctx.observed}"
                    f"{' (' + details + ')' if details else ''}. Rows naming a third-party custodian are excluded.")
            for value in cells[address].split() + [cells[index] for index in extra]:
                if value.strip("-"):  # '-' stands for no address (escrow rows)
                    ctx.add(value, note, where=f"{name}:{number}")
        ctx.lists[name] = dict(kind=kind, **stats)
    if not sections:
        raise ValueError(f"{path.name}: unrecognised layout (no section with coin and address columns)")


def dig(data, path: str):
    """data[a][b]... for path 'a.b'; None when the last key is absent."""
    for key in [key for key in path.split(".") if key]:
        if not isinstance(data, dict):
            raise ValueError(f"unrecognised layout: no object at {key!r}")
        data = data.get(key)
        if data is None:
            return None
    return data


def parse_json_list(path: Path, ctx: Context, item: dict) -> None:
    """A JSON list of {address, chain} entries (options: path, address_key, chain_key, chain_values)."""
    options = ctx.source["options"]
    data = json.loads(path.read_bytes())
    for key in options.get("require", []):
        if not isinstance(data, dict) or key not in data:
            raise ValueError(f"{path.name}: unrecognised layout (no {key!r})")
    if options.get("observed_epoch") and isinstance(data, dict) and data.get(options["observed_epoch"]):
        ctx.observed = dt.datetime.fromtimestamp(int(data[options["observed_epoch"]]),
                                                 dt.timezone.utc).date().isoformat()
    entries = dig(data, options.get("path", "")) or []
    if not isinstance(entries, list):
        raise ValueError(f"{path.name}: unrecognised layout ({options.get('path')!r} is not a list)")
    wanted = {value.lower() for value in options["chain_values"]}
    for index, entry in enumerate(entries):
        chain = dig(entry, options["chain_key"]) if isinstance(entry, dict) else None
        if chain is None or options["address_key"] not in entry:
            raise ValueError(f"{path.name}: unrecognised entry {index}")
        chain = str(chain).strip()
        if chain.lower() in wanted:
            ctx.add(entry[options["address_key"]], f"{ctx.source['entity']} {options['list']} ({chain}).",
                    where=f"entry {index}")
        elif options.get("btc_only"):
            ctx.dropped[f"BTC on {chain}"] += 1


WALLET_LINE = re.compile(r"^(\S+)(?:\s+\([^)]*\))?\s+-\s+(\S.*?)\s*$")  # an address, an optional (note), its description


def parse_text_wallets(path: Path, ctx: Context, item: dict) -> None:
    """'ADDRESS - DESCRIPTION' lines; options.keep selects the Bitcoin descriptions."""
    keep = re.compile(ctx.source["options"]["keep"])
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        match = WALLET_LINE.match(line)
        if not match:
            raise ValueError(f"{path.name} line {number}: unrecognised layout {line[:60]!r}")
        value, description = match.groups()
        if keep.search(description):
            ctx.add(value, f"{ctx.source['entity']} published wallet list: {description}.", where=f"line {number}")
        elif "BTC" in description:
            ctx.dropped[description] += 1


BITMEX_ENTRY = re.compile(r"^\s+-\s+\{'addr_type':\s*'([\w-]*)',\s*'addr':\s*'([^']*)',\s*'script':\s*'[0-9a-fA-F]*',"
                          r"\s*'balance':\s*'?(\d+)'?\s*\}\s*$")


def parse_bitmex_reserves(path: Path, ctx: Context, item: dict) -> None:
    """BitMEX reserves YAML: chain main, a total, and one flow-map line per address. The balances
    must add up to the stated total, so a truncated copy fails."""
    header, section, total = {}, None, 0
    with path.open(encoding="utf-8") as stream:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            if not line[0].isspace():
                section = line.strip().removesuffix(":")
                continue
            if section in ("address", "custodial"):
                match = BITMEX_ENTRY.match(line)
                if not match:
                    raise ValueError(f"{path.name} line {number}: unrecognised address entry")
                kind, value, balance = match.groups()
                if section == "custodial":
                    ctx.excluded.append(dict(address=value, custodian="third-party custody (BitMEX 'custodial')",
                                             list=path.name, observed=ctx.observed, source=ctx.record["url"]))
                    continue
                total += int(balance)
                ctx.add(value, f"BitMEX proof-of-reserves file at block {header.get('height')} "
                        f"({kind}, balance {balance} sats).", where=f"line {number}")
            elif section in ("height", "chain", "total"):
                header[section] = line.strip()
    if header.get("chain") != "main" or not header.get("height", "").isdigit() or not header.get("total", "").isdigit():
        raise ValueError(f"{path.name}: unrecognised layout (height, chain main and total are required)")
    if total != int(header["total"]):
        raise ValueError(f"{path.name}: balances add up to {total}, not the stated {header['total']} (truncated?)")
    ctx.lists[path.name] = dict(kind="reserves", height=int(header["height"]), total_sats=total,
                                addresses=len(ctx.rows))


def parse_figshare_csv(path: Path, ctx: Context, item: dict) -> None:
    """BitcoinTemporalGraph addresses.csv: EXCHANGE rows naming a registry entity."""
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        if not {"address", "entity", "category", "source"} <= set(reader.fieldnames or ()):
            raise ValueError(f"{path.name}: unrecognised layout {reader.fieldnames}")
        known = {name.lower(): name for name in ctx.entities}
        for row in reader:
            if row["category"].strip().upper() != "EXCHANGE":
                continue
            name = row["entity"].strip()
            entity = known.get(labels.normalize_entity(name).lower()) if name else None
            if not entity:
                ctx.skipped[f"exchange outside the registry: {name or '(unnamed)'}"] += 1
                continue
            ctx.add(row["address"], f"BitcoinTemporalGraph labelled address '{name}' (category EXCHANGE, "
                    f"dataset source '{row['source'].strip()}'). Exact third-party tag; its method is not stated.",
                    entity=entity, where=f"line {reader.line_num}")


class HtmlCells(HTMLParser):
    """Table rows (each cell's text and link targets) and every link (its class and target)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.links, self.row, self.cell = [], [], None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = dict(text="", links=[])
        elif tag in ("br", "p", "div", "li") and self.cell is not None:  # keep line breaks between addresses
            self.cell["text"] += "\n"
        elif tag == "a" and attrs.get("href"):
            self.links.append(dict(href=attrs["href"], cls=attrs.get("class") or ""))
            if self.cell is not None:
                self.cell["links"].append(attrs["href"])

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(self.cell)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["text"] += data


def html_cells(path: Path) -> HtmlCells:
    page = HtmlCells()
    page.feed(path.read_text(encoding="utf-8", errors="replace"))
    return page


def parse_html_table(path: Path, ctx: Context, item: dict) -> None:
    """Table rows whose first cell names Bitcoin (options.coin_pattern); the addresses are the other
    cells' words and link targets."""
    options = ctx.source["options"]
    coin = re.compile(options["coin_pattern"], re.I)
    rows = html_cells(path).rows
    if not rows and not options.get("allow_empty"):  # allow_empty: a search can also match posts without a table
        raise ValueError(f"{path.name}: unrecognised layout (no table rows)")
    listed = 0
    for number, row in enumerate(rows, 1):
        label = row[0]["text"].strip() if row else ""
        if len(row) < 2 or not coin.search(label):
            continue
        listed += 1
        for cell in row[1:]:
            for value in dict.fromkeys(address_text(value) for value in cell["text"].split() + cell["links"]):
                if ADDRESS_LIKE.fullmatch(value):
                    ctx.add(value, f"{ctx.source['entity']} {options['list']}, table row '{label}'.", where=f"row {number}")
    ctx.lists[path.name] = dict(btc_rows=listed)


def parse_html_anchors(path: Path, ctx: Context, item: dict) -> None:
    """Links whose target matches options.href_pattern and class matches options.class_pattern (either
    may be omitted); each target's last segment is the address."""
    options = ctx.source["options"]
    href, cls = re.compile(options.get("href_pattern", "")), re.compile(options.get("class_pattern", ""))
    links = [link for link in html_cells(path).links if href.search(link["href"]) and cls.search(link["cls"])]
    if not links:
        raise ValueError(f"{path.name}: unrecognised layout (no link matches {href.pattern!r} and class {cls.pattern!r})")
    for link in links:
        role = cls.search(link["cls"]).group(0) or urllib.parse.urlsplit(link["href"]).hostname
        ctx.add(link["href"], f"{ctx.source['entity']} {options['list']} ({role}).", where=role)


def parse_text_pattern(path: Path, ctx: Context, item: dict) -> None:
    """Addresses captured by options.pattern in a page's text, HTML tags removed, or every address in
    each block that options.block captures; options.json_path first takes the HTML out of a JSON reply."""
    options = ctx.source["options"]
    text = path.read_text(encoding="utf-8", errors="replace")
    if options.get("json_path"):
        text = dig(json.loads(text), options["json_path"])
        if not isinstance(text, str):
            raise ValueError(f"{path.name}: unrecognised layout (no {options['json_path']!r} text)")
    text = html.unescape(re.sub(r"<[^>]+>", "\n", text))
    if options.get("block"):
        matches = [value for block in re.findall(options["block"], text, re.S) for value in ADDRESS_LIKE.findall(block)]
    else:
        matches = re.findall(options["pattern"], text, re.M)
    if not matches and not options.get("allow_empty"):  # allow_empty: archived shells that load the list by script
        raise ValueError(f"{path.name}: unrecognised layout (nothing matches {options.get('block') or options['pattern']!r})")
    ctx.lists[path.name] = dict(matches=len(matches))
    for value in matches:
        ctx.add(value, f"{ctx.source['entity']} {options['list']}.", where=options.get("block") or options["pattern"])


def parse_typed_csv(path: Path, ctx: Context, item: dict) -> None:
    """CSV rows whose type column is one of options.keep_types; options.fieldnames names the columns
    of a file without a header row."""
    options = ctx.source["options"]
    keep = {value.lower() for value in options["keep_types"]}
    with path.open(newline="", encoding="utf-8-sig") as stream:
        rows = [row for row in csv.reader(stream) if any(cell.strip() for cell in row)]
    header = [cell.strip().lower() for cell in rows[0]] if rows else []
    if options["address_column"].lower() in header:
        rows = rows[1:]
    else:
        header = [name.lower() for name in options["fieldnames"]]
    if options["address_column"].lower() not in header or options["type_column"].lower() not in header:
        raise ValueError(f"{path.name}: unrecognised layout {header}")
    address, kind = header.index(options["address_column"].lower()), header.index(options["type_column"].lower())
    name = header.index(options["name_column"].lower()) if options.get("name_column", "").lower() in header else None
    for number, row in enumerate(rows, 1):
        if len(row) != len(header):
            raise ValueError(f"{path.name} row {number}: {len(row)} fields under a {len(header)}-field header")
        if row[kind].strip().lower() in keep:
            wallet = f", wallet '{row[name].strip()}'" if name is not None else ""
            ctx.add(row[address], f"{ctx.source['entity']} published wallet list ({row[kind].strip()}{wallet}).",
                    where=f"row {number}")


def parse_js_items(path: Path, ctx: Context, item: dict) -> None:
    """A script bundle's {coin:"BTC",items:[{address:"..."}]} objects."""
    blocks = re.findall(r'coin:\s*"BTC"\s*,\s*items:\s*\[(.*?)\]', path.read_text(encoding="utf-8", errors="replace"), re.S)
    if not blocks:
        raise ValueError(f"{path.name}: unrecognised layout (no BTC items)")
    for block in blocks:
        for value in re.findall(r'address:\s*"([^"]+)"', block):
            ctx.add(value, f"{ctx.source['entity']} {ctx.source['options']['list']}.", where="BTC items")


def parse_pdf_table(path: Path, ctx: Context, item: dict) -> None:
    """A PDF 'Network  Address' table (pdftotext -layout). A long address can wrap around a line
    holding only its network, so parts are joined until they form a valid address."""
    options = ctx.source["options"]
    text = subprocess.check_output(["pdftotext", "-layout", str(path), "-"], text=True).replace("\u200b", "")
    rows, column = [], None
    for line in text.splitlines():
        if re.fullmatch(r"\s*Network\s+Address\s*", line):  # each page repeats the header
            column = line.index("Address")
        elif column is not None and line.strip():
            rows.append((line[:column].strip(), line[column:].strip()))
    if column is None:
        raise ValueError(f"{path.name}: unrecognised layout (no 'Network  Address' table)")
    index = 0
    while index < len(rows):
        network, joined = rows[index]
        networks, end = [network], index + 1
        while joined and end < len(rows) and end - index <= 3 and not valid_address(joined):
            networks.append(rows[end][0])
            joined += rows[end][1]
            end += 1
        named = next((name for name in networks if name), "")
        if valid_address(joined) and named == options["network"]:
            ctx.add(joined, f"{ctx.source['entity']} {options['list']} ({named}).", where=f"table row {index + 1}")
            index = end
        else:
            index += 1
    ctx.lists[path.name] = dict(table_rows=len(rows))


def valid_address(value: str) -> bool:
    try:
        labels.normalize_address(value)
        return True
    except ValueError:
        return False


PARSERS = {"por_csv": parse_por_csv, "json_list": parse_json_list, "text_wallets": parse_text_wallets,
           "bitmex_reserves": parse_bitmex_reserves, "figshare_csv": parse_figshare_csv,
           "html_table": parse_html_table, "html_anchors": parse_html_anchors, "text_pattern": parse_text_pattern,
           "typed_csv": parse_typed_csv, "js_items": parse_js_items, "pdf_table": parse_pdf_table}
MULTI_ENTITY = {"figshare_csv", "defillama"}


# --- DefiLlama-Adapters ----------------------------------------------------------------------

JS_TOKEN = re.compile(r"""\s+|//[^\n]*|/\*.*?\*/|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)"""
                      r"|([A-Za-z_$][\w$]*)|(\.\.\.|[{}\[\]().,:;=])|(.)", re.S)
PAIRS = {"{": "}", "[": "]", "(": ")"}


def js_tokens(text: str) -> list[tuple[str, str]]:
    """Strings ('s'), names ('n'), punctuation ('p') and other characters of JavaScript, without comments."""
    tokens = []
    for match in JS_TOKEN.finditer(text):
        string, name, mark, other = match.groups()
        if string is not None:
            tokens.append(("s", string[1:-1]))
        elif name is not None:
            tokens.append(("n", name))
        elif mark is not None:
            tokens.append(("p", mark))
        elif other is not None:
            tokens.append(("o", other))
    return tokens


def closing(tokens, start: int) -> int:
    """Index of the bracket that closes tokens[start]."""
    depth = 0
    for index in range(start, len(tokens)):
        kind, value = tokens[index]
        if kind == "p" and value in PAIRS:
            depth += 1
        elif kind == "p" and value in PAIRS.values():
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("unbalanced brackets")


def value_end(tokens, index: int, end: int) -> int:
    """Index of the comma that ends the value starting at index (or end)."""
    depth = 0
    while index < end:
        kind, value = tokens[index]
        if kind == "p" and value in PAIRS:
            depth += 1
        elif kind == "p" and value in PAIRS.values():
            depth -= 1
        elif (kind, value) == ("p", ",") and depth == 0:
            return index
        index += 1
    return end


def object_entries(tokens, start: int) -> dict[str, tuple[int, int]]:
    """key -> (first, end) token range of each value of the object literal at tokens[start]."""
    end, index, entries = closing(tokens, start), start + 1, {}
    while index < end:
        kind, value = tokens[index]
        if kind in ("n", "s") and tokens[index + 1] == ("p", ":"):
            stop = value_end(tokens, index + 2, end)
            entries[value] = (index + 2, stop)
        elif kind == "n" and tokens[index + 1] in (("p", ","), ("p", "}")):
            stop = index + 1
            entries[value] = (index, stop)
        else:
            stop = value_end(tokens, index, end)
        index = stop + 1
    return entries


def find(tokens, *pattern, start: int = 0, end: int | None = None) -> int:
    end = len(tokens) if end is None else end
    for index in range(start, end - len(pattern) + 1):
        if all(tokens[index + offset] == part for offset, part in enumerate(pattern)):
            return index
    return -1


def book_refs(tokens, first: int, end: int) -> list:
    """('book', key) references and the ('list', strings) of an owners value."""
    refs = []
    for index in range(first, end - 2):
        if tokens[index] == ("n", "bitcoinAddressBook"):
            mark, key = tokens[index + 1], tokens[index + 2]
            if (mark == ("p", ".") and key[0] == "n") or (mark == ("p", "[") and key[0] == "s"):
                refs.append(("book", key[1]))
    found = [value for kind, value in tokens[first:end] if kind == "s"]
    return refs + ([("list", found)] if found else [])


def bitcoin_refs(tokens, first: int = 0, end: int | None = None) -> list:
    """References of every 'bitcoin:' configuration between first and end."""
    end = len(tokens) if end is None else end
    refs = []
    for index in range(first, end - 2):
        if tokens[index] != ("n", "bitcoin") or tokens[index + 1] != ("p", ":"):
            continue
        kind, value = tokens[index + 2]
        if kind == "s":
            refs.append(("book", value))
        elif (kind, value) == ("p", "{"):
            stop = closing(tokens, index + 2)
            owners = find(tokens, ("n", "owners"), ("p", ":"), start=index + 2, end=stop)
            if owners < 0:
                refs.append(("unknown", "bitcoin configuration without owners"))
                continue
            found = book_refs(tokens, owners + 2, value_end(tokens, owners + 2, stop))
            refs.extend(found or [("unknown", "owners computed at run time")])
        else:
            found = book_refs(tokens, index + 2, value_end(tokens, index + 2, end))
            refs.extend(found or [("unknown", f"bitcoin value {value!r}")])
    return refs


def registered_domain(host: str) -> str:
    parts = host.lower().removeprefix("www.").split(".")
    keep = 3 if len(parts) > 2 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "net", "org", "ac") else 2
    return ".".join(parts[-keep:])


def link_target(link: str) -> str:
    """Lower-case host/path of a URL, without www., with x.com as twitter.com."""
    parts = urllib.parse.urlsplit(link)
    host = (parts.hostname or "").lower().removeprefix("www.")
    return (("twitter.com" if host == "x.com" else host) + parts.path).lower()


def wallets_link_kind(link: str | None, site: str | None, prefixes, unlisted: bool = False) -> tuple[str | None, str]:
    """Evidence type of an aggregator's addresses, from the wallet page it cites (None: excluded).
    unlisted: the registry found that the operator publishes no address list."""
    if not link:
        return "third_party_exact_tag", "DefiLlama cites no wallet page for it"
    host = (urllib.parse.urlsplit(link).hostname or "").lower()
    if any(host == paid or host.endswith("." + paid) for paid in PAID):
        return None, f"DefiLlama's wallet page {link} is a paid analytics platform"
    target = link_target(link)
    if any(target.startswith(prefix) for prefix in prefixes) or (
            site and registered_domain(host) == registered_domain(urllib.parse.urlsplit(site).hostname or "")):
        if unlisted:
            return "third_party_exact_tag", f"DefiLlama cites {link}, but the operator publishes no address list there"
        return "service_disclosure_via_aggregator", f"DefiLlama cites the operator's page {link}"
    return "third_party_exact_tag", f"DefiLlama cites {link}, which is not the operator's page"


def run_defillama(source: dict, fetcher: Fetcher, operators: dict[str, dict]):
    """Bitcoin owners of every DefiLlama CEX adapter at the pinned commit, resolved through its
    Bitcoin address book. Returns one context per file holding addresses, and the enumeration.
    operators: entity -> {hosts, unlisted} from the registry; options.excluded: entity -> reason."""
    options = source["options"]
    commit = options["commit"]
    repo = mirror(options["repository"], fetcher.folder, commit)
    committed = dt.datetime.fromtimestamp(int(subprocess.check_output(
        ["git", "-C", str(repo), "show", "-s", "--format=%ct", commit], text=True)), dt.timezone.utc).date().isoformat()
    raw = options["repository"].replace("https://github.com/", "https://raw.githubusercontent.com/")
    cexs = fetcher.archive(options["cexs"], "cexs.json", live=True)
    protocols = fetcher.archive(options["protocols"], "protocols.json", live=True)
    for record in (cexs, protocols):
        if "status" in record:
            raise RuntimeError(f"{record['url']}: HTTP {record['status']}")
    contexts, files = {}, {}

    def blob(path: str):
        if path not in files:
            exists = not subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{commit}:{path}"],
                                        capture_output=True).returncode
            files[path] = None
            if exists:
                record = fetcher.git_blob(repo, commit, path, f"{raw}/{commit}/{path}")
                files[path] = (js_tokens((fetcher.folder / record["local_path"]).read_text(encoding="utf-8")), record)
        return files[path]

    def context(record: dict) -> Context:
        if record["url"] not in contexts:
            contexts[record["url"]] = Context(source, record, committed)
        return contexts[record["url"]]

    book_path = "projects/helper/bitcoin-book/index.js"
    if not blob(book_path):
        raise ValueError(f"{book_path} is missing at {commit}")
    tokens, book_record = blob(book_path)
    consts = {}
    for index in range(len(tokens) - 3):
        if tokens[index] == ("n", "const") and tokens[index + 2] == ("p", "=") and tokens[index + 3] == ("p", "["):
            consts[tokens[index + 1][1]] = (index + 3, closing(tokens, index + 3))
    exports = find(tokens, ("n", "module"), ("p", "."), ("n", "exports"), ("p", "="), ("p", "{"))
    if exports < 0:
        raise ValueError(f"{book_path}: unrecognised layout (no module.exports object)")
    book, dynamic = {}, {}
    for key, (first, end) in object_entries(tokens, exports + 4).items():
        if tokens[first] == ("p", "["):
            book[key] = ([value for kind, value in tokens[first:end] if kind == "s"], book_record)
        elif tokens[first][0] == "n" and tokens[first][1] in consts and first + 1 == end:
            start, stop = consts[tokens[first][1]]
            book[key] = ([value for kind, value in tokens[start:stop] if kind == "s"], book_record)
        else:
            dynamic[key] = "computed at run time"
    if "imports" in consts:
        start, stop = consts["imports"]
        pairs = [value for kind, value in tokens[start:stop] if kind == "s"]
        for key, relative in zip(pairs[::2], pairs[1::2], strict=True):
            path = f"{Path(book_path).parent.as_posix()}/{relative.removeprefix('./')}"
            if not blob(path):
                raise ValueError(f"{book_path}: imported {path} is missing")
            part, record = blob(path)
            at = find(part, ("n", "module"), ("p", "."), ("n", "exports"), ("p", "="), ("p", "["))
            if at < 0:
                dynamic[key] = f"{path} does not export a list"
                continue
            book[key] = ([value for kind, value in part[at + 4:closing(part, at + 4)] if kind == "s"], record)
    if len(book) < 10:
        raise ValueError(f"{book_path}: unrecognised layout (only {len(book)} static entries)")
    if not blob("cex/index.js"):
        raise ValueError(f"cex/index.js is missing at {commit}")
    cex_tokens, cex_record = blob("cex/index.js")
    at = find(cex_tokens, ("n", "const"), ("n", "configs"), ("p", "="), ("p", "{"))
    if at < 0:
        raise ValueError("cex/index.js: unrecognised layout (no configs object)")
    configs = {key: (cex_tokens, cex_record, first, end)
               for key, (first, end) in object_entries(cex_tokens, at + 3).items()}
    at = find(cex_tokens, ("n", "const"), ("n", "fileConfigs"), ("p", "="), ("p", "["))
    for name in ([] if at < 0 else [value for kind, value in cex_tokens[at + 3:closing(cex_tokens, at + 3)]
                                    if kind == "s"]):
        if blob(f"cex/{name}.js"):
            part, record = blob(f"cex/{name}.js")
            configs[name] = (part, record, 0, len(part))
    walls = {str(item.get("slug") or "").lower(): item for item in
             json.loads((fetcher.folder / cexs["local_path"]).read_bytes())["cexs"] if item.get("slug")}
    report = []
    for protocol in json.loads((fetcher.folder / protocols["local_path"]).read_bytes()):
        if protocol.get("category") != "CEX":
            continue
        module, name = protocol.get("module") or "", protocol.get("name") or ""
        entity = labels.normalize_entity(name)
        cex = walls.get(str(protocol.get("slug") or "").lower(), {})
        entry = dict(name=name, entity=entity, slug=protocol.get("slug"), module=module,
                     walletsLink=cex.get("walletsLink"), url=cex.get("url") or protocol.get("url"))
        report.append(entry)
        loaded = blob(f"projects/{module}") if module and module != "dummy.js" else None
        if loaded:
            refs, record = bitcoin_refs(loaded[0]), loaded[1]
        elif module.split("/")[0] in configs:
            part, record, first, end = configs[module.split("/")[0]]
            refs = bitcoin_refs(part, first, end)
        else:
            entry["result"] = "no adapter (dummy.js)" if module == "dummy.js" else "no adapter file"
            continue
        operator = operators.get(entity, {})
        kind, why = wallets_link_kind(cex.get("walletsLink"), entry["url"], operator.get("hosts", ()), operator.get("unlisted", False))
        if entity in options.get("excluded", {}):
            kind, why = None, options["excluded"][entity]
        entry.update(evidence_type=kind, reason=why,
                     references=[ref[0] if ref[0] == "list" else f"{ref[0]}:{ref[1]}" for ref in refs])
        if not refs:
            entry["result"] = "no bitcoin configuration"
            continue
        added = 0
        for ref in refs:
            if ref[0] == "list":
                values, file_record, key = ref[1], record, "inline list"
            elif ref[0] == "book" and ref[1] in book:
                (values, file_record), key = book[ref[1]], f"address book entry {ref[1]}"
            else:
                entry.setdefault("unresolved", []).append(
                    f"{ref[1]}: {dynamic.get(ref[1], 'not in the address book')}" if ref[0] == "book" else ref[1])
                continue
            ctx = context(file_record)
            note = (f"DefiLlama-Adapters {file_record['path']} at commit {commit[:12]}: bitcoin owners of its "
                    f"{name} CEX adapter ({key}). {why}; DefiLlama states no source per address.")
            for value in values:
                if not (ADDRESS_LIKE.fullmatch(value.strip()) or value.strip().lower().startswith("bc1")):
                    ctx.skipped["owners string that is not an address"] += 1
                elif kind is None:
                    ctx.excluded.append(dict(address=value, custodian=None, list=name, reason=why,
                                             source=file_record["url"]))
                else:
                    added += ctx.add(value, note, entity=entity, evidence_type=kind, where=f"{name}: {key}")
        entry["result"] = "excluded" if kind is None else f"{added} rows"
    return list(contexts.values()), [dict(repository=options["repository"], commit=commit, committed=committed,
                                          cexs=dict(url=cexs["url"], sha256=cexs["sha256"]),
                                          protocols=dict(url=protocols["url"], sha256=protocols["sha256"]),
                                          adapters=report, dynamic_book_entries=sorted(dynamic))]


RUNNERS = {"defillama": run_defillama}


# --- one source -----------------------------------------------------------------------------

def first_and_last(rows: list[dict], files: int) -> list[dict]:
    """Per address, entity and evidence type, the rows of the first and last files that list it,
    each noting how many files did."""
    groups = defaultdict(list)
    for row in rows:
        groups[(row["address"], row["entity"], row["evidence_type"])].append(row)
    kept = []
    for group in groups.values():
        group.sort(key=lambda row: (row["observed_date"], row["source"], row["historical_note"]))
        listed = len({row["source"] for row in group})
        summary = (f" Listed in {listed} of {files} files of this source, "
                   f"{group[0]['observed_date']} to {group[-1]['observed_date']}.")
        for row in {id(group[0]): group[0], id(group[-1]): group[-1]}.values():
            kept.append(dict(row, historical_note=row["historical_note"] + summary))
    return kept


def run_source(source: dict, research: Path, reuse=(), entities=frozenset(), operators=None) -> dict:
    """Fetch, archive and parse one source; write its labels, rejections and supplement manifest."""
    folder = research / source["id"]
    fetcher = Fetcher(folder, reuse)
    sources, missing = [], []
    if source["parse"] in RUNNERS:
        contexts, enumeration = RUNNERS[source["parse"]](source, fetcher, operators or {})
        for ctx in contexts:
            sources.append(dict(ctx.record, license=source["license"], observed=ctx.observed,
                                addresses=len({row["address"] for row in ctx.rows})))
    else:
        items, enumeration = ENUMERATORS[source["fetch"]](source, fetcher)
        contexts = []
        for item in items:
            try:
                record = item.get("record") or fetch_item(fetcher, source, item)
            except RuntimeError as exc:  # the host did not answer; the source's other files and captures still count
                record = dict(url=item["url"], status=f"failed: {exc}", checked_at=now())
            meta = {key: item[key] for key in ("month", "found_in", "commit", "path") if key in item}
            if record.get("sha256") in source.get("options", {}).get("placeholder_sha256", ()):
                fetcher.forget(record["url"])  # the server's reply for a date it has no snapshot for yet
                record = dict(url=item["url"], status="placeholder", checked_at=record.get("fetched_at"))
            if "status" in record:
                missing.append(dict(meta, url=item["url"], status=record["status"], checked_at=record["checked_at"],
                                    observed=item.get("observed")))
                log(f"{source['id']}: {item['url']} not available (HTTP {record['status']})")
                continue
            observed = item.get("observed") or (record.get("checked_at") or record["fetched_at"])[:10]
            ctx = Context(source, record, observed, entities)
            PARSERS[source["parse"]](folder / record["local_path"], ctx, item)
            contexts.append(ctx)
            sources.append(dict(record, **meta, license=source["license"], observed=ctx.observed,
                                addresses=len({row["address"] for row in ctx.rows}), lists=ctx.lists))
            log(f"{source['id']}: {record['local_path']} {sources[-1]['addresses']} addresses")
    if not sources:
        raise ValueError(f"{source['id']}: no file is available")
    every = [row for ctx in contexts for row in ctx.rows]
    rows = first_and_last(every, len(sources))
    unique = {tuple(row[key] for key in labels.FIELDS): row for row in rows}
    rows = [unique[key] for key in sorted(unique)]
    csv_path = folder / f"{source['id']}_labels.csv"
    labels.write_csv(csv_path, rows)
    rejected = [row for ctx in contexts for row in ctx.rejected]
    labels.write_csv(folder / f"{source['id']}_rejected.csv", rejected, ("value", "reason", "file", "where"))
    excluded = [row for ctx in contexts for row in ctx.excluded]
    dropped, skipped = Counter(), Counter()
    for ctx in contexts:
        dropped.update(ctx.dropped)
        skipped.update(ctx.skipped)
    counts = dict(files=len(sources), missing=len(missing), listed_rows=len(every), evidence_rows=len(rows),
                  unique_addresses=len({row["address"] for row in rows}),
                  addresses_by_entity=dict(Counter(entity for _, entity in
                                                   {(row["address"], row["entity"]) for row in rows}).most_common()),
                  custodian_rows_excluded=len(excluded), btc_rows_on_other_networks=sum(dropped.values()),
                  rejected_rows=len(rejected))
    write_json(folder / f"{source['id']}_supplement.json", dict(
        source_id=source["id"], entity=source.get("entity"), adapter=f"{source.get('fetch')}/{source['parse']}",
        evidence_type=source.get("evidence_type"), landing_page=source["landing"], license=source["license"],
        labels_csv=csv_path.name, labels_sha256=labels.sha256(csv_path), sources=sources, missing=missing,
        excluded=excluded, dropped_other_networks=dict(dropped.most_common()), skipped=dict(skipped.most_common()),
        rejected_csv=f"{source['id']}_rejected.csv", enumeration=enumeration, counts=counts,
        generated_at=now(), policy=(
            "Exact Bitcoin mainnet addresses that the retained files list; nothing is inferred. Each address "
            "keeps the rows of the first and last files listing it, and every file is archived with its "
            "SHA-256. Rows naming a third-party custodian are excluded and listed; BTC on other networks is "
            "counted and dropped.")))
    return counts


def fetch_sources(registry: Path, research: Path, only=(), reuse=()) -> int:
    """Run the active sources (or only the given ids); fetch_report.json records each outcome."""
    sources = load_registry(registry)
    unknown = set(only) - {source["id"] for source in sources}
    if unknown:
        raise SystemExit(f"unknown source ids: {sorted(unknown)}")
    entities = frozenset(source["entity"] for source in sources if source.get("entity"))
    operators = defaultdict(lambda: dict(hosts=[], statuses=set()))
    for source in sources:
        if source.get("entity"):
            operators[source["entity"]]["hosts"].extend(source.get("operator_hosts", []))
            operators[source["entity"]]["statuses"].add(source["status"])
    for operator in operators.values():  # researched and found to publish no list of its own
        operator["unlisted"] = operator.pop("statuses") <= {"no_public_list", "reported_only"}
    research.mkdir(parents=True, exist_ok=True)
    report_path = research / "fetch_report.json"
    failed = 0
    for source in sources:
        if source["status"] != "active" or (only and source["id"] not in only):
            continue
        log(f"{source['id']}: fetching")
        try:
            counts = run_source(source, research, reuse, entities, operators)
            outcome = dict(ok=True, finished=now(), counts=counts)
            log(f"{source['id']}: {counts['unique_addresses']} addresses from {counts['files']} files")
        except Exception as exc:  # noqa: BLE001 - one broken source must not stop the others
            failed += 1
            outcome = dict(ok=False, finished=now(), error=f"{type(exc).__name__}: {exc}")
            log(f"{source['id']}: FAILED {type(exc).__name__}: {exc}")
        report = json.loads(report_path.read_text()) if report_path.exists() else {}  # other runs may have written
        report[source["id"]] = outcome
        write_json(report_path, report)
    return 1 if failed else 0


# --- discovery ---------------------------------------------------------------------------------

def discover(registry: Path, research: Path, tagpacks: Path | None = None, revision: str = labels.DEFAULT_REVISION,
             catalog: Path | None = None) -> dict:
    """Archive the candidate seed lists and write research/candidates.json: every exchange any seed
    names, the registry sources covering it, and a check of its own wallet page when DefiLlama cites one."""
    sources = load_registry(registry)
    fetcher = Fetcher(research / "discovery")
    candidates, seeds = {}, []

    def get(url: str, name: str, **options) -> dict:
        """An archived seed, or a status saying why it could not be fetched (one dead page is not fatal)."""
        try:
            return fetcher.archive(url, name, **options)
        except (RuntimeError, OSError, ValueError) as exc:
            return dict(url=url, status=f"failed: {exc}")

    def read(record: dict):
        return json.loads((fetcher.folder / record["local_path"]).read_bytes())

    def add(name, seed: str, **info) -> None:
        name = " ".join(str(name or "").split())
        if not name:
            return
        entity = labels.normalize_entity(name)
        item = candidates.setdefault(entity.casefold(), dict(name=entity, seeds=[]))
        item["seeds"].append(dict(seed=seed, listed_as=name, **{key: value for key, value in info.items() if value}))

    for source in sources:
        if source.get("entity"):
            add(source["entity"], "registry", source_id=source["id"], status=source["status"], note=source.get("note"))
    record = get("https://api.llama.fi/cexs", "defillama-cexs.json", live=True)
    seeds.append(dict(seed="defillama", **record))
    llama = read(record)["cexs"] if "status" not in record else []
    by_gecko = {item["cgId"]: item["name"] for item in llama if item.get("cgId")}
    for item in llama:
        add(item["name"], "defillama", slug=item.get("slug"), url=item.get("url"),
            walletsLink=item.get("walletsLink"), coingecko=item.get("cgId"))
    for page in range(1, 30):
        record = get(f"https://api.coingecko.com/api/v3/exchanges?per_page=250&page={page}",
                                 f"coingecko-exchanges-{page}.json", live=True)
        seeds.append(dict(seed=f"coingecko page {page}", **record))
        data = [] if "status" in record else read(record)
        if not data:
            break
        for item in data:
            add(by_gecko.get(item.get("id"), item.get("name")), "coingecko", id=item.get("id"), url=item.get("url"),
                country=item.get("country"), trust_score_rank=item.get("trust_score_rank"))
    record = get("https://coinmarketcap.com/rankings/exchanges/", "coinmarketcap-exchanges.html",
                             live=True, headers={"User-Agent": BROWSER})
    seeds.append(dict(seed="coinmarketcap", **record))
    if "status" not in record:
        text = (fetcher.folder / record["local_path"]).read_text(errors="replace")
        for name, slug in sorted(set(re.findall(r'"name":"([^"]{1,60})","slug":"([a-z0-9-]{1,60})"', text))):
            if f'"slug":"{slug}"' in text and f"/exchanges/{slug}/" in text:
                add(name, "coinmarketcap", slug=slug)
    if tagpacks is not None:
        import yaml
        actors = yaml.load(labels.git(tagpacks, "show", f"{revision}:actors/graphsense.actorpack.yaml"),
                           Loader=labels.YAML_LOADER)["actors"]
        seeds.append(dict(seed="graphsense actors", url=f"{labels.REPOSITORY} {revision} actors/graphsense.actorpack.yaml"))
        for actor in actors:
            if "exchange" in [str(category).lower() for category in actor.get("categories") or []]:
                add(labels.ALIASES.get(str(actor["id"]), actor.get("label")), "graphsense", actor=str(actor["id"]),
                    url=actor.get("uri"))
    record = get("https://docs.glassnode.com/basic-api/endpoints/distribution.md", "glassnode-distribution.md",
                 live=True, headers={"User-Agent": BROWSER})
    seeds.append(dict(seed="glassnode", **record))
    if "status" not in record:  # the 'e' parameter of its exchange and reserve metrics lists the exchanges it covers
        text = (fetcher.folder / record["local_path"]).read_text(errors="replace")
        for names in sorted(set(re.findall(r'"name":"e"[^{}]*?"description":"exchange name - ([^"]+)"', text))):
            for name in names.split(","):
                add(name.strip(), "glassnode")
    if catalog is not None:
        counts = json.loads((catalog / "sources_manifest.json").read_text())["counts"]
        for name, count in counts["addresses_by_entity"].items():
            add(name, "catalog", direct_addresses=count)
        with (catalog / "labels_reported.csv").open(newline="", encoding="utf-8") as stream:
            for name, count in Counter(row["entity"] for row in csv.DictReader(stream)).items():
                add(name, "catalog reported tier", reported_addresses=count)
    hosts = defaultdict(list)
    for source in sources:
        if source.get("entity"):
            hosts[source["entity"].casefold()].extend(source.get("operator_hosts", []))
    for item in candidates.values():
        registry_seeds = [seed for seed in item["seeds"] if seed["seed"] == "registry"]
        link = next((seed["walletsLink"] for seed in item["seeds"] if seed.get("walletsLink")), None)
        site = next((seed["url"] for seed in item["seeds"] if seed["seed"] == "defillama" and seed.get("url")), None)
        if any(seed["status"] == "active" for seed in registry_seeds) or not link:
            continue
        kind, why = wallets_link_kind(link, site, hosts.get(item["name"].casefold(), ()))
        if kind != "service_disclosure_via_aggregator":
            item["wallet_page"] = dict(url=link, result=why)
            continue
        record = get(link, f"wallet-page-{registered_domain(urllib.parse.urlsplit(link).hostname or '')}.html",
                                 live=True, headers={"User-Agent": BROWSER})
        if "status" in record:
            item["wallet_page"] = dict(url=link, result=f"HTTP {record['status']}")
            continue
        found = set()
        for match in ADDRESS_LIKE.findall((fetcher.folder / record["local_path"]).read_text(errors="replace")):
            try:
                found.add(labels.normalize_address(match))
            except ValueError:
                pass
        item["wallet_page"] = dict(url=link, local_path=record["local_path"], sha256=record["sha256"],
                                   bitcoin_address_strings=len(found),
                                   result=(f"{len(found)} strings validate as Bitcoin addresses; review before use"
                                           if found else "no Bitcoin address in the served page (it may be scripted)"))
    result = dict(generated_at=now(), seeds=seeds, candidates=sorted(candidates.values(), key=lambda c: c["name"].casefold()))
    write_json(research / "candidates.json", result)
    return dict(candidates=len(candidates), seeds=len(seeds))


# --- coverage report -----------------------------------------------------------------------------

def script_type(address: str) -> str:
    script = labels.address_script(address)
    return {b"\x76\xa9\x14": "P2PKH"}.get(script[:3]) or {
        b"\xa9\x14": "P2SH", b"\x00\x14": "P2WPKH", b"\x00\x20": "P2WSH", b"\x51\x20": "P2TR"}.get(script[:2], "other")


def month_gaps(months: set[str]) -> list[str]:
    """Months between the first and last of months that are not in it."""
    if not months:
        return []
    every = month_list(min(months), max(months))
    return [f"{month[:4]}-{month[4:]}" for month in every if f"{month[:4]}-{month[4:]}" not in months]


def read_rows(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def coverage_report(catalog: Path, registry: Path, research: Path, out: Path) -> dict:
    """Per entity: addresses by evidence type, operator and reported counts, observed dates, snapshot
    months and gaps, script types and sources; then conflicts, rejections, custodian exclusions,
    sources that failed and candidates without usable public addresses. Writes out (JSON) and .md."""
    manifest = json.loads((catalog / "sources_manifest.json").read_text())
    rows = read_rows(catalog / "labels_extended.csv")
    resolved = {row["address"]: row["entity"] for row in read_rows(catalog / "labels_extended_resolved.csv")}
    conflicts = read_rows(catalog / "labels_extended_conflicts.csv")
    sources = load_registry(registry)
    fetched = json.loads((research / "fetch_report.json").read_text()) if (research / "fetch_report.json").exists() else {}
    candidates_path = research / "candidates.json"
    candidates = json.loads(candidates_path.read_text())["candidates"] if candidates_path.exists() else []
    supplements = manifest.get("supplements", [])
    months = defaultdict(set)
    for supplement in supplements:
        for item in supplement.get("sources", []):
            entity = supplement.get("entity")
            if entity and item.get("observed"):
                months[entity].add(item["observed"][:7])
    entities = defaultdict(lambda: dict(rows=[], addresses=set()))
    for row in rows:
        entity = entities[row["entity"]]
        entity["rows"].append(row)
        if resolved.get(row["address"]) == row["entity"]:
            entity["addresses"].add(row["address"])
    conflicted = defaultdict(set)
    for row in conflicts:
        conflicted[row["entity"]].add(row["address"])
    report = []
    for name, entity in sorted(entities.items(), key=lambda item: (-len(item[1]["addresses"]), item[0])):
        kept = [row for row in entity["rows"] if row["address"] in entity["addresses"]]
        by_type = defaultdict(set)
        for row in kept:
            by_type[row["evidence_type"]].add(row["address"])
        operator = set().union(*[by_type[kind] for kind in OPERATOR_TYPES if kind in by_type])
        dates = sorted(row["observed_date"] for row in kept)
        operator_dates = sorted(row["observed_date"] for row in kept if row["evidence_type"] in OPERATOR_TYPES)
        hosts = Counter(f"{row['evidence_type']} {urllib.parse.urlsplit(row['source']).hostname}" for row in kept)
        report.append(dict(
            entity=name, addresses=len(entity["addresses"]), operator_addresses=len(operator),
            reported_only_addresses=len(entity["addresses"] - operator),
            by_evidence_type={kind: len(found) for kind, found in sorted(by_type.items())},
            conflicting_addresses=len(conflicted.get(name, ())),
            first_observed=dates[0] if dates else None, last_observed=dates[-1] if dates else None,
            operator_first_observed=operator_dates[0] if operator_dates else None,
            operator_last_observed=operator_dates[-1] if operator_dates else None,
            snapshot_months=sorted(months.get(name, ())), snapshot_gaps=month_gaps(months.get(name, set())),
            script_types=dict(Counter(script_type(address) for address in entity["addresses"]).most_common()),
            sources=dict(hosts.most_common())))
    by_address = defaultdict(list)
    for row in conflicts:
        by_address[row["address"]].append(dict(entity=row["entity"], evidence_type=row["evidence_type"],
                                                source=row["source"], observed=row["observed_date"]))
    covered = {item["entity"].casefold() for item in report if item["addresses"]}
    registry_by_entity = defaultdict(list)
    for source in sources:
        if source.get("entity"):
            registry_by_entity[source["entity"].casefold()].append(source)
    without = []
    for candidate in candidates:
        if candidate["name"].casefold() in covered:
            continue
        mine = registry_by_entity.get(candidate["name"].casefold(), [])
        reason = ("; ".join(f"{source['id']}: {source['status']} - {source.get('note', '')}" for source in mine)
                  or (candidate.get("wallet_page") or {}).get("result")
                  or "named by a seed list only; no retained source lists its addresses")
        without.append(dict(name=candidate["name"], seeds=sorted({seed["seed"] for seed in candidate["seeds"]}),
                            reason=reason))
    custody = [dict(item, source_id=supplement.get("source_id") or Path(supplement["manifest_path"]).stem)
               for supplement in supplements for item in supplement.get("excluded", [])]
    result = dict(
        generated_at=now(), catalog=str(catalog), catalog_manifest_sha256=labels.sha256(catalog / "sources_manifest.json"),
        counts=manifest["counts"], entities=report,
        conflicts=[dict(address=address, evidence=evidence) for address, evidence in sorted(by_address.items())],
        rejected=dict(catalog=read_rows(catalog / "labels_rejected.csv"),
                      sources={supplement.get("source_id") or Path(supplement["manifest_path"]).stem:
                               supplement.get("counts", {}).get("rejected_rows", 0) for supplement in supplements}),
        dropped_other_networks={supplement.get("source_id"): supplement.get("dropped_other_networks")
                                for supplement in supplements if supplement.get("dropped_other_networks")},
        custodian_exclusions=custody,
        missing_files={supplement.get("source_id"): supplement.get("missing") for supplement in supplements
                       if supplement.get("missing")},
        source_failures={ident: item["error"] for ident, item in fetched.items() if not item.get("ok")},
        blocked_sources=[dict(id=source["id"], entity=source.get("entity"), status=source["status"],
                              note=source.get("note")) for source in sources
                         if source["status"].startswith("blocked") or source["status"] == "deferred"],
        candidates_without_addresses=without)
    write_json(out, result)
    out.with_suffix(".md").write_text(coverage_markdown(result))
    return dict(entities=len(report), conflicts=len(by_address), candidates_without_addresses=len(without))


def coverage_markdown(result: dict) -> str:
    def cell(value) -> str:
        return str(value if value not in (None, "") else "–").replace("|", "/")

    lines = [f"# Exchange address coverage, {result['generated_at'][:10]}", "",
             f"Catalog: {result['catalog']}. Exact listed addresses only; a listing is not proof of control "
             "before or after it. Operator means service_disclosure, service_disclosure_via_graphsense or "
             "service_disclosure_via_aggregator evidence; reported only means third-party tags alone.", "",
             "| Entity | Addresses | Operator | Reported only | By evidence type | First–last observed | "
             "Snapshot months | Gaps | Script types | Sources |", "|" + "---|" * 10]
    for item in result["entities"]:
        if not item["addresses"]:
            continue
        months = item["snapshot_months"]
        lines.append("| " + " | ".join(cell(value) for value in (
            item["entity"], item["addresses"], item["operator_addresses"], item["reported_only_addresses"],
            ", ".join(f"{kind} {count}" for kind, count in item["by_evidence_type"].items()),
            f"{item['first_observed']} – {item['last_observed']}",
            f"{len(months)} ({months[0]} – {months[-1]})" if months else "",
            f"{len(item['snapshot_gaps'])}: {', '.join(item['snapshot_gaps'][:12])}"
            f"{' …' if len(item['snapshot_gaps']) > 12 else ''}" if item["snapshot_gaps"] else "",
            ", ".join(f"{kind} {count}" for kind, count in item["script_types"].items()),
            "; ".join(f"{name} ({count})" for name, count in list(item["sources"].items())[:6]))) + " |")
    lines += ["", f"## Conflicts ({len(result['conflicts'])} addresses, excluded from the resolved catalog)", ""]
    for conflict in result["conflicts"][:300]:
        lines.append(f"- {conflict['address']}: " + "; ".join(
            f"{e['entity']} ({e['evidence_type']}, {e['observed']}, {e['source']})" for e in conflict["evidence"]))
    lines += ["", f"## Custodian exclusions ({len(result['custodian_exclusions'])} rows)", ""]
    for item in result["custodian_exclusions"][:300]:
        lines.append(f"- {item.get('address')}: {item.get('custodian') or item.get('reason')} "
                     f"({item.get('source_id')}, {item.get('list') or item.get('source')}, {item.get('observed', '')})")
    lines += ["", "## BTC rows on other networks (dropped)", ""]
    for ident, counts in result["dropped_other_networks"].items():
        lines.append(f"- {ident}: " + ", ".join(f"{key} {value}" for key, value in counts.items()))
    lines += ["", "## Rejected rows", "", f"- Catalog: {len(result['rejected']['catalog'])}"]
    lines += [f"- {ident}: {count}" for ident, count in result["rejected"]["sources"].items() if count]
    lines += ["", "## Missing files (not published or no longer served)", ""]
    for ident, missing in result["missing_files"].items():
        lines.append(f"- {ident}: {len(missing)} ("
                     + ", ".join(str(item.get("month") or item.get("observed") or item["url"]) for item in missing[:24])
                     + (" …" if len(missing) > 24 else "") + ")")
    lines += ["", "## Sources that failed", ""]
    lines += [f"- {ident}: {error}" for ident, error in result["source_failures"].items()] or ["- none"]
    lines += ["", "## Blocked or deferred sources", ""]
    lines += [f"- {item['id']} ({item['entity']}): {item['status']}. {item.get('note') or ''}"
              for item in result["blocked_sources"]] or ["- none"]
    lines += ["", f"## Candidates without usable public addresses ({len(result['candidates_without_addresses'])})", ""]
    lines += [f"- {item['name']} [{', '.join(item['seeds'])}]: {item['reason']}"
              for item in result["candidates_without_addresses"]]
    return "\n".join(lines) + "\n"

