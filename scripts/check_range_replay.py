#!/usr/bin/env python3
"""Compare baseline/optimized raw RGB output, without video compression.

Creates a bounded, disposable BLK fixture under a fresh run directory. Never
modifies the input. All emitted RGB frame hashes, process logs and timings are
retained. Useful for hidden replay changes, including starts inside a slide.
"""
import argparse
import hashlib
import json
import shutil
import socket
import struct
import subprocess
import time
from pathlib import Path


def capture(binary, config, directory, timeout=600):
    directory.mkdir()
    config = dict(config)
    start = time.monotonic()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(timeout)
        config['connectionSocket'] = listener.getsockname()[1]
        config['connectionIpAddr'] = '127.0.0.1'
        path = directory / 'config.json'
        path.write_text(json.dumps(config, indent=2) + '\n')
        with (directory / 'render.log').open('xb') as log:
            process = subprocess.Popen([str(binary), '-ns', '-tc=visualizer', '-cfg=' + str(path)],
                                       cwd=directory, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            hashes = []
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(timeout)
                    length = config['imageWidth'] * config['imageHeight'] * 3
                    frame = bytearray(length)
                    view = memoryview(frame)
                    while True:
                        used = 0
                        while used < length:
                            n = connection.recv_into(view[used:])
                            if not n:
                                break
                            used += n
                        if not used:
                            break
                        if used != length:
                            raise RuntimeError(f'Incomplete RGB frame: {used}/{length} bytes')
                        hashes.append(hashlib.sha256(frame).hexdigest())
                rc = process.wait(timeout=60)
                if rc:
                    raise RuntimeError(f'Render exited {rc}: {directory / "render.log"}')
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=30)
    log = (directory / 'render.log').read_text()
    if 'Status: SUCCESS!' not in log or 'ledger misses=0, dropped decrements=0' not in log:
        raise RuntimeError(f'Render correctness diagnostics failed: {directory}')
    expected = config['endShowAtBlockHeight'] - config['startShowAtBlockHeight'] + 1 + config['repeatLastBlockTimes']
    if len(hashes) != expected:
        raise RuntimeError(f'Expected {expected} frames, got {len(hashes)}')
    result = {'seconds': time.monotonic() - start, 'frames': len(hashes), 'sha256': hashes}
    (directory / 'frames.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--run', required=True, type=Path)
    args = parser.parse_args()
    args.run = args.run.resolve()
    args.run.mkdir(exist_ok=False)
    config = json.loads(args.config.read_text())
    start = time.monotonic()
    fixture = args.run / 'through225000.blk2'
    # Scan only the bounded prefix, then copy it sequentially once. Legacy
    # baseline startup otherwise scans the full current chain for every case.
    with Path(config['blkFile']).open('rb') as source:
        for height in range(225001):
            header = source.read(12)
            marker, actual, size = struct.unpack('<4sII', header)
            if marker != b'BLK\x02' or actual != height or size < 124:
                raise RuntimeError('Invalid or non-contiguous BLK fixture source')
            source.seek(size, 1)
        length = source.tell()
        source.seek(0)
        with fixture.open('xb') as target:
            remaining = length
            while remaining:
                part = source.read(min(8 << 20, remaining))
                if not part:
                    raise RuntimeError('Unexpected source EOF')
                target.write(part)
                remaining -= len(part)
    result = {'fixtureSeconds': time.monotonic() - start, 'fixtureBytes': length, 'cases': []}
    config.update(blkFile=str(fixture), repeatLastBlockTimes=60, skipBlocks=0)
    for first, last in [(209999, 210121), (210060, 210121), (210120, 210180), (224000, 225000)]:
        cfg = dict(config, startShowAtBlockHeight=first, endShowAtBlockHeight=last)
        old = capture(args.baseline.resolve(), cfg, args.run / f'baseline_{first}')
        new = capture(args.candidate.resolve(), cfg, args.run / f'candidate_{first}')
        differences = [first + i for i, (a, b) in enumerate(zip(old['sha256'], new['sha256'])) if a != b]
        case = {'first': first, 'last': last, 'frames': old['frames'], 'baselineSeconds': old['seconds'],
                'candidateSeconds': new['seconds'], 'differingFrames': differences}
        result['cases'].append(case)
        print(json.dumps(case), flush=True)
        (args.run / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
        if differences:
            raise RuntimeError(f'RGB frame differences at {differences[:10]}')


if __name__ == '__main__':
    main()
