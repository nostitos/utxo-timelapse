import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history_delta_publish as p
from r2_publish_history_delta import make_patch


def records(blocks):
    # Repeated amounts exercise stable ordering, not amount-based identity.
    return p.np.array([(h,p.UNSPENT,s) for h in range(blocks)
                       for s in (100,100,500000000,10**10,10**13)], dtype=p.RECORD_DTYPE)


def write_history(path, recs, blocks, token=b'\0'*16):
    times = p.np.arange(1500000000,1500000000+blocks,dtype='<u4')
    idx = p.np.searchsorted(recs['creationHeight'],p.np.arange(blocks+1)).astype('<u8')
    hdr = p.HISTORY_HEADER.pack(b'BUVHIST1',blocks,len(recs),64+len(recs)*16,
                               64+len(recs)*16+blocks*4,64,token)
    path.write_bytes(hdr+recs.tobytes()+times.tobytes()+idx.tobytes())
    return p.History(path)


def write_journal(path, before, after):
    old = before.records
    changed = p.np.flatnonzero(old['spendHeight'] != after.records[:before.count]['spendHeight'])
    spends = p.np.empty(len(changed),dtype=p.SPEND_DTYPE)
    spends['id'] = changed
    for field in ['creationHeight','spendHeight','satoshi']:
        spends[field] = after.records[changed][field]
    body = (b'BUVDLT01'+before.header+after.header+struct.pack('<QQ',len(changed),123)+bytes(32)+
            spends.tobytes()+after.records[before.count:].tobytes()+after.times.tobytes()+after.index.tobytes())
    path.write_bytes(body+hashlib.sha256(body).digest())


class DeltaPublisherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.objects = p.Objects(self.root/'objects')
        self.cache = self.root/'positions'
        self.base_records = records(1025)
        self.base_records[0]['spendHeight'] = 1024
        self.before = write_history(self.root/'before.bin',self.base_records,1025)
        seed = dict(historyHeader=self.before.header.hex(),geometry=p.GEOMETRY,shards={})
        for n in range(3):
            body,_ = p.build_shard(self.before.records,self.before.index,n,512,1025,p.ROWS)
            tip = 1023 if n<2 else 1024
            base = bytearray(body)
            view = p.np.frombuffer(base,p.RECORD_DTYPE,offset=32+(p.ROWS+1)*8)
            mask = (view['spendHeight']>tip)&(view['spendHeight']!=p.UNSPENT)
            view['spendHeight'][mask] = p.UNSPENT
            key=f'explorer/base/shards/{n:05d}.bin'
            desc=dict(baseKey=key,baseEtag=p.md5(base),baseTip=tip)
            p.immutable(self.objects.path(key),base)
            patch_body=make_patch(body,tip,desc['baseEtag'])
            if patch_body:
                pk=f'explorer/previous/spends/{n:05d}.bin';p.immutable(self.objects.path(pk),patch_body)
                desc.update(patchKey=pk,patchEtag=p.md5(patch_body))
            seed['shards'][str(n)]=desc
        self.seed=seed
        p.bootstrap(self.before.path,seed,self.cache,self.objects,self.root/'catalog.json',workers=2)
        self.catalog=json.loads((self.root/'catalog.json').read_text())
        recs=records(1030);recs[:len(self.base_records)]=self.base_records
        recs[1]['spendHeight']=1025 # duplicate-amount identity, distinct from prior spent index 0
        recs[1024*5+1]['spendHeight']=1026 # old record in partial tail shard
        recs[1027*5]['spendHeight']=1027 # same-block new creation/spend
        self.after=write_history(self.root/'after.bin',recs,1030,b'a'*16)
        self.journal=self.root/'delta.bin';write_journal(self.journal,self.before,self.after)

    def stage(self, **kw):
        args=dict(history_path=self.after.path,journal_path=self.journal,catalog=self.catalog,
                  objects=self.objects,cache=self.cache,output=self.root/'staged',prefix='explorer/next')
        args.update(kw);return p.stage(**args)

    def test_matches_legacy_without_building_old_shards(self):
        real=p.build_shard
        with patch.object(p,'build_shard',wraps=real) as build:
            result=self.stage()
        self.assertEqual([c.args[2] for c in build.call_args_list],[2])
        self.assertEqual(result['scannedHistoricalShards'],0)
        self.assertEqual(result['patchedShards'],[0]);self.assertEqual(result['rebuiltShards'],[2])
        staged=self.root/'staged'
        body,_=real(self.after.records,self.after.index,0,512,1030,p.ROWS)
        expected=make_patch(body,1023,self.seed['shards']['0']['baseEtag'])
        self.assertEqual((staged/'objects/explorer/next/spends/00000.bin').read_bytes(),expected)
        full,_=real(self.after.records,self.after.index,2,512,1030,p.ROWS)
        self.assertEqual((staged/'objects/explorer/next/shards/00002.bin').read_bytes(),full)
        cat=json.loads((staged/'catalog.json').read_text())
        self.assertEqual(cat['shards']['1'],self.catalog['shards']['1'])
        self.assertEqual(cat['historyHeader'],self.after.header.hex())

    def test_second_update_merges_one_patch_and_reuses_prior_objects(self):
        first=self.stage()
        for a in first['artifacts']:p.immutable(self.objects.path(a['key']),Path(a['path']).read_bytes())
        catalog=json.loads((self.root/'staged/catalog.json').read_text())
        recs=records(1032);recs[:self.after.count]=self.after.records
        recs[2]['spendHeight']=1031
        after2=write_history(self.root/'after2.bin',recs,1032,b'b'*16)
        journal2=self.root/'delta2.bin';write_journal(journal2,self.after,after2)
        self.stage(history_path=after2.path,journal_path=journal2,catalog=catalog,output=self.root/'staged2',prefix='explorer/next2')
        body,_=p.build_shard(after2.records,after2.index,0,512,1032,p.ROWS)
        self.assertEqual((self.root/'staged2/objects/explorer/next2/spends/00000.bin').read_bytes(),
                         make_patch(body,1023,self.seed['shards']['0']['baseEtag']))

    def test_bad_journal_checksum(self):
        data=bytearray(self.journal.read_bytes());data[-1]^=1;self.journal.write_bytes(data)
        with self.assertRaisesRegex(ValueError,'checksum'):self.stage()
        self.assertFalse((self.root/'staged').exists())

    def test_wrong_catalog_lineage(self):
        self.catalog['historyHeader']=self.after.header.hex()
        with self.assertRaisesRegex(ValueError,'last catalog'):self.stage()

    def test_uncommitted_journal(self):
        with self.assertRaisesRegex(ValueError,'not committed'):self.stage(history_path=self.before.path)

    def test_missing_shard(self):
        del self.catalog['shards']['1']
        with self.assertRaisesRegex(ValueError,'incomplete'):self.stage()

    def test_changed_cache_is_rejected(self):
        f=Path(self.catalog['shards']['0']['mapping']['path']);d=bytearray(f.read_bytes());d[-1]^=1;f.write_bytes(d)
        with self.assertRaisesRegex(ValueError,'cache changed'):self.stage()

    def test_corrupt_previous_patch_is_rejected(self):
        f=self.objects.path(self.catalog['shards']['0']['patchKey']);d=bytearray(f.read_bytes());d[-1]^=1;f.write_bytes(d)
        with self.assertRaisesRegex(ValueError,'checksum'):self.stage()

    def test_no_overwrite(self):
        self.stage()
        with self.assertRaisesRegex(ValueError,'already exists'):self.stage()

    def test_wrong_geometry(self):
        self.catalog['geometry']='different'
        with self.assertRaisesRegex(ValueError,'unsupported'):self.stage()

    def test_old_prefix_rejected(self):
        with self.assertRaisesRegex(ValueError,'fresh'):self.stage(prefix='explorer/base')

    def test_bootstrap_wrong_base(self):
        seed=copy.deepcopy(self.seed);seed['shards']['0']['baseEtag']='wrong'
        with self.assertRaisesRegex(ValueError,'base shard differs'):
            p.bootstrap(self.before.path,seed,self.cache,self.objects,self.root/'bad-catalog.json')

    def test_duplicate_journal_ids(self):
        data=bytearray(self.journal.read_bytes());data[208:232]=data[184:208]
        data[-32:]=hashlib.sha256(data[:-32]).digest();self.journal.write_bytes(data)
        with self.assertRaisesRegex(ValueError,'duplicate'):self.stage()

    def test_zero_new_records(self):
        recs=self.base_records.copy();recs[1]['spendHeight']=1025
        after=write_history(self.root/'no-creations.bin',recs,1026,b'c'*16)
        journal=self.root/'no-creations.delta';write_journal(journal,self.before,after)
        result=self.stage(history_path=after.path,journal_path=journal)
        self.assertEqual(result['newRecords'],0)

    def test_exact_shard_boundary(self):
        recs=records(1536);recs[:self.before.count]=self.before.records
        after=write_history(self.root/'boundary.bin',recs,1536,b'd'*16)
        journal=self.root/'boundary.delta';write_journal(journal,self.before,after)
        result=self.stage(history_path=after.path,journal_path=journal)
        self.assertEqual(result['rebuiltShards'],[2])

    def test_prepare_clears_stale_journal(self):
        config=self.root/'config.json';config.write_text(json.dumps(dict(blkFile='/input/changes.blk',historyDeltaFile='/old/used.delta')))
        result=p.prepare_update(config,self.before.path,self.root/'catalog.json',self.root/'next-run')
        cfg=json.loads(Path(result['config']).read_text())
        self.assertEqual(cfg['historyDeltaFile'],str((self.root/'next-run/history.delta').resolve()))
        self.assertFalse(cfg['allowBlkFileTruncate'])
        with self.assertRaisesRegex(ValueError,'exists'):
            p.prepare_update(config,self.before.path,self.root/'catalog.json',self.root/'next-run')

    def test_upload_is_conditional_and_idempotent(self):
        self.stage()
        class Error(Exception):
            def __init__(self,status): self.response={'ResponseMetadata':{'HTTPStatusCode':status}}
        class S3:
            class exceptions: ClientError=Error
            def __init__(self):self.data={};self.puts=0
            def head_object(self,**kw):
                if kw['Key'] not in self.data:raise Error(404)
                data=self.data[kw['Key']]
                return {'ETag':p.md5(data),'ContentLength':len(data)}
            def put_object(self,**kw):
                assert kw['IfNoneMatch']=='*'
                if kw['Key'] in self.data:raise Error(412)
                self.data[kw['Key']]=kw['Body'];self.puts+=1
                return {'ETag':p.md5(kw['Body'])}
        s3=S3();staged=self.root/'staged/staged.json'
        p.upload(staged,s3,2);puts=s3.puts;p.upload(staged,s3,2)
        self.assertEqual(s3.puts,puts)
        key=next(iter(s3.data));s3.data[key]=b'conflicting object'
        with self.assertRaisesRegex(ValueError,'collision'):
            p.upload(staged,s3,2)


if __name__=='__main__':unittest.main()
