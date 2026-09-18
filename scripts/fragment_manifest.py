"""Local immutable fMP4 ledger. Single writer; committed objects are never truncated.

Durations are caller-supplied media ticks (not inferred from trun). Supported
fragments have exactly one tfdt and mfhd; sidx is optional. No transcoding.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile


def boxes(data, start=0, end=None):
    end = len(data) if end is None else end
    while start < end:
        if start + 8 > end:
            raise ValueError('truncated box header')
        size, kind = struct.unpack_from('>I4s', data, start)
        header = 8
        if size == 1:
            if start + 16 > end:
                raise ValueError('truncated extended box')
            size = struct.unpack_from('>Q', data, start + 8)[0]
            header = 16
        if size == 0:
            size = end - start
        if size < header or start + size > end:
            raise ValueError('invalid box size')
        yield start, size, kind, header
        if kind in (b'moof', b'traf'):
            yield from boxes(data, start + header, start + size)
        start += size


def inspect(data):
    result = {'payloadSHA256': [], 'decodeTimes': [], 'sequences': [], 'indexes': []}
    for p, n, kind, h in boxes(data):
        body = data[p+h:p+n]
        if kind == b'mdat':
            result['payloadSHA256'].append(hashlib.sha256(body).hexdigest())
        if kind in (b'tfdt', b'mfhd', b'sidx'):
            if len(body) < 4 or body[0] not in (0, 1):
                raise ValueError('unsupported full box')
            width = 8 if body[0] else 4
            offset = 12 if kind == b'sidx' else 4
            width = 4 if kind == b'mfhd' else width
            if len(body) < offset + width:
                raise ValueError('truncated timing box')
            value = int.from_bytes(body[offset:offset+width], 'big')
            if kind == b'tfdt':
                result['decodeTimes'].append(value)
            elif kind == b'mfhd':
                result['sequences'].append(value)
            else:
                result['indexes'].append((int.from_bytes(body[8:12], 'big'), value))
    if len(result['decodeTimes']) != 1 or len(result['sequences']) != 1 or not result['payloadSHA256']:
        raise ValueError('requires one decode time, sequence and media payload')
    return result


def rebase(data, *, ticks, sequence_offset, timescale):
    """Change timing/sequence fields only; fail on overflow, never resize boxes."""
    before = inspect(data)
    if timescale <= 0 or any(scale != timescale for scale, _ in before['indexes']):
        raise ValueError('timescale mismatch')
    output = bytearray(data)
    for p, n, kind, h in boxes(data):
        if kind not in (b'tfdt', b'mfhd', b'sidx'):
            continue
        width = 4 if kind == b'mfhd' or data[p+h] == 0 else 8
        offset = p+h+(12 if kind == b'sidx' else 4)
        value = int.from_bytes(data[offset:offset+width], 'big')
        value += sequence_offset if kind == b'mfhd' else ticks
        if not 0 <= value < 1 << (width*8):
            raise ValueError('timing or sequence overflow')
        output[offset:offset+width] = value.to_bytes(width, 'big')
    if inspect(output)['payloadSHA256'] != before['payloadSHA256']:
        raise ValueError('media payload changed')
    return bytes(output)


def atomic_json(path, value):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.manifest-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable(root, data, suffix):
    digest = hashlib.sha256(data).hexdigest()
    name = digest + suffix
    path = root / name
    # Link a fully fsynced temporary file: interrupted writes cannot poison a key.
    fd, tmp = tempfile.mkstemp(prefix='.object-', dir=root)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError('immutable object conflict')
        sync_dir(root)
    finally:
        os.unlink(tmp)
    return {'file': name, 'sha256': digest, 'bytes': len(data)}


def load_previous(path, expected_sha256):
    """Load a caller-pinned, previously verified publication ledger, not media.

    The pin authenticates the local baseline only; it is not a new remote audit.
    """
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('previous manifest digest mismatch')
    previous = json.loads(raw)
    validate_metadata(previous)
    for entry in [previous['init'], *previous['segments']]:
        validate_uri(entry['uri'])
    return previous


def validate_uri(uri):
    from urllib.parse import urlsplit
    if not isinstance(uri, str) or any(c in uri for c in '\r\n"\\'):
        raise ValueError('unsafe media URI')
    parsed = urlsplit(uri)
    if not ((parsed.scheme == 'https' and parsed.netloc) or
            (not parsed.scheme and not parsed.netloc and uri.startswith('/'))):
        raise ValueError('media URI must be HTTPS or root-relative')
    if parsed.query or parsed.fragment or any(p == '..' for p in parsed.path.split('/')):
        raise ValueError('media URI must be immutable, without query or fragment')


def validate_metadata(ledger):
    if ledger['format'] != 'utxo-fmp4-segments-v1' or type(ledger['timescale']) is not int or ledger['timescale'] <= 0:
        raise ValueError('unsupported ledger')
    end, sequence = 0, None
    for entry in [ledger['init'], *ledger['segments']]:
        if Path(entry['file']).name != entry['file'] or entry['file'] in ('', '.', '..'):
            raise ValueError('unsafe object path')
        if len(entry['sha256']) != 64 or any(c not in '0123456789abcdef' for c in entry['sha256']):
            raise ValueError('invalid object digest')
        if type(entry['bytes']) is not int or entry['bytes'] <= 0:
            raise ValueError('invalid object size')
    for entry in ledger['segments']:
        if (type(entry['durationTicks']) is not int or entry['durationTicks'] <= 0 or
                type(entry['startTicks']) is not int or entry['startTicks'] != end or
                type(entry['sequence']) is not int or not 0 <= entry['sequence'] < 2**32):
            raise ValueError('non-contiguous decode timeline')
        if sequence is not None and entry['sequence'] != sequence+1:
            raise ValueError('non-contiguous sequence')
        end += entry['durationTicks']
        sequence = entry['sequence']


def manifest_hash(ledger):
    """Canonical JSON SHA256 for parentHash, independent of file indentation.

    This is distinct from load_previous's expected SHA256 of exact file bytes.
    """
    return hashlib.sha256(json.dumps(ledger, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def retained_entries(ledger, previous):
    """Retain the full prior prefix, or a hash-bound replacement prefix.

    A branch's parentHash uses manifest_hash(previous). Same-lineage appends
    retain the entire previous ledger, not just its original replacement prefix.
    """
    if previous is None:
        return {}
    validate_metadata(previous)
    count = len(previous['segments'])
    branch = (ledger.get('parentHash'), ledger.get('retainedCount'))
    prior_branch = (previous.get('parentHash'), previous.get('retainedCount'))
    if branch != prior_branch:
        if ledger.get('parentHash') != manifest_hash(previous):
            raise ValueError('replacement parent hash mismatch')
        count = ledger.get('retainedCount')
        if type(count) is not int or not 0 <= count <= len(previous['segments']):
            raise ValueError('invalid retainedCount')
    if ledger['timescale'] != previous['timescale'] or len(ledger['segments']) < count:
        raise ValueError('baseline is not a prefix')
    retained = {}
    current = [ledger['init'], *ledger['segments'][:count]]
    for entry, old in zip(current, [previous['init'], *previous['segments'][:count]]):
        validate_uri(old['uri'])
        if ({k: v for k, v in entry.items() if k != 'uri'} !=
                {k: v for k, v in old.items() if k != 'uri'} or
                ('uri' in entry and entry['uri'] != old['uri'])):
            raise ValueError('retained entry changed')
        retained[entry['file']] = old['uri']
    return retained


def plan_tail(previous, *, join_frame, segment_frames, fps_num, fps_den=1):
    """Plan boundary packaging without opening any media, at any explicit FPS.

    Segment indices [0, retainedCount) are preserved. Package old frames
    [packageStartFrame, joinFrame) followed by new encoded frames starting at
    joinFrame. Never copy the old tail after JOIN (including repeated endcap).
    The orchestrator must remux that bounded splice to relative-zero fMP4
    before replace_tail(..., rebase_to_boundary=True). This helper does not
    claim the chosen frame is independently decodable; caller verifies IDRs.
    """
    from fractions import Fraction
    validate_metadata(previous)
    if (type(join_frame) is not int or join_frame < 0 or
            any(type(n) is not int or n <= 0 for n in (segment_frames, fps_num, fps_den))):
        raise ValueError('invalid frame/segment/rate')
    ticks_per_frame = Fraction(previous['timescale']*fps_den, fps_num)
    count = join_frame // segment_frames
    boundary = count*segment_frames
    boundary_ticks = boundary*ticks_per_frame
    segment_ticks = segment_frames*ticks_per_frame
    entries = previous['segments']
    if count > len(entries) or boundary_ticks.denominator != 1:
        raise ValueError('segment boundary outside ledger or nonintegral ticks')
    for i, entry in enumerate(entries[:count]):
        if entry['startTicks'] != i*segment_ticks or entry['durationTicks'] != segment_ticks:
            raise ValueError('retained prefix does not match fixed segment grid')
    old_end = entries[-1]['startTicks']+entries[-1]['durationTicks'] if entries else 0
    if join_frame*ticks_per_frame > old_end:
        raise ValueError('JOIN outside previous media timeline')
    return {'retainedCount': count, 'packageStartFrame': boundary, 'joinFrame': join_frame,
            'oldTailFrames': join_frame-boundary, 'offsetTicks': int(boundary_ticks),
            'firstSequence': entries[count-1]['sequence']+1 if count else
                             (entries[0]['sequence'] if entries else 1),
            'segmentFrames': segment_frames, 'fpsNum': fps_num, 'fpsDen': fps_den}


def replace_tail(root, *, previous_path, expected_parent_sha256, retained_count,
                 fragments, rebase_to_boundary=False):
    """Commit a fresh branch retaining [0, retained_count), replacing ALL later media.

    fragments: iterable of (bytes, durationTicks), already packaged from the
    retained boundary, not merely from an in-segment JOIN. If rebase_to_boundary
    is true, requires relative decode time zero and shifts tfdt/sidx/mfhd only.
    Init is inherited verbatim from the pinned parent, never read or replaced.
    expected_parent_sha256 pins exact parent-file bytes; parentHash in the new
    ledger is canonical JSON SHA256. The old manifest/media are never written.
    A failed commit can leave unreferenced immutable objects for safe retry.
    root/segments.json must not exist: replacement is not an in-place truncate.
    """
    import copy
    previous = load_previous(previous_path, expected_parent_sha256)
    if type(retained_count) is not int or not 0 <= retained_count <= len(previous['segments']):
        raise ValueError('invalid retained_count')
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root/'.append.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (root/'segments.json').exists():
            raise FileExistsError('fresh branch required; refusing to replace committed ledger')
        ledger = copy.deepcopy(previous)
        ledger.update(parentHash=manifest_hash(previous), retainedCount=retained_count,
                      parentManifestSHA256=expected_parent_sha256)
        ledger['segments'] = ledger['segments'][:retained_count]
        entries = ledger['segments']
        end = entries[-1]['startTicks']+entries[-1]['durationTicks'] if entries else 0
        next_sequence = entries[-1]['sequence']+1 if entries else (
            previous['segments'][0]['sequence'] if previous['segments'] else 1)
        offset_ticks, sequence_offset = end, None
        added = 0
        for data, duration in fragments:
            if rebase_to_boundary:
                meta = inspect(data)
                if sequence_offset is None:
                    if meta['decodeTimes'] != [0]:
                        raise ValueError('replacement package must start at relative decode time zero')
                    sequence_offset = next_sequence-meta['sequences'][0]
                data = rebase(data, ticks=offset_ticks, sequence_offset=sequence_offset,
                              timescale=ledger['timescale'])
            meta = inspect(data)
            if type(duration) is not int or duration <= 0 or meta['decodeTimes'] != [end]:
                raise ValueError('replacement must begin at retained boundary with continuous timing')
            if meta['sequences'] != [next_sequence]:
                raise ValueError('replacement sequence gap')
            if any(scale != ledger['timescale'] for scale, _ in meta['indexes']):
                raise ValueError('sidx timescale mismatch')
            entries.append(dict(immutable(root, data, '.m4s'), startTicks=end,
                                durationTicks=duration, sequence=next_sequence,
                                payloadSHA256=meta['payloadSHA256']))
            end += duration
            next_sequence += 1
            added += 1
        if not added:
            raise ValueError('replacement fragments required; tail deletion is not implicit')
        validate_metadata(ledger)
        retained_entries(ledger, previous)
        # Recheck the caller's rollback anchor before the sole commit point.
        if hashlib.sha256(Path(previous_path).read_bytes()).hexdigest() != expected_parent_sha256:
            raise ValueError('parent manifest changed during preparation')
        atomic_json(root/'segments.json', ledger)
        return ledger


def verify(root, *, previous=None):
    """Verify only new bytes when a trusted previous ledger is supplied."""
    root = Path(root)
    ledger = json.loads((root/'segments.json').read_text())
    validate_metadata(ledger)
    retained = retained_entries(ledger, previous)
    for entry in [ledger['init'], *ledger['segments']]:
        if entry['file'] in retained:
            continue
        data = (root/entry['file']).read_bytes()
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('object integrity failure')
        if 'durationTicks' in entry:
            meta = inspect(data)
            if meta['decodeTimes'] != [entry['startTicks']]:
                raise ValueError('non-contiguous decode timeline')
            if any(scale != ledger['timescale'] for scale, _ in meta['indexes']):
                raise ValueError('sidx timescale mismatch')
            if meta['payloadSHA256'] != entry['payloadSHA256'] or meta['sequences'] != [entry['sequence']]:
                raise ValueError('fragment metadata mismatch')
    return ledger


def append(root, *, init, fragments, timescale, expected_count, previous=None):
    """Append (bytes, durationTicks) pairs already rebased to continuous timing.

    expected_count is a compare-and-swap guard. On pre-commit failure, the old
    ledger remains valid; orphan content-addressed objects are safe to reuse.
    Identical init bytes are required; codec compatibility is not guessed.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root/'.append.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (root/'segments.json').exists():
            ledger = verify(root, previous=previous)
            if ledger['timescale'] != timescale or ledger['init']['sha256'] != hashlib.sha256(init).hexdigest():
                raise ValueError('init or timescale changed')
        elif previous is not None:
            import copy
            validate_metadata(previous)
            retained_entries(previous, previous)
            ledger = copy.deepcopy(previous)
            if ledger['timescale'] != timescale or ledger['init']['sha256'] != hashlib.sha256(init).hexdigest():
                raise ValueError('init or timescale changed')
        else:
            if timescale <= 0 or not init:
                raise ValueError('invalid init or timescale')
            ledger = {'format': 'utxo-fmp4-segments-v1', 'timescale': timescale,
                      'init': immutable(root, init, '.mp4'), 'segments': []}
        entries = ledger['segments']
        if len(entries) != expected_count:
            raise ValueError('stale expected_count')
        end = entries[-1]['startTicks']+entries[-1]['durationTicks'] if entries else 0
        for data, duration in fragments:
            meta = inspect(data)
            if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0 or meta['decodeTimes'] != [end]:
                raise ValueError('invalid duration or decode timestamp')
            if any(scale != timescale for scale, _ in meta['indexes']):
                raise ValueError('sidx timescale mismatch')
            sequence = meta['sequences'][0]
            if entries and sequence != entries[-1]['sequence']+1:
                raise ValueError('sequence gap')
            entries.append(dict(immutable(root, data, '.m4s'), startTicks=end,
                                durationTicks=duration, sequence=sequence,
                                payloadSHA256=meta['payloadSHA256']))
            end += duration
        atomic_json(root/'segments.json', ledger)
        return ledger


