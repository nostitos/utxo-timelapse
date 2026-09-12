#!/usr/bin/env python3
"""Publish the verified append with continuous fMP4 timing; no media encoding."""
from pathlib import Path
import sys,json,hashlib,boto3
from botocore.config import Config
from r2_publish_cloud_history import load_credentials,save_json
from r2_publish_history_delta import ENDPOINT
from update_video_append import ROOT,step

def main(r):
 assert (r/'hls_continuous_payload_verified.json').exists()
 a,b=load_credentials(Path.home()/'.config/utxo-r2/credentials')
 s3=boto3.client('s3',endpoint_url=ENDPOINT,aws_access_key_id=a,aws_secret_access_key=b,region_name='auto',config=Config(retries={'max_attempts':8,'mode':'adaptive'},read_timeout=300))
 state={}
 def put(key,body,kind):
  md5=hashlib.md5(body).hexdigest()
  try:old=s3.head_object(Bucket='utxo-video',Key=key)
  except s3.exceptions.ClientError as e:
   if e.response['ResponseMetadata']['HTTPStatusCode']!=404:raise
   old=None
  if old:assert old['ETag'].strip('"')==md5 and old['ContentLength']==len(body),'immutable conflict '+key
  else:
   response=s3.put_object(Bucket='utxo-video',Key=key,Body=body,ContentType=kind,CacheControl='public,max-age=31536000,immutable')
   assert response['ETag'].strip('"')==md5
  state[key]={'bytes':len(body),'md5':md5};save_json(r/'continuous_upload_state.json',state)
 with step(r,'upload_continuous_hls_tail'):
  d=r/'hls_continuous'
  for p in sorted(d.glob('segment_*.m4s')):put('hls/v3/'+p.name,p.read_bytes(),'video/iso.segment')
  put('hls/v3/media.m3u8',(d/'media.m3u8').read_bytes(),'application/vnd.apple.mpegurl')
 with step(r,'stage_continuous_release'):
  site=ROOT/'cloudflare/utxo-video-worker/static'
  info=json.loads((r/'info.json').read_text());info.update(videoVersion='append-966360-20260910-r2',videoUrl='/hls/v3/media.m3u8')
  put('explorer/v3/site/info.json',(json.dumps(info,separators=(',',':'))+'\n').encode(),'application/json')
  for name,kind in [('explorer.html','text/html; charset=utf-8'),('hls.min.js','text/javascript; charset=utf-8')]:put('explorer/v3/site/'+name,(site/name).read_bytes(),kind)
  release=json.loads((r/'cloud_staged.json').read_text())['release'];release.update(version=info['videoVersion'],sitePrefix='explorer/v3/site')
  (ROOT/'cloudflare/utxo-video-worker/src/release.js').write_text('// Verified append release; prior HLS and history objects remain shared.\nexport const RELEASE = Object.freeze('+json.dumps(release,indent=2)+');\n')
  save_json(site/'info.json',info);save_json(r/'continuous_info.json',info)
  save_json(r/'cloud_continuous_staged.json',{'release':release,'info':info})
if __name__=='__main__':main(Path(sys.argv[1]))
