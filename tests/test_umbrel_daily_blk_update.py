import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/umbrel_daily_blk_update.py'
spec = importlib.util.spec_from_file_location('daily', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DailyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg = self.root / 'config.json'
        self.cfg.write_text(json.dumps(dict(allowBlkFileTruncate=False,
                            blkFile='/buv_data/changes.blk1.v3', checkpointFile='/buv_data/checkpoint_v3.utxo')))
        self.info = dict(Config=dict(Image='buv:checkpoint-v3'),
                         HostConfig=dict(RestartPolicy=dict(Name='no')),
                         Path='/app/buv', Args=['-ns', '-tc=utxo_to_change', '-cfg=/config/config.json'],
                         Mounts=[dict(Type='bind', Source=str(self.root), Destination='/config')],
                         State=dict(Status='exited', ExitCode=0, Running=False))

    def test_safe_start_and_final_exit(self):
        with patch.object(m, 'inspect_container', return_value=self.info), patch.object(m.subprocess, 'run') as start:
            self.assertEqual(m.run(self.cfg, self.root / 'lock'), 0)
            start.assert_called_once_with(['docker', 'start', '--attach', 'buv_blk_v3'], check=True)

    def test_running_skips(self):
        self.info['State']['Running'] = True
        with patch.object(m, 'inspect_container', return_value=self.info), patch.object(m.subprocess, 'run') as start:
            m.run(self.cfg, self.root / 'lock')
            start.assert_not_called()

    def test_failure_does_not_restart(self):
        self.info['State']['ExitCode'] = 1
        with patch.object(m, 'inspect_container', return_value=self.info), patch.object(m.subprocess, 'run') as start:
            with self.assertRaises(ValueError):
                m.run(self.cfg, self.root / 'lock')
            start.assert_not_called()

    def test_truncation_and_wrong_mount_rejected(self):
        self.cfg.write_text('{"allowBlkFileTruncate": true}')
        with self.assertRaises(ValueError):
            m.check_config(self.info, self.cfg)
        self.info['Mounts'][0]['Source'] = '/elsewhere'
        with self.assertRaises(ValueError):
            m.check_config(self.info, self.cfg)

    def test_root_cron_install_once_in_fixture_only(self):
        destination = self.root / 'cron-fixture'
        original_stat = Path.stat
        def stat(path, *args, **kw):
            st = original_stat(path, *args, **kw)
            if path == destination:
                return SimpleNamespace(st_uid=0, st_mode=st.st_mode)
            return st
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'trusted_root_script'), patch.object(Path, 'stat', stat), patch.object(m.subprocess, 'run') as docker:
            self.assertEqual(m.install_root_cron(self.cfg, self.root / 'lock', destination), 0)
            content = destination.read_text()
            self.assertIn('15 3 * * * root ', content)
            self.assertNotIn('sudo', content)
            self.assertEqual(m.install_root_cron(self.cfg, self.root / 'lock', destination), 0)
            self.assertEqual(destination.read_text(), content)
            destination.write_text('unrelated cron')
            with self.assertRaisesRegex(ValueError, 'existing cron differs'):
                m.install_root_cron(self.cfg, self.root / 'lock', destination)
            docker.assert_not_called()

    def test_cron_nonroot_and_newlines_refused(self):
        with patch.object(m.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(ValueError, 'root required'):
                m.install_root_cron(self.cfg, self.root / 'lock', self.root / 'cron')
        with self.assertRaisesRegex(ValueError, 'newline'):
            m.cron_line('/tmp/a\nb', self.cfg, self.root / 'lock')

    def test_default_never_calls_docker(self):
        with patch('sys.argv', [str(SCRIPT)]), patch.object(m.subprocess, 'run') as start, patch.object(m.subprocess, 'check_output') as inspect:
            self.assertEqual(m.main(), 0)
            start.assert_not_called()
            inspect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
