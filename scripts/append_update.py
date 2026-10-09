#!/usr/bin/env python3
"""Manifest-driven append preparation and dependency runner (no implicit publication).

CLI: plan SOURCE.json | prepare SOURCE.json | run RUN [--retry]
Required source keys: master, oldEndBlock, newEndBlock, blk, history, config,
runPath, buv, repeatLastBlockTimes, port. Paths must be absolute; runPath fresh.
Optional: rendererCheckpoint={path,nextHeight}, ffmpeg, ffprobe, timeoutSeconds,
commands=[{name,argv,dependsOn,outputs,successContains,retrySafe,validateArgv}].
Commands use literal argv (no shell or substitutions); `render` is reserved.
renderDependsOn lists prerequisite commands. Independent history commands can
run concurrently with render. Publish/finalize commands must depend on render
and history as appropriate. Publication handoff (all paths explicit):
  package_append.py SPEC.json
  publish_append.py prepare SOURCE DEST --object-prefix PREFIX
      --previous PREVIOUS_SEGMENTS_JSON --previous-sha256 RAW_FILE_SHA256
      [--execution-manifest EXECUTION_JSON]
SPEC={preparedManifest:RUN/plan.json,previousManifest:PREVIOUS_SEGMENTS_JSON,
previousSHA256:RAW_FILE_SHA256,oldInit:LOCAL_INIT,destination:FRESH_DIR,segmentFrames:600}.
Package validates the plan seal/render.status.json/tail hash, then packet-copies
short-old-prefix plus tail.mkv; outputs FRESH_DIR/ledger/segments.json and
FRESH_DIR/package_verified.json. It does not encode the old prefix.
fragment_manifest.plan_tail(previous,join_frame=JOIN,segment_frames=600,fps_num=60)
returns retainedCount/packageStartFrame/oldTailFrames/offsetTicks/firstSequence.
replace_tail(fresh_root,previous_path,expected_parent_sha256,retained_count,
fragments=[(bytes,durationTicks)],rebase_to_boundary=True) writes the next ledger.
Publication prepare is local-only; never implicitly call execute or rollback.
The review-only scripts/examples/append-current-20260912 bundle shows wiring.
Source unresolvedPlaceholders must be empty before plan/prepare. Optional
inputManifests lists additional JSON specifications to hash/seal at prepare.
Every command requires nonempty output files as durable resume evidence. Optional
validateArgv is a read-only semantic gate, also rerun before skipping completed
steps (use it for mutable BLK/history inputs; receipts alone cannot prove them). External
commands own their semantics (including append safety and publication validation).
No historical scripts are imported. There is deliberately no automatic master
splice or production promotion: supply separately validated dependency stages.
"""
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import struct
import subprocess
import threading
import time


class GateError(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise GateError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(8*1024*1024), b''):
            h.update(b)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def absolute(value):
    p = Path(value)
    require(p.is_absolute(), f'absolute path required: {p}')
    return str(p.resolve())


def warm_start(join, epoch, slide):
    warm = max(0, join - 1380)
    if warm >= epoch and 0 < warm % epoch < slide:
        warm -= warm % epoch
    return warm


