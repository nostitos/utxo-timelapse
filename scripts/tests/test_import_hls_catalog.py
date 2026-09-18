import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import import_hls_catalog as catalog
import fragment_manifest as fm
from test_fragment_publication import box


def init_bytes():
    tkhd = box(b'tkhd', b'\0'*12+struct.pack('>I', 1))
    mdia = box(b'mdia', box(b'mdhd', b'\0'*12+struct.pack('>I', 1000))+
               box(b'hdlr', b'\0'*8+b'vide'))
    trex = box(b'trex', struct.pack('>6I', 0, 1, 1, 1000, 4, 0))
    return box(b'ftyp', b'isom')+box(b'moov', box(b'trak', tkhd+mdia)+box(b'mvex', trex))


def fragment(start=0, seq=1, payload=b'abcd'):
    tfhd = box(b'tfhd', struct.pack('>2I', 0x020000, 1))
    tfdt = box(b'tfdt', struct.pack('>IQ', 0x01000000, start))
    trun = box(b'trun', struct.pack('>2I', 0, 1))
    return box(b'moof', box(b'mfhd', struct.pack('>2I', 0, seq))+box(b'traf', tfhd+tfdt+trun))+box(b'mdat', payload)


class FakeHTTP:
    def __init__(self, objects):
        self.objects = objects
        self.calls = []
        self.reads = {}
        self.etags = {}

    def __call__(self, request, timeout):
        url, method = request.full_url, request.get_method()
        self.calls.append((method, url))
        body = self.objects[url]
        etag = self.etags.get(url, '"'+hashlib.md5(body).hexdigest()+'"')
        if request.get_header('If-match'):
            assert request.get_header('If-match') == etag
        owner = self
        class Response(io.BytesIO):
            status = 200
            headers = {'Content-Length': str(len(body)), 'ETag': etag}
            def geturl(self): return url
            def read(self, size=-1):
                if size < 0: raise AssertionError('unbounded network read')
                data = super().read(size)
                owner.reads[url] = owner.reads.get(url, 0)+len(data)
                return data
        return Response(b'' if method == 'HEAD' else body)


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.url = 'https://example.test/hls/v1/media.m3u8'
        self.playlist = b'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.000000,\na.m4s\n#EXTINF:1.000000,\nb.m4s\n#EXT-X-ENDLIST\n'
        self.path = self.root/'media.m3u8'; self.path.write_bytes(self.playlist)
        base = self.url.rsplit('/', 1)[0]+'/'
        self.objects = {self.url: self.playlist, base+'init.mp4': init_bytes(),
                        base+'a.m4s': fragment(), base+'b.m4s': fragment(1000, 2)}
        self.spec = {'playlistPath': str(self.path), 'playlistURL': self.url,
                     'playlistSHA256': catalog.digest(self.playlist), 'destination': str(self.root/'out')}

    def test_remote_bytes_read_once_no_fragments_saved(self):
        fake = FakeHTTP(self.objects)
        result = catalog.bootstrap(self.spec, opener=fake)
        ledger = fm.load_previous(self.root/'out/segments.json', result['segmentsSHA256'])
        for entry in [ledger['init'], *ledger['segments']]:
            self.assertEqual(entry['sha256'], catalog.digest(self.objects[entry['uri']]))
            self.assertEqual(fake.reads[entry['uri']], len(self.objects[entry['uri']]))
        self.assertEqual(len(list((self.root/'out').glob('*.m4s'))), 0)
        self.assertEqual(ledger['segments'][1]['startTicks'], 1000)
        self.assertEqual(ledger['segments'][0]['payloadSHA256'], [catalog.digest(b'abcd')])
        self.assertTrue(all(method in ('GET', 'HEAD') for method, _ in fake.calls))
        # The resulting catalog is immediately usable as a remote-only parent.
        fm.replace_tail(self.root/'branch', previous_path=self.root/'out/segments.json',
                        expected_parent_sha256=result['segmentsSHA256'], retained_count=1,
                        fragments=[(fragment(), 1000)], rebase_to_boundary=True)
        fm.verify(self.root/'branch', previous=ledger)

    def test_cached_bytes_bound_to_actual_head(self):
        local = {}
        for i, (uri, body) in enumerate(self.objects.items()):
            if uri == self.url: continue
            path = self.root/f'cache-{i}'; path.write_bytes(body); local[uri] = str(path)
        fake = FakeHTTP(self.objects)
        catalog.bootstrap(dict(self.spec, localObjects=local), opener=fake)
        self.assertFalse(any(method == 'GET' and uri != self.url for method, uri in fake.calls))
        for name in local.values():
            if Path(name).read_bytes() == fragment():
                Path(name).write_bytes(fragment(payload=b'xxxx'))
                break
        with self.assertRaisesRegex(ValueError, 'cached bytes do not match'):
            catalog.bootstrap(dict(self.spec, localObjects=local, destination=str(self.root/'bad')), opener=fake)
        self.assertFalse((self.root/'bad').exists())

    def test_discontinuity_and_wrong_playlist_pin_refused_offline(self):
        with self.assertRaises(ValueError): catalog.inventory(dict(self.spec, playlistSHA256='0'*64))
        for tag in (b'#EXT-X-DISCONTINUITY\n', b'#EXT-X-BYTERANGE:4\n', b'#EXT-X-KEY:METHOD=AES-128\n'):
            raw = self.playlist.replace(b'#EXTINF:', tag+b'#EXTINF:', 1)
            self.path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                catalog.inventory(dict(self.spec, playlistSHA256=catalog.digest(raw)))

    def test_no_commit_on_remote_drift_or_timeline_gap(self):
        changed = dict(self.objects); changed[self.url] += b' '
        with self.assertRaisesRegex(ValueError, 'remote playlist changed'):
            catalog.bootstrap(self.spec, opener=FakeHTTP(changed))
        changed = dict(self.objects)
        uri = next(k for k in changed if k.endswith('b.m4s'))
        changed[uri] = fragment(1500, 2)
        with self.assertRaisesRegex(ValueError, 'timeline'):
            catalog.bootstrap(self.spec, opener=FakeHTTP(changed))
        self.assertFalse((self.root/'out').exists())

    def test_truncation_and_sample_sizes(self):
        metadata = catalog.scan(io.BytesIO(init_bytes()), len(init_bytes()))['initMetadata']
        for body in (fragment()[:-1], fragment(payload=b'abcde')):
            with self.assertRaises(ValueError): catalog.scan(io.BytesIO(body), len(body), init=metadata)

    def test_existing_output_preserved(self):
        out = self.root/'out'; out.mkdir(); (out/'keep').write_text('original')
        fake = FakeHTTP(self.objects)
        with self.assertRaises(ValueError): catalog.bootstrap(self.spec, opener=fake)
        self.assertEqual(fake.calls, [])
        self.assertEqual((out/'keep').read_text(), 'original')

    def test_multipart_remote_hashed_not_invented(self):
        fake = FakeHTTP(self.objects)
        uri = next(u for u in self.objects if u.endswith('a.m4s'))
        fake.etags[uri] = '"multipart-2"'
        result = catalog.bootstrap(self.spec, opener=fake)
        ledger = fm.load_previous(self.root/'out/segments.json', result['segmentsSHA256'])
        self.assertEqual(ledger['segments'][0]['sha256'], catalog.digest(self.objects[uri]))

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_real_fragment_duration_parser(self):
        hls = self.root/'real'; hls.mkdir()
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=2',
                        '-an', '-c:v', 'libx264', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4',
                        '-hls_playlist_type', 'vod', str(hls/'media.m3u8')], capture_output=True, check=True)
        raw = (hls/'media.m3u8').read_bytes()
        objects = {self.url.rsplit('/', 1)[0]+'/'+p.name: p.read_bytes() for p in hls.iterdir()}
        result = catalog.bootstrap(dict(self.spec, playlistPath=str(hls/'media.m3u8'), playlistSHA256=catalog.digest(raw)), opener=FakeHTTP(objects))
        ledger = fm.load_previous(self.root/'out/segments.json', result['segmentsSHA256'])
        self.assertEqual(len(ledger['segments']), 2)
        self.assertEqual(sum(e['durationTicks'] for e in ledger['segments']), 2*ledger['timescale'])


if __name__ == '__main__': unittest.main()
