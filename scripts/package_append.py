#!/usr/bin/env python3
"""Local bounded packet-copy bridge from append_update to immutable HLS.

CLI: package_append.py SPEC.json
SPEC: {preparedManifest: absolute run/plan.json, previousManifest: absolute path,
       previousSHA256: exact previous-file SHA256, oldInit: absolute init.mp4,
       destination: fresh absolute directory, segmentFrames: 600 (optional)}
The prepared plan seal and complete render.status.json evidence must match.
Outputs: package_verified.json, ledger/segments.json, bounded preview.mp4,
relative HLS and command logs. Follow with publish_append.py prepare, supplying
same pinned previous manifest. No uploads, node access or full-master rewrite.
Production is HEVC 3840x2160 yuv444p 60fps. The Python-only fixture_dimensions
argument relaxes dimensions for tiny real-media tests, never codec/rate checks.
Old init is a small explicitly supplied local file; old HLS fragments are not
opened. Existing master is only probed/seeked in a bounded window near JOIN.
"""
import argparse
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import subprocess

from fragment_manifest import atomic_json, inspect, load_previous, plan_tail, replace_tail, verify


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda: stream.read(1024*1024), b''):
            digest.update(data)
    return digest.hexdigest()


def extradata(stream):
    return bytes.fromhex(''.join(line.split(':', 1)[1].strip().split('  ')[0].replace(' ', '')
                                for line in stream['extradata'].splitlines() if ':' in line))


def parameter_sets(data):
    require(len(data) >= 23 and data[0] == 1, 'HEVC hvcC required')
    result, pos = {}, 23
    for _ in range(data[22]):
        require(pos+3 <= len(data), 'truncated hvcC array')
        kind, count = data[pos] & 63, int.from_bytes(data[pos+1:pos+3], 'big')
        pos += 3
        items = []
        for _ in range(count):
            require(pos+2 <= len(data), 'truncated parameter length')
            size = int.from_bytes(data[pos:pos+2], 'big')
            pos += 2
            require(size > 0 and pos+size <= len(data), 'truncated parameter set')
            items.append(data[pos:pos+size].hex())
            pos += size
        if kind in (32, 33, 34):
            require(kind not in result and bool(items), 'duplicate/empty parameter array')
            result[kind] = items
    require(set(result) == {32, 33, 34}, 'VPS/SPS/PPS required')
    return result


def idr(packet, length_size):
    data = extradata({'extradata': packet['data']})
    pos = 0
    while pos < len(data):
        require(pos+length_size <= len(data), 'truncated NAL size')
        size = int.from_bytes(data[pos:pos+length_size], 'big')
        pos += length_size
        require(size >= 2 and pos+size <= len(data), 'truncated NAL')
        kind = (data[pos] >> 1) & 63
        if kind < 32:
            return kind in (19, 20)
        pos += size
    return False


def decimal(value):
    return f'{float(value):.9f}'


def verified_producer(plan_path):
    """Match append_update's exact canonical stage binding and sealed inputs.

    Receipt status alone is not provenance. Verify every declared artifact and
    render-attempt log before trusting the tail; do not run media commands here.
    """
    plan_path = Path(plan_path)
    run = plan_path.parent
    seal = json.loads((run/'seal.json').read_text())
    require(plan_path.name == 'plan.json' and set(seal) == {'source.json', 'render.json', 'plan.json'},
            'invalid prepared seal')
    documents = {}
    for name in ('source.json', 'render.json', 'plan.json'):
        raw = (run/name).read_bytes()
        require(hashlib.sha256(raw).hexdigest() == seal[name], 'prepared seal mismatch: '+name)
        documents[name] = json.loads(raw)
    plan = documents['plan.json']
    require(plan['format'] == 'utxo-append-plan-v1' and not plan['noOp'], 'prepared non-noop append required')
    require(Path(plan['source']['runPath']).resolve() == run.resolve(), 'prepared run moved')
    require(documents['render.json'] == plan['renderConfig'], 'render config differs from sealed plan')
    stages = [stage for stage in plan['stages'] if stage.get('name') == 'render']
    require(len(stages) == 1 and stages[0].get('kind') == 'render', 'one declared render producer required')
    stage = stages[0]
    canonical = json.dumps(stage, sort_keys=True, separators=(',', ':')).encode()
    status = json.loads((run/'render.status.json').read_text())
    require(status.get('status') == 'complete', 'render producer is not complete')
    require(status.get('binding') == hashlib.sha256(canonical).hexdigest(), 'render producer binding mismatch')
    require(type(status.get('attempt')) is int and status['attempt'] > 0, 'invalid render attempt')
    outputs = stage.get('outputs')
    require(isinstance(outputs, list) and outputs and all(isinstance(p, str) and Path(p).is_absolute() for p in outputs)
            and len(set(outputs)) == len(outputs), 'invalid declared render outputs')
    checkpoint = plan['renderConfig'].get('rendererCheckpointSave')
    require(str(run/'tail.mkv') in outputs and checkpoint in outputs, 'tail and checkpoint must be declared outputs')
    attempt = run/f'render.attempt-{status["attempt"]}'
    evidence = status.get('evidence')
    required = set(outputs) | {str(attempt/name) for name in ('process.log', 'encoder.log', 'decode.log')}
    require(isinstance(evidence, dict) and required <= set(evidence), 'incomplete render evidence')
    for path, expected_hash in evidence.items():
        p = Path(path)
        require(path in outputs or (p.parent == attempt and p.suffix == '.log'), 'unexpected render evidence path')
        require(p.is_file(), 'missing render evidence: '+path)
        if path in outputs:
            require(p.stat().st_size > 0, 'empty render output: '+path)
        require(file_hash(p) == expected_hash, 'render evidence digest mismatch: '+path)
    return plan


