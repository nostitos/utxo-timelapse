#!/usr/bin/env python3
"""Publish a rebuilt landscape dataset under a new immutable R2 prefix (needs boto3).

Objects whose SHA-256 (manifest.json snapshots / chunks.json chunks) equals the same file in the
currently published dataset are copied server-side inside R2; all other files are uploaded from
the local build. manifest.json is uploaded last, after every other object exists. Resumable through
--state. Verify afterwards with scripts/landscape_r2_verify.py (size + MD5 of every object).

  landscape_r2_publish.py NEW_DIR OLD_DIR --prefix landscape/<new-id> --old-prefix landscape/<old-id> --state FILE [--no-manifest]
"""
import argparse, concurrent.futures, json, sys, threading, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from r2_publish_cloud_history import load_credentials
from r2_publish_history_delta import ENDPOINT
import boto3
from botocore.config import Config

BUCKET = 'utxo-video'


def table(d):
    m = json.loads((d/'manifest.json').read_text()); c = json.loads((d/'chunks.json').read_text())
    t = {s['file']: s['sha256'] for s in m['snapshots']}
    t.update({x['file']: x['sha256'] for x in c['chunks']})
    return t


def ctype(name):
    return 'application/json' if name.endswith('.json') else 'application/octet-stream'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('new', type=Path); ap.add_argument('old', type=Path)
    ap.add_argument('--prefix', required=True); ap.add_argument('--old-prefix', required=True)
    ap.add_argument('--state', type=Path, required=True); ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--no-manifest', action='store_true')
    a = ap.parse_args()
    assert a.prefix != a.old_prefix and a.prefix.startswith('landscape/') and a.old_prefix.startswith('landscape/')
    new, old = table(a.new), table(a.old)
    files = sorted(p.relative_to(a.new).as_posix() for p in a.new.rglob('*') if p.is_file())
    assert 'manifest.json' in files and not any(f.endswith('.tmp') for f in files), 'incomplete build'
    state = json.loads(a.state.read_text()) if a.state.exists() else {'completed': {}}
    lock = threading.Lock()
    akey, skey = load_credentials(Path.home()/'.config/utxo-r2/credentials')
    s3 = boto3.client('s3', endpoint_url=ENDPOINT, aws_access_key_id=akey, aws_secret_access_key=skey, region_name='auto',
                      config=Config(retries={'max_attempts': 8, 'mode': 'adaptive'}, max_pool_connections=a.workers+4, connect_timeout=20, read_timeout=300))

    def save():
        tmp = a.state.with_suffix('.tmp'); tmp.write_text(json.dumps(state, indent=1)); tmp.replace(a.state)

    def done(rel, how, size):
        with lock:
            state['completed'][rel] = {'how': how, 'bytes': size}
            if len(state['completed']) % 200 == 0:
                save()

    def send(rel):
        key = a.prefix+'/'+rel; path = a.new/rel; size = path.stat().st_size
        if rel in new and old.get(rel) == new[rel] and (a.old/rel).stat().st_size == size:
            r = s3.copy_object(Bucket=BUCKET, Key=key, CopySource={'Bucket': BUCKET, 'Key': a.old_prefix+'/'+rel}, MetadataDirective='COPY')
            assert r['CopyObjectResult']['ETag'], rel
            done(rel, 'copy', size); return 'copy', size
        with path.open('rb') as body:
            s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentLength=size, ContentType=ctype(rel),
                          CacheControl='public, max-age=31536000, immutable', IfNoneMatch='*')
        done(rel, 'put', size); return 'put', size

    todo = [f for f in files if f != 'manifest.json' and f not in state['completed']]
    started = time.time(); stats = {'copy': [0, 0], 'put': [0, 0]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for i, (how, size) in enumerate(pool.map(send, todo), 1):
            stats[how][0] += 1; stats[how][1] += size
            if i % 500 == 0:
                print(f'{i}/{len(todo)} {stats} {time.time()-started:.1f}s', flush=True)
    save()
    body_seconds = time.time()-started
    if not a.no_manifest:
        how, size = send('manifest.json'); stats[how][0] += 1; stats[how][1] += size
        save()
    result = {'prefix': a.prefix, 'files': len(files), 'copied': stats['copy'], 'uploaded': stats['put'], 'seconds': round(time.time()-started, 1),
              'bodySeconds': round(body_seconds, 1), 'manifestUploaded': not a.no_manifest}
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()