def replace_tail_from_manifest(path):
    """Local-only command specification, all paths absolute:

    {previousPath, expectedParentSHA256, destination, retainedCount,
     rebaseToBoundary: true|false,
     fragments: [{path, sha256, durationTicks}, ...]}

    The orchestrator owns bounded old-tail/new-tail packaging. Input fragments
    must cover the retained boundary, including old frames before an inner JOIN.
    """
    spec = json.loads(Path(path).read_text())
    for key in ('previousPath', 'destination'):
        if not Path(spec[key]).is_absolute():
            raise ValueError('absolute command paths required')
    if type(spec.get('rebaseToBoundary', False)) is not bool:
        raise ValueError('rebaseToBoundary must be boolean')
    def fragments():
        for item in spec['fragments']:
            if not Path(item['path']).is_absolute():
                raise ValueError('absolute fragment path required')
            data = Path(item['path']).read_bytes()
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('replacement input digest mismatch')
            yield data, item['durationTicks']
    return replace_tail(spec['destination'], previous_path=spec['previousPath'],
                        expected_parent_sha256=spec['expectedParentSHA256'],
                        retained_count=spec['retainedCount'], fragments=fragments(),
                        rebase_to_boundary=spec.get('rebaseToBoundary', False))


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Plan or commit local immutable tail replacement; no uploads')
    commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan-tail')
    plan.add_argument('previous', type=Path)
    plan.add_argument('--previous-sha256', required=True)
    plan.add_argument('--join-frame', type=int, required=True)
    plan.add_argument('--segment-frames', type=int, required=True)
    plan.add_argument('--fps-num', type=int, required=True)
    plan.add_argument('--fps-den', type=int, default=1)
    replace = commands.add_parser('replace-tail')
    replace.add_argument('manifest', type=Path)
    args = parser.parse_args()
    if args.command == 'replace-tail':
        result = replace_tail_from_manifest(args.manifest)
    else:
        previous = load_previous(args.previous, args.previous_sha256)
        result = plan_tail(previous, join_frame=args.join_frame, segment_frames=args.segment_frames,
                           fps_num=args.fps_num, fps_den=args.fps_den)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