def package(spec, *, fixture_dimensions=None):
    for key in ('preparedManifest', 'previousManifest', 'oldInit', 'destination'):
        require(Path(spec[key]).is_absolute(), 'absolute path required: '+key)
    plan_path = Path(spec['preparedManifest'])
    run = plan_path.parent
    plan = verified_producer(plan_path)
    master = Path(plan['source']['master'])
    require(master.is_absolute(), 'absolute master path required')
    master_stat = master.stat()
    baseline_stat = plan['inputStats'][str(master)]
    require(master_stat.st_size == baseline_stat['size'] and master_stat.st_mtime_ns == baseline_stat['mtimeNs'], 'master changed since preparation')
    tail = run/'tail.mkv'
    previous = load_previous(spec['previousManifest'], spec['previousSHA256'])
    init = Path(spec['oldInit'])
    require(file_hash(init) == previous['init']['sha256'], 'old init digest mismatch')
    layout = plan_tail(previous, join_frame=plan['joinBlock'], segment_frames=spec.get('segmentFrames', 600), fps_num=60)
    require(plan['tailFrames'] > 0 and plan['finalFrames'] == plan['joinBlock']+plan['tailFrames'], 'inconsistent frame plan')
    destination = Path(spec['destination'])
    destination.mkdir(parents=True, exist_ok=False)
    ffmpeg = plan['source'].get('ffmpeg', 'ffmpeg')
    ffprobe = plan['source'].get('ffprobe', 'ffprobe')
    commands = []

    def execute(argv):
        commands.append(argv)
        atomic_json(destination/'commands.json', commands)
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=plan['source'].get('timeoutSeconds', 3600))
        (destination/f'command-{len(commands):03d}.stderr').write_bytes(result.stderr)
        result.check_returncode()
        return result.stdout

    def probe(path, packets=False, interval=None, data=False):
        argv = [ffprobe, '-v', 'error', '-select_streams', 'v:0']
        if interval is not None:
            argv += ['-read_intervals', interval]
        if packets:
            argv += ['-show_packets', '-show_entries', 'packet=pts,dts,duration,pts_time,dts_time,flags,data_hash'+(',data' if data else ''),
                     '-show_data_hash', 'sha256']
        else:
            argv += ['-show_streams', '-show_data']
        if packets and data:
            argv += ['-show_data']
        return json.loads(execute(argv+['-of', 'json', str(path)]))

    def video(path):
        streams = probe(path)['streams']
        require(len(streams) == 1, 'single video stream required')
        return streams[0]

    def packet_list(path, **kwargs):
        return probe(path, packets=True, **kwargs)['packets']

    def decode(path):
        execute([ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'])

    def copy_mp4(input_args, output):
        execute([ffmpeg, '-nostdin', '-hide_banner', '-n', *input_args, '-map', '0:v:0', '-an', '-c:v', 'copy',
                 '-tag:v', 'hvc1', '-video_track_timescale', str(scale), str(output)])

    try:
        old_meta, init_meta, tail_meta = video(master), video(init), video(tail)
        dimensions = fixture_dimensions or (3840, 2160)
        for meta in (old_meta, init_meta, tail_meta):
            for key, expected in dict(codec_name='hevc', width=dimensions[0], height=dimensions[1], pix_fmt='yuv444p').items():
                require(meta.get(key) == expected, 'codec field mismatch: '+key)
        for meta in (old_meta, tail_meta):
            require(Fraction(meta['r_frame_rate']) == 60, '60 fps required')
        time_base = Fraction(init_meta['time_base'])
        require(time_base.numerator == 1 and time_base.denominator == previous['timescale'], 'old init timescale mismatch')
        scale = previous['timescale']
        # Matroska encodes timestamps on a millisecond grid. Keep measured
        # fragment durations, allowing at most one source tick at the final end.
        tail_time_base = Fraction(tail_meta['time_base'])
        require(tail_time_base <= Fraction(1, 1000), 'tail timestamp precision too coarse')
        duration_tolerance = max(1, math.ceil(scale*tail_time_base))
        parameters = parameter_sets(extradata(old_meta))
        for meta in (init_meta, tail_meta):
            require(parameter_sets(extradata(meta)) == parameters, 'VPS/SPS/PPS differ; unsafe packet-copy splice')
        normalized_tail = destination/'tail.mp4'
        copy_mp4(['-i', str(tail)], normalized_tail)
        normalized_meta = video(normalized_tail)
        for key in ('profile', 'level', 'width', 'height', 'pix_fmt', 'color_range', 'color_space'):
            require(old_meta.get(key) == normalized_meta.get(key), 'normalized codec mismatch: '+key)
        length_size = (extradata(old_meta)[21] & 3)+1
        tail_packets = packet_list(normalized_tail)
        tail_first = packet_list(normalized_tail, interval='0%+#1', data=True)
        require(len(tail_packets) == plan['tailFrames'], 'tail packet count mismatch')
        require(abs(float(tail_packets[0]['pts_time'])) < 1/scale and bool(tail_first) and idr(tail_first[0], length_size), 'tail must begin at zero PTS with IDR')
        boundary, join = Fraction(layout['packageStartFrame'], 60), Fraction(plan['joinBlock'], 60)
        window_start = max(Fraction(0), boundary-1)
        old_packets = packet_list(master, interval=f'{decimal(window_start)}%+{decimal(join-window_start+2)}', data=True)
        def key_at(seconds):
            selected = [p for p in old_packets if 'K' in p['flags'] and abs(Fraction(p['pts_time'])-seconds) <= Fraction(1, scale)]
            require(len(selected) == 1 and idr(selected[0], length_size), 'boundary/JOIN must be measured closed-GOP IDR')
            return selected[0]
        join_key = key_at(join)
        boundary_key = key_at(boundary)
        # Concat outpoint is exclusive DTS, NOT presentation time.
        old_time_base = Fraction(old_meta['time_base'])
        exclusive_dts = int(join_key['dts'])*old_time_base
        retained_packets = [p for p in old_packets if int(boundary_key['dts']) <= int(p['dts']) < int(join_key['dts'])]
        # ffconcat timestamps have microsecond resolution. Round the exclusive
        # bound DOWN, never include JOIN by rounding its DTS up.
        outpoint_us = exclusive_dts.numerator*1000000 // exclusive_dts.denominator
        exclusive_text = f'{outpoint_us/1000000:.6f}'
        require(len(retained_packets) == layout['oldTailFrames'], 'bounded old-tail packet count mismatch')
        lines = ['ffconcat version 1.0']
        for path in (master, normalized_tail):
            require(not any(c in str(path) for c in "'\r\n\\"), 'unsupported ffconcat path characters')
        if layout['oldTailFrames']:
            lines += [f"file '{master}'", f'inpoint {decimal(boundary)}',
                      f'outpoint {exclusive_text}', f'duration {decimal(join-boundary)}']
        lines += [f"file '{normalized_tail}'"]
        concat = destination/'splice.ffconcat'
        concat.write_text('\n'.join(lines)+'\n')
        preview = destination/'preview.mp4'
        copy_mp4(['-f', 'concat', '-safe', '0', '-i', str(concat)], preview)
        preview_packets = packet_list(preview)
        expected = retained_packets+tail_packets
        require(len(preview_packets) == layout['oldTailFrames']+plan['tailFrames'], f'short preview frame count mismatch: {len(preview_packets)} != {layout["oldTailFrames"]+plan["tailFrames"]}; first={preview_packets[:1]}')
        require([p['data_hash'] for p in preview_packets] == [p['data_hash'] for p in expected], 'short splice changed encoded payloads')
        require(all(int(a['dts']) < int(b['dts']) for a, b in zip(preview_packets, preview_packets[1:])), 'non-monotonic preview DTS')
        require(int(preview_packets[0]['pts']) == 0, 'preview PTS must start at zero')
        decode(preview)
        counted = json.loads(execute([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-count_frames',
                                      '-show_entries', 'stream=nb_read_frames', '-of', 'json', str(preview)]))
        require(int(counted['streams'][0]['nb_read_frames']) == len(preview_packets), 'decoded preview frame count mismatch')
        hls = destination/'hls'
        hls.mkdir()
        execute([ffmpeg, '-nostdin', '-hide_banner', '-n', '-i', str(preview), '-map', '0:v:0', '-an', '-c:v', 'copy',
                 '-tag:v', 'hvc1', '-f', 'hls', '-hls_time', decimal(Fraction(layout['segmentFrames'], 60)),
                 '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
                 '-hls_segment_options', f'video_track_timescale={scale}', '-hls_fmp4_init_filename', 'init.mp4',
                 '-start_number', '0', '-hls_segment_filename', str(hls/'segment_%05d.m4s'), str(hls/'tail.m3u8')])
        new_init_meta = video(hls/'init.mp4')
        for key in ('time_base', 'codec_tag_string', 'id', 'profile', 'level', 'width', 'height', 'pix_fmt'):
            require(init_meta.get(key) == new_init_meta.get(key), 'old/new HLS init incompatibility: '+key)
        require(parameter_sets(extradata(new_init_meta)) == parameters, 'HLS parameter sets changed')
        relative_packets = packet_list(hls/'tail.m3u8')
        require(len(relative_packets) == len(preview_packets), 'HLS packet count mismatch')
        require([p['data_hash'] for p in relative_packets] == [p['data_hash'] for p in preview_packets], 'HLS changed packet payloads')
        decode(hls/'tail.m3u8')
        fragments, total_packets = [], 0
        for name in (line for line in (hls/'tail.m3u8').read_text().splitlines() if line and not line.startswith('#')):
            require(Path(name).name == name and name.endswith('.m4s'), 'unexpected HLS filename')
            data = (hls/name).read_bytes()
            local = hls/'verify-fragment.mp4'
            # Crucially validate against the OLD init, not just the generated one.
            local.write_bytes(init.read_bytes()+data)
            packets = packet_list(local)
            decode(local)
            require(bool(packets), 'empty HLS fragment')
            duration = sum(int(p['duration']) for p in packets)
            require(duration > 0, 'missing fragment duration')
            require(inspect(data)['decodeTimes'] == [sum(d for _, d in fragments)], 'fragment timing gap')
            total_packets += len(packets)
            fragments.append((hls/name, duration))
        require(total_packets == len(preview_packets), 'fragment packet total mismatch')
        # Gate all short-media checks before the branch manifest commit.
        expected_duration = layout['offsetTicks']+sum(d for _, d in fragments)
        require(abs(Fraction(expected_duration)-Fraction(plan['finalFrames']*scale, 60)) <= duration_tolerance, f'final ledger duration mismatch: {expected_duration} != {Fraction(plan["finalFrames"]*scale, 60)}')
        now = master.stat()
        require((now.st_size, now.st_mtime_ns, now.st_ino, now.st_dev) ==
                (master_stat.st_size, master_stat.st_mtime_ns, master_stat.st_ino, master_stat.st_dev), 'master changed during packaging')
        ledger = replace_tail(destination/'ledger', previous_path=spec['previousManifest'],
                              expected_parent_sha256=spec['previousSHA256'], retained_count=layout['retainedCount'],
                              fragments=((path.read_bytes(), duration) for path, duration in fragments), rebase_to_boundary=True)
        verify(destination/'ledger', previous=previous)
        duration_ticks = ledger['segments'][-1]['startTicks']+ledger['segments'][-1]['durationTicks']
        require(abs(Fraction(duration_ticks)-Fraction(plan['finalFrames']*scale, 60)) <= duration_tolerance, f'final ledger duration mismatch: {expected_duration} != {Fraction(plan["finalFrames"]*scale, 60)}')
        receipt = dict(format='utxo-package-append-v1', layout=layout, parentSHA256=spec['previousSHA256'],
                       ledger=str(destination/'ledger/segments.json'), ledgerSHA256=file_hash(destination/'ledger/segments.json'),
                       finalFrames=plan['finalFrames'], durationTicks=duration_ticks, durationToleranceTicks=duration_tolerance, previewFrames=total_packets, exclusiveJoinDts=str(exclusive_dts),
                       parameterSetsMatch=True, packetPayloadsIdentical=True, decoded=True,
                       fullMasterRewritten=False, fixtureDimensions=fixture_dimensions)
        atomic_json(destination/'package_verified.json', receipt)
        return receipt
    except BaseException as exc:
        atomic_json(destination/'package_failed.json', {'error': str(exc)})
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(json.loads(args.spec.read_text())), indent=2))
