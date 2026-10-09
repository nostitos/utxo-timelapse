"""Read one real shard, benchmark a synthetic spend update without touching production.
Usage: python scripts/tests/benchmark_history_delta.py --history H --output FRESH_DIR
"""
import argparse
import json
from pathlib import Path
import time
from test_history_delta_publish import write_history, write_journal
import history_delta_publish as p
from r2_publish_history_delta import make_patch


def main():
    parser=p.argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--shard',type=int,default=1758)
    a=parser.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=False)
    source=p.History(a.history);h1=a.shard*512;h2=h1+512
    p.require(h2<=source.blocks,'complete source shard required')
    lo,hi=map(int,(source.index[h1],source.index[h2]))
    recs=source.records[lo:hi].copy();recs['creationHeight']-=h1
    # Real amounts/order/workload; synthetic time context and spends. This is
    # explicitly NOT replay of real new chain blocks or a production mutation.
    recs['spendHeight'][recs['spendHeight']!=p.UNSPENT]=511
    before=write_history(out/'before.bin',recs,512)
    body,_=p.build_shard(before.records,before.index,0,512,512,p.ROWS)
    objects=p.Objects(out/'objects');key='explorer/bench-base/shards/00000.bin'
    p.immutable(objects.path(key),body)
    seed=dict(historyHeader=before.header.hex(),geometry=p.GEOMETRY,shards={'0':dict(baseKey=key,baseEtag=p.md5(body),baseTip=511)})
    bootstrap=p.bootstrap(before.path,seed,out/'cache',objects,out/'catalog.json',workers=1)
    open_ids=p.np.flatnonzero(recs['spendHeight']==p.UNSPENT)
    selected=open_ids[p.np.linspace(0,len(open_ids)-1,min(10000,len(open_ids)),dtype=int)]
    p.require(len(selected)>0,'no unspent records to benchmark')
    recs['spendHeight'][selected]=512
    after=write_history(out/'after.bin',recs,513,b'b'*16)
    write_journal(out/'history.delta',before,after)
    begin=time.monotonic()
    legacy_body,_=p.build_shard(after.records,after.index,0,512,513,p.ROWS)
    expected=make_patch(legacy_body,511,seed['shards']['0']['baseEtag'])
    legacy=time.monotonic()-begin
    staged=p.stage(after.path,out/'history.delta',json.loads((out/'catalog.json').read_text()),
                   objects,out/'cache',out/'stage','explorer/bench-next')
    actual=(out/'stage/objects/explorer/bench-next/spends/00000.bin').read_bytes()
    p.require(actual==expected,'new patch differs from full old-shard rebuild')
    source.unchanged()
    result=dict(workload='real shard amounts/order, synthetic spend transition; warm-cache bounded test',
                sourceShard=a.shard,sourceRecords=hi-lo,sourceBytes=(hi-lo)*16,changedRecords=len(selected),
                bootstrapSeconds=bootstrap['seconds'],legacyOldShardSeconds=legacy,
                journalWholeStageSeconds=staged['seconds'],patchBytes=len(actual),patchByteIdentical=True,
                newHistoricalShardsRebuilt=0,productionHistoryUnchanged=True)
    p.immutable(out/'result.json',p.json_bytes(result));print(json.dumps(result,indent=2))


if __name__=='__main__':main()
