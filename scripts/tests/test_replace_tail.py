import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fragment_manifest as fm
from publish_append import prepare
from test_fragment_publication import fragment


class ReplaceTailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        source = self.root/'source'
        # Two complete ten-second fragments, one partial fragment, one old endcap.
        fm.append(source, init=b'init', timescale=1000, expected_count=0,
                  fragments=[(fragment(0, 1), 10000), (fragment(10000, 2), 10000),
                             (fragment(20000, 3), 5000), (fragment(25000, 4), 1000)])
        prepare(source, self.root/'published', object_prefix='hls/old')
        self.parent = self.root/'published/segments.json'
        self.parent_bytes = self.parent.read_bytes()
        self.pin = hashlib.sha256(self.parent_bytes).hexdigest()
        self.previous = fm.load_previous(self.parent, self.pin)
        self.branch = self.root/'branch'

    def replace(self, **kw):
        options = dict(previous_path=self.parent, expected_parent_sha256=self.pin, retained_count=2,
                       fragments=[(fragment(0, 1), 10000), (fragment(10000, 2), 1000)],
                       rebase_to_boundary=True)
        options.update(kw)
        return fm.replace_tail(self.branch, **options)

    def test_plan_inside_last_segment_and_boundary(self):
        plan = fm.plan_tail(self.previous, join_frame=1440, segment_frames=600, fps_num=60)
        self.assertEqual(plan['retainedCount'], 2)
        self.assertEqual(plan['packageStartFrame'], 1200)
        self.assertEqual(plan['oldTailFrames'], 240)
        self.assertEqual(plan['offsetTicks'], 20000)
        self.assertEqual(plan['firstSequence'], 3)
        boundary = fm.plan_tail(self.previous, join_frame=1200, segment_frames=600, fps_num=60)
        self.assertEqual(boundary['oldTailFrames'], 0)
        with self.assertRaises(ValueError):
            fm.plan_tail(self.previous, join_frame=1561, segment_frames=600, fps_num=60)

    def test_replacement_no_historical_reads_and_publication(self):
        forbidden = {e['file'] for e in [self.previous['init'], *self.previous['segments']]}
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path.name in forbidden:
                raise AssertionError('historical media accessed')
            return original(path, *args, **kwargs)
        # New payload must differ from discarded partial segment to make an
        # unequivocal new object; same timing header alone could otherwise match.
        new = fragment(0, 1).replace(b'encoded-media', b'replace-media')
        with patch.object(Path, 'open', guarded):
            ledger = self.replace(fragments=[(new, 10000), (fragment(10000, 2), 1000)])
            fm.verify(self.branch, previous=self.previous)
            plan = prepare(self.branch, self.root/'stage', object_prefix='hls/new', previous=self.previous)
        self.assertEqual(self.parent.read_bytes(), self.parent_bytes)
        self.assertEqual(ledger['parentHash'], fm.manifest_hash(self.previous))
        self.assertEqual(ledger['parentManifestSHA256'], self.pin)
        self.assertEqual(ledger['segments'][:2], self.previous['segments'][:2])
        self.assertEqual([e['startTicks'] for e in ledger['segments']], [0, 10000, 20000, 30000])
        self.assertEqual(len(plan['objects']), 2)
        self.assertEqual(len(plan['retained']), 3)  # init and first two fragments
        playlist = (self.root/'stage/media.m3u8').read_text()
        self.assertNotIn(self.previous['segments'][2]['uri'], playlist)
        self.assertNotIn(self.previous['segments'][3]['uri'], playlist)
        self.assertIn(self.previous['segments'][1]['uri'], playlist)

    def test_failed_commit_leaves_old_manifest_and_safe_retry(self):
        with patch.object(fm.os, 'replace', side_effect=OSError('commit failed')):
            with self.assertRaises(OSError): self.replace()
        self.assertEqual(self.parent.read_bytes(), self.parent_bytes)
        self.assertFalse((self.branch/'segments.json').exists())
        self.replace()
        with self.assertRaises(FileExistsError): self.replace()

    def test_stale_parent_empty_replacement_and_inner_join_rejected(self):
        for args in ({'expected_parent_sha256': '0'*64}, {'retained_count': 5}, {'retained_count': True},
                     {'fragments': []},
                     {'fragments': [(fragment(24000, 3), 1000)], 'rebase_to_boundary': False}):
            with self.assertRaises(ValueError): self.replace(**args)
        self.assertEqual(self.parent.read_bytes(), self.parent_bytes)
        self.assertFalse((self.branch/'segments.json').exists())

    def test_parent_changed_while_generating(self):
        def fragments():
            self.parent.write_bytes(self.parent_bytes+b' ')
            yield fragment(0, 1), 1000
        with self.assertRaisesRegex(ValueError, 'parent manifest changed'):
            self.replace(fragments=fragments())
        self.assertFalse((self.branch/'segments.json').exists())

    def test_replacement_parent_binding_and_second_generation(self):
        self.replace()
        prepare(self.branch, self.root/'stage', object_prefix='hls/new', previous=self.previous)
        staged_path = self.root/'stage/segments.json'
        staged = fm.load_previous(staged_path, hashlib.sha256(staged_path.read_bytes()).hexdigest())
        other = copy.deepcopy(self.previous)
        other['segments'][-1]['durationTicks'] += 1
        with self.assertRaisesRegex(ValueError, 'parent hash'):
            fm.verify(self.branch, previous=other)
        # A subsequent append of this branch trusts all its now-published media.
        fm.append(self.root/'next', init=b'init', timescale=1000, expected_count=4, previous=staged,
                  fragments=[(fragment(31000, 5), 1000)])
        self.assertEqual(len(fm.verify(self.root/'next', previous=staged)['segments']), 5)
        # A branch of a branch binds the direct parent, not its grandparent.
        second = fm.replace_tail(self.root/'second', previous_path=staged_path,
                                 expected_parent_sha256=hashlib.sha256(staged_path.read_bytes()).hexdigest(),
                                 retained_count=3, fragments=[(fragment(0, 1), 2000)], rebase_to_boundary=True)
        self.assertEqual(second['parentHash'], fm.manifest_hash(staged))
        fm.verify(self.root/'second', previous=staged)

    def test_retain_zero_and_full_prefix(self):
        zero = self.replace(retained_count=0)
        self.assertEqual(zero['segments'][0]['startTicks'], 0)
        full = fm.replace_tail(self.root/'full', previous_path=self.parent, expected_parent_sha256=self.pin,
                               retained_count=4, fragments=[(fragment(), 1000)], rebase_to_boundary=True)
        self.assertEqual(full['segments'][-1]['startTicks'], 26000)

    def test_command_manifest(self):
        fragment_path = self.root/'replacement.m4s'
        fragment_path.write_bytes(fragment())
        spec = {'previousPath': str(self.parent), 'expectedParentSHA256': self.pin,
                'destination': str(self.branch), 'retainedCount': 2, 'rebaseToBoundary': True,
                'fragments': [{'path': str(fragment_path), 'sha256': hashlib.sha256(fragment_path.read_bytes()).hexdigest(),
                               'durationTicks': 10000}]}
        path = self.root/'replace.json'
        path.write_text(json.dumps(spec))
        result = fm.replace_tail_from_manifest(path)
        self.assertEqual(len(result['segments']), 3)
        self.assertEqual(result['segments'][-1]['startTicks'], 20000)


if __name__ == '__main__':
    unittest.main()
