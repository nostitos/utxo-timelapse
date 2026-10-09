import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/blk_chunk_hashes.py'
spec = importlib.util.spec_from_file_location('chunks', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ChunksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'blk'
        self.cache = self.root / 'cache.json'
        self.source.write_bytes(b'abcdefghijklmnopqr')

    def scan(self):
        return m.refresh(self.source, self.cache, scan=True, chunk_bytes=8)[0]

    def test_explicit_initial_scan(self):
        with self.assertRaises(FileNotFoundError):
            m.refresh(self.source, self.cache)
        self.scan()
        self.assertEqual(m.CHUNK_BYTES, 256 * 1024 * 1024)

    def test_attested_append_rehashes_partial(self):
        old = self.scan()
        with self.source.open('ab') as f:
            f.write(b'stuvwxyz012345')
        proof = dict(kind='verified-append-v1', manifest_sha256=m.digest_object(old),
                     before=old['source'], after=m.snapshot(self.source))
        with patch.object(m, 'hash_range', wraps=m.hash_range) as h:
            new, _ = m.refresh(self.source, self.cache, proof=proof)
        self.assertEqual([c.args[1] for c in h.call_args_list], [16, 24])
        self.assertEqual(new['hashes'], self.scan()['hashes'])

    def test_unattested_growth_detects_historical_corruption(self):
        old = self.scan()
        self.source.write_bytes(b'Xbcdefghijklmnopqrstuvwxyz')
        new, _ = m.refresh(self.source, self.cache)
        self.assertNotEqual(old['hashes'][0], new['hashes'][0])

    def test_same_size_change_not_trusted_even_immutable(self):
        old = self.scan()
        self.source.write_bytes(b'Xbcdefghijklmnopqr')
        new, _ = m.refresh(self.source, self.cache, immutable=True)
        self.assertNotEqual(old['hashes'][0], new['hashes'][0])

    def test_shrink_replacement_and_bad_proof(self):
        self.scan()
        with self.assertRaises(ValueError):
            m.refresh(self.source, self.cache, proof={})
        self.source.write_bytes(b'a')
        with self.assertRaises(ValueError):
            m.refresh(self.source, self.cache)
        self.scan()
        other = self.root / 'other'
        other.write_bytes(b'abc')
        other.replace(self.source)
        with self.assertRaises(ValueError):
            m.refresh(self.source, self.cache)

    def test_split_node_chunk_and_cli_corruption(self):
        self.scan()
        _, contract = m.refresh(self.source, self.cache, length=11)
        self.assertEqual(contract['hashes'][-1], hashlib.sha256(b'ijk').hexdigest())
        node = self.root / 'node'
        node.write_bytes(self.source.read_bytes() + b'longer node')
        nc = self.root / 'node.json'
        m.refresh(node, nc, scan=True, chunk_bytes=8)
        c = self.root / 'prefix.json'
        c.write_text(json.dumps(contract))
        cmd = [sys.executable, str(SCRIPT), 'verify', str(node), '--manifest', str(nc), '--contract', str(c)]
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        node.write_bytes(b'X' + node.read_bytes()[1:])
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 1)

    def test_empty_boundary_and_bounds(self):
        self.scan()
        for n in (0, 8, 16, 18):
            _, c = m.refresh(self.source, self.cache, length=n)
            m.validate_contract(c)
            self.assertEqual(len(c['hashes']), (n + 7) // 8)
        for n in (-1, 19):
            with self.assertRaises(ValueError):
                m.refresh(self.source, self.cache, length=n)

    def test_race_preserves_sidecar(self):
        self.scan()
        previous = self.cache.read_bytes()
        original = m.hash_range
        def changed(f, offset, length):
            h = original(f, offset, length)
            with self.source.open('ab') as out:
                out.write(b'!')
            return h
        with patch.object(m, 'hash_range', side_effect=changed):
            with self.assertRaises(ValueError):
                m.refresh(self.source, self.cache)
        self.assertEqual(previous, self.cache.read_bytes())

    def test_lock_serializes_cli_and_atomic_failure_preserves_cache(self):
        self.scan()
        with m.locked(self.cache):
            child = subprocess.Popen([sys.executable, str(SCRIPT), 'prefix', str(self.source),
                                      '--manifest', str(self.cache)], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.wait(timeout=0.15)
            finally:
                # Release the lock before waiting for the child below.
                pass
        stdout, stderr = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)['length'], 18)
        previous = self.cache.read_bytes()
        with patch.object(m.os, 'replace', side_effect=OSError('simulated failure')):
            with self.assertRaises(OSError):
                m.refresh(self.source, self.cache)
        self.assertEqual(previous, self.cache.read_bytes())
        self.assertEqual(list(self.root.glob('cache.json.*')), [self.root / 'cache.json.lock'])

    def test_reject_source_alias(self):
        with self.assertRaises(ValueError):
            m.refresh(self.source, self.source, scan=True)
        self.assertEqual(self.source.read_bytes(), b'abcdefghijklmnopqr')


if __name__ == '__main__':
    unittest.main()
