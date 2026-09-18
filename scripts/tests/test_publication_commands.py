import argparse
import ast
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fragment_manifest as fm
import publication_commands as pc
from publish_append import prepare
from test_fragment_publication import fragment


class Missing(Exception):
    response = {'ResponseMetadata': {'HTTPStatusCode': 404}}


class FakeClient:
    def __init__(self):
        self.data = {}
        self.puts = []
        self.heads = []
        self.active = self.maximum = 0
        self.lock = threading.Lock()

    def head_object(self, Bucket, Key):
        self.heads.append(Key)
        if Key not in self.data:
            raise Missing()
        body, meta = self.data[Key]
        return {'ContentLength': len(body), 'ETag': hashlib.md5(body).hexdigest(), 'Metadata': meta}

    def put_object(self, **kw):
        assert kw['IfNoneMatch'] == '*'
        with self.lock:
            self.active += 1
            self.maximum = max(self.maximum, self.active)
        try:
            time.sleep(.005)
            self.data[kw['Key']] = (kw['Body'], kw['Metadata'])
            self.puts.append(kw['Key'])
        finally:
            with self.lock:
                self.active -= 1


def checks(version):
    return [{'kind': 'info', 'url': 'https://example.test/api/info', 'expected': {'version': version}},
            {'kind': 'range', 'url': 'https://example.test/video', 'start': 1, 'end': 3,
             'total': 5, 'sha256': hashlib.sha256(b'abc').hexdigest()}]


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'source'
        self.config = {'endpoint': 'https://example.test', 'credentials': str(self.root/'credentials'),
                       'bucket': 'test', 'info': {'version': 'new'},
                       'release': {'version': 'new', 'sitePrefix': 'site/new'},
                       'deploy': [{'argv': ['fake-deploy', '{release}'], 'cwd': str(self.root)}],
                       'rollback': [{'argv': ['fake-rollback', 'old'], 'cwd': str(self.root)}],
                       'beforeChecks': checks('old'), 'afterChecks': checks('new'),
                       'rollbackChecks': checks('old')}

    def stage(self, count=1):
        fm.append(self.source, init=b'init', fragments=[(fragment(n*1000, n+1), 1000) for n in range(count)],
                  timescale=1000, expected_count=0)
        prepare(self.source, self.root/'stage', object_prefix='hls/new', execution=self.config)
        return self.root/'stage/publication.json'

    def execute(self, manifest, **kwargs):
        return pc.execute_publication(manifest, expected_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(), **kwargs)

    def test_retained_media_never_read_or_uploaded(self):
        old = fm.append(self.source, init=b'init', fragments=[(fragment(), 1000)], timescale=1000, expected_count=0)
        prepare(self.source, self.root/'old', object_prefix='hls/old')
        path = self.root/'old/segments.json'
        previous = fm.load_previous(path, hashlib.sha256(path.read_bytes()).hexdigest())
        # All historical files absent: metadata remains sufficient.
        for entry in [old['init'], *old['segments']]:
            (self.source/entry['file']).unlink()
        forbidden = {entry['file'] for entry in [old['init'], *old['segments']]}
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path.name in forbidden:
                raise AssertionError('historical read: '+str(path))
            return original(path, *args, **kwargs)
        with patch.object(Path, 'open', guarded):
            fm.append(self.source, init=b'init', fragments=[(fragment(1000, 2), 1000)],
                      timescale=1000, expected_count=1, previous=previous)
            plan = prepare(self.source, self.root/'stage', object_prefix='hls/new', previous=previous, execution=self.config)
            client = FakeClient()
            self.execute(self.root/'stage/publication.json', client=client, checker=lambda _: None, runner=lambda *_: None)
        self.assertEqual(len(plan['retained']), 2)
        self.assertFalse(any('/old/' in k for k in client.heads+client.puts))
        self.assertIn('/hls/old/', (self.root/'stage/media.m3u8').read_text())
        self.assertEqual(len(list((self.root/'stage').glob('*.m4s'))), 1)

    def test_concurrency_and_success(self):
        path = self.stage(12)
        client = FakeClient()
        actions = []
        result = self.execute(path, client=client, checker=lambda _: None, runner=lambda c, r: actions.append(c))
        self.assertEqual(result['phase'], 'verified')
        self.assertLessEqual(client.maximum, 5)
        self.assertGreater(client.maximum, 1)
        self.assertEqual(client.puts[-1], 'hls/new/media.m3u8')
        self.assertEqual(actions, [self.config['deploy']])

    def test_deploy_failure_rolls_back(self):
        path = self.stage()
        actions, observed = [], []
        def run(commands, root):
            actions.append(commands)
            if commands == self.config['deploy']:
                raise RuntimeError('partial deployment')
        with self.assertRaisesRegex(RuntimeError, 'partial deployment'):
            self.execute(path, client=FakeClient(), checker=observed.append, runner=run)
        self.assertEqual(actions, [self.config['deploy'], self.config['rollback']])
        self.assertEqual(observed[-1], self.config['rollbackChecks'])
        self.assertEqual(json.loads((path.parent/'execution-state.json').read_text())['phase'], 'rolled_back')

    def test_verification_failure_and_rollback_failure_record_both(self):
        path = self.stage()
        def check(c):
            if c == self.config['afterChecks']:
                raise ValueError('wrong public version')
        def run(c, r):
            if c == self.config['rollback']:
                raise RuntimeError('rollback command failed')
        with self.assertRaisesRegex(RuntimeError, 'wrong public version.*rollback command failed'):
            self.execute(path, client=FakeClient(), checker=check, runner=run)
        state = json.loads((path.parent/'execution-state.json').read_text())
        self.assertEqual(state['phase'], 'rollback_failed')
        result = pc.recover_publication(path, expected_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                                        checker=lambda _: None, runner=lambda *_: None)
        self.assertEqual(result['phase'], 'rolled_back')

    def test_upload_failure_does_not_deploy_or_rollback(self):
        path = self.stage()
        client = FakeClient()
        with patch.object(client, 'put_object', side_effect=RuntimeError('upload failed')):
            with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                self.execute(path, client=client, checker=lambda _: None, runner=lambda *_: self.fail('command ran'))

    def test_reject_invalid_schema_and_baseline(self):
        for change in ({'workers': 6}, {'deploy': [{'argv': 'shell command', 'cwd': str(self.root)}]},
                       {'afterChecks': []}):
            with self.assertRaises(ValueError): pc.validate_execution(dict(self.config, **change))
        path = self.stage()
        with self.assertRaises(ValueError): fm.load_previous(path, '0'*64)
        with self.assertRaises(ValueError):
            pc.execute_publication(path, expected_sha256='0'*64, client=FakeClient())

    def test_changed_retained_metadata_rejected(self):
        self.stage()
        ledger = json.loads((self.root/'stage/segments.json').read_text())
        changed = copy.deepcopy(ledger)
        changed['segments'][0]['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'retained entry changed'):
            fm.retained_entries(changed, ledger)
        changed = copy.deepcopy(ledger)
        changed['segments'][0]['uri'] = '/different/object'
        with self.assertRaisesRegex(ValueError, 'retained entry changed'):
            fm.retained_entries(changed, ledger)

    def test_corrupt_staged_payload_fails_before_network(self):
        path = self.stage()
        (path.parent/'info.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.execute(path, client=FakeClient(), checker=lambda _: self.fail('network check ran'),
                         runner=lambda *_: self.fail('command ran'))

    def test_after_checks_failure_rolls_back_and_verifies_old_release(self):
        path = self.stage()
        observed, actions = [], []
        def checker(c):
            observed.append(c)
            if c == self.config['afterChecks']:
                raise ValueError('range failed')
        with self.assertRaisesRegex(ValueError, 'range failed'):
            self.execute(path, client=FakeClient(), checker=checker, runner=lambda c, r: actions.append(c))
        self.assertEqual(actions, [self.config['deploy'], self.config['rollback']])
        self.assertEqual(observed[-1], self.config['rollbackChecks'])

    def test_command_argv_no_shell(self):
        with patch.object(pc.subprocess, 'run') as run:
            pc.run_commands([{'argv': ['echo', 'a; false', '{release}'], 'cwd': str(self.root)}], self.root)
        self.assertEqual(run.call_args.args[0], ['echo', 'a; false', str(self.root/'release.json')])
        self.assertIs(run.call_args.kwargs['shell'], False)

    def test_two_renditions_upload_before_single_deploy(self):
        fm.append(self.root/'compat', init=b'avc-init', fragments=[(fragment(), 1000)],
                  timescale=1000, expected_count=0)
        prepare(self.root/'compat',self.root/'compat-stage',object_prefix='hls/compat1')
        extra=self.root/'compat-stage/publication.json'
        self.config['additionalStages']=[{'manifest':str(extra),'sha256':hashlib.sha256(extra.read_bytes()).hexdigest()}]
        path=self.stage()
        client=FakeClient()
        def run(*_):
            self.assertIn('hls/compat1/media.m3u8',client.puts)
            self.assertIn('hls/new/media.m3u8',client.puts)
        self.execute(path,client=client,checker=lambda _:None,runner=run)
        self.assertTrue(all(k.endswith('media.m3u8') for k in client.puts[-2:]))

    def test_changed_additional_manifest_fails_before_network(self):
        extra=self.root/'extra.json';extra.write_text('{}')
        self.config['additionalStages']=[{'manifest':str(extra),'sha256':'0'*64}]
        path=self.stage()
        with self.assertRaisesRegex(ValueError,'additional stage manifest digest'):
            self.execute(path,client=FakeClient(),checker=lambda _:self.fail('network before verification'))

    def test_changed_cutoff_requires_both_renditions(self):
        self.config['info'].update(fps=1, videoFrameCount=2, videoRenditions={
            'full': {'url':'/hls/new/media.m3u8'}, 'compat': {'url':'/hls/compat1/media.m3u8'}})
        self.config['beforeChecks'][0]['expected']['videoFrameCount']=1
        path=self.stage(2)
        with self.assertRaisesRegex(ValueError,'requires every rendition'):
            self.execute(path,client=FakeClient(),checker=lambda _:self.fail('network before timeline check'))

    def test_wrong_rendition_duration_rejected_even_with_valid_object_hashes(self):
        self.config['info'].update(fps=1,videoFrameCount=2,videoRenditions={
            'compat': {'url':'/hls/new/media.m3u8'}})
        self.config['beforeChecks'][0]['expected']['videoFrameCount']=2
        path=self.stage(1)
        with self.assertRaisesRegex(ValueError,'timeline mismatch'):
            self.execute(path,client=FakeClient(),checker=lambda _:self.fail('network before timeline check'))

    def test_immutable_conflict_not_replaced(self):
        client = FakeClient()
        entry = {'key': 'new/test', 'file': 'x.json', 'sha256': hashlib.sha256(b'new').hexdigest()}
        client.data['new/test'] = (b'old', {})
        with self.assertRaises(ValueError): pc.upload_immutable(client, 'test', entry, b'new')
        self.assertEqual(client.puts, [])

    def test_public_checks_exact(self):
        class Response(io.BytesIO):
            def geturl(self): return self.url
        def opener(request, timeout):
            is_range = request.get_header('Range') is not None
            response = Response(b'abc' if is_range else b'{"version":"old"}')
            response.url = request.full_url
            response.status = 206 if is_range else 200
            response.headers = {'Content-Range': 'bytes 1-3/5'}
            return response
        pc.check_public(checks('old'), opener=opener)
        with self.assertRaisesRegex(ValueError, 'info mismatch'):
            pc.check_public(checks('new'), opener=opener)
        changed = checks('old'); changed[0]['expectedHeaders'] = {'X-Worker-Version': 'expected-release'}
        with self.assertRaisesRegex(ValueError, 'public header mismatch'):
            pc.check_public(changed, opener=opener)
        bad = checks('old'); bad[1]['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'payload mismatch'):
            pc.check_public(bad, opener=opener)



if __name__ == '__main__':
    unittest.main()
