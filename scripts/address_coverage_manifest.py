#!/usr/bin/env python3
"""Bind a coverage window to an existing BLK dataset without changing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct


def fnv64(data):
    value = 14695981039346656037
    for byte in data:
        value = ((value ^ byte) * 1099511628211) & 0xffffffffffffffff
    return value


def file_identity(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def make_manifest(source, index, start, end):
    source, index = Path(source), Path(index)
    if not 0 <= start <= end:
        raise ValueError('invalid height range')
    before = source.stat()
    raw = index.read_bytes()
    if len(raw) < 56:
        raise ValueError('truncated block index')
    magic, size, count = struct.unpack_from('<8sQQ', raw)
    if magic != b'BUVBIDX1' or len(raw) != 56 + count * 8:
        raise ValueError('invalid block index format')
    if size != before.st_size or end >= count:
        raise ValueError('index/source size mismatch or range outside dataset')
    if fnv64(raw[:-8]) != struct.unpack_from('<Q', raw, len(raw)-8)[0]:
        raise ValueError('block index checksum mismatch')
    if struct.unpack_from('<Q', raw, 40)[0] != 0:
        raise ValueError('index does not start at zero')
    if struct.unpack_from('<Q', raw, 40+count*8)[0] != size:
        raise ValueError('index does not end at source EOF')
    blocks = []
    with source.open('rb') as stream:
        for height in range(start, end+1):
            offset, following = struct.unpack_from('<QQ', raw, 40+8*height)
            if not 0 <= offset < following <= size:
                raise ValueError('invalid indexed block boundary')
            stream.seek(offset)
            record = stream.read(44)
            if len(record) != 44:
                raise ValueError('truncated BLK record')
            marker, actual_height, payload = struct.unpack_from('<4sII', record)
            if marker != b'BLK\x02' or actual_height != height or offset+12+payload != following:
                raise ValueError('index does not match BLK record')
            blocks.append({'height': height, 'hash': record[12:44].hex()})
        if file_identity(os.fstat(stream.fileno())) != file_identity(before):
            raise ValueError('source changed during manifest extraction')
    if file_identity(source.stat()) != file_identity(before):
        raise ValueError('source path changed during manifest extraction')
    return {'schema_version': 1, 'start': start, 'end': end,
            'source': {'path': str(source), 'bytes': size,
                       'index_sha256': hashlib.sha256(raw).hexdigest()}, 'blocks': blocks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--index', type=Path)
    parser.add_argument('--start', type=int, default=916828)
    parser.add_argument('--end', type=int, default=966827)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    value = make_manifest(args.source, args.index or Path(str(args.source)+'.idx'), args.start, args.end)
    data = json.dumps(value, separators=(',', ':')).encode()
    if args.output.exists():
        if args.output.read_bytes() != data:
            raise ValueError('refusing to replace a different expected-block manifest')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('xb') as stream:
            stream.write(data)
    print(json.dumps({'manifest': str(args.output), 'blocks': len(value['blocks']),
                      'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    main()
