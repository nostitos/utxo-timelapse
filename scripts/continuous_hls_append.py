#!/usr/bin/env python3
"""Rebase appended fMP4 timestamps, without changing any encoded video bytes."""
from pathlib import Path
import struct,hashlib,json
CONTAINERS={b'moof',b'traf'}
def boxes(b,start=0,end=None):
 end=len(b) if end is None else end
 while start<end:
  assert start+8<=end
  n,k=struct.unpack_from('>I4s',b,start);head=8
  if n==1:n=struct.unpack_from('>Q',b,start+8)[0];head=16
  if n==0:n=end-start
  assert n>=head and start+n<=end
  yield start,n,k,head
  if k in CONTAINERS:yield from boxes(b,start+head,start+n)
  start+=n

def rebase(data,ticks,sequence_offset):
 b=bytearray(data);counts={b'tfdt':0,b'sidx':0,b'mfhd':0};payload=[]
 for p,n,k,h in boxes(data):
  q=p+h
  if k==b'mdat':payload.append(hashlib.sha256(data[q:p+n]).hexdigest())
  if k==b'tfdt':
   assert data[q] in (0,1);fmt='>Q' if data[q] else '>I';off=q+4
   struct.pack_into(fmt,b,off,struct.unpack_from(fmt,data,off)[0]+ticks);counts[k]+=1
  if k==b'sidx':
   assert struct.unpack_from('>I',data,q+8)[0]==16000
   fmt='>Q' if data[q] else '>I';off=q+12
   struct.pack_into(fmt,b,off,struct.unpack_from(fmt,data,off)[0]+ticks);counts[k]+=1
  if k==b'mfhd':
   off=q+4;struct.pack_into('>I',b,off,struct.unpack_from('>I',data,off)[0]+sequence_offset);counts[k]+=1
 assert counts=={b'tfdt':1,b'sidx':1,b'mfhd':1}
 after=[hashlib.sha256(b[p+h:p+n]).hexdigest() for p,n,k,h in boxes(b) if k==b'mdat']
 assert after==payload
 return bytes(b),payload

def main(r):
 d=r/'hls_continuous';d.mkdir(exist_ok=True)
 original=r/'hls';e=[]
 for p in sorted(original.glob('segment_*.m4s')):
  b,h=rebase(p.read_bytes(),16070*16000,1607)
  (d/p.name).write_bytes(b);e.append({'file':p.name,'mdatSHA256':h})
 (d/'init.mp4').write_bytes((r/'old_init.mp4').read_bytes())
 s=(original/'tail.m3u8').read_text()
 (d/'tail.m3u8').write_text(s)
 short=s[:s.index('#EXT-X-MAP:')].replace('1607','1606')+'#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10.000000,\n/old_segment_01606.m4s\n'+s[s.index('#EXTINF:'):]
 (d/'short.m3u8').write_text(short)
 s=(original/'media.m3u8').read_text().replace('#EXT-X-DISCONTINUITY\n','').replace('#EXT-X-MAP:URI="/hls/v2/init.mp4"\n','').replace('/hls/v2/','/hls/v3/')
 (d/'media.m3u8').write_text(s)
 (r/'hls_continuous_payload_verified.json').write_text(json.dumps({'offsetTicks':257120000,'timescale':16000,'segments':e},indent=2)+'\n')
 p=r/'diag.html';s=p.read_text()
 if 'Short continuous' not in s:s=s.replace('<input id="sec"','<button onclick="load(\'/hls_continuous/short.m3u8\')">Short continuous</button><input id="sec"');p.write_text(s)
if __name__=='__main__':
 import sys;main(Path(sys.argv[1]))
