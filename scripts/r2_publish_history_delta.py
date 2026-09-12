#!/usr/bin/env python3
"""Stage an immutable incremental explorer release without republishing old shards.
Old complete shards keep their original R2 objects. Small row-indexed overlays
stamp only newly spent records. New/previously partial shards are replaced.
Each overlay's reconstructed original shard must match the prior upload MD5.
"""
import argparse,concurrent.futures,hashlib,json,os,struct,sys,threading,time
from pathlib import Path
import numpy as np
import boto3
from botocore.config import Config
from r2_publish_cloud_history import HISTORY_HEADER,RECORD_DTYPE,SHARD_HEADER,SHARD_MAGIC,UNSPENT,build_shard,load_credentials,save_json
from update_video_append import step,event

PATCH_MAGIC=b'BUVSPN1\0'
ENDPOINT='https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com'

def make_patch(payload,old_tip,base_etag):
    magic,version,rows,h1,h2,n=SHARD_HEADER.unpack_from(payload)
    assert magic==SHARD_MAGIC and version==1
    offsets=np.frombuffer(payload,dtype='<u8',count=rows+1,offset=SHARD_HEADER.size)
    start=SHARD_HEADER.size+(rows+1)*8
    records=np.frombuffer(payload,dtype=RECORD_DTYPE,count=n,offset=start)
    changed=(records['spendHeight']>old_tip)&(records['spendHeight']!=UNSPENT)
    original=bytearray(payload)
    original_records=np.frombuffer(original,dtype=RECORD_DTYPE,count=n,offset=start)
    original_records['spendHeight'][changed]=UNSPENT
    assert hashlib.md5(original).hexdigest()==base_etag.strip('"'),'history base shard differs: cannot apply positional patch'
    indices=np.flatnonzero(changed)
    if not len(indices):return None
    assert n<2**32
    # indices refer to the existing shard's row-sorted record array, not heights.
    pairs=np.empty((len(indices),2),dtype='<u4')
    pairs[:,0]=indices;pairs[:,1]=records['spendHeight'][changed]
    patch_offsets=np.searchsorted(indices,offsets).astype('<u8')
    body=SHARD_HEADER.pack(PATCH_MAGIC,1,rows,h1,h2,len(indices))+patch_offsets.tobytes()+pairs.tobytes()
    return body

