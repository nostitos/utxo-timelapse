import json
from pathlib import Path
import struct
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fragment_manifest as fm
from publish_append import prepare


def box(kind, body):
    return struct.pack('>I4s', len(body)+8, kind)+body


def fragment(ticks=0, seq=1, version=1, scale=1000):
    timing = bytes([version, 0, 0, 0])+ticks.to_bytes(8 if version else 4, 'big')
    index = bytes([version, 0, 0, 0])+struct.pack('>II', 1, scale)+ticks.to_bytes(8 if version else 4, 'big')
    return box(b'sidx', index)+box(b'moof', box(b'mfhd', b'\0'*4+struct.pack('>I', seq))+box(b'traf', box(b'tfdt', timing)))+box(b'mdat', b'encoded-media\x00\xff')


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'ledger'

    def append(self, data=None, count=0):
        return fm.append(self.root, init=b'init', fragments=[(data or fragment(), 1000)], timescale=1000, expected_count=count)

    def test_rebase_preserves_payload_and_timestamp_versions(self):
        for version in (0, 1):
            data = fragment(version=version)
            result = fm.rebase(data, ticks=3000, sequence_offset=3, timescale=1000)
            meta = fm.inspect(result)
            self.assertEqual(meta['decodeTimes'], [3000])
            self.assertEqual(meta['sequences'], [4])
            self.assertEqual(meta['indexes'], [(1000, 3000)])
            self.assertEqual(meta['payloadSHA256'], fm.inspect(data)['payloadSHA256'])
            self.assertEqual(len(data), len(result))

    def test_invalid_timing_and_boxes(self):
        for data in (b'x', struct.pack('>I4s', 100, b'mdat'), fragment()[:-1]):
            with self.assertRaises(ValueError): fm.inspect(data)
        for ticks, scale in ((-1, 1000), (2**32, 1000), (0, 90000)):
            with self.assertRaises(ValueError):
                fm.rebase(fragment(version=0), ticks=ticks, sequence_offset=0, timescale=scale)

    def test_append_and_stage(self):
        first = self.append()
        original = (self.root/first['segments'][0]['file']).read_bytes()
        self.append(fragment(1000, 2), 1)
        ledger = fm.verify(self.root)
        self.assertEqual(len(ledger['segments']), 2)
        self.assertEqual((self.root/first['segments'][0]['file']).read_bytes(), original)
        dest = Path(self.tmp.name)/'stage'
        plan = prepare(self.root, dest, object_prefix='hls/test')
        self.assertFalse(plan['deploymentPerformed'])
        self.assertEqual((dest/'media.m3u8').read_text().count('#EXTINF:'), 2)
        fm.verify(dest)
        with self.assertRaises(FileExistsError): prepare(self.root, dest, object_prefix='hls/test')

    def test_rollback_and_retry(self):
        self.append()
        before = (self.root/'segments.json').read_bytes()
        with patch.object(fm.os, 'replace', side_effect=OSError('commit failure')):
            with self.assertRaises(OSError): self.append(fragment(1000, 2), 1)
        self.assertEqual((self.root/'segments.json').read_bytes(), before)
        fm.verify(self.root)
        self.append(fragment(1000, 2), 1)
        self.assertEqual(len(fm.verify(self.root)['segments']), 2)

    def test_reject_stale_gap_and_corruption(self):
        ledger = self.append()
        for data, count in ((fragment(1000, 2), 0), (fragment(2000, 2), 1), (fragment(1000, 3), 1)):
            with self.assertRaises(ValueError): self.append(data, count)
        p = self.root/ledger['segments'][0]['file']
        p.write_bytes(p.read_bytes()+b'corruption')
        with self.assertRaises(ValueError): fm.verify(self.root)
        with self.assertRaises(ValueError): prepare(self.root, Path(self.tmp.name)/'bad', object_prefix='hls/test')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_media_payload_and_packet_timestamps(self):
        work = Path(self.tmp.name)/'media'
        work.mkdir()
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'color=size=32x32:rate=10:duration=1', '-an', '-c:v', 'libx264',
                        '-bf', '0', '-g', '10', '-f', 'hls', '-hls_segment_type', 'fmp4',
                        '-hls_time', '1', str(work/'test.m3u8')], check=True, capture_output=True)
        data = next(work.glob('*.m4s')).read_bytes()
        init = (work/'init.mp4').read_bytes()
        original = work/'original.mp4'
        original.write_bytes(init+data)
        def probe(path):
            result = subprocess.run(['ffprobe', '-v', 'error', '-show_packets',
                                     '-show_streams', '-of', 'json', str(path)],
                                    check=True, capture_output=True, text=True)
            return json.loads(result.stdout)
        before = probe(original)
        numerator, scale = map(int, before['streams'][0]['time_base'].split('/'))
        self.assertEqual(numerator, 1)
        shifted = fm.rebase(data, ticks=scale, sequence_offset=1, timescale=scale)
        after_path = work/'after.mp4'
        after_path.write_bytes(init+shifted)
        after = probe(after_path)
        self.assertEqual(len(before['packets']), 10)
        self.assertEqual(len(after['packets']), 10)
        for a, b in zip(before['packets'], after['packets']):
            self.assertEqual(int(b['dts'])-int(a['dts']), scale)
            self.assertEqual(int(b['pts'])-int(a['pts']), scale)
            self.assertEqual(a['size'], b['size'])
        self.assertEqual(fm.inspect(data)['payloadSHA256'], fm.inspect(shifted)['payloadSHA256'])
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(after_path), '-f', 'null', '-'],
                       check=True, capture_output=True)

    def test_init_mismatch(self):
        self.append()
        with self.assertRaises(ValueError):
            fm.append(self.root, init=b'other', fragments=[], timescale=1000, expected_count=1)


if __name__ == '__main__':
    unittest.main()
