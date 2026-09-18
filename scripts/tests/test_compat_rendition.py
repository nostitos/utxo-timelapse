import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compat_rendition as cr
import fragment_manifest as fm
from publish_append import prepare


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class RealRenditionTest(unittest.TestCase):
    def test_build_and_append_keep_grid_and_replace_old_ending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def source(name, count):
                p = root/name
                subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i',
                    'testsrc2=size=384x216:rate=60','-frames:v',str(count),'-c:v',
                    'libx264','-preset','ultrafast','-bf','0',str(p)],check=True)
                return p
            def spec(src, count, name):
                return dict(source=str(src),sourceSHA256=cr.digest(src),frameCount=count,destination=str(root/name))
            old_source=source('old.mp4',600)
            old=spec(old_source,600,'old-run')
            receipt=cr.execute(old,fixture_dimensions=(256,144))
            self.assertEqual(receipt['segmentCount'],3)
            self.assertEqual(cr.verify(root/'old-run')['codecs'],'avc1.640033')
            prepare(root/'old-run/ledger',root/'published',object_prefix='hls/compat1')
            previous_path=root/'published/segments.json'
            previous=json.loads(previous_path.read_text())
            new_source=source('new.mp4',720)
            new=spec(new_source,720,'new-run')
            new.update(previousManifest=str(previous_path),previousSHA256=cr.digest(previous_path),
                       previousInit=str(root/'published'/previous['init']['file']),joinFrame=500)
            receipt=cr.execute(new,fixture_dimensions=(256,144))
            self.assertEqual(receipt['startFrame'],480)
            self.assertEqual(receipt['encodedFrames'],240)
            ledger=json.loads((root/'new-run/ledger/segments.json').read_text())
            self.assertEqual(ledger['segments'][:2],previous['segments'][:2])
            self.assertEqual(ledger['segments'][2]['startTicks'],480*256)
            self.assertEqual(sum(e['durationTicks'] for e in ledger['segments']),720*256)
            cr.verify(root/'new-run')
            prepare(root/'new-run/ledger',root/'new-stage',object_prefix='hls/compat2',previous=previous)
            playlist=(root/'new-stage/media.m3u8').read_text()
            self.assertIn('/hls/compat1/',playlist)
            self.assertIn('/hls/compat2/',playlist)
            self.assertTrue(playlist.endswith('#EXT-X-ENDLIST\n'))
            # Same frame from the two independently encoded ranges still aligns.
            # Count alone would not catch seeking to the wrong GOP.
            def decoded_first(path):
                return subprocess.check_output(['ffmpeg','-nostdin','-v','error','-i',str(path),
                    '-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'])
            expected=root/'expected.mp4'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-ss','8','-i',str(new_source),
                '-frames:v','1','-vf',cr.downscale(256,144),'-c:v','libx264','-crf','0',str(expected)],check=True)
            actual=decoded_first(root/'new-run/encode/media.m3u8')
            target=decoded_first(expected)
            self.assertEqual(len(actual),len(target))
            self.assertLess(sum(abs(a-b) for a,b in zip(actual,target))/len(actual),12)
            with self.assertRaisesRegex(ValueError,'fresh destination'):
                cr.execute(old,fixture_dimensions=(256,144))
            bad=dict(old,destination=str(root/'bad'),sourceSHA256='0'*64)
            with self.assertRaisesRegex(ValueError,'SHA256 mismatch'):
                cr.execute(bad,fixture_dimensions=(256,144))
            self.assertFalse((root/'bad').exists())
            (root/'new-run/command.json').write_text('[]')
            with self.assertRaisesRegex(ValueError,'receipt mismatch'):
                cr.verify(root/'new-run')


if __name__ == '__main__':
    unittest.main()
