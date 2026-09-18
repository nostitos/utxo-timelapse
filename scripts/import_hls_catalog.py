#!/usr/bin/env python3
"""One-time, read-only HLS catalog bootstrap. Never uploads or converts video.

CLI: import_hls_catalog.py inventory SPEC.json
     import_hls_catalog.py bootstrap SPEC.json --allow-remote
SPEC: {playlistPath: absolute saved media.m3u8, playlistURL: HTTPS public URL,
       playlistSHA256: exact saved-playlist hash, destination: fresh absolute dir,
       localObjects: {absolute public object URL: absolute cached file path}}
localObjects is optional. Without a cache, bootstrap streams each object via GET
once; with a cache it streams local bytes once and verifies remote HEAD size/MD5
ETag. Multipart/non-MD5 ETags cannot authenticate a local cache; omit that cache
mapping to use GET. No hashes are inferred from filenames or ETags.

Inventory is offline and emits only URIs/counts, NOT a trusted ledger. Explicit
bootstrap may read the ENTIRE historical media corpus once (e.g. 84 GB): budget
bandwidth/time first. It does not save fragments. Only init and small manifests
are saved. Hashes and timing come from bytes, not rounded playlist EXTINF values.
At completion, use destination/segments.json + its SHA256 as the pinned previous
manifest, and destination/<init SHA256>.mp4 as package_append's oldInit.

Supported: complete, sequence-zero, single-map, unencrypted continuous fMP4 VOD,
one video track, one moof/traf/tfdt/mfhd per object, explicit or default sample
sizes/durations. Discontinuities, variant playlists, byte ranges, encryption,
redirects and changed objects fail closed. Immutable URI retention remains an
operator contract: bootstrap verifies observed bytes, not future object changes.
No auto-bootstrap, conversion, deployment, credential loading or upload path.
"""
import argparse
import fcntl
from fractions import Fraction
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

from fragment_manifest import atomic_json, sync_dir, validate_metadata, validate_uri

CHUNK = 1024*1024
MAX_METADATA = 16*1024*1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def children(data):
    pos = 0
    while pos < len(data):
        require(pos+8 <= len(data), 'truncated metadata box')
        size, kind = struct.unpack_from('>I4s', data, pos)
        header = 8
        if size == 1:
            require(pos+16 <= len(data), 'truncated extended metadata box')
            size = struct.unpack_from('>Q', data, pos+8)[0]; header = 16
        require(size >= header and pos+size <= len(data), 'invalid metadata box size')
        yield kind, data[pos+header:pos+size]
        pos += size


def one(data, name):
    matches = [body for kind, body in children(data) if kind == name]
    require(len(matches) == 1, 'requires exactly one '+name.decode())
    return matches[0]


def uint(data, offset, width=4):
    require(offset+width <= len(data), 'truncated integer field')
    return int.from_bytes(data[offset:offset+width], 'big')


def init_metadata(moov):
    track = one(moov, b'trak')
    tkhd = one(track, b'tkhd')
    require(tkhd and tkhd[0] in (0, 1), 'unsupported tkhd version')
    track_id = uint(tkhd, 20 if tkhd[0] else 12)
    mdia = one(track, b'mdia')
    hdlr = one(mdia, b'hdlr')
    require(hdlr[8:12] == b'vide', 'one video track required')
    mdhd = one(mdia, b'mdhd')
    require(mdhd and mdhd[0] in (0, 1), 'unsupported mdhd version')
    scale = uint(mdhd, 20 if mdhd[0] else 12)
    trex = one(one(moov, b'mvex'), b'trex')
    require(uint(trex, 4) == track_id and scale > 0, 'track/timescale mismatch')
    return {'trackID': track_id, 'timescale': scale,
            'defaultDuration': uint(trex, 12), 'defaultSize': uint(trex, 16)}


