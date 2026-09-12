#!/usr/bin/env python3
"""Stage only the appended HLS tail and matching site metadata in immutable R2 keys.
The original 1,607 streaming segments remain reused. No deployment is performed.
"""
import argparse,datetime,hashlib,json,os,re,struct,subprocess
from pathlib import Path
import boto3
from botocore.config import Config
from r2_publish_cloud_history import HISTORY_HEADER,load_credentials,save_json
from update_video_append import ROOT,step,event,probe
from r2_publish_history_delta import ENDPOINT


def playlist_entries(s):
    entries=[];duration=None
    for line in s.splitlines():
        if line.startswith('#EXTINF:'):duration=line.split(':',1)[1].split(',')[0]
        elif line and not line.startswith('#'):
            assert duration is not None
            entries.append((duration,line));duration=None
    return entries

def main(run):
    ready=json.loads((run/'local_append_complete.json').read_text())
    hist=json.loads((run/'cloud-history-delta-verified.json').read_text())
    m=json.loads((run/'prepared.json').read_text());assert hist['numBlocks']==m['newEndBlock']+1
    access,secret=load_credentials(Path.home()/'.config/utxo-r2/credentials')
    s3=boto3.client('s3',endpoint_url=ENDPOINT,aws_access_key_id=access,aws_secret_access_key=secret,region_name='auto',config=Config(retries={'max_attempts':8,'mode':'adaptive'},connect_timeout=20,read_timeout=300))
    state_path=run/'video-site-upload-state.json';state=json.loads(state_path.read_text()) if state_path.exists() else {'completed':{}}
    def put(key,body,kind):
        md5=hashlib.md5(body).hexdigest()
        try:prev=s3.head_object(Bucket='utxo-video',Key=key)
        except s3.exceptions.ClientError as e:
            if e.response['ResponseMetadata']['HTTPStatusCode']!=404:raise
        else:
            assert prev['ETag'].strip('"')==md5 and prev['ContentLength']==len(body),'immutable key already has different bytes: '+key
            state['completed'][key]={'bytes':len(body),'etag':prev['ETag']};save_json(state_path,state);return
        response=s3.put_object(Bucket='utxo-video',Key=key,Body=body,ContentLength=len(body),ContentType=kind,CacheControl='public, max-age=31536000, immutable')
        assert response['ETag'].strip('"')==md5
        state['completed'][key]={'bytes':len(body),'etag':response['ETag']};save_json(state_path,state)
    hls=run/'hls'
    with step(run,'verify_hls_tail'):
        meta=probe(hls/'tail.m3u8',True)
        retained=ready['hlsOldSegmentsRetained']
        assert int(meta['streams'][0]['nb_read_packets'])==m['finalFrames']-retained*600
        old=s3.get_object(Bucket='utxo-video',Key='hls/v1/media.m3u8')['Body'].read().decode()
        (run/'old_cloud_playlist.m3u8').write_text(old)
        old_entries=playlist_entries(old);new_entries=playlist_entries((hls/'tail.m3u8').read_text())
        assert len(old_entries)>retained
        assert abs(sum(float(x[0]) for x in old_entries[:retained])-retained*10)<0.0001
        lines=['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-TARGETDURATION:10','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD','#EXT-X-INDEPENDENT-SEGMENTS','#EXT-X-MAP:URI="/hls/v1/init.mp4"']
        for duration,name in old_entries[:retained]:
            assert re.fullmatch(r'segment_\d{5}\.m4s',name)
            lines.extend(['#EXTINF:'+duration+',','/hls/v1/'+name])
        lines.extend(['#EXT-X-DISCONTINUITY','#EXT-X-MAP:URI="/hls/v2/init.mp4"'])
        for duration,name in new_entries:
            assert re.fullmatch(r'segment_\d{5}\.m4s',name)
            lines.extend(['#EXTINF:'+duration+',','/hls/v2/'+name])
        lines.append('#EXT-X-ENDLIST')
        joined='\n'.join(lines)+'\n'
        assert abs(sum(float(x[0]) for x in playlist_entries(joined))-m['finalFrames']/60)<0.002
        (hls/'media.m3u8').write_text(joined)
        save_json(run/'hls_verified.json',{'oldSegmentsReused':retained,'newSegments':len(new_entries),'frames':m['finalFrames'],'duration':m['finalFrames']/60,'discontinuityAtBlock':retained*600})
    with step(run,'upload_only_hls_tail'):
        for path in sorted(hls.iterdir()):
            if path.name=='tail.m3u8':continue
            if path.suffix not in ('.mp4','.m4s','.m3u8'):continue
            kind={'.mp4':'video/mp4','.m4s':'video/iso.segment','.m3u8':'application/vnd.apple.mpegurl'}[path.suffix]
            put('hls/v2/'+path.name,path.read_bytes(),kind)
    with step(run,'stage_explorer_release'):
        site=ROOT/'cloudflare/utxo-video-worker/static'
        info=json.loads((site/'info.json').read_text())
        with Path('/Volumes/4T Data/buv_render/utxo_history.bin').open('rb') as f:
            head=HISTORY_HEADER.unpack(f.read(HISTORY_HEADER.size));assert head[1]==hist['numBlocks']
            f.seek(head[3]+m['newEndBlock']*4);stamp=struct.unpack('<I',f.read(4))[0]
        info.update(numBlocks=hist['numBlocks'],videoEndBlock=m['newEndBlock'],videoFrameCount=m['finalFrames'],videoVersion='append-966360-20260910',videoUrl='/hls/v2/media.m3u8',tipDate=datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc).date().isoformat())
        save_json(run/'info.json',info)
        put('explorer/v2/site/info.json',(json.dumps(info,separators=(',',':'))+'\n').encode(),'application/json')
        for name,kind in [('explorer.html','text/html; charset=utf-8'),('hls.min.js','text/javascript; charset=utf-8')]:
            put('explorer/v2/site/'+name,(site/name).read_bytes(),kind)
        release={'version':'append-966360-20260910','numBlocks':hist['numBlocks'],'sitePrefix':'explorer/v2/site','historyBasePrefix':hist['basePrefix'],'historyDeltaPrefix':hist['prefix'],'historyOldTip':hist['oldNumBlocks']-1,'historyFullShards':hist['fullShards'],'historyPatchShards':hist['patchShards']}
        (ROOT/'cloudflare/utxo-video-worker/src/release.js').write_text('// Verified immutable append release; previous HLS/history objects remain shared.\nexport const RELEASE = Object.freeze('+json.dumps(release,indent=2)+');\n')
        save_json(site/'info.json',info)
        save_json(run/'cloud_staged.json',{'release':release,'video':ready['video'],'readyToDeploy':True})
    print('All cloud objects staged; deploy only after local/browser validation.',flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('run',type=Path);a=p.parse_args()
    try:main(a.run)
    except BaseException as e:event(a.run,'cloud_staging_failed',error=str(e));raise
