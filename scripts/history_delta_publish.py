#!/usr/bin/env python3
"""Journal-driven history publication. Staging never deploys or changes the live release.

bootstrap: one-time stable record-position cache, validated against an existing
release's base ETags AND spend patches. stage: touch only journal-affected shards;
reuse every unchanged object, merge small patches, rebuild only the creation tail.
upload: separate immutable upload step. See docs/history-delta-publication.md.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import time
import threading
import fcntl
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from r2_publish_cloud_history import (HISTORY_HEADER, RECORD_DTYPE, SHARD_HEADER,
                                     UNSPENT, build_shard, satoshi_rows)

ROWS = 2072
BLOCKS = 512
JOURNAL_HEADER = 184
SPEND_DTYPE = np.dtype([('id', '<u8'), ('creationHeight', '<u4'),
                       ('spendHeight', '<u4'), ('satoshi', '<i8')])
GEOMETRY = 'buv-three-zone-2072-1e13-low-third-top015-stable-v1'
OBJECT_LOCK = threading.RLock()


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def md5(data):
    return hashlib.md5(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def immutable(path, data):
    with OBJECT_LOCK:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            require(path.read_bytes() == data, 'refusing to overwrite ' + str(path))
            return
        pending = path.with_name(path.name + '.pending')
        with pending.open('xb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(pending, path)
        finally:
            pending.unlink()


def identity(path):
    st = Path(path).stat()
    return [st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_dev, st.st_ino]


class History:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = self.path.open('rb')
        fcntl.flock(self.lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        self.identity = identity(path)
        self.header = self.lock.read(64)
        magic, self.blocks, self.count, toff, ioff, roff, _ = HISTORY_HEADER.unpack(self.header)
        require(magic == b'BUVHIST1' and 0 < self.blocks < UNSPENT, 'bad history header')
        for offset, size in [(toff, self.blocks*4), (ioff, (self.blocks+1)*8), (roff, self.count*16)]:
            require(offset >= 64 and offset+size <= self.path.stat().st_size, 'bad history section')
        self.records = (np.memmap(path, dtype=RECORD_DTYPE, mode='r', offset=roff, shape=(self.count,))
                        if self.count else np.empty(0,dtype=RECORD_DTYPE))
        self.index = np.memmap(path, dtype='<u8', mode='r', offset=ioff, shape=(self.blocks+1,))
        self.times = np.memmap(path, dtype='<u4', mode='r', offset=toff, shape=(self.blocks,))
        require(self.index[0] == 0 and self.index[-1] == self.count and
                np.all(self.index[1:] >= self.index[:-1]), 'bad height index')

    def unchanged(self):
        require(identity(self.path) == self.identity, 'history changed during staging')

    def __del__(self):
        if hasattr(self,'lock'):
            self.lock.close()


class Journal:
    def __init__(self, path):
        self.data = Path(path).read_bytes()
        d = self.data
        require(len(d) >= JOURNAL_HEADER+32 and d[:8] == b'BUVDLT01', 'bad delta journal')
        require(hashlib.sha256(d[:-32]).digest() == d[-32:], 'journal checksum mismatch')
        self.before, self.after = d[8:72], d[72:136]
        bh, ah = HISTORY_HEADER.unpack(self.before), HISTORY_HEADER.unpack(self.after)
        require(bh[0] == ah[0] == b'BUVHIST1', 'bad journal history magic')
        self.old_blocks, self.old_count = bh[1:3]
        self.blocks, self.count = ah[1:3]
        require(0 < self.old_blocks < self.blocks < UNSPENT and self.old_count <= self.count,
                'bad journal boundary')
        require(ah[5] == bh[5] and ah[3] == ah[5]+self.count*16 and ah[4] == ah[3]+self.blocks*4,
                'bad journal target offsets')
        n = struct.unpack_from('<Q', d, 136)[0]
        expected = JOURNAL_HEADER+n*24+(self.count-self.old_count)*16+self.blocks*4+(self.blocks+1)*8+32
        require(len(d) == expected, 'journal length mismatch')
        off = JOURNAL_HEADER
        self.spends = np.frombuffer(d, dtype=SPEND_DTYPE, count=n, offset=off); off += n*24
        self.new = np.frombuffer(d, dtype=RECORD_DTYPE, count=self.count-self.old_count, offset=off)
        off += len(self.new)*16
        self.times = np.frombuffer(d, dtype='<u4', count=self.blocks, offset=off); off += self.blocks*4
        self.index = np.frombuffer(d, dtype='<u8', count=self.blocks+1, offset=off)
        require(self.index[0] == 0 and self.index[-1] == self.count and
                self.index[self.old_blocks] == self.old_count and np.all(self.index[1:] >= self.index[:-1]),
                'invalid journal height index')
        require(len(np.unique(self.spends['id'])) == n, 'duplicate journal record id')
        s = self.spends
        require(np.all(s['id'] < self.old_count) and np.all(s['creationHeight'] < self.old_blocks) and
                np.all(s['spendHeight'] >= self.old_blocks) and np.all(s['spendHeight'] < self.blocks) and
                np.all(s['satoshi'] > 0), 'invalid journal spend')
        require(np.all(s['id'] >= self.index[s['creationHeight']]) and
                np.all(s['id'] < self.index[s['creationHeight']+1]), 'journal record creation mismatch')
        require(np.all(self.new['creationHeight'] >= self.old_blocks) and
                np.all(self.new['creationHeight'] < self.blocks) and np.all(self.new['satoshi'] > 0) and
                np.all((self.new['spendHeight'] == UNSPENT) |
                       ((self.new['spendHeight'] >= self.new['creationHeight']) & (self.new['spendHeight'] < self.blocks))),
                'invalid new journal record')


class Objects:
    """Local immutable read-through cache; optional remote reads, never implicit uploads."""
    def __init__(self, root, s3=None, bucket='utxo-video'):
        self.root, self.s3, self.bucket = Path(root), s3, bucket

    def path(self, key):
        p = Path(key)
        require(not p.is_absolute() and '..' not in p.parts and str(p) == key, 'unsafe object key')
        return self.root/p

    def get(self, key, etag=None):
        p = self.path(key)
        if not p.exists():
            require(self.s3 is not None, 'missing cached object ' + key)
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
            data = obj['Body'].read()
            require(not etag or md5(data) == etag.strip('"'), 'remote object checksum mismatch')
            immutable(p, data)
        data = p.read_bytes()
        require(not etag or md5(data) == etag.strip('"'), 'cached object checksum mismatch')
        return data


def parse_patch(data, shard, n, base_tip, tip):
    require(len(data) >= 32+(ROWS+1)*8, 'short patch')
    magic, version, rows, h1, h2, count = SHARD_HEADER.unpack_from(data)
    require(magic == b'BUVSPN1\0' and version == 1 and rows == ROWS and h1 == shard*BLOCKS and
            h1 < h2 <= (shard+1)*BLOCKS, 'bad patch header')
    require(len(data) == 32+(ROWS+1)*8+count*8, 'bad patch length')
    offsets = np.frombuffer(data, '<u8', ROWS+1, 32)
    pairs = np.frombuffer(data, '<u4', count*2, 32+(ROWS+1)*8).reshape((-1, 2)).copy()
    require(offsets[0] == 0 and offsets[-1] == count and np.all(offsets[1:] >= offsets[:-1]), 'bad patch offsets')
    require(np.all(pairs[:, 0] < n) and np.all(pairs[1:, 0] > pairs[:-1, 0]) and
            np.all(pairs[:, 1] > base_tip) and np.all(pairs[:, 1] <= tip), 'invalid patch records')
    return offsets, pairs


def patch_bytes(shard, end, offsets, pairs):
    patch_offsets = np.searchsorted(pairs[:, 0], offsets).astype('<u8')
    return (SHARD_HEADER.pack(b'BUVSPN1\0', 1, ROWS, shard*BLOCKS, end, len(pairs)) +
            patch_offsets.tobytes() + pairs.astype('<u4').tobytes())


def make_mapping(history, shard, cache):
    a, b = int(history.index[shard*BLOCKS]), int(history.index[min((shard+1)*BLOCKS, history.blocks)])
    require(b-a < 2**32, 'shard exceeds u32 positions')
    y = satoshi_rows(history.records[a:b]['satoshi'], ROWS)
    order = np.argsort(y, kind='stable')
    inverse = np.empty(len(y), dtype='<u4'); inverse[order] = np.arange(len(y), dtype='<u4')
    offsets = np.zeros(ROWS+1, dtype='<u8'); offsets[1:] = np.cumsum(np.bincount(y, minlength=ROWS))
    body = offsets.tobytes()+inverse.tobytes()
    digest = sha(body)
    path = Path(cache).resolve()/(digest+'.positions')
    immutable(path, body)
    return dict(path=str(path), sha256=digest, identity=identity(path), firstRecord=a, count=b-a,
                geometry=GEOMETRY)


def load_mapping(desc):
    m = desc['mapping']
    require(m['geometry'] == GEOMETRY and identity(m['path']) == m['identity'],
            'position cache changed; revalidate/rebuild it, do not silently trust it')
    require(m['identity'][0] == (ROWS+1)*8+m['count']*4, 'wrong position cache size')
    offsets = np.memmap(m['path'], '<u8', 'r', shape=(ROWS+1,))
    positions = np.memmap(m['path'], '<u4', 'r', offset=(ROWS+1)*8, shape=(m['count'],)) if m['count'] else np.empty(0, '<u4')
    return offsets, positions


def bootstrap(history_path, seed, cache, objects, output, workers=4):
    h = History(history_path)
    require(seed['historyHeader'] == h.header.hex() and seed['geometry'] == GEOMETRY, 'seed/history mismatch')
    require(set(seed['shards']) == {str(i) for i in range((h.blocks+511)//512)}, 'incomplete seed')
    def one(item):
        key, desc = item; n = int(key); desc = dict(desc)
        receipt = Path(cache)/('bootstrap-'+sha(json_bytes([h.header.hex(), h.identity, desc]))+'.json')
        if receipt.exists():
            saved = json.loads(receipt.read_text()); load_mapping(saved)
            return key, saved
        # Expensive ONCE, not repeated during updates. Prove positions against
        # the base ETag and current patch, not just amounts or a small sample.
        payload, _ = build_shard(h.records, h.index, n, BLOCKS, h.blocks, ROWS)
        count = SHARD_HEADER.unpack_from(payload)[-1]
        records_off = 32+(ROWS+1)*8
        source = np.frombuffer(payload, RECORD_DTYPE, count, records_off)
        base = bytearray(payload)
        original = np.frombuffer(base, RECORD_DTYPE, count, records_off)
        changed = (source['spendHeight'] > desc['baseTip']) & (source['spendHeight'] != UNSPENT)
        original['spendHeight'][changed] = UNSPENT
        require(md5(base) == desc['baseEtag'], 'base shard differs from history: '+key)
        indices = np.flatnonzero(changed)
        if desc.get('patchKey'):
            po, pairs = parse_patch(objects.get(desc['patchKey'], desc['patchEtag']), n, count, desc['baseTip'], h.blocks-1)
            offsets = np.frombuffer(payload, '<u8', ROWS+1, 32)
            require(np.array_equal(po, np.searchsorted(pairs[:, 0], offsets)), 'patch row index mismatch')
            require(np.array_equal(pairs[:, 0], indices) and np.array_equal(pairs[:, 1], source['spendHeight'][changed]),
                    'current patch does not reproduce history')
        else:
            require(not len(indices), 'missing previous spend patch')
        desc['mapping'] = make_mapping(h, n, cache)
        desc['endHeight'] = min((n+1)*BLOCKS, h.blocks)
        immutable(receipt, json_bytes(desc))
        return key, desc
    began = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        shards = {}
        for key, desc in pool.map(one, seed['shards'].items()):
            shards[key] = desc
            if len(shards)%100 == 0 or len(shards) == len(seed['shards']):
                print(json.dumps(dict(phase='bootstrap', completed=len(shards),total=len(seed['shards']),
                                      seconds=time.monotonic()-began)),flush=True)
    h.unchanged()
    catalog = dict(format='buv-history-catalog-v1', historyHeader=h.header.hex(), geometry=GEOMETRY, shards=shards)
    immutable(output, json_bytes(catalog))
    return dict(shards=len(shards), seconds=time.monotonic()-began)


def stage(history_path, journal_path, catalog, objects, cache, output, prefix):
    started = time.monotonic()
    h, j = History(history_path), Journal(journal_path)
    require(catalog['format'] == 'buv-history-catalog-v1' and catalog['geometry'] == GEOMETRY, 'unsupported catalog')
    require(catalog['historyHeader'] == j.before.hex(), 'journal does not extend last catalog')
    require(h.header == j.after and np.array_equal(h.index, j.index) and np.array_equal(h.times, j.times),
            'journal is not committed to this history')
    require(np.array_equal(h.records[j.old_count:], j.new), 'journal creation payload differs')
    require(set(catalog['shards']) == {str(i) for i in range((j.old_blocks+511)//512)}, 'incomplete catalog')
    require(prefix.startswith('explorer/') and '..' not in prefix.split('/') and not prefix.endswith('/'), 'unsafe prefix')
    previous_keys = {v.get(k) for v in catalog['shards'].values() for k in ['baseKey','patchKey']}
    require(not any(k and k.startswith(prefix+'/') for k in previous_keys), 'fresh immutable prefix required')
    output = Path(output); require(not output.exists(), 'staging directory already exists; preserve it and use a fresh path')
    output.mkdir(parents=True)
    artifacts = []
    def artifact(key, body):
        path = output/'objects'/key
        immutable(path, body)
        # Preserve the tiny merged patches locally for the NEXT update too.
        # Otherwise each run would serially fetch its own previous uploads.
        cached = objects.path(key)
        cached.parent.mkdir(parents=True, exist_ok=True)
        if cached.exists():
            require(cached.read_bytes() == body, 'staged object cache collision')
        else:
            try:
                os.link(path, cached)
            except OSError as error:
                if error.errno != 18:  # EXDEV: cache on another filesystem
                    raise
                immutable(cached, body)
        artifacts.append(dict(key=key, path=str(path.resolve()), bytes=len(body), md5=md5(body), sha256=sha(body)))
        return md5(body)
    shards = json.loads(json.dumps(catalog['shards']))
    tail = set(range(j.old_blocks//BLOCKS, (j.blocks+511)//BLOCKS))
    # One grouping pass, not one scan of the entire delta per historical shard.
    shard_ids = j.spends['creationHeight']//BLOCKS
    order = np.argsort(shard_ids, kind='stable')
    groups, starts = np.unique(shard_ids[order], return_index=True)
    grouped = {int(n): j.spends[order[a:b]] for n,a,b in
               zip(groups, starts, list(starts[1:])+[len(order)])}
    def previous_patch(n):
        desc = shards[str(n)]
        return n, objects.get(desc['patchKey'], desc['patchEtag'])
    needed = [n for n in grouped if n not in tail and shards[str(n)].get('patchKey')]
    with ThreadPoolExecutor(max_workers=16) as pool:
        previous = dict(pool.map(previous_patch, needed))
    for n, spends in grouped.items():
        # Read only the touched local records, not every historical shard.
        actual = h.records[spends['id']]
        for field in ['creationHeight', 'spendHeight', 'satoshi']:
            require(np.array_equal(actual[field], spends[field]), 'journal/history spend mismatch')
        if n in tail:
            continue  # replaced complete partial shard includes these spends
        desc = shards[str(n)]; offsets, positions = load_mapping(desc)
        require(desc['mapping']['firstRecord'] == int(j.index[n*BLOCKS]) and
                desc['mapping']['count'] == int(j.index[(n+1)*BLOCKS]-j.index[n*BLOCKS]) and
                desc['endHeight'] == (n+1)*BLOCKS and 0 <= desc['baseTip'] < j.old_blocks,
                'catalog shard binding differs')
        relative = spends['id'] - desc['mapping']['firstRecord']
        require(np.all(relative < len(positions)), 'spend outside position cache')
        ids = np.asarray(positions[relative], dtype='<u4')
        require(np.all(ids < len(positions)), 'invalid cached record position')
        ys = satoshi_rows(spends['satoshi'], ROWS)
        require(np.all(ids >= offsets[ys]) and np.all(ids < offsets[ys+1]), 'cached row position mismatch')
        old = np.empty((0,2), '<u4')
        if desc.get('patchKey'):
            po, old = parse_patch(previous[n], n, len(positions), desc['baseTip'], j.old_blocks-1)
            require(np.array_equal(po, np.searchsorted(old[:,0], offsets)), 'prior patch row offsets differ')
        require(not np.intersect1d(old[:,0], ids).size, 'journal attempts to spend an already patched record')
        pairs = np.concatenate([old, np.column_stack([ids, spends['spendHeight']]).astype('<u4')])
        pairs = pairs[np.argsort(pairs[:,0])]
        require(np.all(pairs[1:,0] > pairs[:-1,0]), 'duplicate cloud positions')
        body = patch_bytes(n, desc['endHeight'], offsets, pairs)
        key = f'{prefix}/spends/{n:05d}.bin'
        desc['patchKey'], desc['patchEtag'] = key, artifact(key, body)
    for n in sorted(tail):
        body, _ = build_shard(h.records, h.index, n, BLOCKS, h.blocks, ROWS)
        key = f'{prefix}/shards/{n:05d}.bin'
        shards[str(n)] = dict(baseKey=key, baseEtag=artifact(key,body), baseTip=j.blocks-1,
                              endHeight=min((n+1)*BLOCKS,j.blocks), mapping=make_mapping(h,n,cache))
    time_key = prefix+'/block_times.bin'; artifact(time_key, j.times.tobytes())
    h.unchanged()
    next_catalog = dict(format='buv-history-catalog-v1', historyHeader=j.after.hex(), geometry=GEOMETRY, shards=shards)
    public = {n:{k:v[k] for k in ['baseKey','baseTip','patchKey'] if k in v} for n,v in shards.items()}
    release = dict(historyShardSources=public, historyBlockTimesKey=time_key, numBlocks=j.blocks)
    artifact(prefix+'/manifest.json', json_bytes(release))
    immutable(output/'catalog.json', json_bytes(next_catalog))
    immutable(output/'release-history.json', json_bytes(release))
    result = dict(oldBlocks=j.old_blocks, newBlocks=j.blocks, newRecords=len(j.new), oldSpends=len(j.spends),
                  scannedHistoricalShards=0, rebuiltShards=sorted(tail), patchedShards=sorted(set(grouped)-tail),
                  reusedShards=len(shards)-len(tail | set(grouped)), uploadBytes=sum(a['bytes'] for a in artifacts),
                  seconds=time.monotonic()-started, artifacts=artifacts)
    immutable(output/'staged.json',json_bytes(result))
    return result


def seed_from_run(history_path, run, output):
    h = History(history_path); run = Path(run)
    manifest = json.loads((run/'cloud-history-delta-verified.json').read_text())
    require(h.blocks == manifest['numBlocks'] and h.count == manifest['numRecords'], 'run is not current history')
    baseline = json.loads((run/'history-baseline.json').read_text())
    base = json.loads(Path(baseline['cloudState']).read_text())['completed']
    current = json.loads((run/'cloud-history-delta-state.json').read_text())['completed']
    full, patches = set(manifest['fullShards']), set(manifest['patchShards'])
    shards = {}
    for n in range((h.blocks+511)//512):
        prefix = manifest['prefix'] if n in full else manifest['basePrefix']
        key = f'{prefix}/shards/{n:05d}.bin'; receipts = current if n in full else base
        desc = dict(baseKey=key, baseEtag=receipts[key]['etag'].strip('"'),
                    baseTip=h.blocks-1 if n in full else manifest['oldNumBlocks']-1)
        if n in patches:
            key = f'{manifest["prefix"]}/spends/{n:05d}.bin'
            desc.update(patchKey=key, patchEtag=current[key]['etag'].strip('"'))
        shards[str(n)] = desc
    h.unchanged()
    immutable(output, json_bytes(dict(historyHeader=h.header.hex(), geometry=GEOMETRY, shards=shards)))


def prepare_update(config_path, history_path, catalog_path, output):
    """Make a fresh updater config; never inherit a used journal filename."""
    h = History(history_path)
    catalog = json.loads(Path(catalog_path).read_text())
    require(catalog['historyHeader'] == h.header.hex() and catalog['geometry'] == GEOMETRY,
            'catalog is not the current history; finish publication before another update')
    out = Path(output).resolve()
    require(not out.exists(), 'update directory exists; choose a fresh path')
    config = json.loads(Path(config_path).read_text())
    require(Path(config['blkFile']).is_absolute(), 'absolute BLK path required')
    config.update(historyFile=str(Path(history_path).resolve()), historyDeltaFile=str(out/'history.delta'),
                  allowBlkFileTruncate=False)
    immutable(out/'history-update.json', json_bytes(config))
    immutable(out/'history-publish-input.json', json_bytes(dict(history=str(h.path.resolve()),
              journal=str(out/'history.delta'), catalog=str(Path(catalog_path).resolve()),
              catalogSHA256=sha(Path(catalog_path).read_bytes()), oldBlocks=h.blocks)))
    return dict(config=str(out/'history-update.json'),journal=str(out/'history.delta'),oldBlocks=h.blocks)


def client(workers):
    import boto3
    from botocore.config import Config
    from r2_publish_cloud_history import load_credentials
    access, secret = load_credentials(Path.home()/'.config/utxo-r2/credentials')
    return boto3.client('s3', endpoint_url='https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com',
                       aws_access_key_id=access, aws_secret_access_key=secret, region_name='auto',
                       config=Config(max_pool_connections=workers, retries={'max_attempts':8,'mode':'adaptive'}))


def upload(staged_path, s3, workers=16):
    staged_path = Path(staged_path)
    staged = json.loads(staged_path.read_text())
    def one(item):
        data = Path(item['path']).read_bytes()
        require(len(data) == item['bytes'] and sha(data) == item['sha256'] and md5(data) == item['md5'], 'staged artifact changed')
        try:
            old = s3.head_object(Bucket='utxo-video', Key=item['key'])
        except s3.exceptions.ClientError as e:
            if e.response['ResponseMetadata']['HTTPStatusCode'] != 404:
                raise
            try:
                old = s3.put_object(Bucket='utxo-video', Key=item['key'], Body=data, IfNoneMatch='*',
                                    ContentType='application/json' if item['key'].endswith('.json') else 'application/octet-stream',
                                    CacheControl='public, max-age=31536000, immutable')
            except s3.exceptions.ClientError as collision:
                if collision.response['ResponseMetadata']['HTTPStatusCode'] not in (409,412):
                    raise
                old = s3.head_object(Bucket='utxo-video',Key=item['key'])
        require(old['ETag'].strip('"') == item['md5'] and old.get('ContentLength',len(data)) == len(data),
                'immutable upload collision or checksum mismatch')
        return item['key']
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        keys = list(pool.map(one, staged['artifacts']))
    immutable(staged_path.parent/'uploaded.json', json_bytes(dict(keys=keys)))
    return dict(objects=len(keys), seconds=time.monotonic()-start)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command',required=True)
    seed = sub.add_parser('seed'); seed.add_argument('--history',required=True); seed.add_argument('--run',required=True); seed.add_argument('--output',required=True)
    prep = sub.add_parser('prepare-update')
    for name in ['config','history','catalog','output']: prep.add_argument('--'+name,required=True)
    boot = sub.add_parser('bootstrap')
    for name in ['history','seed','cache','objects','catalog']: boot.add_argument('--'+name,required=True)
    boot.add_argument('--workers',type=int,default=4); boot.add_argument('--r2',action='store_true')
    st = sub.add_parser('stage')
    for name in ['history','journal','catalog','cache','objects','output','prefix']: st.add_argument('--'+name,required=True)
    st.add_argument('--r2',action='store_true')
    up = sub.add_parser('upload'); up.add_argument('--staged',required=True); up.add_argument('--workers',type=int,default=16)
    a = p.parse_args(); workers = getattr(a,'workers',4); require(workers > 0,'workers must be positive')
    if a.command == 'seed': result = seed_from_run(a.history,a.run,a.output)
    elif a.command == 'prepare-update': result = prepare_update(a.config,a.history,a.catalog,a.output)
    elif a.command == 'upload': result = upload(a.staged,client(workers),workers)
    else:
        objects = Objects(a.objects,client(workers) if a.r2 else None)
        if a.command == 'bootstrap': result = bootstrap(a.history,json.loads(Path(a.seed).read_text()),a.cache,objects,a.catalog,workers)
        else: result = stage(a.history,a.journal,json.loads(Path(a.catalog).read_text()),objects,a.cache,a.output,a.prefix)
    print(json.dumps({k:v for k,v in (result or {}).items() if k != 'artifacts'},indent=2))


if __name__ == '__main__':
    main()