def fragment_metadata(moof, init):
    mfhd = one(moof, b'mfhd')
    sequence = uint(mfhd, 4)
    traf = one(moof, b'traf')
    require(all(kind in (b'tfhd', b'tfdt', b'trun') for kind, _ in children(traf)), 'unsupported/encrypted traf metadata')
    tfhd = one(traf, b'tfhd')
    flags = uint(tfhd, 0) & 0xffffff
    require(uint(tfhd, 4) == init['trackID'] and not flags & 0x10000, 'invalid fragment track')
    pos = 8 + (8 if flags & 1 else 0) + (4 if flags & 2 else 0)
    duration, size = init['defaultDuration'], init['defaultSize']
    if flags & 8:
        duration = uint(tfhd, pos); pos += 4
    if flags & 16:
        size = uint(tfhd, pos); pos += 4
    if flags & 32:
        uint(tfhd, pos); pos += 4
    require(pos == len(tfhd), 'unexpected tfhd layout')
    tfdt = one(traf, b'tfdt')
    require(tfdt and tfdt[0] in (0, 1), 'unsupported tfdt version')
    start = uint(tfdt, 4, 8 if tfdt[0] else 4)
    ticks, payload_bytes, samples = 0, 0, 0
    runs = [body for kind, body in children(traf) if kind == b'trun']
    require(runs, 'missing sample run')
    for run in runs:
        require(run and run[0] in (0, 1), 'unsupported trun version')
        f, count = uint(run, 0) & 0xffffff, uint(run, 4)
        require(0 < count <= 1000000 and not f & ~0xf05, 'unsupported sample flags/count')
        p = 8 + (4 if f & 1 else 0) + (4 if f & 4 else 0)
        for _ in range(count):
            d, n = duration, size
            if f & 0x100:
                d = uint(run, p); p += 4
            if f & 0x200:
                n = uint(run, p); p += 4
            if f & 0x400:
                uint(run, p); p += 4
            if f & 0x800:
                uint(run, p); p += 4
            require(d > 0 and n > 0, 'missing sample duration/size')
            ticks += d; payload_bytes += n
        require(p == len(run), 'unexpected trun length')
        samples += count
    return {'startTicks': start, 'durationTicks': ticks, 'sequence': sequence,
            'sampleBytes': payload_bytes, 'samples': samples}


def scan(stream, length, *, init=None):
    """Single forward pass, bounded buffers; hashes every header and media byte."""
    sha, md5 = hashlib.sha256(), hashlib.md5()
    remaining = length
    metadata, payload_hashes, payload_size = {}, [], 0
    def read(n):
        nonlocal remaining
        require(n <= remaining, 'box exceeds object length')
        chunks = []
        while n:
            data = stream.read(min(n, CHUNK))
            require(bool(data), 'truncated object stream')
            sha.update(data); md5.update(data)
            remaining -= len(data); n -= len(data); chunks.append(data)
        return b''.join(chunks)
    while remaining:
        require(remaining >= 8, 'truncated object box header')
        header = read(8)
        size, kind = struct.unpack('>I4s', header)
        h = 8
        if size == 1:
            size = int.from_bytes(read(8), 'big'); h = 16
        if size == 0:
            size = remaining+h
        require(size >= h and size-h <= remaining, 'invalid object box size')
        body_size = size-h
        if kind in (b'moov', b'moof', b'sidx'):
            require(body_size <= MAX_METADATA and kind not in metadata, 'oversized/duplicate metadata box')
            metadata[kind] = read(body_size)
        else:
            payload = hashlib.sha256() if kind == b'mdat' else None
            if payload is not None:
                payload_size += body_size
            while body_size:
                data = read(min(body_size, CHUNK)); body_size -= len(data)
                if payload is not None:
                    payload.update(data)
            if payload is not None:
                payload_hashes.append(payload.hexdigest())
    require(not stream.read(1), 'object longer than Content-Length')
    result = {'sha256': sha.hexdigest(), 'md5': md5.hexdigest(), 'bytes': length}
    if init is None:
        require(b'moov' in metadata and b'moof' not in metadata and not payload_hashes, 'invalid init object')
        result['initMetadata'] = init_metadata(metadata[b'moov'])
    else:
        require(b'moof' in metadata and b'moov' not in metadata and payload_hashes, 'invalid fragment object')
        result.update(fragment_metadata(metadata[b'moof'], init))
        require(result['sampleBytes'] == payload_size, 'mdat/sample-size mismatch')
        if b'sidx' in metadata:
            require(uint(metadata[b'sidx'], 8) == init['timescale'], 'sidx timescale mismatch')
        result['payloadSHA256'] = payload_hashes
    return result