def main(run):
    assert (run/'history_updated.json').exists(),'history update not verified'
    hfile=Path('/Volumes/4T Data/buv_render/utxo_history.bin')
    old=json.loads((run/'history-baseline.json').read_text())
    old_header=HISTORY_HEADER.unpack(bytes.fromhex(old['headerHex']))
    old_blocks=old_header[1];old_tip=old_blocks-1
    base=json.loads(Path(old['cloudState']).read_text())
    assert base['sourceSize']==old['sourceSize'] and base['sourceMtimeNs']==old['sourceMtimeNs']
    with hfile.open('rb') as f:head=HISTORY_HEADER.unpack(f.read(HISTORY_HEADER.size))
    magic,blocks,count,toff,ioff,roff,_=head
    assert magic==b'BUVHIST1' and blocks==json.loads((run/'prepared.json').read_text())['newEndBlock']+1
    records=np.memmap(hfile,dtype=RECORD_DTYPE,mode='r',offset=roff,shape=(count,))
    index=np.memmap(hfile,dtype='<u8',mode='r',offset=ioff,shape=(blocks+1,))
    times=np.memmap(hfile,dtype='<u4',mode='r',offset=toff,shape=(blocks,))
    prefix='explorer/v2/history';state_path=run/'cloud-history-delta-state.json'
    state=json.loads(state_path.read_text()) if state_path.exists() else {'sourceSize':hfile.stat().st_size,'sourceMtimeNs':hfile.stat().st_mtime_ns,'completed':{},'patchShards':[],'unchangedShards':[],'fullShards':[]}
    assert (state['sourceSize'],state['sourceMtimeNs'])==(hfile.stat().st_size,hfile.stat().st_mtime_ns)
    access,secret=load_credentials(Path.home()/'.config/utxo-r2/credentials')
    s3=boto3.client('s3',endpoint_url=ENDPOINT,aws_access_key_id=access,aws_secret_access_key=secret,region_name='auto',config=Config(retries={'max_attempts':8,'mode':'adaptive'},max_pool_connections=12,connect_timeout=20,read_timeout=300))
    lock=threading.Lock()
    def upload(key,body,content_type='application/octet-stream'):
        md5=hashlib.md5(body).hexdigest()
        try:
            prev=s3.head_object(Bucket='utxo-video',Key=key)
        except s3.exceptions.ClientError as e:
            if e.response['ResponseMetadata']['HTTPStatusCode']!=404:raise
        else:
            assert prev['ContentLength']==len(body) and prev['ETag'].strip('"')==md5,'refusing to replace immutable key '+key
            return {'bytes':len(body),'etag':prev['ETag']}
        resp=s3.put_object(Bucket='utxo-video',Key=key,Body=body,ContentLength=len(body),ContentType=content_type,CacheControl='public, max-age=31536000, immutable')
        assert resp['ETag'].strip('"')==md5
        return {'bytes':len(body),'etag':resp['ETag']}
    def shard(n):
        old_key=f'explorer/v1/history/shards/{n:05d}.bin'
        key=f'{prefix}/shards/{n:05d}.bin'
        if n<old_blocks//512:
            a,b=int(index[n*512]),int(index[(n+1)*512]);source=records[a:b]
            changed=(source['spendHeight']>old_tip)&(source['spendHeight']!=UNSPENT)
            if not np.any(changed):return n,'unchanged',None,None
            payload,_=build_shard(records,index,n,512,blocks,2072)
            body=make_patch(payload,old_tip,base['completed'][old_key]['etag'])
            assert body is not None
            key=f'{prefix}/spends/{n:05d}.bin';kind='patch'
        else:
            body,_=build_shard(records,index,n,512,blocks,2072);kind='full'
        return n,kind,key,upload(key,body)
    start=time.monotonic()
    with step(run,'publish_incremental_history'):
        key=prefix+'/block_times.bin'
        if key not in state['completed']:
            state['completed'][key]=upload(key,times.tobytes());save_json(state_path,state)
        done=set(state['patchShards']+state['unchangedShards']+state['fullShards'])
        count_shards=(blocks+511)//512
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures={pool.submit(shard,n):n for n in range(count_shards) if n not in done}
            for future in concurrent.futures.as_completed(futures):
                n,kind,key,meta=future.result()
                state[kind+'Shards'].append(n)
                if key:state['completed'][key]=meta
                save_json(state_path,state)
                completed=sum(len(state[x]) for x in ['patchShards','unchangedShards','fullShards'])
                if completed%25==0 or completed==count_shards:
                    uploaded=sum(x['bytes'] for x in state['completed'].values())
                    event(run,'history_publish_progress',shards=completed,total=count_shards,uploadedBytes=uploaded,seconds=time.monotonic()-start)
        manifest={'numBlocks':blocks,'numRecords':count,'oldNumBlocks':old_blocks,'basePrefix':'explorer/v1/history','prefix':prefix,'patchShards':sorted(state['patchShards']),'fullShards':sorted(state['fullShards']),'unchangedShards':sorted(state['unchangedShards']),'blockTimesKey':prefix+'/block_times.bin','shardBlocks':512,'rows':2072,'format':'buv-cloud-history-delta-v1'}
        body=(json.dumps(manifest,separators=(',',':'))+'\n').encode()
        state['completed'][prefix+'/manifest.json']=upload(prefix+'/manifest.json',body,'application/json')
        state['finished']=True;save_json(state_path,state);save_json(run/'cloud-history-delta-verified.json',manifest)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('run',type=Path);a=p.parse_args();main(a.run)
