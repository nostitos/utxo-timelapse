#!/usr/bin/env python3
"""Read-only BLK SHA256 chunks, portable prefix contracts, atomic local/node cache.

API/CLI (run the same standalone file on both hosts):
  scan SOURCE --manifest CACHE           # explicit initial full scan (or reset)
  prefix SOURCE --manifest CACHE --length N > prefix.json
  verify SOURCE --manifest CACHE --contract prefix.json
Each command prints JSON; failures exit 1. Default chunks are 256 MiB. Contracts
contain ordered SHA256s for exactly N bytes, NOT a SHA256 of the entire prefix.
The final digest covers only N % chunk_bytes bytes, even on a longer node file.

Default refresh fully hashes: metadata and chunk hashes cannot establish that
historical bytes were never rewritten. --immutable asserts external protection
from writes since the cached snapshot; it permits reuse ONLY at identical stat.
--append-proof FILE is a TRUSTED CALLER ATTESTATION (not a cryptographic proof):
{ "kind": "verified-append-v1", "manifest_sha256": digest_object(old_manifest),
  "before": old_manifest["source"], "after": snapshot(new_source) }
Only an exclusive append-only writer/independent verifier may issue it, after
successful append and fsync. Never derive it merely from growth, checkpoint tail
or allowBlkFileTruncate=false. Exact before/after binding permits reuse of sealed
chunks; the prior partial chunk and new bytes are read again. Missing continuity
falls back to full hashing; invalid supplied proof, shrink or identity replacement
fails (explicit scan resets). Same-size changed input is fully rehashed.

Caches/proofs must be in trusted directories. Sidecar locks serialize cooperating
callers, NOT writers. Stop writers or hold their shared operational lock throughout
verification/transfer; stat checks detect ordinary races, not hostile restored
metadata. Prefix success is a point-in-time comparison, not transfer authorization.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

CHUNK_BYTES = 256 * 1024 * 1024


def digest_object(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def snapshot(source):
    s = os.fstat(source.fileno()) if hasattr(source, 'fileno') else os.stat(source)
    return dict(dev=s.st_dev, ino=s.st_ino, size=s.st_size,
                mtime_ns=s.st_mtime_ns, ctime_ns=s.st_ctime_ns)


def hash_range(f, offset, length):
    f.seek(offset)
    h = hashlib.sha256()
    while length:
        data = f.read(min(length, 8 * 1024 * 1024))
        if not data:
            raise ValueError('source truncated while hashing')
        h.update(data)
        length -= len(data)
    return h.hexdigest()


def validate_contract(c):
    if c.get('schema') != 'blk-prefix-v1' or c.get('algorithm') != 'sha256':
        raise ValueError('unsupported prefix contract')
    n, chunk = c['length'], c['chunk_bytes']
    if type(n) is not int or n < 0 or type(chunk) is not int or chunk <= 0:
        raise ValueError('invalid byte lengths')
    hashes = c['hashes']
    if not isinstance(hashes, list) or len(hashes) != (n + chunk - 1) // chunk:
        raise ValueError('invalid chunk count')
    for h in hashes:
        if not isinstance(h, str) or len(h) != 64 or any(x not in '0123456789abcdef' for x in h):
            raise ValueError('invalid SHA256')


def atomic_save(path, value):
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, sort_keys=True)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        d = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def locked(path):
    with open(str(path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def refresh(source, manifest, *, scan=False, immutable=False, proof=None,
            length=None, chunk_bytes=CHUNK_BYTES, persist=True):
    """Return (manifest, prefix contract); persist=False reads without sidecar writes.

    Read-only callers must hold an external writer lock. Missing cache needs scan.
    """
    source, manifest = Path(source), Path(manifest)
    if source.resolve() in (manifest.resolve(), Path(str(manifest) + '.lock').resolve()):
        raise ValueError('sidecar must not be source')
    # Also reject hardlinked sidecars, including the lock, before opening for write.
    for p in (manifest, Path(str(manifest) + '.lock')):
        if p.exists() and os.path.samefile(source, p):
            raise ValueError('sidecar aliases source')
    with (locked(manifest) if persist else contextlib.nullcontext()), source.open('rb') as f:
        now = snapshot(f)
        old = None if scan else json.loads(manifest.read_text())
        reuse = 0
        if old is not None:
            if old.get('schema') != 'blk-chunks-v1' or old.get('algorithm') != 'sha256':
                raise ValueError('unsupported cache')
            chunk_bytes = old['chunk_bytes']
            validate_contract(dict(schema='blk-prefix-v1', algorithm='sha256',
                                   length=old['source']['size'], chunk_bytes=chunk_bytes,
                                   hashes=old['hashes']))
            before = old['source']
            if any(now[k] != before[k] for k in ('dev', 'ino')) or now['size'] < before['size']:
                raise ValueError('source replaced or shrunk; explicit scan required')
            if proof is not None:
                if (proof.get('kind') != 'verified-append-v1' or
                    proof.get('manifest_sha256') != digest_object(old) or
                    proof.get('before') != before or proof.get('after') != now or
                    now['size'] <= before['size']):
                    raise ValueError('invalid append attestation')
                reuse = before['size'] // chunk_bytes
            elif immutable and now == before:
                reuse = before['size'] // chunk_bytes
        if type(chunk_bytes) is not int or chunk_bytes <= 0:
            raise ValueError('invalid chunk size')
        n = now['size'] if length is None else length
        if type(n) is not int or not 0 <= n <= now['size']:
            raise ValueError('prefix outside source')
        hashes = old['hashes'][:reuse] if reuse else []
        for offset in range(reuse * chunk_bytes, now['size'], chunk_bytes):
            hashes.append(hash_range(f, offset, min(chunk_bytes, now['size'] - offset)))
        prefix = hashes[:n // chunk_bytes]
        if n % chunk_bytes:
            prefix.append(hash_range(f, n // chunk_bytes * chunk_bytes, n % chunk_bytes))
        if snapshot(f) != now or snapshot(source) != now:
            raise ValueError('source changed during hashing')
        result = dict(schema='blk-chunks-v1', algorithm='sha256', source=now,
                      chunk_bytes=chunk_bytes, hashes=hashes)
        if persist:
            atomic_save(manifest, result)
        return result, dict(schema='blk-prefix-v1', algorithm='sha256', length=n,
                            chunk_bytes=chunk_bytes, hashes=prefix)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['scan', 'prefix', 'verify'])
    p.add_argument('source')
    p.add_argument('--manifest', required=True)
    p.add_argument('--length', type=int)
    p.add_argument('--contract', help='JSON file, or - for stdin')
    trust = p.add_mutually_exclusive_group()
    trust.add_argument('--immutable', action='store_true')
    trust.add_argument('--append-proof')
    a = p.parse_args()
    try:
        expected = None
        if a.command == 'verify':
            if not a.contract:
                raise ValueError('verify requires --contract')
            expected = json.load(sys.stdin) if a.contract == '-' else json.loads(Path(a.contract).read_text())
            validate_contract(expected)
            if a.length is not None and a.length != expected['length']:
                raise ValueError('conflicting length')
            a.length = expected['length']
        result, contract = refresh(a.source, a.manifest, scan=a.command == 'scan',
                                   immutable=a.immutable, length=a.length,
                                   proof=json.loads(Path(a.append_proof).read_text()) if a.append_proof else None)
        if expected is not None:
            if contract != expected:
                raise ValueError('prefix mismatch')
            print(json.dumps(dict(equal=True, prefix=contract, source=result['source'])))
        else:
            print(json.dumps(result if a.command == 'scan' else contract))
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(json.dumps(dict(error=str(e))), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
