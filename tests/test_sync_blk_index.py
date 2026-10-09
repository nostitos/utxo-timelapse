"""BUVBIDX1 compatibility and fallback tests; no working datasets are touched."""
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import sync_blk_append as s


def record(height):
    return struct.pack('<4sII', b'BLK\2', height, 130) + bytes([height % 256]) * 32 + bytes(98)


def make_index(path, count):
    data = path.read_bytes()
    offsets = [i * 142 for i in range(count + 1)]
    identity = s.fnv64(data[-142:], s.fnv64(data[:142])) if count else s.FNV_OFFSET
    stat = os.stat(path)
    # Independent packing directly from stat, rather than index_source_stamp.
    values = [stat.st_dev, stat.st_ino, stat.st_size,
              stat.st_mtime_ns // 10**9, stat.st_mtime_ns % 10**9,
              stat.st_ctime_ns // 10**9, stat.st_ctime_ns % 10**9]
    stamp = s.fnv64(struct.pack('<7Q', *values))
    payload = b'BUVBIDX1' + struct.pack('<4Q', len(data), count, identity, stamp)
    payload += struct.pack('<' + 'Q' * len(offsets), *offsets)
    Path(str(path) + '.idx').write_bytes(payload + struct.pack('<Q', s.fnv64(payload)))


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'fixture.blk'
        self.path.write_bytes(b''.join(record(i) for i in range(5)))
        self.idx = Path(str(self.path) + '.idx')
        make_index(self.path, 5)

    def test_fnv_reference_vectors(self):
        self.assertEqual(s.fnv64(b''), 0xcbf29ce484222325)
        self.assertEqual(s.fnv64(b'a'), 0xaf63dc4c8601ec8c)
        self.assertEqual(s.fnv64(b'foobar'), 0x85944171f73967e8)

    def test_valid_index_skips_scan_preserves_files(self):
        expected = s.records(self.path)
        before = (s.chunks.snapshot(self.path), s.chunks.snapshot(self.idx))
        with patch.object(s, 'records', side_effect=AssertionError('full scan forbidden')):
            self.assertEqual(s.local_tip(self.path), expected)
        self.assertEqual(before, (s.chunks.snapshot(self.path), s.chunks.snapshot(self.idx)))

    def test_missing_or_bad_checksum_falls_back(self):
        expected = s.records(self.path)
        self.idx.unlink()
        self.assertEqual(s.local_tip(self.path), expected)
        make_index(self.path, 5)
        data = bytearray(self.idx.read_bytes())
        data[-1] ^= 1
        self.idx.write_bytes(data)
        with patch.object(s, 'records', wraps=s.records) as scan:
            self.assertEqual(s.local_tip(self.path), expected)
            scan.assert_called_once_with(self.path)

    def corrupt_field(self, offset, value):
        data = bytearray(self.idx.read_bytes())
        struct.pack_into('<Q', data, offset, value)
        struct.pack_into('<Q', data, len(data) - 8, s.fnv64(data[:-8]))
        self.idx.write_bytes(data)

    def test_rechecks_offsets_identity_stamp_count_with_valid_checksum(self):
        for offset, value in ((40 + 2 * 8, 142), (24, 0), (32, 0), (16, 2), (8, 709)):
            with self.subTest(offset=offset):
                make_index(self.path, 5)
                self.corrupt_field(offset, value)
                with self.assertRaises(ValueError):
                    s.indexed_tip(self.path)
                self.assertEqual(s.local_tip(self.path)['tip'], 4)

    def test_growth_and_same_size_rewrite_reject_stamp(self):
        with self.path.open('ab') as out:
            out.write(record(5))
        with self.assertRaises(ValueError):
            s.indexed_tip(self.path)
        self.assertEqual(s.local_tip(self.path)['tip'], 5)
        make_index(self.path, 6)
        old_time = os.stat(self.path).st_mtime_ns
        with self.path.open('r+b') as out:
            out.seek(142 + 80)
            out.write(b'!')
        os.utime(self.path, ns=(old_time, old_time))
        with self.assertRaisesRegex(ValueError, 'stamp'):
            s.indexed_tip(self.path)

    def test_boundary_framing_checked_even_valid_fingerprints(self):
        data = bytearray(self.path.read_bytes())
        struct.pack_into('<I', data, 4 * 142 + 4, 99)
        self.path.write_bytes(data)
        make_index(self.path, 5)
        with self.assertRaisesRegex(ValueError, 'boundary framing'):
            s.indexed_tip(self.path)
        with self.assertRaisesRegex(ValueError, 'noncontiguous'):
            s.local_tip(self.path)

    def test_empty_and_single_record_match_cpp_double_boundary_hash(self):
        for count in (0, 1):
            self.path.write_bytes(b''.join(record(i) for i in range(count)))
            make_index(self.path, count)
            self.assertEqual(s.indexed_tip(self.path), s.records(self.path))



if __name__ == '__main__':
    unittest.main()
