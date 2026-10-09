#!/usr/bin/env python3
"""Generic, bounded node BLK suffix sync. No extraction, node start, or refetch.

CLI: dry-run --manifest INPUT.json | prepare --manifest INPUT.json | apply --run DIR
Required INPUT fields (absolute paths except sshHost): sshHost, nodeBlk,
nodeCheckpoint, nodeChunkManifest, nodeLock, localBlk, localChunkManifest,
localLock, runDir. runDir MUST be new. nodeContainer defaults to buv_blk_v3.
Optional: localImmutable/nodeImmutable (external immutability assertions),
localAppendProof/nodeAppendProof (trusted proof JSON paths on respective hosts).
Existing chunk manifests AND operational lock files must be bootstrapped by the
parent. Every writer must honor these locks. Idle alone is not a writer lock.
Transport options: sshArgv defaults to ["ssh", "-o", "BatchMode=yes", "-o",
"ConnectTimeout=30"], e.g. caller may provide ["sshpass", "-e", "ssh", ...].
remotePythonArgv defaults to ["python3", "-"], or a parent-provisioned privileged
wrapper / ["sudo", "-n", "python3", "-"]. nodeInspectArgv defaults to
["docker", "inspect"], or ["sudo", "-n", "docker", "inspect"]. Prefixes are trusted
operator commands; NEVER put passwords in them or the manifest.
Optional remoteSudoPasswordEnv is an environment VARIABLE NAME, not a password.
With remotePythonArgv ["sudo", "-S", "-p", "", "python3", "-"], the named value is
read only at execution and prepended as one stdin line before Python code. Absolute
sudo/python3 paths are also accepted. We add -k to force password consumption even
with a cached sudo timestamp; this mode requires password-authenticating sudo,
not NOPASSWD. Missing/empty/multiline values fail before SSH. Secrets are never
written to run artifacts, argv, or logs. No sudoers or wrapper changes are made.
Credentials are inherited by ssh from the caller environment/agent, never logged.

'dry-run' validates input locally; no SSH and no writes. 'prepare' reads local/node
chain AND caches, writes only a new run directory containing plan.json, suffix.blk,
input.json, timings.jsonl. Code is sent to python3 over SSH stdin, never installed.
Checkpoint UTX3 size is a fixed upper bound even if node BLK has additional bytes.
'apply' rechecks snapshots, local hashes (full fallback unless immutable asserted),
suffix digest/record boundaries, and node checkpoint under its writer lock. Only
then appends with fsync, publishes chunk attestation/cache and result.json. The
node cache is committed separately while its source/old-cache snapshot is current.

result.json: status, oldTip, nextTip, oldBytes, nextBytes, appendedBytes, localBlk.
Prepare is NOT permission to skip apply validation. Interrupted writes are NOT
rolled back/truncated or automatically retried: applying.json requires manual
recovery/new run. No-op is verified, not appended. Metadata checks are ordinary
race detection, not proof against hostile writers restoring metadata. Chunk trust
boundaries are documented in blk_chunk_hashes.py; missing continuity rehashes.
Local tip discovery uses an adjacent BUVBIDX1 .idx only at an exact source stamp,
with checksum, offsets and first/last-record validation; missing/stale indexes fall
back to framing scan. No index is created or modified by sync.
Run artifacts/config/caches must be trusted; preserve suffix until result verified.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import struct
import subprocess
import sys
import time
import blk_chunk_hashes as chunks


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def validate_input(c):
    require(isinstance(c, dict), 'manifest must be an object')
    host = c.get('sshHost')
    require(isinstance(host, str) and host and not host.startswith('-') and
            not any(x.isspace() for x in host), 'invalid sshHost')
    keys = ('nodeBlk', 'nodeCheckpoint', 'nodeChunkManifest', 'nodeLock',
            'localBlk', 'localChunkManifest', 'localLock', 'runDir')
    for key in keys:
        require(isinstance(c.get(key), str) and Path(c[key]).is_absolute(), 'absolute path required: ' + key)
    for side in ('node', 'local'):
        paths = [c[side + k] for k in ('Blk', 'ChunkManifest', 'Lock')]
        if side == 'node':
            paths.append(c['nodeCheckpoint'])
        require(len(set(paths)) == len(paths), 'source/cache/lock paths must differ')
        require(type(c.get(side + 'Immutable', False)) is bool, 'immutable must be boolean')
        require(not (c.get(side + 'Immutable') and c.get(side + 'AppendProof')), 'choose one trust assertion')
    for key in ('sshArgv', 'remotePythonArgv', 'nodeInspectArgv'):
        if key in c:
            require(isinstance(c[key], list) and c[key] and isinstance(c[key][0], str) and bool(c[key][0]) and all(isinstance(x, str) and '\0' not in x for x in c[key]), 'invalid argv: ' + key)
    if 'remoteSudoPasswordEnv' in c:
        name = c['remoteSudoPasswordEnv']
        require(isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name),
                'remoteSudoPasswordEnv must be an environment variable name')
        sudo_python_argv(c)
    # Never place a new run directory inside a source/cache path.
    for key in ('localBlk', 'localChunkManifest', 'localLock'):
        require(Path(c['runDir']).resolve() != Path(c[key]).resolve(), 'run path aliases input')
    return c


@contextlib.contextmanager
def writer_lock(path):
    # Pre-existing, read-only lock; compatible with the daily updater's flock.
    with open(path, 'rb') as f:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


@contextlib.contextmanager
def timed(run, name):
    start = time.monotonic()
    outcome = 'ok'
    try:
        yield
    except BaseException:
        outcome = 'failed'
        raise
    finally:
        with (Path(run) / 'timings.jsonl').open('a') as f:
            f.write(json.dumps(dict(step=name, seconds=time.monotonic() - start,
                                   outcome=outcome, unixTime=time.time())) + '\n')


def records(path, first=0, base=0):
    """Scan bounded BLK2 framing and contiguous heights, not full payload semantics."""
    size = Path(path).stat().st_size
    offset, height, last = 0, first, None
    with open(path, 'rb') as f:
        while offset < size:
            require(size - offset >= 12, 'truncated record header')
            f.seek(offset)
            magic, h, n = struct.unpack('<4sII', f.read(12))
            require(magic == b'BLK\x02' and h == height and n >= 130,
                    'invalid BLK record or noncontiguous height')
            require(n <= size - offset - 12, 'truncated record payload')
            last = dict(tip=h, offset=base + offset, blockHash=f.read(32).hex())
            offset += 12 + n
            height += 1
    return last or dict(tip=first - 1, offset=None, blockHash=None)



FNV_OFFSET = 14695981039346656037
FNV_PRIME = 1099511628211
U64_MASK = (1 << 64) - 1


def fnv64(data, value=FNV_OFFSET):
    for byte in data:
        value = ((value ^ byte) * FNV_PRIME) & U64_MASK
    return value


def index_source_stamp(snapshot):
    # Mirror BlockIndex.h: unsigned little-endian dev/ino/size and timespec pairs.
    values = [snapshot['dev'], snapshot['ino'], snapshot['size'],
              *divmod(snapshot['mtime_ns'], 1_000_000_000),
              *divmod(snapshot['ctime_ns'], 1_000_000_000)]
    return fnv64(struct.pack('<7Q', *(v & U64_MASK for v in values)))


def indexed_tip(path):
    """Read-only BUVBIDX1 fast path; reject any mismatch, never extend an old index.

    Same-size source stamp is mandatory. FNV/boundaries are accidental-corruption
    checks, not proof against a malicious source/cache writer. Caller holds the
    operational writer lock. Reads only the index and two complete BLK records.
    """
    with open(path, 'rb') as source, open(str(path) + '.idx', 'rb') as index:
        before, index_before = chunks.snapshot(source), chunks.snapshot(index)
        size, index_size = before['size'], index_before['size']
        require(56 <= index_size <= 56 + (size // 142) * 8, 'invalid index length')
        data = index.read(index_size)
        require(len(data) == index_size and data[:8] == b'BUVBIDX1', 'invalid index header')
        stored_size, count, identity, stamp = struct.unpack_from('<4Q', data, 8)
        require(index_size == 56 + count * 8 and count <= (1 << 32), 'invalid index count')
        require(stored_size == size and stamp == index_source_stamp(before), 'stale index source stamp/size')
        require(struct.unpack_from('<Q', data, index_size - 8)[0] == fnv64(memoryview(data)[:-8]),
                'invalid index checksum')
        offsets = [v[0] for v in struct.iter_unpack('<Q', memoryview(data)[40:-8])]
        require(offsets[0] == 0 and offsets[-1] == size, 'invalid index endpoints')
        require(all(142 <= b - a and b <= size for a, b in zip(offsets, offsets[1:])),
                'invalid index offsets')
        boundary = FNV_OFFSET
        last = dict(tip=-1, offset=None, blockHash=None)
        if count:
            # Count=1 deliberately hashes the same record twice, as C++ does.
            for height in (0, count - 1):
                start, end = offsets[height], offsets[height + 1]
                source.seek(start)
                head = source.read(44)
                require(len(head) == 44, 'short indexed boundary record')
                magic, actual_height, n = struct.unpack('<4sII', head[:12])
                require(magic == b'BLK\x02' and actual_height == height and n >= 130 and
                        start + 12 + n == end, 'invalid indexed boundary framing')
                last = dict(tip=actual_height, offset=start, blockHash=head[12:].hex())
                source.seek(start)
                remaining = end - start
                while remaining:
                    block = source.read(min(8 * 1024 * 1024, remaining))
                    require(bool(block), 'short indexed boundary payload')
                    boundary = fnv64(block, boundary)
                    remaining -= len(block)
        require(boundary == identity, 'invalid index boundary identity')
        require(chunks.snapshot(source) == before == chunks.snapshot(path) and
                chunks.snapshot(index) == index_before == chunks.snapshot(str(path) + '.idx'),
                'source/index changed during index validation')
        return last


def local_tip(path):
    try:
        return indexed_tip(path)
    except (OSError, ValueError, struct.error):
        # Optional/disposable cache: absent, stale, malformed => safe full scan.
        return records(path)


def idle(c):
    info = json.loads(subprocess.check_output(
        c.get('nodeInspectArgv', ['docker', 'inspect']) + [c.get('nodeContainer', 'buv_blk_v3')], stderr=subprocess.PIPE))[0]
    s = info['State']
    require(not any(s.get(k) for k in ('Running', 'Restarting', 'Paused', 'OOMKilled', 'Error'))
            and s.get('Status') == 'exited' and s.get('ExitCode') == 0,
            'node updater must be idle and cleanly exited')


def node_snapshot(c):
    idle(c)
    bs = chunks.snapshot(c['nodeBlk'])
    cs = chunks.snapshot(c['nodeCheckpoint'])
    with open(c['nodeCheckpoint'], 'rb') as f:
        header = f.read(56)
    require(len(header) == 56, 'short checkpoint')
    magic, tip, size, offset, blockhash = struct.unpack('<4sIQQ32s', header)
    require(magic == b'UTX3' and 0 <= offset < size <= bs['size'], 'invalid UTX3 target bound')
    with open(c['nodeBlk'], 'rb') as f:
        f.seek(offset)
        record = f.read(44)
    require(len(record) == 44, 'short checkpoint tail')
    marker, h, n = struct.unpack('<4sII', record[:12])
    require(marker == b'BLK\x02' and h == tip and n >= 130 and offset + 12 + n == size
            and record[12:] == blockhash, 'checkpoint does not match BLK tail')
    require(chunks.snapshot(c['nodeBlk']) == bs and chunks.snapshot(c['nodeCheckpoint']) == cs,
            'node changed during snapshot')
    return dict(source=bs, checkpoint=cs, checkpointHeader=header.hex(),
                tip=tip, size=size, offset=offset, blockHash=blockhash.hex())


def remote_op(c, request, output=None):
    """Executed on node or against mocked local fixtures; all requests hold node lock."""
    with writer_lock(c['nodeLock']):
        snap = node_snapshot(c)
        action = request['action']
        if action != 'prepare':
            require(snap == request['snapshot'], 'node snapshot changed; prepare a new run')
        if action == 'prepare':
            old_cache = read_json(c['nodeChunkManifest'])
            cache, prefix = chunks.refresh(c['nodeBlk'], c['nodeChunkManifest'],
                length=request['length'], immutable=c.get('nodeImmutable', False),
                proof=read_json(c['nodeAppendProof']) if c.get('nodeAppendProof') else None,
                persist=False)
            require(request['length'] <= snap['size'], 'local BLK exceeds checkpoint target')
            with open(c['nodeBlk'], 'rb') as f:
                sha = chunks.hash_range(f, request['length'], snap['size'] - request['length'])
                chunk = cache['chunk_bytes']
                target_hashes = cache['hashes'][:snap['size'] // chunk]
                if snap['size'] % chunk:
                    target_hashes.append(chunks.hash_range(f, snap['size'] // chunk * chunk, snap['size'] % chunk))
            target_prefix = dict(schema='blk-prefix-v1', algorithm='sha256', length=snap['size'],
                                 chunk_bytes=chunk, hashes=target_hashes)
            require(node_snapshot(c) == snap and cache['source'] == snap['source'], 'node changed during preparation')
            return dict(snapshot=snap, cache=cache, oldCacheDigest=chunks.digest_object(old_cache),
                        prefix=prefix, targetPrefix=target_prefix, suffixSha256=sha)
        if action == 'download':
            start = request['length']
            require(0 <= start <= snap['size'], 'invalid suffix range')
            remaining = snap['size'] - start
            with open(c['nodeBlk'], 'rb') as f:
                f.seek(start)
                while remaining:
                    b = f.read(min(8 * 1024 * 1024, remaining))
                    require(bool(b), 'short node read')
                    output.write(b)
                    remaining -= len(b)
            require(node_snapshot(c) == snap, 'node changed during download')
            return None
        if action == 'check':
            return snap
        if action == 'cache':
            with chunks.locked(Path(c['nodeChunkManifest'])):
                old = read_json(c['nodeChunkManifest'])
                require(chunks.digest_object(old) == request['oldCacheDigest'], 'node cache changed')
                require(request['cache']['source'] == snap['source'], 'cache snapshot mismatch')
                chunks.atomic_save(Path(c['nodeChunkManifest']), request['cache'])
            return dict(cached=True)
        raise ValueError('unknown remote action')


def sudo_python_argv(c):
    argv = c.get('remotePythonArgv', ['python3', '-'])
    require(isinstance(argv, list) and len(argv) in (6, 7) and
            all(isinstance(x, str) for x in argv) and
            argv[0] in ('sudo', '/usr/bin/sudo', '/bin/sudo') and
            argv[-2] in ('python3', '/usr/bin/python3', '/usr/local/bin/python3') and
            argv[-1] == '-' and argv[1:-2] in (['-S', '-p', ''], ['-k', '-S', '-p', '']),
            'remoteSudoPasswordEnv requires sudo -S -p empty-string python3 -')
    return [argv[0], '-k', '-S', '-p', '', argv[-2], '-']


class SSHRemote:
    def __init__(self, c):
        self.c = c

    def call(self, request, output=None):
        # No remote files uploaded; stdin is code, stdout is JSON or bounded bytes.
        module = Path(chunks.__file__).read_text()
        own = Path(__file__).read_text()
        code = ('import types,sys\n'
                'm=types.ModuleType("blk_chunk_hashes")\n'
                'sys.modules["blk_chunk_hashes"]=m\n'
                f'exec({module!r},m.__dict__)\n'
                'ns={"__name__":"sync_remote"}\n'
                f'exec({own!r},ns)\n'
                f'r=ns["remote_op"]({self.c!r},{request!r},sys.stdout.buffer)\n'
                'if r is not None: print(ns["json"].dumps(r))\n')
        payload = code.encode()
        python_argv = self.c.get('remotePythonArgv', ['python3', '-'])
        if 'remoteSudoPasswordEnv' in self.c:
            python_argv = sudo_python_argv(self.c)
            name = self.c['remoteSudoPasswordEnv']
            require(isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name),
                    'invalid remoteSudoPasswordEnv name')
            password = os.environ.get(name)
            require(password is not None and bool(password) and
                    not any(ch in password for ch in ('\n', '\r', '\0')),
                    'sudo password environment value missing, empty, or invalid')
            payload = password.encode() + b'\n' + payload
            del password
        result = subprocess.run(self.c.get('sshArgv', ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30']) +
                                [self.c['sshHost'], shlex.join(python_argv)],
                                input=payload, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE)
        # Do not echo SSH stderr/config/environment into logs.
        require(result.returncode == 0, 'remote operation failed (exit %s)' % result.returncode)
        return None if output is not None else json.loads(result.stdout)


def check_suffix(path, old_tip, old_size, node):
    require(Path(path).stat().st_size == node['snapshot']['size'] - old_size, 'suffix length mismatch')
    with open(path, 'rb') as f:
        require(chunks.hash_range(f, 0, Path(path).stat().st_size) == node['suffixSha256'], 'suffix SHA256 mismatch')
    if node['snapshot']['size'] == old_size:
        return
    last = records(path, old_tip + 1, old_size)
    require(last == {k: node['snapshot'][k] for k in ('tip', 'offset', 'blockHash')},
            'suffix tip/hash/offset does not match checkpoint')


def prepare(c, remote=None):
    validate_input(c)
    remote = remote or SSHRemote(c)
    run = Path(c['runDir'])
    run.mkdir(mode=0o700, parents=False, exist_ok=False)
    chunks.atomic_save(run / 'input.json', c)
    with writer_lock(c['localLock']), timed(run, 'prepare'):
        before = chunks.snapshot(c['localBlk'])
        with timed(run, 'local_prefix'):
            cache, prefix = chunks.refresh(c['localBlk'], c['localChunkManifest'],
                immutable=c.get('localImmutable', False),
                proof=read_json(c['localAppendProof']) if c.get('localAppendProof') else None, persist=False)
            with timed(run, 'local_tip_index_or_scan'):
                last = local_tip(c['localBlk'])
        with timed(run, 'node_prefix_and_suffix_hash'):
            node = remote.call(dict(action='prepare', length=before['size']))
        require(prefix == node['prefix'], 'local/node prefix mismatch')
        require(before == cache['source'] == chunks.snapshot(c['localBlk']), 'local source changed')
        require(node['snapshot']['tip'] >= last['tip'], 'checkpoint behind local tip')
        if before['size'] == node['snapshot']['size']:
            require(last == {k: node['snapshot'][k] for k in ('tip', 'offset', 'blockHash')}, 'no-op checkpoint mismatch')
        with timed(run, 'download_suffix'), (run / 'suffix.blk').open('xb') as f:
            remote.call(dict(action='download', snapshot=node['snapshot'], length=before['size']), output=f)
            f.flush()
            os.fsync(f.fileno())
        check_suffix(run / 'suffix.blk', last['tip'], before['size'], node)
        require(chunks.snapshot(c['localBlk']) == before, 'local changed during transfer')
        plan = dict(schema='blk-sync-plan-v1', localBefore=before, localCache=cache,
                    localPrefix=prefix, oldTip=last['tip'], node=node)
        chunks.atomic_save(run / 'plan.json', plan)
        return plan


def apply(run, remote=None):
    run = Path(run)
    c = validate_input(read_json(run / 'input.json'))
    require(run.resolve() == Path(c['runDir']).resolve(), 'run path mismatch')
    remote = remote or SSHRemote(c)
    p = read_json(run / 'plan.json')
    require(p['schema'] == 'blk-sync-plan-v1', 'invalid plan')
    with writer_lock(c['localLock']), timed(run, 'apply'):
        require(not (run / 'applying.json').exists() and not (run / 'result.json').exists(),
                'run already applied or interrupted; manual recovery required')
        before, node = p['localBefore'], p['node']
        require(chunks.snapshot(c['localBlk']) == before, 'local fingerprint changed')
        # Missing external immutability continuity => full historical hashing again.
        cache, prefix = chunks.refresh(c['localBlk'], c['localChunkManifest'],
                                       immutable=c.get('localImmutable', False), persist=False)
        require(cache['source'] == before and prefix == p['localPrefix'], 'local prefix changed')
        check_suffix(run / 'suffix.blk', p['oldTip'], before['size'], node)
        remote.call(dict(action='check', snapshot=node['snapshot']))
        remote.call(dict(action='cache', snapshot=node['snapshot'], cache=node['cache'],
                         oldCacheDigest=node['oldCacheDigest']))
        count = node['snapshot']['size'] - before['size']
        with open(c['localBlk'], 'ab') as out, (run / 'suffix.blk').open('rb') as src:
            fcntl.flock(out, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(chunks.snapshot(out) == before == chunks.snapshot(c['localBlk']), 'local changed before append')
            suffix_before = chunks.snapshot(src)
            chunks.atomic_save(run / 'applying.json', dict(oldBytes=before['size'], appendBytes=count))
            if count:
                remaining = count
                h = hashlib.sha256()
                while remaining:
                    b = src.read(min(8 * 1024 * 1024, remaining))
                    require(bool(b), 'suffix shortened during append; manual recovery required')
                    out.write(b)
                    h.update(b)
                    remaining -= len(b)
                out.flush()
                os.fsync(out.fileno())
                require(h.hexdigest() == node['suffixSha256'] and chunks.snapshot(src) == suffix_before,
                        'suffix changed during append; manual recovery required')
            after = chunks.snapshot(out)
            require(after == chunks.snapshot(c['localBlk']) and after['size'] == node['snapshot']['size'],
                    'unexpected local append result; manual recovery required')
        # Own exclusive, validated append provides the continuity attestation.
        proof = None
        with chunks.locked(Path(c['localChunkManifest'])):
            chunks.atomic_save(Path(c['localChunkManifest']), cache)
        if count:
            proof = dict(kind='verified-append-v1', manifest_sha256=chunks.digest_object(cache),
                         before=before, after=after)
            chunks.atomic_save(run / 'local-append-proof.json', proof)
        _, final_prefix = chunks.refresh(c['localBlk'], c['localChunkManifest'], proof=proof, immutable=not count)
        require(final_prefix == node['targetPrefix'], 'post-append prefix mismatch; manual recovery required')
        result = dict(status='appended' if count else 'noop', oldTip=p['oldTip'],
                      nextTip=node['snapshot']['tip'], oldBytes=before['size'],
                      nextBytes=after['size'], appendedBytes=count, localBlk=c['localBlk'])
        chunks.atomic_save(run / 'result.json', result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('dry-run', 'prepare', 'apply'))
    parser.add_argument('--manifest')
    parser.add_argument('--run')
    a = parser.parse_args()
    try:
        if a.command == 'apply':
            require(a.run is not None and a.manifest is None, 'apply requires --run only')
            result = apply(a.run)
        else:
            require(a.manifest is not None and a.run is None, 'dry-run/prepare requires --manifest only')
            c = validate_input(read_json(a.manifest))
            result = dict(status='dry-run', remoteExecuted=False, writes=False) if a.command == 'dry-run' else prepare(c)
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, TypeError, struct.error, subprocess.SubprocessError) as e:
        print(json.dumps(dict(error=str(e))), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
