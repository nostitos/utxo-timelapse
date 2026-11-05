#!/usr/bin/env python3
"""Publish a landscape dataset to R2 (needs boto3).

Snapshots and chunks are stored once for all datasets at landscape/blobs/<sha256>, the SHA-256 that
the dataset's manifest.json and chunks.json record; the Worker serves /dataset/<id>/<file> from
there. Only content the bucket does not hold yet is uploaded, so an update stores only its new
files. rows.bin, blocktimes.bin, chunks.json and, last, manifest.json go to the dataset's prefix.
A rerun skips everything already present. Verify with scripts/landscape_r2_verify.py.

--copy-from PREFIX copies missing content from PREFIX/<file> inside R2 instead of uploading it. It
moved the datasets published before the shared layout; DATASET_DIR then needs only that dataset's
manifest.json and chunks.json (from /dataset/<id>/).

  landscape_r2_publish.py DATASET_DIR --prefix landscape/<id> [--no-manifest] [--copy-from landscape/<id>]
"""
import argparse, concurrent.futures, hashlib, json, re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from r2_publish_cloud_history import load_credentials
from r2_publish_history_delta import ENDPOINT
import boto3
from botocore.config import Config

BUCKET = 'utxo-video'
BLOBS = 'landscape/blobs/'
META = ('rows.bin', 'blocktimes.bin', 'chunks.json', 'manifest.json')  # upload order: manifest last


def table(d):
    """file -> (sha256, bytes) of a dataset's snapshots and chunks."""
    m = json.loads((d/'manifest.json').read_text()); c = json.loads((d/'chunks.json').read_text())
    t = {e['file']: (e['sha256'], e['bytes']) for e in m['snapshots'] + c['chunks']}
    bad = [f for f, (s, _) in t.items() if not re.fullmatch(r'[0-9a-f]{64}', s)]
    if bad:
        raise SystemExit(f'bad sha256 for {bad[:3]}')
    return t


def digest(path, algo):
    h = hashlib.new(algo)
    with path.open('rb') as f:
        while block := f.read(8 << 20):
            h.update(block)
    return h.hexdigest()


def listing(s3, prefix):
    out = {}
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix):
        for o in page.get('Contents', []):
            out[o['Key']] = (o['Size'], o['ETag'].strip('"'))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset', type=Path); ap.add_argument('--prefix', required=True)
    ap.add_argument('--copy-from'); ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--no-manifest', action='store_true')
    a = ap.parse_args()
    if not re.fullmatch(r'landscape/d\d{1,7}-\d{8}', a.prefix) or (a.copy_from and not re.fullmatch(r'landscape/d\d{1,7}-\d{8}', a.copy_from)):
        raise SystemExit('--prefix and --copy-from must be landscape/d<tip>-<yyyymmdd>')
    files = table(a.dataset)
    on_disk = {p.relative_to(a.dataset).as_posix() for p in a.dataset.rglob('*') if p.is_file() and not p.name.startswith('.')}
    stray = on_disk - set(files) - set(META)
    if stray or 'manifest.json' not in on_disk:
        raise SystemExit(f'incomplete build: unexpected {sorted(stray)[:5]}')
    akey, skey = load_credentials(Path.home()/'.config/utxo-r2/credentials')
    s3 = boto3.client('s3', endpoint_url=ENDPOINT, aws_access_key_id=akey, aws_secret_access_key=skey, region_name='auto',
                      config=Config(retries={'max_attempts': 8, 'mode': 'adaptive'}, max_pool_connections=a.workers+4, connect_timeout=20, read_timeout=300))
    pool = listing(s3, BLOBS)
    source = listing(s3, a.copy_from + '/') if a.copy_from else {}
    unique = {sha: (rel, size) for rel, (sha, size) in files.items()}  # identical files are stored once

    def send(item):
        sha, (rel, size) = item
        key = BLOBS + sha
        if key in pool:
            if pool[key][0] != size:
                raise SystemExit(f'{key}: {pool[key][0]} bytes in R2, {size} in the table ({rel})')
            return 'shared', size
        path = a.dataset/rel
        if path.is_file():
            # The key names the content, so check it before it is stored under that name.
            if path.stat().st_size != size or digest(path, 'sha256') != sha:
                raise SystemExit(f'{rel}: local file does not match its table entry')
            with path.open('rb') as body:
                s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentLength=size, ContentType='application/octet-stream',
                              CacheControl='public, max-age=31536000, immutable', IfNoneMatch='*')
            return 'put', size
        src = a.copy_from + '/' + rel if a.copy_from else None
        if src not in source:
            raise SystemExit(f'{rel}: not in R2, on disk or under --copy-from')
        if source[src][0] != size:
            raise SystemExit(f'{src}: {source[src][0]} bytes in R2, {size} in the table')
        r = s3.copy_object(Bucket=BUCKET, Key=key, CopySource={'Bucket': BUCKET, 'Key': src}, MetadataDirective='COPY')
        if r['CopyObjectResult']['ETag'].strip('"') != source[src][1]:
            raise SystemExit(f'{key}: copy ETag differs from {src}')
        return 'copy', size

    started = time.time(); stats = {'shared': [0, 0], 'put': [0, 0], 'copy': [0, 0]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for i, (how, size) in enumerate(ex.map(send, sorted(unique.items())), 1):
            stats[how][0] += 1; stats[how][1] += size
            if i % 500 == 0:
                print(f'{i}/{len(unique)} {stats} {time.time()-started:.1f}s', flush=True)
    pool = listing(s3, BLOBS)
    missing = [rel for sha, (rel, size) in unique.items() if pool.get(BLOBS + sha, (None,))[0] != size]
    if missing:
        raise SystemExit(f'{len(missing)} files missing from {BLOBS}, for example {missing[:3]}')

    existing = listing(s3, a.prefix + '/')
    meta = {}
    for rel in META:
        if rel not in on_disk or (rel == 'manifest.json' and a.no_manifest):
            continue
        key = a.prefix + '/' + rel; path = a.dataset/rel
        if key in existing:
            if existing[key] != (path.stat().st_size, digest(path, 'md5')):
                raise SystemExit(f'{key} exists with different content')
            meta[rel] = 'present'; continue
        with path.open('rb') as body:
            s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentLength=path.stat().st_size,
                          ContentType='application/json' if rel.endswith('.json') else 'application/octet-stream',
                          CacheControl='public, max-age=31536000, immutable', IfNoneMatch='*')
        meta[rel] = 'put'
    print(json.dumps({'prefix': a.prefix, 'files': len(files), 'unique': len(unique), **stats, 'meta': meta,
                      'seconds': round(time.time()-started, 1)}), flush=True)


if __name__ == '__main__':
    main()
