import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import sync_blk_append as s
import blk_chunk_hashes as h


def record(height):
    return struct.pack('<4sII', b'BLK\2', height, 130) + bytes([height % 256]) * 32 + bytes(98)


class FixtureRemote:
    def __init__(self, c):
        self.c = c
        self.actions = []
        self.corrupt = False

    def call(self, request, output=None):
        self.actions.append(request['action'])
        with patch.object(s, 'idle'):
            if output is not None and self.corrupt:
                buf = io.BytesIO()
                s.remote_op(self.c, request, buf)
                data = buf.getvalue()
                output.write(b'X' + data[1:])
                return None
            return s.remote_op(self.c, request, output)


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.c = dict(sshHost='fixture', nodeContainer='buv_blk_v3')
        for key in ('nodeBlk', 'nodeCheckpoint', 'nodeChunkManifest', 'nodeLock',
                    'localBlk', 'localChunkManifest', 'localLock', 'runDir'):
            self.c[key] = str(self.root / key)
        Path(self.c['localBlk']).write_bytes(record(0) + record(1))
        Path(self.c['nodeBlk']).write_bytes(record(0) + record(1) + record(2) + b'uncheckpointed tail')
        for key in ('nodeLock', 'localLock'):
            Path(self.c[key]).touch()
        self.checkpoint(2)
        for side in ('local', 'node'):
            h.refresh(self.c[side + 'Blk'], self.c[side + 'ChunkManifest'], scan=True, chunk_bytes=256)
        self.remote = FixtureRemote(self.c)

    def checkpoint(self, tip):
        Path(self.c['nodeCheckpoint']).write_bytes(struct.pack('<4sIQQ32s', b'UTX3', tip,
                                    (tip + 1) * 142, tip * 142, bytes([tip]) * 32))

    def prepare(self):
        return s.prepare(self.c, self.remote)

    def test_prepare_readonly_then_bounded_append(self):
        keys = ('nodeBlk', 'nodeCheckpoint', 'localBlk', 'localChunkManifest', 'nodeChunkManifest')
        before = {k: (Path(self.c[k]).read_bytes(), h.snapshot(self.c[k])) for k in keys}
        p = self.prepare()
        for k in keys:
            self.assertEqual(before[k], (Path(self.c[k]).read_bytes(), h.snapshot(self.c[k])))
        self.assertEqual(Path(self.c['runDir'], 'suffix.blk').read_bytes(), record(2))
        result = s.apply(self.c['runDir'], self.remote)
        self.assertEqual(result['nextTip'], 2)
        self.assertEqual(result['nextBytes'], 426)
        self.assertEqual(Path(self.c['localBlk']).read_bytes(), record(0) + record(1) + record(2))
        self.assertTrue(Path(self.c['runDir'], 'local-append-proof.json').exists())
        self.assertEqual(s.read_json(self.c['localChunkManifest'])['source'], h.snapshot(self.c['localBlk']))
        with self.assertRaisesRegex(ValueError, 'already applied'):
            s.apply(self.c['runDir'], self.remote)

    def test_prepare_index_avoids_history_scan(self):
        from test_sync_blk_index import make_index
        make_index(Path(self.c['localBlk']), 2)
        original = s.records
        def only_suffix(path, *args, **kwargs):
            if Path(path) == Path(self.c['localBlk']):
                raise AssertionError('historical header scan must not run')
            return original(path, *args, **kwargs)
        with patch.object(s, 'records', side_effect=only_suffix):
            plan = self.prepare()
        self.assertEqual(plan['oldTip'], 1)

    def test_corrupt_download_does_not_append(self):
        self.remote.corrupt = True
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            self.prepare()
        self.assertEqual(Path(self.c['localBlk']).read_bytes(), record(0) + record(1))
        self.assertFalse(Path(self.c['runDir'], 'plan.json').exists())

    def test_local_rewrite_after_prepare_refused(self):
        self.prepare()
        local = Path(self.c['localBlk'])
        local.write_bytes(b'X' + local.read_bytes()[1:])
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            s.apply(self.c['runDir'], self.remote)
        self.assertEqual(local.stat().st_size, 284)

    def test_node_rewrite_after_prepare_refused(self):
        self.prepare()
        node = Path(self.c['nodeBlk'])
        node.write_bytes(b'X' + node.read_bytes()[1:])
        with self.assertRaisesRegex(ValueError, 'snapshot changed'):
            s.apply(self.c['runDir'], self.remote)
        self.assertEqual(Path(self.c['localBlk']).stat().st_size, 284)

    def test_stale_cached_prefix_rewrite_refused(self):
        node = Path(self.c['nodeBlk'])
        data = bytearray(node.read_bytes())
        data[80] = 99
        node.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'prefix mismatch'):
            self.prepare()

    def test_noop(self):
        self.checkpoint(1)
        p = self.prepare()
        self.assertEqual(Path(self.c['runDir'], 'suffix.blk').stat().st_size, 0)
        before = h.snapshot(self.c['localBlk'])
        r = s.apply(self.c['runDir'], self.remote)
        self.assertEqual(r['status'], 'noop')
        self.assertEqual(before, h.snapshot(self.c['localBlk']))

    def test_corrupt_suffix_after_prepare_refused(self):
        self.prepare()
        Path(self.c['runDir'], 'suffix.blk').write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError, 'length mismatch'):
            s.apply(self.c['runDir'], self.remote)
        self.assertEqual(Path(self.c['localBlk']).stat().st_size, 284)

    def test_invalid_checkpoint_and_noncontiguous_records(self):
        self.checkpoint(5)
        with self.assertRaisesRegex(ValueError, 'target bound'):
            self.prepare()
        bad = self.root / 'bad'
        bad.write_bytes(record(2) + record(4))
        with self.assertRaisesRegex(ValueError, 'noncontiguous'):
            s.records(bad, 2)
        bad.write_bytes(record(2)[:-1])
        with self.assertRaisesRegex(ValueError, 'truncated'):
            s.records(bad, 2)

    def test_checkpoint_tail_hash_error(self):
        cp = Path(self.c['nodeCheckpoint'])
        cp.write_bytes(cp.read_bytes()[:-1] + b'X')
        with self.assertRaisesRegex(ValueError, 'checkpoint does not match'):
            self.prepare()

    def test_dry_run_no_writes_or_subprocess(self):
        manifest = self.root / 'input.json'
        manifest.write_text(json.dumps(self.c))
        with patch.object(sys, 'argv', ['sync', 'dry-run', '--manifest', str(manifest)]), patch.object(s.subprocess, 'run') as run:
            self.assertEqual(s.main(), 0)
            run.assert_not_called()
        self.assertFalse(Path(self.c['runDir']).exists())

    def test_transport_prefixes_stdin_and_no_credentials(self):
        self.c.update(sshArgv=['sshpass', '-e', 'ssh'],
                      remotePythonArgv=['sudo', '-n', 'python3', '-'])
        with patch.object(s.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{}', b'')) as run:
            s.SSHRemote(self.c).call(dict(action='check'))
        self.assertEqual(run.call_args.args[0], ['sshpass', '-e', 'ssh', 'fixture', 'sudo -n python3 -'])
        self.assertIn(b'remote_op', run.call_args.kwargs['input'])
        self.assertNotIn('env', run.call_args.kwargs)

    def test_sudo_password_stdin_only(self):
        self.c.update(remoteSudoPasswordEnv='SYNC_TEST_SUDO',
                      remotePythonArgv=['sudo', '-S', '-p', '', 'python3', '-'])
        s.validate_input(self.c)
        secret = 'fixture-only-password'
        with patch.dict(os.environ, {'SYNC_TEST_SUDO': secret}), patch.object(s.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{}', b'')) as run:
            s.SSHRemote(self.c).call(dict(action='check'))
        argv = run.call_args.args[0]
        payload = run.call_args.kwargs['input']
        first, code = payload.split(b'\n', 1)
        self.assertEqual(first, secret.encode())
        self.assertEqual(argv[-1], "sudo -k -S -p '' python3 -")
        self.assertNotIn(secret, repr(argv))
        self.assertNotIn(secret.encode(), code)
        self.assertNotIn(secret, json.dumps(self.c))
        compile(code, '<remote-test>', 'exec')

    def test_missing_invalid_password_rejected_before_ssh(self):
        self.c.update(remoteSudoPasswordEnv='SYNC_TEST_SUDO',
                      remotePythonArgv=['sudo', '-S', '-p', '', 'python3', '-'])
        for value in (None, '', 'bad\nline', 'bad\rline'):
            env = {} if value is None else {'SYNC_TEST_SUDO': value}
            with patch.dict(os.environ, env, clear=True), patch.object(s.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'environment value'):
                    s.SSHRemote(self.c).call(dict(action='check'))
                run.assert_not_called()

    def test_password_mode_requires_sudo_and_valid_env_name(self):
        self.c['remoteSudoPasswordEnv'] = 'SYNC_TEST_SUDO'
        with self.assertRaisesRegex(ValueError, 'requires sudo'):
            s.validate_input(self.c)
        self.c['remoteSudoPasswordEnv'] = 'not a variable'
        with self.assertRaisesRegex(ValueError, 'variable name'):
            s.validate_input(self.c)

    def test_sudo_failure_does_not_echo_stderr_secret(self):
        self.c.update(remoteSudoPasswordEnv='SYNC_TEST_SUDO',
                      remotePythonArgv=['sudo', '-S', '-p', '', 'python3', '-'])
        with patch.dict(os.environ, {'SYNC_TEST_SUDO': 'fixture-secret'}), patch.object(s.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'fixture-secret')):
            with self.assertRaises(ValueError) as error:
                s.SSHRemote(self.c).call(dict(action='check'))
        self.assertEqual(str(error.exception), 'remote operation failed (exit 1)')

    def test_idle_privileged_inspect(self):
        self.c['nodeInspectArgv'] = ['sudo', '-n', 'docker', 'inspect']
        data = json.dumps([dict(State=dict(Status='exited', ExitCode=0))]).encode()
        with patch.object(s.subprocess, 'check_output', return_value=data) as inspect:
            s.idle(self.c)
        self.assertEqual(inspect.call_args.args[0], ['sudo', '-n', 'docker', 'inspect', 'buv_blk_v3'])
        with patch.object(s.subprocess, 'check_output', return_value=b'[{"State":{"Running":true}}]'):
            with self.assertRaisesRegex(ValueError, 'idle'):
                s.idle(self.c)


if __name__ == '__main__':
    unittest.main()
