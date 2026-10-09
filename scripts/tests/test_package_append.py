import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fragment_manifest as fm
import package_append as pa
from publish_append import prepare


def producer_fixture(run, plan):
    """Produce the complete append_update receipt shape, not a tail-only stub."""
    plan['renderConfig'] = {'rendererCheckpointSave': str(run/'renderer-next.chk')}
    stage = {'name': 'render', 'kind': 'render', 'dependsOn': [], 'retrySafe': True,
             'argv': ['buv', '-cfg='+str(run/'render.json')],
             'encoderArgv': ['ffmpeg', '-crf', '21', str(run/'tail.mkv')],
             'outputs': [str(run/'tail.mkv'), str(run/'renderer-next.chk')]}
    plan['stages'] = [stage]
    (run/'renderer-next.chk').write_bytes(b'fixture-checkpoint')
    attempt = run/'render.attempt-1'
    attempt.mkdir()
    for name in ('process.log', 'encoder.log', 'decode.log'):
        (attempt/name).write_text('fixture successful process')
    fm.atomic_json(run/'source.json', plan['source'])
    fm.atomic_json(run/'render.json', plan['renderConfig'])
    fm.atomic_json(run/'plan.json', plan)
    fm.atomic_json(run/'seal.json', {name: pa.file_hash(run/name) for name in ('source.json', 'render.json', 'plan.json')})
    # Use the actual producer's serializer to detect consumer/producer drift.
    from append_update import canonical
    status = {'status': 'complete', 'attempt': 1, 'binding': hashlib.sha256(canonical(stage)).hexdigest(),
              'evidence': {p: pa.file_hash(p) for p in [*stage['outputs'], *map(str, attempt.glob('*.log'))]}}
    fm.atomic_json(run/'render.status.json', status)
    return status


class ProducerGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name)
        (self.run/'tail.mkv').write_bytes(b'same encoded tail bytes')
        self.plan = {'format': 'utxo-append-plan-v1', 'noOp': False, 'source': {'runPath': str(self.run)}}
        self.status = producer_fixture(self.run, self.plan)

    def test_copied_receipt_bad_binding_with_matching_tail(self):
        self.assertEqual(pa.verified_producer(self.run/'plan.json'), self.plan)
        # New sealed plan at the same paths, but a different real producer stage.
        # Keep the old complete receipt AND all output bytes/checkpoint/log hashes.
        self.plan['stages'][0]['encoderArgv'][2] = '22'
        fm.atomic_json(self.run/'plan.json', self.plan)
        seal = json.loads((self.run/'seal.json').read_text())
        seal['plan.json'] = pa.file_hash(self.run/'plan.json')
        fm.atomic_json(self.run/'seal.json', seal)
        self.assertEqual(pa.file_hash(self.run/'tail.mkv'), self.status['evidence'][str(self.run/'tail.mkv')])
        spec = {'preparedManifest': str(self.run/'plan.json'), 'previousManifest': str(self.run/'unused.json'),
                'oldInit': str(self.run/'unused.mp4'), 'destination': str(self.run/'must-not-exist')}
        with patch.object(pa.subprocess, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'producer binding mismatch'):
                pa.package(spec)
            command.assert_not_called()
        self.assertFalse(Path(spec['destination']).exists())

    def test_render_seal_rejects_config_mutation(self):
        (self.run/'render.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'seal mismatch: render.json'):
            pa.verified_producer(self.run/'plan.json')

    def test_missing_checkpoint_or_process_log_evidence(self):
        for path in (self.run/'renderer-next.chk', self.run/'render.attempt-1/process.log'):
            status = json.loads(json.dumps(self.status))
            del status['evidence'][str(path)]
            fm.atomic_json(self.run/'render.status.json', status)
            with self.assertRaisesRegex(ValueError, 'incomplete render evidence'):
                pa.verified_producer(self.run/'plan.json')

    def test_changed_checkpoint_and_log_rejected(self):
        for path in (self.run/'renderer-next.chk', self.run/'render.attempt-1/process.log'):
            original = path.read_bytes()
            path.write_bytes(b'copied from another run')
            with self.assertRaisesRegex(ValueError, 'evidence digest mismatch'):
                pa.verified_producer(self.run/'plan.json')
            path.write_bytes(original)



@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class PackageTest(unittest.TestCase):
    def test_real_hevc_short_splice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run = root/'run'; run.mkdir()
            master = root/'master.mp4'
            tail = run/'tail.mkv'
            def command(argv):
                subprocess.run(argv, capture_output=True, check=True)
            for output, count, color in ((master, 840, 'red'), (tail, 781, 'blue')):
                command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'color={color}:size=64x48:rate=60',
                         '-frames:v', str(count), '-an', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p',
                         '-x265-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:bframes=2:pools=1:frame-threads=1:log-level=error',
                         *(['-tag:v', 'hvc1', '-video_track_timescale', '16000'] if output == master else []), str(output)])
            hls = root/'hls'; hls.mkdir()
            command(['ffmpeg', '-v', 'error', '-i', str(master), '-c', 'copy', '-f', 'hls', '-hls_time', '10',
                     '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod', '-hls_segment_options', 'video_track_timescale=16000',
                     '-hls_segment_filename', str(hls/'segment_%05d.m4s'), str(hls/'old.m3u8')])
            files = sorted(hls.glob('*.m4s'))
            self.assertEqual(len(files), 2)
            fm.append(root/'old-ledger', init=(hls/'init.mp4').read_bytes(), timescale=16000, expected_count=0,
                      fragments=[(files[0].read_bytes(), 160000), (files[1].read_bytes(), 64000)])
            prepare(root/'old-ledger', root/'old-publication', object_prefix='hls/old')
            previous = root/'old-publication/segments.json'
            plan = {'format': 'utxo-append-plan-v1', 'noOp': False, 'joinBlock': 720, 'tailFrames': 781, 'finalFrames': 1501,
                    'source': {'master': str(master), 'runPath': str(run)},
                    'inputStats': {str(master): {'size': master.stat().st_size, 'mtimeNs': master.stat().st_mtime_ns}}}
            producer_status = producer_fixture(run, plan)
            spec = {'preparedManifest': str(run/'plan.json'), 'previousManifest': str(previous),
                    'previousSHA256': pa.file_hash(previous), 'oldInit': str(hls/'init.mp4'),
                    'destination': str(root/'package')}
            original_master = pa.file_hash(master)
            old_files = {e['file'] for e in json.loads(previous.read_text())['segments']}
            original_open = Path.open
            def guarded(path, *args, **kwargs):
                if path.name in old_files:
                    raise AssertionError('old immutable fragment read')
                return original_open(path, *args, **kwargs)
            with patch.object(Path, 'open', guarded):
                receipt = pa.package(spec, fixture_dimensions=(64, 48))
            self.assertEqual(receipt['previewFrames'], 901)
            self.assertEqual(receipt['layout']['retainedCount'], 1)
            self.assertFalse(receipt['fullMasterRewritten'])
            self.assertEqual(pa.file_hash(master), original_master)
            new = fm.verify(root/'package/ledger', previous=fm.load_previous(previous, pa.file_hash(previous)))
            self.assertEqual(new['segments'][0]['uri'], json.loads(previous.read_text())['segments'][0]['uri'])
            self.assertEqual(new['segments'][1]['startTicks'], 160000)
            prepare(root/'package/ledger', root/'publication', object_prefix='hls/new',
                    previous=fm.load_previous(previous, pa.file_hash(previous)))
            commands = json.loads((root/'package/commands.json').read_text())
            self.assertTrue(all(isinstance(c, list) for c in commands))
            # No FFmpeg full-master input: master only occurs inside bounded ffconcat.
            self.assertFalse(any(c[0] == 'ffmpeg' and str(master) in c for c in commands))
            concat = (root/'package/splice.ffconcat').read_text()
            self.assertIn('inpoint 10.000000000', concat)
            self.assertIn('duration 2.000000000', concat)
            self.assertNotIn('outpoint 12.000000000', concat)  # B-frame exclusive DTS differs.
            self.assertEqual(len(new['segments']), 3)  # retained + full replacement + partial
            self.assertLessEqual(abs(receipt['durationTicks']-1501*16000/60), receipt['durationToleranceTicks'])
            # Changed parameter sets must fail before any branch ledger exists.
            incompatible = dict(spec, destination=str(root/'bad-parameters'))
            real_sets = pa.parameter_sets
            calls = [0]
            def different(data):
                calls[0] += 1
                result = real_sets(data)
                if calls[0] == 3:
                    result[34] = ['mismatched PPS']
                return result
            with patch.object(pa, 'parameter_sets', different):
                with self.assertRaisesRegex(ValueError, 'VPS/SPS/PPS differ'):
                    pa.package(incompatible, fixture_dimensions=(64, 48))
            self.assertFalse((root/'bad-parameters/ledger/segments.json').exists())
            # No stale "complete" receipt may authorize a changed tail.
            producer_status['evidence'][str(tail)] = '0'*64
            fm.atomic_json(run/'render.status.json', producer_status)
            with self.assertRaisesRegex(ValueError, 'evidence digest mismatch'):
                pa.package(dict(spec, destination=str(root/'bad-tail')), fixture_dimensions=(64, 48))
            self.assertFalse((root/'bad-tail').exists())


if __name__ == '__main__':
    unittest.main()
