#!/usr/bin/env python3
"""Verify an independently encoded tail, then splice by packet-copy at a closed GOP.
No retained frame is decoded/re-encoded for the new master. Outpoint uses DTS,
not PTS (FFmpeg concat demuxer specification). Stages are timed separately.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,sys,time
from pathlib import Path
from update_video_append import ROOT,BASE,OLD,JOIN,FPS,save,step,event,probe,command

def extra(path):
    s=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=extradata','-show_data','-of','json',str(path)]))['streams'][0]['extradata']
    return bytes.fromhex(''.join(line.split(':',1)[1].strip().split('  ')[0].replace(' ','') for line in s.splitlines() if ':' in line))

def parameter_sets(data):
    assert data[0]==1
    arrays={};p=23
    for _ in range(data[22]):
        kind=data[p]&63;num=int.from_bytes(data[p+1:p+3],'big');p+=3;sets=[]
        for _ in range(num):
            n=int.from_bytes(data[p:p+2],'big');p+=2;sets.append(data[p:p+n].hex());p+=n
        if kind in (32,33,34):arrays[kind]=sets
    assert set(arrays)=={32,33,34};return arrays

def packet_window(path,start,length,hashes=False):
    cmd=['ffprobe','-v','error','-select_streams','v:0','-read_intervals',f'{start}%+{length}','-show_packets','-show_entries','packet=pts_time,dts_time,flags'+(',data_hash' if hashes else ''),'-of','json']
    if hashes:cmd+=['-show_data_hash','sha256']
    return json.loads(subprocess.check_output(cmd+[str(path)]))['packets']

def ffconcat(path,entries):
    lines=['ffconcat version 1.0']
    for f,opts in entries:
        assert "'" not in str(f)
        lines.append("file '"+str(f)+"'")
        lines.extend(f'{k} {v}' for k,v in opts.items())
    path.write_text('\n'.join(lines)+'\n')

def main(run):
    m=json.loads((run/'prepared.json').read_text());assert (run/'tail_verified.json').exists()
    tail=run/'tail.mp4'
    command(run,'remux_tail',['ffmpeg','-nostdin','-hide_banner','-n','-i',str(run/'tail.mkv'),'-map','0:v:0','-c','copy','-tag:v','hvc1','-video_track_timescale','16000',str(tail)])
    with step(run,'verify_splice_compatibility'):
        oldmeta=probe(OLD)['streams'][0];newmeta=probe(tail)['streams'][0]
        for k in ['codec_name','profile','level','width','height','pix_fmt','r_frame_rate','time_base','color_range','color_space']:
            assert oldmeta[k]==newmeta[k],f'codec field differs {k}: {oldmeta[k]} vs {newmeta[k]}'
        assert parameter_sets(extra(OLD))==parameter_sets(extra(tail)),'HEVC parameter sets differ; unsafe hvc1 splice'
        boundary=JOIN/FPS
        packets=packet_window(OLD,boundary-1,3)
        key=next(p for p in packets if 'K' in p['flags'] and abs(float(p['pts_time'])-boundary)<0.0001)
        outpoint=key['dts_time'];save(run/'splice.json',dict(joinBlock=JOIN,pts=boundary,exclusiveDts=outpoint,parameterSetsMatch=True))
    # Join sample includes the preceding keyframe group and all new output.
    preview_manifest=run/'join_preview.ffconcat'
    ffconcat(preview_manifest,[(OLD,{'inpoint':boundary-1,'outpoint':outpoint,'duration':1}),(tail,{})])
    command(run,'splice_preview',['ffmpeg','-nostdin','-hide_banner','-n','-f','concat','-safe','0','-i',str(preview_manifest),'-map','0:v:0','-c','copy','-tag:v','hvc1','-video_track_timescale','16000',str(run/'join_preview.mp4')])
    with step(run,'verify_splice_preview'):
        p=probe(run/'join_preview.mp4',True)
        assert int(p['streams'][0]['nb_read_packets'])==60+m['tailFrames']
        # Decodes the entire short join clip, detecting reference-frame/SPS errors.
        subprocess.run(['ffmpeg','-v','error','-xerror','-nostdin','-i',str(run/'join_preview.mp4'),'-f','null','-'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
        save(run/'splice_preview_verified.json',p)
    out=BASE/f'utxo_4k_epoch105k_60fps_transition_crf21_to_{m["newEndBlock"]}.mp4'
    required=OLD.stat().st_size+tail.stat().st_size+20*1024**3
    assert shutil.disk_usage(BASE).free>required,'insufficient free space; retained master untouched'
    manifest=run/'append.ffconcat';ffconcat(manifest,[(OLD,{'outpoint':outpoint,'duration':boundary}),(tail,{})])
    command(run,'packet_copy_full_master',['ffmpeg','-nostdin','-hide_banner','-n','-stats_period','15','-f','concat','-safe','0','-i',str(manifest),'-map','0:v:0','-c','copy','-tag:v','hvc1','-video_track_timescale','16000','-movflags','+faststart',str(out)])
    with step(run,'verify_appended_master'):
        meta=probe(out);s=meta['streams'][0]
        assert int(s['nb_frames'])==m['finalFrames'] and s['width']==3840 and s['height']==2160
        assert s['codec_name']=='hevc' and s['pix_fmt']=='yuv444p' and s['r_frame_rate']=='60/1'
        assert abs(float(meta['format']['duration'])-m['finalFrames']/60)<0.002
        # Retained packets must be identical in multiple eras, including at the join.
        for h in [0,210000,500000,900000,JOIN-60]:
            a=packet_window(OLD,h/60,0.9,True);b=packet_window(out,h/60,0.9,True)
            assert a==b,f'retained packet/timestamp mismatch at block {h}'
        joined=packet_window(out,boundary-1,3)
        assert all(float(a['dts_time'])<float(b['dts_time']) for a,b in zip(joined,joined[1:]))
        for h in [100000,210060,JOIN-1,JOIN,m['newEndBlock']]:
            subprocess.run(['ffmpeg','-v','error','-xerror','-nostdin','-ss',str(h/60),'-i',str(out),'-frames:v','1','-f','null','-'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
        save(run/'master_verified.json',{'video':str(out),'probe':meta,'retainedPacketSamplesIdentical':True})
    # Existing cloud segments 0..1606 remain byte-for-byte unchanged. Repackage
    # only their last partial 10-second segment plus the new tail (no encoding).
    hls=run/'hls';hls.mkdir(exist_ok=False)
    hls_start=(JOIN//600)*600
    command(run,'package_hls_tail',['ffmpeg','-nostdin','-hide_banner','-n','-ss',str(hls_start/60),'-i',str(out),'-map','0:v:0','-c','copy','-f','hls','-hls_time','10','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_flags','independent_segments','-hls_fmp4_init_filename','init.mp4','-start_number',str(hls_start//600),'-hls_segment_filename',str(hls/'segment_%05d.m4s'),str(hls/'tail.m3u8')])
    save(run/'local_append_complete.json',{'video':str(out),'newEndBlock':m['newEndBlock'],'hlsOldSegmentsRetained':hls_start//600,'status':'ready_for_cloud_validation'})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('run',type=Path);a=p.parse_args()
    try:main(a.run)
    except BaseException as e:event(a.run,'finalize_failed',error=str(e));raise
