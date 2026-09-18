#!/usr/bin/env python3
"""Build/append a 1440p H.264 delivery rendition without running the renderer.

build SPEC.json | append SPEC.json | verify RUN_DIRECTORY
Spec: source (absolute MP4), sourceSHA256, frameCount, destination (fresh absolute
directory). Append also requires previousManifest, previousSHA256, previousInit,
and joinFrame (the master append's first changed frame, before the old ending).
No network operations. publish_append.prepare consumes the resulting ledger/.
"""
import argparse
from fractions import Fraction
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import time

import fragment_manifest as fm
from import_hls_catalog import scan

FPS = 60
TIMESCALE = 15360
SEGMENT_FRAMES = 240
DIMENSIONS = (2560, 1440)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8*1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def source_stat(path):
    s = Path(path).stat()
    return dict(size=s.st_size, mtimeNs=s.st_mtime_ns, device=s.st_dev, inode=s.st_ino)


def downscale(width, height):
    # p=4 power mean keeps sparse lights visible. Work in planar 16-bit RGB,
    # never apply RGB LUTs to YUV or average the renderer's density ledger.
    lift = ':'.join(f"{c}='pow(val/maxval,4)*maxval'" for c in 'rgb')
    lower = ':'.join(f"{c}='pow(val/maxval,0.25)*maxval'" for c in 'rgb')
    return (f'format=gbrp16le,lutrgb={lift},scale={width}:{height}:flags=area,'
            f'lutrgb={lower},scale=in_range=pc:out_range=tv:out_color_matrix=bt709,'
            'format=yuv420p,setsar=1,setpts=N/(60*TB)')


def encode_argv(source, out, start, count, dimensions=DIMENSIONS):
    return ['ffmpeg', '-hide_banner', '-nostdin', '-n', '-stats_period', '10',
            '-ss', f'{start/FPS:.12f}', '-i', str(source), '-map', '0:v:0', '-an',
            '-frames:v', str(count), '-vf', downscale(*dimensions),
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-profile:v', 'high', '-level:v', '5.1', '-pix_fmt', 'yuv420p',
            '-g', str(SEGMENT_FRAMES), '-keyint_min', str(SEGMENT_FRAMES),
            '-sc_threshold', '0', '-bf', '0', '-refs', '3',
            '-maxrate', '20M', '-bufsize', '40M', '-x264-params', 'open-gop=0',
            '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-tag:v', 'avc1', '-fps_mode', 'passthrough',
            '-progress', str(out.parent/'progress.txt'), '-f', 'hls',
            '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
            '-hls_segment_options', 'video_track_timescale=15360',
            '-hls_flags', 'independent_segments+temp_file',
            '-hls_fmp4_init_filename', 'init.mp4',
            '-hls_segment_filename', str(out/'segment_%05d.m4s'), str(out/'media.m3u8')]


def avcc(init):
    # Traverse the actual sample entry, rather than search compressed payloads.
    from import_hls_catalog import one
    moov = one(init, b'moov')
    stbl = one(one(one(one(moov, b'trak'), b'mdia'), b'minf'), b'stbl')
    stsd = one(stbl, b'stsd')
    require(int.from_bytes(stsd[4:8], 'big') == 1, 'single sample entry required')
    entry = one(stsd[8:], b'avc1')
    data = one(entry[78:], b'avcC')
    require(data[0] == 1 and len(data) >= 7, 'invalid avcC')
    return data


def first_vcl_is_idr(data, length_size):
    for pos, size, kind, header in fm.boxes(data):
        if kind != b'mdat':
            continue
        payload = memoryview(data)[pos+header:pos+size]
        offset = 0
        while offset+length_size < len(payload):
            n = int.from_bytes(payload[offset:offset+length_size], 'big')
            offset += length_size
            require(n > 0 and offset+n <= len(payload), 'invalid AVC NAL length')
            nal_type = payload[offset] & 31
            if 1 <= nal_type <= 5:
                return nal_type == 5
            offset += n
    return False


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
        '-select_streams', 'v:0', '-show_streams', '-of', 'json', str(path)]))['streams'][0]


