import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import landscape_r2_publish as pub
import landscape_r2_verify as verify

sha = lambda b: hashlib.sha256(b).hexdigest()
OLD, NEW = 'landscape/d1-20260101', 'landscape/d2-20260102'
FILES = {'snapshots/0000000.bin': b'a' * 10, 'snapshots/0000005.bin': b'b' * 7, 'chunks/00001.bin': b'c' * 5, 'chunks/00002.bin': b'd' * 4}


class FakeS3:
    def __init__(self, objects):
        self.objects, self.puts, self.copies = objects, [], []

    def get_paginator(self, _):
        s3 = self
        class Pages:
            def paginate(self, Bucket, Prefix):
                yield {'Contents': [{'Key': k, 'Size': len(v), 'ETag': '"%s"' % hashlib.md5(v).hexdigest()}
                                    for k, v in sorted(s3.objects.items()) if k.startswith(Prefix)]}
        return Pages()

    def put_object(self, Bucket, Key, Body, IfNoneMatch, **_):
        assert IfNoneMatch == '*' and Key not in self.objects, Key
        self.objects[Key] = Body.read(); self.puts.append(Key)

    def copy_object(self, Bucket, Key, CopySource, **_):
        self.objects[Key] = self.objects[CopySource['Key']]; self.copies.append(Key)
        return {'CopyObjectResult': {'ETag': '"%s"' % hashlib.md5(self.objects[Key]).hexdigest()}}


def dataset(root, skip=(), delta=True):
    for rel, b in FILES.items():
        if rel not in skip:
            (root / rel).parent.mkdir(parents=True, exist_ok=True); (root / rel).write_bytes(b)
    entry = lambda rel: {'file': rel, 'sha256': sha(FILES[rel]), 'bytes': len(FILES[rel])}
    (root / 'manifest.json').write_text(json.dumps({'snapshots': [entry(r) for r in FILES if r.startswith('snapshots/')]}))
    (root / 'chunks.json').write_text(json.dumps({'chunks': [entry(r) for r in FILES if r.startswith('chunks/')]}))
    (root / 'rows.bin').write_bytes(b'r'); (root / 'blocktimes.bin').write_bytes(b't')
    if delta:  # datasets built since November 2026
        (root / 'blocktimes-delta.bin').write_bytes(b'u')


def run(s3, *argv):
    with patch.object(pub.boto3, 'client', return_value=s3), patch.object(pub, 'load_credentials', return_value=('k', 's')), \
         patch.object(sys, 'argv', ['landscape_r2_publish.py', *map(str, argv)]):
        pub.main()


class PublishTest(unittest.TestCase):
    def test_stores_only_new_content_and_the_manifest_last(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); dataset(root, skip={'chunks/00002.bin'})
            s3 = FakeS3({pub.BLOBS + sha(FILES['snapshots/0000000.bin']): FILES['snapshots/0000000.bin'],
                         OLD + '/chunks/00002.bin': FILES['chunks/00002.bin']})
            run(s3, root, '--prefix', NEW, '--copy-from', OLD)
            for rel, b in FILES.items():
                self.assertEqual(s3.objects[pub.BLOBS + sha(b)], b, rel)
            self.assertEqual(sorted(s3.puts[:2]), sorted(pub.BLOBS + sha(FILES[r]) for r in ('snapshots/0000005.bin', 'chunks/00001.bin')))
            self.assertEqual(s3.puts[2:], [NEW + '/' + r for r in pub.META])
            self.assertEqual(s3.copies, [pub.BLOBS + sha(FILES['chunks/00002.bin'])])
            self.assertFalse(any(k.startswith(NEW + '/snapshots') or k.startswith(NEW + '/chunks/') for k in s3.objects))
            s3.puts.clear(); s3.copies.clear()
            run(s3, root, '--prefix', NEW, '--copy-from', OLD)
            self.assertEqual((s3.puts, s3.copies), ([], []), 'a rerun stores nothing')
            creds = Path(d) / '.creds'; creds.write_text('[default]\naws_access_key_id = k\naws_secret_access_key = s\n')
            (root / 'chunks/00002.bin').write_bytes(FILES['chunks/00002.bin'])
            check = lambda: verify.main()
            with patch.object(verify.boto3, 'client', return_value=s3), \
                 patch.object(sys, 'argv', ['landscape_r2_verify.py', str(root), '--prefix', NEW, '--credentials', str(creds)]):
                self.assertEqual(check(), 0)
                s3.objects[NEW + '/chunks/00001.bin'] = FILES['chunks/00001.bin']
                self.assertEqual(check(), 1, 'an old per-dataset copy is reported')

    def test_refuses_a_file_that_does_not_match_its_hash(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); dataset(root); (root / 'chunks/00001.bin').write_bytes(b'x' * 5)
            s3 = FakeS3({})
            with self.assertRaises(SystemExit):
                run(s3, root, '--prefix', NEW)
            self.assertNotIn(pub.BLOBS + sha(FILES['chunks/00001.bin']), s3.objects)
            self.assertFalse(any(k.endswith('manifest.json') for k in s3.objects))

    def test_an_older_dataset_without_delta_block_times_publishes_and_verifies(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); dataset(root, delta=False)
            s3 = FakeS3({})
            run(s3, root, '--prefix', NEW)
            self.assertEqual([k for k in s3.puts if k.startswith(NEW + '/')],
                             [NEW + '/' + r for r in pub.META if r != 'blocktimes-delta.bin'])
            creds = Path(d) / '.creds'; creds.write_text('[default]\naws_access_key_id = k\naws_secret_access_key = s\n')
            with patch.object(verify.boto3, 'client', return_value=s3), \
                 patch.object(sys, 'argv', ['landscape_r2_verify.py', str(root), '--prefix', NEW, '--credentials', str(creds)]):
                self.assertEqual(verify.main(), 0)


if __name__ == '__main__':
    unittest.main()
