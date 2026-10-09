import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('coverage_manifest', Path(__file__).parents[1]/'address_coverage_manifest.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def fixture(self, root):
        data = b''
        offsets = [0]
        for height in range(3):
            payload = bytes([height+1])*130
            data += struct.pack('<4sII', b'BLK\x02', height, len(payload))+payload
            offsets.append(len(data))
        source = root/'changes.blk1'
        source.write_bytes(data)
        raw = struct.pack('<8sQQQQ', b'BUVBIDX1', len(data), 3, 0, 0)
        raw += struct.pack('<4Q', *offsets)
        raw += struct.pack('<Q', module.fnv64(raw))
        index = root/'changes.blk1.idx'
        index.write_bytes(raw)
        return source, index

    def test_bounded_matching_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            source, index = self.fixture(Path(directory))
            result = module.make_manifest(source, index, 1, 2)
            self.assertEqual([b['height'] for b in result['blocks']], [1, 2])
            self.assertEqual(result['blocks'][0]['hash'], '02'*32)

    def test_corrupt_index_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, index = self.fixture(Path(directory))
            raw = bytearray(index.read_bytes()); raw[48] ^= 1; index.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                module.make_manifest(source, index, 0, 2)

    def test_wrong_height_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, index = self.fixture(Path(directory))
            raw = bytearray(source.read_bytes()); raw[4] = 2; source.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, 'does not match'):
                module.make_manifest(source, index, 0, 2)


if __name__ == '__main__':
    unittest.main()