def encoded_fragments(run, expected, dimensions):
    out = run/'encode'
    lines = (out/'media.m3u8').read_text().splitlines()
    require('#EXT-X-ENDLIST' in lines, 'incomplete playlist')
    names = [line for line in lines if line and not line.startswith('#')]
    require(len(names) == (expected+SEGMENT_FRAMES-1)//SEGMENT_FRAMES, 'segment count mismatch')
    init = (out/'init.mp4').read_bytes()
    metadata = scan(io.BytesIO(init), len(init))['initMetadata']
    require(metadata['timescale'] == TIMESCALE, 'incorrect track timescale')
    config = avcc(init)
    require(config[1] == 100 and config[3] == 51, 'H.264 High level 5.1 required')
    stream = probe('concat:'+str(out/'init.mp4')+'|'+str(out/names[0]))
    for key, value in dict(codec_name='h264', profile='High', level=51,
                           width=dimensions[0], height=dimensions[1], pix_fmt='yuv420p',
                           color_range='tv', color_space='bt709', codec_tag_string='avc1').items():
        require(stream.get(key) == value, 'codec field mismatch: '+key)
    length_size = (config[4] & 3)+1
    require(Fraction(stream['r_frame_rate']) == FPS, 'incorrect encoded frame rate')
    def fragments():
        total = 0
        for i, name in enumerate(names):
            require(name == f'segment_{i:05d}.m4s', 'unexpected segment name')
            data = (out/name).read_bytes()
            meta = scan(io.BytesIO(data), len(data), init=metadata)
            count = min(SEGMENT_FRAMES, expected-total)
            require(meta['samples'] == count and meta['durationTicks'] == count*256,
                    'sample count/duration mismatch')
            require(meta['startTicks'] == total*256, 'decode timeline gap')
            require(first_vcl_is_idr(data, length_size), 'segment is not IDR-led')
            total += count
            yield data, count*256
        require(total == expected, 'encoded frame count mismatch')
    return init, config, fragments


def execute(spec, *, fixture_dimensions=None):
    source, run = Path(spec['source']), Path(spec['destination'])
    require(source.is_absolute() and source.is_file() and run.is_absolute(), 'absolute source/destination required')
    require(not run.exists(), 'fresh destination required')
    frames = spec['frameCount']
    require(type(frames) is int and frames > 0, 'positive frameCount required')
    before = source_stat(source)
    require(re.fullmatch('[0-9a-f]{64}', spec['sourceSHA256']), 'source SHA256 required')
    require(digest(source) == spec['sourceSHA256'], 'source SHA256 mismatch')
    stream = probe(source)
    require(Fraction(stream['r_frame_rate']) == FPS and int(stream['nb_frames']) == frames,
            'source FPS/frame count mismatch')
    dimensions = fixture_dimensions or DIMENSIONS
    if fixture_dimensions is None:
        require((stream['width'], stream['height'], stream['codec_name'], stream['pix_fmt']) ==
                (3840, 2160, 'hevc', 'yuv444p'), '4K HEVC 4:4:4 source required')
    previous, layout = None, {'packageStartFrame': 0}
    if 'previousManifest' in spec:
        require(all(Path(spec[k]).is_absolute() for k in ('previousManifest', 'previousInit')), 'absolute previous paths required')
        previous = fm.load_previous(spec['previousManifest'], spec['previousSHA256'])
        require(previous['timescale'] == TIMESCALE, 'previous timescale mismatch')
        require(frames*256 > sum(e['durationTicks'] for e in previous['segments']), 'append must extend the previous timeline')
        require(type(spec['joinFrame']) is int and 0 <= spec['joinFrame'] < frames, 'invalid join frame')
        layout = fm.plan_tail(previous, join_frame=spec['joinFrame'],
                              segment_frames=SEGMENT_FRAMES, fps_num=FPS)
        require(digest(spec['previousInit']) == previous['init']['sha256'], 'previous init mismatch')
    start = layout['packageStartFrame']
    run.mkdir(parents=True, exist_ok=False)
    (run/'encode').mkdir()
    fm.atomic_json(run/'spec.json', spec)
    argv = encode_argv(source, run/'encode', start, frames-start, dimensions)
    fm.atomic_json(run/'command.json', argv)
    started = time.time()
    fm.atomic_json(run/'status.json', dict(phase='encoding', startFrame=start, expectedFrames=frames-start))
    try:
        with (run/'encode.log').open('wb') as log:
            subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, check=True)
        require(source_stat(source) == before, 'source changed during encoding')
        progress = dict(line.split('=', 1) for line in (run/'progress.txt').read_text().splitlines() if '=' in line)
        require(progress.get('progress') == 'end' and int(progress['frame']) == frames-start,
                'encoder did not finish requested frames')
        init, config, fragments = encoded_fragments(run, frames-start, dimensions)
        if previous:
            require(avcc(Path(spec['previousInit']).read_bytes()) == config, 'AVC configuration changed; rebuild required')
            ledger = fm.replace_tail(run/'ledger', previous_path=spec['previousManifest'],
                expected_parent_sha256=spec['previousSHA256'], retained_count=layout['retainedCount'],
                fragments=fragments(), rebase_to_boundary=True)
            fm.atomic_json(run/'previous.json', previous)
        else:
            ledger = fm.append(run/'ledger', init=init, fragments=fragments(),
                               timescale=TIMESCALE, expected_count=0)
        fm.verify(run/'ledger', previous=previous)
        require(sum(e['durationTicks'] for e in ledger['segments']) == frames*256, 'ledger frame count mismatch')
        # Actually decode the entire newly encoded range. A playlist footer alone
        # does not demonstrate that the last fragments can be decoded.
        fm.atomic_json(run/'status.json', dict(phase='decoding', expectedFrames=frames-start))
        decode_progress = run/'decode-progress.txt'
        with (run/'decode.log').open('wb') as log:
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-progress',
                str(decode_progress), '-i', str(run/'encode/media.m3u8'), '-map', '0:v:0',
                '-fps_mode', 'passthrough', '-f', 'null', '-'], stdout=log, stderr=log, check=True)
        decoded = dict(line.split('=', 1) for line in decode_progress.read_text().splitlines() if '=' in line)
        require(decoded.get('progress') == 'end' and int(decoded['frame']) == frames-start, 'decoded frame count mismatch')
        receipt = dict(format='utxo-compat-rendition-v1', frameCount=frames, startFrame=start,
            encodedFrames=frames-start, width=dimensions[0], height=dimensions[1], fps=FPS,
            codecs='avc1.'+config[1:4].hex(), avcC=config.hex(), sourceSHA256=spec['sourceSHA256'],
            sourceStat=before, ledgerSHA256=digest(run/'ledger/segments.json'),
            specSHA256=digest(run/'spec.json'), elapsedSeconds=round(time.time()-started, 2),
            commandSHA256=digest(run/'command.json'), segmentCount=len(ledger['segments']))
        fm.atomic_json(run/'build_verified.json', receipt)
        fm.atomic_json(run/'status.json', dict(phase='verified', **receipt))
        return receipt
    except BaseException as exc:
        fm.atomic_json(run/'status.json', dict(phase='failed', error=str(exc)))
        raise


def verify(run):
    run = Path(run)
    receipt = json.loads((run/'build_verified.json').read_text())
    for filename, key in [('spec.json', 'specSHA256'), ('command.json', 'commandSHA256'),
                          ('ledger/segments.json', 'ledgerSHA256')]:
        require(digest(run/filename) == receipt[key], 'receipt mismatch: '+filename)
    spec = json.loads((run/'spec.json').read_text())
    previous = fm.load_previous(spec['previousManifest'], spec['previousSHA256']) if 'previousManifest' in spec else None
    ledger = fm.verify(run/'ledger', previous=previous)
    require(sum(e['durationTicks'] for e in ledger['segments']) == receipt['frameCount']*256, 'frame count mismatch')
    return receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['build', 'append', 'verify'])
    p.add_argument('path', type=Path)
    args = p.parse_args()
    if args.command == 'verify':
        result = verify(args.path)
    else:
        spec = json.loads(args.path.read_text())
        require(('previousManifest' in spec) == (args.command == 'append'), 'build/append spec mismatch')
        result = execute(spec)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