def inventory(spec):
    path = Path(spec['playlistPath'])
    require(path.is_absolute() and Path(spec['destination']).is_absolute(), 'absolute local paths required')
    raw = path.read_bytes()
    require(len(raw) <= MAX_METADATA and digest(raw) == spec['playlistSHA256'], 'playlist digest/size mismatch')
    url = spec['playlistURL']
    validate_uri(url)
    require(urlsplit(url).scheme == 'https' and not urlsplit(url).username, 'HTTPS playlist URL required')
    origin = (urlsplit(url).scheme, urlsplit(url).netloc)
    def resolve(uri):
        result = urljoin(url, uri)
        validate_uri(result)
        require((urlsplit(result).scheme, urlsplit(result).netloc) == origin, 'cross-origin playlist object refused')
        return result
    init, entries, pending, ended = None, [], None, False
    lines = raw.decode('utf-8-sig').splitlines()
    require(lines and lines[0] == '#EXTM3U', 'media playlist header required')
    allowed = ('#EXT-X-VERSION:', '#EXT-X-TARGETDURATION:', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS')
    for line in lines[1:]:
        if not line:
            continue
        require(not ended, 'content after ENDLIST')
        if line.startswith('#EXT-X-MAP:'):
            match = re.fullmatch(r'#EXT-X-MAP:URI="([^"]+)"', line)
            require(match is not None and not entries and pending is None, 'one simple init map required')
            value = resolve(match[1])
            require(init is None or init == value, 'changed init map')
            init = value
        elif line.startswith('#EXTINF:'):
            require(pending is None and init is not None, 'missing map or duplicate duration')
            pending = Fraction(line.split(':', 1)[1].split(',', 1)[0])
            require(pending > 0, 'invalid EXTINF')
        elif line == '#EXT-X-ENDLIST':
            require(pending is None, 'missing segment URI'); ended = True
        elif line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
            require(line == '#EXT-X-MEDIA-SEQUENCE:0', 'sequence-zero catalog required')
        elif line.startswith(allowed):
            pass
        elif line.startswith('#EXT'):
            raise ValueError('unsupported HLS feature: '+line.split(':')[0])
        elif line.startswith('#'):
            pass
        else:
            require(pending is not None, 'segment without EXTINF')
            entries.append({'uri': resolve(line), 'duration': str(pending)})
            pending = None
    require(ended and init and entries, 'complete VOD playlist required')
    require(len({e['uri'] for e in entries}) == len(entries) and init not in {e['uri'] for e in entries}, 'repeated object URI')
    overrides = spec.get('localObjects', {})
    require(set(overrides) <= {init, *(e['uri'] for e in entries)}, 'unknown local object mapping')
    require(all(Path(p).is_absolute() for p in overrides.values()), 'absolute cached paths required')
    return {'playlistURL': url, 'playlistSHA256': digest(raw), 'initURI': init, 'segments': entries,
            'phase': 'inventory-only', 'objectCount': len(entries)+1}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('bootstrap redirects refused')


def bootstrap(spec, *, opener=None):
    catalog = inventory(spec)
    opener = opener or build_opener(NoRedirect()).open
    destination = Path(spec['destination'])
    require(not destination.exists(), 'fresh bootstrap destination required')
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.catalog-', dir=destination.parent))
    observations = []
    def request(uri, method='GET', headers=None):
        response = opener(Request(uri, method=method, headers={'Accept-Encoding': 'identity', **(headers or {})}), timeout=60)
        try:
            require(response.status == 200 and response.geturl() == uri, 'HTTP status/URL mismatch')
            require(response.headers.get('Content-Encoding', 'identity') == 'identity', 'encoded response refused')
            return response
        except BaseException:
            response.close(); raise
    def playlist_matches():
        with request(spec['playlistURL']) as response:
            raw = response.read(MAX_METADATA+1)
            require(len(raw) <= MAX_METADATA and digest(raw) == spec['playlistSHA256'], 'remote playlist changed')
    try:
        playlist_matches()
        for uri in [catalog['initURI'], *(e['uri'] for e in catalog['segments'])]:
            with request(uri, 'HEAD') as response:
                size = int(response.headers['Content-Length'])
                etag = response.headers.get('ETag', '')
            require(size > 0 and etag.startswith('"') and etag.endswith('"') and not etag.startswith('W/'), 'strong ETag/size required')
            if uri == catalog['initURI']:
                require(size <= MAX_METADATA, 'oversized init')
            local = spec.get('localObjects', {}).get(uri)
            init_meta = ledger_init if uri != catalog['initURI'] else None
            if local:
                require(re.fullmatch(r'"[0-9a-fA-F]{32}"', etag) is not None, 'local cache requires MD5 ETag; use remote GET')
                path = Path(local)
                before = path.stat()
                require(before.st_size == size, 'cached object length mismatch')
                with path.open('rb') as stream:
                    result = scan(stream, size, init=init_meta)
                after = path.stat()
                require((before.st_size, before.st_mtime_ns, before.st_ino) ==
                        (after.st_size, after.st_mtime_ns, after.st_ino), 'cached object changed')
                require(result['md5'] == etag.strip('"').lower(), 'cached bytes do not match remote ETag')
                # Small init only is reread to retain an input for package_append.
                init_bytes = path.read_bytes() if init_meta is None else None
            else:
                with request(uri, headers={'If-Match': etag}) as response:
                    require(response.headers.get('ETag') == etag and int(response.headers['Content-Length']) == size, 'object changed before GET')
                    if init_meta is None:
                        require(size <= MAX_METADATA, 'oversized init')
                        init_bytes = response.read(size+1)
                        require(len(init_bytes) == size, 'init size mismatch')
                        result = scan(io.BytesIO(init_bytes), size)
                    else:
                        result = scan(response, size, init=init_meta)
                if re.fullmatch(r'"[0-9a-fA-F]{32}"', etag):
                    require(result['md5'] == etag.strip('"').lower(), 'remote ETag/body mismatch')
            with request(uri, 'HEAD') as response:
                require(response.headers.get('ETag') == etag and int(response.headers['Content-Length']) == size, 'object changed during scan')
            suffix = '.mp4' if init_meta is None else '.m4s'
            entry = {k: result[k] for k in ('sha256', 'bytes')}
            entry.update(file=result['sha256']+suffix, uri=uri)
            observations.append({'uri': uri, 'etag': etag, 'bytes': size, 'sha256': result['sha256'],
                                 'source': 'local-cache+remote-HEAD' if local else 'remote-GET'})
            if init_meta is None:
                ledger_init = result['initMetadata']
                ledger = {'format': 'utxo-fmp4-segments-v1', 'timescale': ledger_init['timescale'], 'init': entry, 'segments': []}
                require(digest(init_bytes) == result['sha256'], 'init changed after scan')
                (staging/entry['file']).write_bytes(init_bytes)
            else:
                expected = Fraction(catalog['segments'][len(ledger['segments'])]['duration'])*ledger['timescale']
                require(abs(result['durationTicks']-expected) <= max(1, math.ceil(ledger['timescale']/1000)), 'EXTINF differs from sample duration')
                entry.update({k: result[k] for k in ('startTicks', 'durationTicks', 'sequence', 'payloadSHA256')})
                ledger['segments'].append(entry)
        validate_metadata(ledger)  # Exact tfdt continuity and sequential mfhd, not EXTINF inference.
        playlist_matches()
        atomic_json(staging/'segments.json', ledger)
        receipt = {'format': 'utxo-hls-bootstrap-v1', 'phase': 'bytes-verified', 'playlistSHA256': spec['playlistSHA256'],
                   'playlistURL': spec['playlistURL'], 'segmentsSHA256': digest((staging/'segments.json').read_bytes()),
                   'bytesScanned': sum(o['bytes'] for o in observations), 'objects': observations,
                   'fragmentsSaved': False, 'futureImmutableURIsAssumed': True}
        atomic_json(staging/'bootstrap.json', receipt)
        with (staging/ledger['init']['file']).open('rb') as stream:
            os.fsync(stream.fileno())
        sync_dir(staging)
        with (destination.parent/('.'+destination.name+'.catalog.lock')).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            require(not destination.exists(), 'bootstrap destination already committed')
            os.rename(staging, destination)
            sync_dir(destination.parent)
        return receipt
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inventory', 'bootstrap'])
    parser.add_argument('spec', type=Path)
    parser.add_argument('--allow-remote', action='store_true', help='Explicitly permit bootstrap HEAD/GET; may stream full history')
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    if args.command == 'bootstrap' and not args.allow_remote:
        parser.error('bootstrap requires --allow-remote; budget full historical read first')
    print(json.dumps(inventory(spec) if args.command == 'inventory' else bootstrap(spec), indent=2))