def boundaries(old, new, keyframes, epoch, slide, repeats):
    require(type(old) is int and type(new) is int and 0 <= old <= new, 'invalid block range')
    require(type(epoch) is int and epoch > 0 and type(slide) is int and 0 <= slide <= epoch,
            'invalid epoch/slide')
    require(type(repeats) is int and repeats >= 0, 'invalid repeat count')
    if old == new:
        return dict(oldEndBlock=old, newEndBlock=new, noOp=True, joinBlock=None,
                    warmupStart=None, nextJoin=None, nextWarm=None, trimFrames=0,
                    tailFrames=0, finalFrames=old+1+repeats)
    eligible = [k for k in keyframes if type(k) is int and 0 <= k <= old]
    require(eligible, 'no measured keyframe at/before oldEndBlock')
    join = max(eligible)  # Even a partial final GOP is replaced, including its key.
    next_join = join + ((new - join)//60)*60
    warm = warm_start(join, epoch, slide)
    next_warm = warm_start(next_join, epoch, slide)
    require(next_warm > 0, 'rolling checkpoint needs positive nextHeight')
    return dict(oldEndBlock=old, newEndBlock=new, noOp=False, joinBlock=join, warmupStart=warm,
                nextJoin=next_join, nextWarm=next_warm, trimFrames=join-warm,
                tailFrames=new-join+1+repeats, finalFrames=new+1+repeats)


def probe_json(argv):
    return json.loads(subprocess.check_output(argv, stdin=subprocess.DEVNULL))


def hex_dump(value):
    return bytes.fromhex(''.join(line.split(':', 1)[1].strip().split('  ')[0].replace(' ', '')
                                for line in value.splitlines() if ':' in line))


def is_idr(packet, length_size):
    data = hex_dump(packet.get('data', ''))
    pos = 0
    while pos < len(data):
        require(pos+length_size <= len(data), 'truncated NAL length')
        n = int.from_bytes(data[pos:pos+length_size], 'big')
        pos += length_size
        require(n >= 2 and pos+n <= len(data), 'invalid NAL packet')
        kind = (data[pos] >> 1) & 63
        if kind < 32:
            return kind in (19, 20)  # CRA/key flag alone does not prove closed GOP.
        pos += n
    return False


def inspect_master(source):
    ff = source.get('ffprobe', 'ffprobe')
    common = [ff, '-v', 'error', '-select_streams', 'v:0']
    meta = probe_json(common + ['-show_streams', '-show_data', '-of', 'json', source['master']])
    s = meta['streams'][0]
    for key, expected in dict(width=3840, height=2160, pix_fmt='yuv444p',
                              r_frame_rate='60/1', codec_name='hevc').items():
        require(s.get(key) == expected, f'master mismatch: {key}')
    require(abs(float(s.get('start_time', 0))) < 1e-6, 'master must start at block zero')
    require(int(s['nb_frames']) >= source['oldEndBlock']+1, 'master lacks real frames')
    extra = hex_dump(s['extradata'])
    require(len(extra) >= 23 and extra[0] == 1, 'HEVC configuration required')
    length_size = (extra[21] & 3)+1
    start = max(0, source['oldEndBlock']-120)/60
    packets = probe_json(common + ['-read_intervals', f'{start}%+4', '-show_packets',
                                   '-show_data', '-of', 'json', source['master']])['packets']
    keys = []
    for packet in packets:
        if 'K' not in packet.get('flags', ''):
            continue
        frame = float(packet['pts_time'])*60
        require(abs(frame-round(frame)) < .01, 'nonintegral keyframe timestamp')
        if round(frame) <= source['oldEndBlock']:
            keys.append((round(frame), packet))
    require(keys, 'no keyframe near old endpoint')
    join, packet = max(keys, key=lambda pair: pair[0])
    require(is_idr(packet, length_size), 'last keyframe is not closed-GOP IDR')
    return {'keyframes': [join], 'joinDts': packet['dts_time'], 'stream': s}


def checkpoint_height(path):
    with Path(path).open('rb') as f:
        header = f.read(152)
    require(len(header) == 152 and header[:8] == b'BUVRCP01', 'bad renderer checkpoint')
    version, size, height = struct.unpack('<QQQ', header[8:32])
    require(version == 1 and size == 152 and hashlib.sha256(header[:120]).digest() == header[120:],
            'bad renderer checkpoint header checksum')
    return height  # Full ledger/config/BLK binding remains a mandatory C++ load gate.


def make_plan(source, cfg, measurement):
    source = json.loads(json.dumps(source))
    require(not source.get('unresolvedPlaceholders'), 'unresolved review placeholders: '+str(source.get('unresolvedPlaceholders')))
    for field in ('master', 'blk', 'history', 'config', 'runPath', 'buv'):
        source[field] = absolute(source[field])
    require(cfg.get('xAxisMode') == 'normalizedGeometric', 'normalizedGeometric required')
    require(cfg.get('imageWidth') == 3840 and cfg.get('imageHeight') == 2160, '4K required')
    require(cfg.get('skipBlocks', 0) in (0, 1), 'one frame per block required')
    timeout = source.get('timeoutSeconds', 86400)
    require(isinstance(timeout, (int, float)) and math.isfinite(timeout) and timeout > 0, 'invalid timeout')
    require(type(source['port']) is int and 1024 <= source['port'] <= 65535, 'invalid port')
    b = boundaries(source['oldEndBlock'], source['newEndBlock'], measurement.get('keyframes', []),
                   cfg['epochBlocks'], cfg['epochTransitionBlocks'], source['repeatLastBlockTimes'])
    run = Path(source['runPath'])
    if b['noOp']:
        return dict(format='utxo-append-plan-v1', source=source, **b, renderConfig={},
                    measurement=measurement, stages=[])
    config = dict(cfg)
    config['historyDeltaFile'] = absolute(source['historyDeltaFile']) if source.get('historyDeltaFile') else ''
    # Never inherit mutable inputs or checkpoint paths from historical configs.
    for key in ('rendererCheckpointLoad', 'rendererCheckpointSave', 'rendererCheckpointSaveAtBlock'):
        config.pop(key, None)
    config.update(blkFile=source['blk'], historyFile=source['history'], allowBlkFileTruncate=False,
                  audioEnabled=False, audioOutputFile='',
                  checkpointFile='', checkpointIntervalBlocks=0,
                  startShowAtBlockHeight=b['warmupStart'], endShowAtBlockHeight=b['newEndBlock'],
                  repeatLastBlockTimes=source['repeatLastBlockTimes'], connectionIpAddr='127.0.0.1',
                  connectionSocket=source['port'], rendererCheckpointSave=str(run/'renderer-next.chk'),
                  rendererCheckpointSaveAtBlock=b['nextWarm'])
    cp = source.get('rendererCheckpoint')
    if cp:
        cp['path'] = absolute(cp['path'])
        require(type(cp['nextHeight']) is int and 0 < cp['nextHeight'] <= b['warmupStart'],
                'checkpoint nextHeight must be at/before WARM')
        require(warm_start(cp['nextHeight']+1380, cfg['epochBlocks'], cfg['epochTransitionBlocks']) == cp['nextHeight'],
                'checkpoint is inside epoch slide')
        config['rendererCheckpointLoad'] = cp['path']
    ff = [source.get('ffmpeg', 'ffmpeg'), '-nostdin', '-hide_banner', '-n', '-stats_period', '2',
          '-progress', str(run/'ffmpeg.progress'), '-f', 'rawvideo', '-pixel_format', 'rgb24',
          '-video_size', '3840x2160', '-framerate', '60', '-i',
          f'tcp://127.0.0.1:{source["port"]}?listen=1', '-an', '-vf',
          f'trim=start_frame={b["trimFrames"]},setpts=PTS-STARTPTS', '-c:v', 'libx265',
          '-preset', 'superfast', '-crf', '21', '-pix_fmt', 'yuv444p', '-x265-params',
          'keyint=60:min-keyint=60:scenecut=0:open-gop=0:range=full:colormatrix=bt709',
          '-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
          '-color_trc', 'bt709', str(run/'tail.mkv')]
    stages = list(source.get('commands', []))
    require(all(s.get('name') != 'render' and s.get('kind', 'command') == 'command' for s in stages),
            'render is reserved')
    stages.append(dict(name='render', dependsOn=source.get('renderDependsOn', []), kind='render',
                       outputs=[str(run/'tail.mkv'), str(run/'renderer-next.chk')],
                       argv=[source['buv'], '-ns', '-tc=visualizer', '-cfg='+str(run/'render.json')],
                       encoderArgv=ff, retrySafe=True))
    validate_stages(stages)
    protected = {source[k] for k in ('master', 'blk', 'history', 'config', 'buv')}
    if cp:
        protected.add(cp['path'])
    require(not any(absolute(p) in protected for s in stages for p in s['outputs']),
            'stage output collides with source input; use a fresh receipt file for in-place stages')
    return dict(format='utxo-append-plan-v1', source=source, **b, renderConfig=config,
                measurement=measurement, stages=stages)


def validate_stages(stages):
    names = [s['name'] for s in stages]
    require(len(set(names)) == len(names), 'duplicate stage name')
    outputs = []
    for s in stages:
        require(re.fullmatch(r'[A-Za-z0-9_-]+', s['name']), 'unsafe stage name')
        require(s.get('kind', 'command') in ('command', 'render'), 'unknown stage kind')
        require(isinstance(s.get('argv'), list) and s['argv'] and
                all(isinstance(x, str) and x for x in s['argv']), 'argv must be a nonempty string list')
        require(isinstance(s.get('dependsOn', []), list), 'dependsOn must be a list')
        require(set(s.get('dependsOn', [])) <= set(names), 'unknown dependency')
        require(isinstance(s.get('outputs'), list) and s['outputs'], 'durable outputs required')
        if 'validateArgv' in s:
            require(isinstance(s['validateArgv'], list) and s['validateArgv'] and
                    all(isinstance(x, str) and x for x in s['validateArgv']), 'validateArgv must be an argv list')
        require(isinstance(s.get('successContains', []), list) and
                all(isinstance(x, str) for x in s.get('successContains', [])), 'successContains must be a list')
        outputs.extend(absolute(p) for p in s['outputs'])
    require(len(outputs) == len(set(outputs)), 'stages must not share outputs')
    done = set()
    while len(done) < len(names):
        ready = {s['name'] for s in stages if set(s.get('dependsOn', [])) <= done} - done
        require(ready, 'dependency cycle')
        done |= ready


def prepare(source):
    require(not source.get('unresolvedPlaceholders'), 'resolve review placeholders before prepare')
    cfg = json.loads(Path(source['config']).read_text())
    measurement = {} if source['oldEndBlock'] == source['newEndBlock'] else inspect_master(source)
    plan = make_plan(source, cfg, measurement)
    run = Path(plan['source']['runPath'])
    if source.get('rendererCheckpoint'):
        cp = source['rendererCheckpoint']
        require(checkpoint_height(cp['path']) == cp['nextHeight'], 'checkpoint height mismatch')
    # Inputs may be updated by explicit stages; master/config/checkpoint must not drift.
    inputs = [source['master'], source['config']]
    if source.get('rendererCheckpoint'):
        inputs.append(source['rendererCheckpoint']['path'])
    plan['inputDigests'] = {absolute(p): digest(p) for p in source.get('inputManifests', [])}
    plan['inputStats'] = {absolute(p): {'size': Path(p).stat().st_size,
                                      'mtimeNs': Path(p).stat().st_mtime_ns} for p in inputs}
    run.mkdir(parents=True, exist_ok=False)
    atomic_json(run/'source.json', source)
    atomic_json(run/'render.json', plan['renderConfig'])
    atomic_json(run/'plan.json', plan)
    atomic_json(run/'seal.json', {p: digest(run/p) for p in ('source.json', 'render.json', 'plan.json')})
    return plan


def read_tail(path, limit=65536):
    """Bounded reads keep polling independent of replay log size."""
    if path is None:
        return ''
    try:
        with Path(path).open('rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size-limit))
            data = f.read()
        if size > limit:
            data = data.partition(b'\n')[2]
        return data.decode(errors='replace')
    except FileNotFoundError:
        return ''


def progress_values(path):
    values = {}
    for line in read_tail(path).splitlines():
        key, sep, value = line.partition('=')
        if sep:
            values[key.strip()] = value.strip()
    return values


def progress_snapshot(plan, renderer_log=None, progress_file=None, phase=None):
    result = {'phase': phase or 'replay', 'block': None, 'frame': None,
              'fps': None, 'speed': None, 'etaSeconds': None}
    blocks = re.findall(r'\| block (\d+),', read_tail(renderer_log))
    if blocks:
        result['block'] = int(blocks[-1])
    raw = progress_values(progress_file)
    for key in ('frame', 'fps', 'speed'):
        try:
            value = float(raw[key].removesuffix('x'))
            if math.isfinite(value) and value >= 0:
                result[key] = int(value) if key == 'frame' else value
        except (KeyError, ValueError):
            pass
    block = result['block']
    if phase is None:
        if block is not None and block >= plan['joinBlock'] or (result['frame'] or 0) > 0:
            result['phase'] = 'encode'
        elif block is not None and block >= plan['warmupStart']:
            result['phase'] = 'warmup'
    if result['phase'] in ('encode', 'decode') and result['frame'] is not None:
        remaining = max(0, plan['tailFrames']-result['frame'])
        result['remainingFrames'] = remaining
        rate = result['fps'] or (result['speed'] or 0)*60
        if rate > 0:
            result['etaSeconds'] = remaining/rate
    return result


class Runner:
    def __init__(self, run, plan, retry=False):
        self.run, self.plan, self.retry = Path(run), plan, retry
        self.mutex = threading.Lock()
        self.stop = threading.Event()

    def event(self, name, **fields):
        with self.mutex:
            with (self.run/'timings.jsonl').open('a') as f:
                f.write(json.dumps(dict(at=time.time(), event=name, **fields))+'\n')
                f.flush()
                os.fsync(f.fileno())

    def kill(self, p):
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()

    def launch(self, argv, log, stage):
        f = log.open('xb')
        try:
            p = subprocess.Popen(argv, cwd=self.run, stdin=subprocess.DEVNULL,
                                 stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
        finally:
            f.close()
        self.event('process_start', stage=stage, pid=p.pid, log=str(log), argv=argv)
        return p

    def wait(self, processes, stage, start, *, renderer_log=None, progress_file=None, phase=None):
        limit = self.plan['source'].get('timeoutSeconds', 86400)
        last_progress = -10.0
        first_block = None
        while True:
            codes = [p.poll() for p in processes]
            require(not self.stop.is_set(), 'another stage failed; cancelled')
            require(time.monotonic()-start < limit, 'process timeout')
            require(all(c in (None, 0) for c in codes), f'process failed: {codes}')
            require(not (len(codes) == 2 and codes[1] is not None and codes[0] is None),
                    'encoder exited before visualizer')
            if time.monotonic()-last_progress >= 5 or all(c is not None for c in codes):
                details = {}
                if renderer_log is not None or progress_file is not None:
                    details = progress_snapshot(self.plan, renderer_log, progress_file, phase)
                    block = details['block']
                    if block is not None and first_block is None:
                        first_block = (block, time.monotonic())
                    if first_block and block is not None and block > first_block[0]:
                        rate = (block-first_block[0])/max(.001, time.monotonic()-first_block[1])
                        details['blocksPerSecond'] = rate
                        if details['phase'] in ('replay', 'warmup'):
                            boundary = self.plan['warmupStart'] if details['phase'] == 'replay' else self.plan['joinBlock']
                            details['etaSeconds'] = max(0, boundary-block)/rate
                    details['etaScope'] = 'currentPhase'
                self.event('progress', stage=stage, pids=[p.pid for p in processes],
                           returncodes=codes, seconds=time.monotonic()-start, **details)
                last_progress = time.monotonic()
            if all(c is not None for c in codes):
                return
            time.sleep(.2)

    def render(self, stage, attempt, start):
        port = self.plan['source']['port']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
        require(not (self.run/'ffmpeg.progress').exists(), 'existing encoder progress; fresh run required')
        fp = self.launch(stage['encoderArgv'], attempt/'encoder.log', stage['name'])
        vp = None
        try:
            # Detect bind without connecting: a probe connection would consume FFmpeg's input.
            deadline = time.monotonic()+15
            while True:
                require(fp.poll() is None, 'encoder exited before listener became ready')
                with socket.socket() as sock:
                    try:
                        sock.bind(('127.0.0.1', port))
                    except OSError as e:
                        import errno
                        if e.errno != errno.EADDRINUSE:
                            raise
                        break
                require(time.monotonic() < deadline, 'listener readiness timeout')
                time.sleep(.05)
            vp = self.launch(stage['argv'], attempt/'process.log', stage['name'])
            self.wait([vp, fp], stage['name'], start, renderer_log=attempt/'process.log',
                      progress_file=self.run/'ffmpeg.progress')
        finally:
            for p in (vp, fp):
                if p is not None:
                    self.kill(p)
        self.verify_tail(stage, attempt, start)

    def verify_tail(self, stage, attempt, start):
        verification_start = time.monotonic()
        self.event('tail_verification_start', stage=stage['name'])
        log = (attempt/'process.log').read_text(errors='replace')
        require('Status: SUCCESS!' in log and 'ledger misses=0, dropped decrements=0' in log,
                'renderer success/ledger gate failed')
        require('Lsize=' in (attempt/'encoder.log').read_text(errors='replace'), 'missing final FFmpeg summary')
        require('progress=end' in (self.run/'ffmpeg.progress').read_text(), 'FFmpeg progress incomplete')
        ff = self.plan['source'].get('ffprobe', 'ffprobe')
        meta = probe_json([ff, '-v', 'error', '-select_streams', 'v:0', '-count_packets',
                           '-show_streams', '-of', 'json', str(self.run/'tail.mkv')])['streams'][0]
        require(int(meta['nb_read_packets']) == self.plan['tailFrames'], 'tail packet count mismatch')
        for key, value in dict(width=3840, height=2160, pix_fmt='yuv444p', r_frame_rate='60/1', codec_name='hevc').items():
            require(meta.get(key) == value, f'tail mismatch: {key}')
        self.event('tail_packet_gate_complete', stage=stage['name'],
                   packets=int(meta['nb_read_packets']), seconds=time.monotonic()-verification_start)
        decode_progress = attempt/'decode.progress'
        decode_start = time.monotonic()
        decoder = self.launch([self.plan['source'].get('ffmpeg', 'ffmpeg'), '-nostdin',
                               '-v', 'error', '-xerror', '-nostats', '-stats_period', '2',
                               '-progress', str(decode_progress), '-i', str(self.run/'tail.mkv'),
                               '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'null', '-'], attempt/'decode.log', stage['name'])
        try:
            self.wait([decoder], stage['name'], start, progress_file=decode_progress, phase='decode')
        finally:
            self.kill(decoder)
        decoded = progress_values(decode_progress)
        require(decoded.get('progress') == 'end', 'decoder progress incomplete')
        require(decoded.get('frame', '').isdigit() and int(decoded['frame']) == self.plan['tailFrames'],
                'decoded frame count mismatch')
        self.event('tail_decode_complete', stage=stage['name'], frames=int(decoded['frame']),
                   seconds=time.monotonic()-decode_start)
        require(checkpoint_height(self.run/'renderer-next.chk') == self.plan['nextWarm'], 'saved checkpoint boundary mismatch')
        self.event('tail_verification_complete', stage=stage['name'], seconds=time.monotonic()-verification_start)

    def validate_command(self, stage):
        if 'validateArgv' not in stage:
            return
        # Unique logs preserve every validation, including read-only resume gates.
        log = self.run / (stage['name'] + f'.validation-{time.time_ns()}.log')
        start = time.monotonic()
        p = self.launch(stage['validateArgv'], log, stage['name'])
        try:
            self.wait([p], stage['name'], start)
        finally:
            self.kill(p)

    def execute(self, stage):
        require(not self.stop.is_set(), 'cancelled before stage launch')
        name = stage['name']
        status_path = self.run/(name+'.status.json')
        old = json.loads(status_path.read_text()) if status_path.exists() else {}
        binding = hashlib.sha256(canonical(stage)).hexdigest()
        require(not old or old.get('binding') == binding, 'stage definition changed')
        if old.get('status') == 'complete':
            require(isinstance(old.get('evidence'), dict) and
                    set(stage['outputs']) <= set(old['evidence']) and
                    str(self.run/f'{name}.attempt-{old["attempt"]}'/'process.log') in old['evidence'],
                    'incomplete resume evidence')
            require(all(Path(p).is_file() and digest(p) == h for p, h in old['evidence'].items()),
                    f'{name}: completed evidence changed')
            self.validate_command(stage)
            self.event('resume_validated', stage=name)
            return
        require(old.get('status') != 'running', f'{name}: interrupted/ambiguous process; manual reconciliation required')
        require(not old or (self.retry and stage.get('retrySafe') is True), f'{name}: explicit safe retry required')
        require(all(not Path(p).exists() for p in stage['outputs']), f'{name}: refusing to overwrite outputs')
        attempt_no = old.get('attempt', 0)+1
        attempt = self.run/f'{name}.attempt-{attempt_no}'
        attempt.mkdir()
        start = time.monotonic()
        state = dict(status='running', binding=binding, attempt=attempt_no, startedAt=time.time())
        atomic_json(status_path, state)
        self.event('step_start', stage=name, attempt=attempt_no)
        try:
            if stage.get('kind') == 'render':
                self.render(stage, attempt, start)
            else:
                p = self.launch(stage['argv'], attempt/'process.log', name)
                try:
                    self.wait([p], name, start)
                finally:
                    self.kill(p)
            log = (attempt/'process.log').read_text(errors='replace')
            require(all(text in log for text in stage.get('successContains', [])), 'missing success log marker')
            require(all(Path(p).is_file() and Path(p).stat().st_size > 0 for p in stage['outputs']), 'missing/empty output')
            self.validate_command(stage)
            evidence = {p: digest(p) for p in stage['outputs']}
            evidence.update({str(p): digest(p) for p in attempt.glob('*.log')})
            state.update(status='complete', evidence=evidence)
        except BaseException as e:
            state.update(status='failed', error=str(e))
            self.stop.set()
            raise
        finally:
            state.update(seconds=time.monotonic()-start, finishedAt=time.time())
            atomic_json(status_path, state)
            self.event('step_'+state['status'], stage=name, seconds=state['seconds'])

    def run_stages(self):
        stages = self.plan['stages']
        if self.plan.get('noOp'):
            require(not stages, 'no-op plan contains executable stages')
            self.event('no_op', oldEndBlock=self.plan['oldEndBlock'])
            return
        validate_stages(stages)
        done, pending = set(), {s['name']: s for s in stages}
        active = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            try:
                while pending or active:
                    for name, stage in list(pending.items()):
                        if set(stage.get('dependsOn', [])) <= done:
                            active[pool.submit(self.execute, stage)] = name
                            del pending[name]
                    require(active, 'unsatisfied dependencies')
                    completed, _ = concurrent.futures.wait(active, return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in completed:
                        future.result()
                        done.add(active.pop(future))
            except BaseException:
                self.stop.set()
                for future in active:
                    future.cancel()
                raise


def run_prepared(run, retry=False):
    run = Path(run).resolve()
    with (run/'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        seal = json.loads((run/'seal.json').read_text())
        require(set(seal) == {'source.json', 'render.json', 'plan.json'}, 'invalid seal')
        require(all(digest(run/p) == h for p, h in seal.items()), 'immutable manifest changed')
        plan = json.loads((run/'plan.json').read_text())
        require(plan['source']['runPath'] == str(run), 'run moved')
        for p, sha in plan.get('inputDigests', {}).items():
            require(digest(p) == sha, f'input manifest changed: {p}')
        for p, st in plan['inputStats'].items():
            now = Path(p).stat()
            require(now.st_size == st['size'] and now.st_mtime_ns == st['mtimeNs'], f'input changed: {p}')
        Runner(run, plan, retry).run_stages()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'prepare', 'run'])
    parser.add_argument('path', type=Path)
    parser.add_argument('--retry', action='store_true')
    parser.add_argument('--old-end', type=int, help='explicit verified endpoint; must agree with manifest')
    args = parser.parse_args()
    if args.command == 'run':
        require(args.old_end is None, '--old-end is only for plan/prepare')
        run_prepared(args.path, args.retry)
    else:
        source = json.loads(args.path.read_text())
        require(not source.get('unresolvedPlaceholders'), 'resolve review placeholders before plan/prepare')
        if args.old_end is not None:
            require(source['oldEndBlock'] == args.old_end, '--old-end disagrees with source manifest')
        if args.command == 'prepare':
            result = prepare(source)
        else:
            result = make_plan(source, json.loads(Path(source['config']).read_text()), ({} if source['oldEndBlock'] == source['newEndBlock'] else inspect_master(source)))
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
