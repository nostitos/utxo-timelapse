"""Pure boundary/manifest tests and tiny synthetic subprocesses; no real media."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_update as au


class PlanningTests(unittest.TestCase):
    def source(self):
        return dict(master='/input/master.mp4', oldEndBlock=966360, newEndBlock=966420,
                    blk='/input/changes.blk', history='/input/history.bin', config='/input/config.json',
                    runPath='/fresh/run', buv='/bin/buv', repeatLastBlockTimes=300, port=12900)

    def cfg(self):
        return dict(xAxisMode='normalizedGeometric', imageWidth=3840, imageHeight=2160,
                    epochBlocks=105000, epochTransitionBlocks=120, skipBlocks=0,
                    rendererCheckpointLoad='/old/load', rendererCheckpointSave='/old/save')

    def plan(self, source=None):
        return au.make_plan(source or self.source(), self.cfg(), {'keyframes': [966300, 966360, 966420]})

    def test_measured_join_includes_last_real_keyframe(self):
        p = self.plan()
        self.assertEqual(p['joinBlock'], 966360)
        self.assertEqual(p['tailFrames'], 361)
        self.assertEqual(p['trimFrames'], 1380)
        self.assertEqual(p['nextWarm'], 965040)
        self.assertEqual(p['finalFrames'], 966721)

    def test_history_journal_path_is_explicit_not_inherited(self):
        cfg=self.cfg();cfg['historyDeltaFile']='/stale/used.delta'
        plan=au.make_plan(self.source(),cfg,{'keyframes':[966360]})
        self.assertEqual(plan['renderConfig']['historyDeltaFile'],'')
        source=self.source();source['historyDeltaFile']='/fresh/run/history.delta'
        plan=au.make_plan(source,cfg,{'keyframes':[966360]})
        self.assertEqual(plan['renderConfig']['historyDeltaFile'],'/fresh/run/history.delta')

    def test_partial_final_gop(self):
        b = au.boundaries(10009, 10050, [9960, 10020], 105000, 120, 0)
        self.assertEqual(b['joinBlock'], 9960)
        self.assertEqual(b['tailFrames'], 91)
        self.assertEqual(b['nextJoin'], 10020)

    def test_slide_adjustment(self):
        self.assertEqual(au.warm_start(106430, 105000, 120), 105000)
        self.assertEqual(au.warm_start(106500, 105000, 120), 105120)
        self.assertEqual(au.warm_start(106380, 105000, 120), 105000)

    def test_noop_ignores_commands_and_checkpoint(self):
        s = self.source()
        s['newEndBlock'] = s['oldEndBlock']
        s['commands'] = [{'name': 'publish'}]
        p = au.make_plan(s, self.cfg(), {})
        self.assertTrue(p['noOp'])
        self.assertEqual(p['stages'], [])
        self.assertEqual(p['renderConfig'], {})
        self.assertIsNone(p['nextWarm'])

    def test_invalid_ranges_and_missing_keys(self):
        for old, new, keys in [(4, 3, [0]), (-1, 3, [0]), (10000, 10001, []), (True, 2000, [0])]:
            with self.assertRaises(au.GateError):
                au.boundaries(old, new, keys, 105000, 120, 0)

    def test_optional_checkpoint_before_warm(self):
        s = self.source()
        s['rendererCheckpoint'] = {'path': '/cp/ledger', 'nextHeight': 960000}
        p = self.plan(s)
        self.assertEqual(p['renderConfig']['rendererCheckpointLoad'], '/cp/ledger')
        self.assertGreater(p['renderConfig']['startShowAtBlockHeight'], 960000)
        s['rendererCheckpoint']['nextHeight'] = 966000
        with self.assertRaises(au.GateError):
            self.plan(s)

    def test_review_bundle_wiring_without_execution(self):
        example = Path(__file__).resolve().parents[1]/'examples/append-current-20260912'
        source = json.loads((example/'source.json').read_text())
        cfg = json.loads((example/'config.json').read_text())
        self.assertTrue(source['unresolvedPlaceholders'])
        self.assertEqual(source['rendererCheckpoint'], {
            'path': '/Volumes/4T Data/buv_render/renderer_before_964980.bin', 'nextHeight': 964980})
        sync = json.loads((example/'sync.json').read_text())
        self.assertEqual(sync['nodeLock'], '/home/umbrel/buv_data/.daily-blk-update.lock')
        self.assertEqual(sync['localLock'], '/Volumes/4T Data/buv_render/.blk-append.lock')
        self.assertEqual(sync['nodeChunkManifest'], sync['nodeBlk']+'.chunks.json')
        self.assertEqual(sync['localChunkManifest'], sync['localBlk']+'.chunks.json')
        source['unresolvedPlaceholders'] = []
        source['newEndBlock'] = 966420  # Synthetic plan only; not a live target.
        plan = au.make_plan(source, cfg, {'keyframes': [966360]})
        stages = {s['name']: s for s in plan['stages']}
        self.assertEqual(stages['render']['dependsOn'], ['index'])
        self.assertEqual(stages['history']['dependsOn'], ['index'])
        self.assertEqual(stages['package']['dependsOn'], ['render', 'history'])
        self.assertIn('prepare', stages['publication_prepare']['argv'])
        self.assertNotIn('execute', stages['publication_prepare']['argv'])

    def test_unresolved_review_manifest_fails_closed(self):
        s = self.source()
        s['unresolvedPlaceholders'] = ['verified next target']
        with self.assertRaisesRegex(au.GateError, 'unresolved'):
            self.plan(s)

    def test_audio_disabled_even_when_inherited_output_is_master(self):
        source = self.source()
        cfg = self.cfg()
        cfg.update(audioEnabled=True, audioOutputFile=source['master'])
        plan = au.make_plan(source, cfg, {'keyframes': [966360]})
        self.assertIs(plan['renderConfig']['audioEnabled'], False)
        self.assertEqual(plan['renderConfig']['audioOutputFile'], '')
        self.assertTrue(cfg['audioEnabled'])  # Caller configuration is not mutated.
        self.assertEqual(cfg['audioOutputFile'], source['master'])

    def test_encoding_and_no_inherited_checkpoint(self):
        p = self.plan()
        argv = p['stages'][-1]['encoderArgv']
        for item in ('-n', 'superfast', '21', 'yuv444p', '3840x2160', '60'):
            self.assertIn(item, argv)
        self.assertNotIn('/input/master.mp4', argv)
        self.assertNotIn('rendererCheckpointLoad', p['renderConfig'])
        self.assertFalse(p['renderConfig']['allowBlkFileTruncate'])
        self.assertEqual(p['renderConfig']['rendererCheckpointSaveAtBlock'], p['nextWarm'])

    def test_dependency_cycle_and_shell_rejected(self):
        for stages in ([dict(name='x', argv='echo x', outputs=['/tmp/x'])],
                       [dict(name='x', argv=['true'], outputs=['/tmp/x'], dependsOn=['x'])],
                       [dict(name='../x', argv=['true'], outputs=['/tmp/x'])]):
            with self.assertRaises(au.GateError):
                au.validate_stages(stages)

    def test_no_input_output_collision(self):
        s = self.source()
        s['commands'] = [dict(name='bad', argv=['true'], outputs=[s['master']])]
        with self.assertRaises(au.GateError):
            self.plan(s)

    def test_closed_gop_idr_not_cra(self):
        def packet(kind):
            data = b'\0\0\0\2'+bytes([kind << 1, 1])
            return {'data': '\n00000000: '+data.hex()+'  ignored\n'}
        self.assertTrue(au.is_idr(packet(19), 4))
        self.assertTrue(au.is_idr(packet(20), 4))
        self.assertFalse(au.is_idr(packet(21), 4))

    def test_ffprobe_uses_explicit_endpoint_not_hold_subtraction(self):
        s = self.source()
        extra = bytearray(23)
        extra[0], extra[21] = 1, 3
        stream = dict(width=3840, height=2160, pix_fmt='yuv444p', r_frame_rate='60/1',
                      codec_name='hevc', start_time='0', nb_frames='999999',
                      extradata='\n00000000: '+extra.hex()+'  ignored')
        packet = dict(flags='K_', pts_time=str(966360/60), dts_time='16105.966667',
                      data='\n00000000: 000000022601  ignored')
        with patch.object(au, 'probe_json', side_effect=[{'streams': [stream]}, {'packets': [packet]}]):
            self.assertEqual(au.inspect_master(s)['keyframes'], [966360])


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name)
        self.plan = dict(source={'timeoutSeconds': 5}, warmupStart=8600, joinBlock=9980,
                         tailFrames=120, nextWarm=8720)
        self.log, self.progress = self.run/'renderer.log', self.run/'ffmpeg.progress'

    def test_latest_bounded_block_frame_speed_eta(self):
        self.log.write_text('old'*40000+'\n| block 9990, done\n| block 9999, done\n')
        self.progress.write_text('frame=1\nspeed=0.1x\nprogress=continue\nframe=60\nfps=30.0\nspeed=0.5x\nprogress=continue\n')
        result = au.progress_snapshot(self.plan, self.log, self.progress)
        self.assertEqual(result['block'], 9999)
        self.assertEqual(result['frame'], 60)
        self.assertEqual(result['speed'], .5)
        self.assertEqual(result['phase'], 'encode')
        self.assertEqual(result['etaSeconds'], 2)

    def test_missing_progress_and_unavailable_rates(self):
        self.log.write_text('| block 7000, done\n')
        self.progress.write_text('frame=0\nfps=N/A\nspeed=N/A\n')
        result = au.progress_snapshot(self.plan, self.log, self.progress)
        self.assertEqual(result['phase'], 'replay')
        self.assertIsNone(result['etaSeconds'])
        self.log.write_text('| block 8700, done\n')
        self.assertEqual(au.progress_snapshot(self.plan, self.log, self.progress)['phase'], 'warmup')

    def test_packet_probe_plus_single_decode_final_count(self):
        from unittest.mock import Mock
        import time
        attempt = self.run/'attempt'
        attempt.mkdir()
        (attempt/'process.log').write_text('Status: SUCCESS! ledger misses=0, dropped decrements=0')
        (attempt/'encoder.log').write_text('Lsize=ok')
        self.progress.write_text('progress=end\n')
        meta = dict(width=3840, height=2160, pix_fmt='yuv444p', r_frame_rate='60/1',
                    codec_name='hevc', nb_read_packets='120')
        runner = au.Runner(self.run, self.plan)
        for frame, end, passes in [(120, 'end', True), (119, 'end', False), (120, 'continue', False)]:
            (attempt/'decode.progress').write_text(f'frame={frame}\nprogress={end}\n')
            with patch.object(au, 'probe_json', return_value={'streams': [meta]}) as probe, \
                 patch.object(runner, 'launch', return_value=Mock()) as launch, \
                 patch.object(runner, 'wait'), patch.object(runner, 'kill'), \
                 patch.object(au, 'checkpoint_height', return_value=8720):
                if passes:
                    runner.verify_tail({'name': 'render'}, attempt, time.monotonic())
                else:
                    with self.assertRaises(au.GateError):
                        runner.verify_tail({'name': 'render'}, attempt, time.monotonic())
                self.assertIn('-count_packets', probe.call_args.args[0])
                self.assertNotIn('-count_frames', probe.call_args.args[0])
                self.assertEqual(launch.call_count, 1)
                self.assertIn('-xerror', launch.call_args.args[0])
                self.assertIn('-progress', launch.call_args.args[0])

    def test_progress_event_contains_measured_fields(self):
        from unittest.mock import Mock
        import time
        self.log.write_text('| block 9990, done\n')
        self.progress.write_text('frame=60\nspeed=1x\nprogress=continue\n')
        runner = au.Runner(self.run, self.plan)
        process = Mock(pid=123)
        process.poll.return_value = 0
        runner.wait([process], 'render', time.monotonic(), renderer_log=self.log, progress_file=self.progress)
        event = json.loads((self.run/'timings.jsonl').read_text().splitlines()[-1])
        self.assertEqual(event['block'], 9990)
        self.assertEqual(event['frame'], 60)
        self.assertEqual(event['etaSeconds'], 1)
        self.assertEqual(event['etaScope'], 'currentPhase')


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name)

    def stage(self, name, code, deps=(), **kw):
        return dict(name=name, argv=[sys.executable, '-c', code], dependsOn=list(deps),
                    outputs=[str(self.run/(name+'.out'))], **kw)

    def runner(self, stages, retry=False, timeout=5):
        return au.Runner(self.run, {'source': {'timeoutSeconds': timeout}, 'stages': stages}, retry)

    def status(self, name):
        return json.loads((self.run/(name+'.status.json')).read_text())

    def test_success_resume_does_not_repeat(self):
        s = self.stage('ok', "from pathlib import Path; assert not Path('ok.out').exists(); Path('ok.out').write_text('ok'); print('SUCCESS')", successContains=['SUCCESS'])
        self.runner([s]).run_stages()
        self.runner([s]).run_stages()
        self.assertEqual(self.status('ok')['attempt'], 1)
        self.assertIn('resume_validated', (self.run/'timings.jsonl').read_text())
        (self.run/'ok.out').write_text('changed')
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()

    def test_nonzero_blocks_dependents(self):
        fail = self.stage('fail', 'raise SystemExit(7)')
        later = self.stage('later', "raise Exception('should never run')", ['fail'])
        with self.assertRaises(au.GateError):
            self.runner([fail, later]).run_stages()
        self.assertEqual(self.status('fail')['status'], 'failed')
        self.assertFalse((self.run/'later.status.json').exists())

    def test_safe_explicit_retry(self):
        s = self.stage('retry', "from pathlib import Path; p=Path('once'); was=p.exists(); p.write_text('1');\nif not was: raise SystemExit(1)\nPath('retry.out').write_text('ok')", retrySafe=True)
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()
        self.runner([s], retry=True).run_stages()
        self.assertEqual(self.status('retry')['attempt'], 2)

    def test_partial_output_never_overwritten_on_retry(self):
        s = self.stage('bad', "from pathlib import Path; Path('bad.out').write_text('partial'); raise SystemExit(1)", retrySafe=True)
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()
        with self.assertRaises(au.GateError):
            self.runner([s], retry=True).run_stages()
        self.assertEqual(self.status('bad')['attempt'], 1)

    def test_timeout(self):
        s = self.stage('slow', 'import time; time.sleep(30)')
        with self.assertRaises(au.GateError):
            self.runner([s], timeout=.1).run_stages()
        self.assertEqual(self.status('slow')['status'], 'failed')

    def test_missing_success_and_output_gates(self):
        s = self.stage('missing', 'print("done")')
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()
        self.assertEqual(self.status('missing')['status'], 'failed')

    def test_ambiguous_running_not_retried(self):
        s = self.stage('x', 'pass', retrySafe=True)
        au.atomic_json(self.run/'x.status.json', dict(status='running', binding=au.hashlib.sha256(au.canonical(s)).hexdigest()))
        with self.assertRaises(au.GateError):
            self.runner([s], retry=True).run_stages()

    def test_independent_history_concurrent_then_dependent(self):
        def code(name, peer):
            return ("from pathlib import Path; import time; "
                    f"Path('{name}.started').write_text('1'); "
                    "end=time.monotonic()+3\n"
                    f"while not Path('{peer}.started').exists():\n"
                    " assert time.monotonic()<end\n time.sleep(.02)\n"
                    f"Path('{name}.out').write_text('ok')")
        a = self.stage('history', code('history', 'synthetic_render'))
        b = self.stage('synthetic_render', code('synthetic_render', 'history'))
        c = self.stage('publish', "from pathlib import Path; assert Path('history.out').exists() and Path('synthetic_render.out').exists(); Path('publish.out').write_text('ok')", ['history', 'synthetic_render'])
        self.runner([a, b, c]).run_stages()
        self.assertEqual(self.status('publish')['status'], 'complete')

    def test_resume_semantic_gate_checks_mutable_state(self):
        s = self.stage('valid', "from pathlib import Path; Path('valid.out').write_text('ok')",
                       validateArgv=[sys.executable, '-c', "from pathlib import Path; assert not Path('invalid').exists()"])
        self.runner([s]).run_stages()
        (self.run/'invalid').touch()
        with self.assertRaises(au.GateError):
            self.runner([s]).run_stages()
        self.assertEqual(self.status('valid')['attempt'], 1)

    def test_encoder_failure_never_launches_visualizer(self):
        import socket
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        s = self.stage('render', "from pathlib import Path; Path('renderer-launched').touch()",
                       kind='render', encoderArgv=[sys.executable, '-c', 'raise SystemExit(9)'])
        runner = self.runner([s])
        runner.plan['source']['port'] = port
        with self.assertRaises(au.GateError):
            runner.run_stages()
        self.assertFalse((self.run/'renderer-launched').exists())
        self.assertEqual(self.status('render')['status'], 'failed')

    def test_manifest_seal_rejects_mutation(self):
        for name in ('plan.json', 'render.json', 'source.json'):
            au.atomic_json(self.run/name, {})
        au.atomic_json(self.run/'seal.json', {name: au.digest(self.run/name) for name in ('plan.json', 'render.json', 'source.json')})
        (self.run/'render.json').write_text('changed')
        with self.assertRaises(au.GateError):
            au.run_prepared(self.run)


if __name__ == '__main__':
    unittest.main()
