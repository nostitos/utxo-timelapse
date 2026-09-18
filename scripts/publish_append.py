#!/usr/bin/env python3
"""Prepare continuous HLS locally; the explicit execute subcommand uploads/deploys.

API: prepare(source, destination, object_prefix='hls/release-id'). Source is a
verified fragment_manifest ledger. Destination must not exist. A fresh directory
is renamed into place only after all objects and the playlist are staged.
Publication order is media objects, playlist, then external release pointer.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
from urllib.parse import quote

from fragment_manifest import verify, atomic_json, sync_dir, retained_entries, load_previous


def prepare(source, destination, *, object_prefix, previous=None, execution=None):
    source, destination = Path(source), Path(destination)
    parts = object_prefix.split('/')
    if not object_prefix or any(p in ('', '.', '..') for p in parts) or any(c in object_prefix for c in '\\?#\r\n'):
        raise ValueError('object_prefix must be a relative immutable key prefix')
    ledger = verify(source, previous=previous)
    retained = retained_entries(ledger, previous)
    if not ledger['segments']:
        raise ValueError('empty publication')
    if destination.exists():
        raise FileExistsError(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.publish-', dir=destination.parent))
    try:
        objects = []
        for entry in [ledger['init'], *ledger['segments']]:
            name = entry['file']
            if name in retained:
                entry['uri'] = retained[name]
                continue
            entry['uri'] = '/' + quote(object_prefix, safe='/') + '/' + quote(name)
            shutil.copyfile(source/name, staging/name)
            body = (staging/name).read_bytes()
            if hashlib.sha256(body).hexdigest() != entry['sha256']:
                raise ValueError('source changed during staging')
            with (staging/name).open('rb') as stream:
                os.fsync(stream.fileno())
            objects.append(dict(entry, key=object_prefix+'/'+name))
        scale = ledger['timescale']
        target = math.ceil(max(e['durationTicks'] for e in ledger['segments'])/scale)
        lines = ['#EXTM3U', '#EXT-X-VERSION:7', f'#EXT-X-TARGETDURATION:{target}',
                 '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
                 f'#EXT-X-MAP:URI="{ledger["init"]["uri"]}"']
        for entry in ledger['segments']:
            lines += [f'#EXTINF:{entry["durationTicks"]/scale:.9f},', entry['uri']]
        lines.append('#EXT-X-ENDLIST')
        playlist = ('\n'.join(lines)+'\n').encode()
        with (staging/'media.m3u8').open('wb') as stream:
            stream.write(playlist)
            stream.flush()
            os.fsync(stream.fileno())
        atomic_json(staging/'segments.json', ledger)
        verify(staging, previous=previous)
        plan = {'format': 'utxo-hls-publication-v1', 'objects': objects,
                'playlist': {'file': 'media.m3u8', 'key': object_prefix+'/media.m3u8',
                             'sha256': hashlib.sha256(playlist).hexdigest(), 'bytes': len(playlist)},
                'deploymentPerformed': False, 'retained': retained,
                'ledgerSHA256': hashlib.sha256((staging/'segments.json').read_bytes()).hexdigest()}
        if previous is not None:
            atomic_json(staging/'previous.json', previous)
            plan['previousSHA256'] = hashlib.sha256((staging/'previous.json').read_bytes()).hexdigest()
        if execution is not None:
            from publication_commands import validate_execution
            validate_execution(execution)
            plan['execution'] = execution
            for name, content in [('info.json', execution['info']), ('release.json', execution['release'])]:
                atomic_json(staging/name, content)
                body = (staging/name).read_bytes()
                plan['objects'].append({'file': name, 'key': execution['release']['sitePrefix']+'/'+name,
                                        'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)})
        atomic_json(staging/'publication.json', plan)
        # Serialize competing preparations of this destination, without replacing it.
        import fcntl
        with (destination.parent/('.'+destination.name+'.publish.lock')).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if destination.exists():
                raise FileExistsError(destination)
            os.rename(staging, destination)
            sync_dir(destination.parent)
        return plan
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    stage = sub.add_parser('prepare')
    stage.add_argument('source', type=Path)
    stage.add_argument('destination', type=Path)
    stage.add_argument('--object-prefix', required=True)
    stage.add_argument('--previous', type=Path)
    stage.add_argument('--previous-sha256')
    stage.add_argument('--execution-manifest', type=Path)
    execute = sub.add_parser('execute', help='Uploads and deploys ONLY when explicitly invoked')
    execute.add_argument('manifest', type=Path)
    execute.add_argument('--manifest-sha256', required=True)
    rollback = sub.add_parser('rollback', help='Explicit recovery of an interrupted deployment')
    rollback.add_argument('manifest', type=Path)
    rollback.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    if args.command == 'rollback':
        from publication_commands import recover_publication
        result = recover_publication(args.manifest, expected_sha256=args.manifest_sha256)
    elif args.command == 'execute':
        from publication_commands import execute_publication
        result = execute_publication(args.manifest, expected_sha256=args.manifest_sha256)
    else:
        if bool(args.previous) != bool(args.previous_sha256):
            parser.error('--previous and --previous-sha256 must be supplied together')
        previous = load_previous(args.previous, args.previous_sha256) if args.previous else None
        execution = json.loads(args.execution_manifest.read_text()) if args.execution_manifest else None
        result = prepare(args.source, args.destination, object_prefix=args.object_prefix,
                         previous=previous, execution=execution)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
