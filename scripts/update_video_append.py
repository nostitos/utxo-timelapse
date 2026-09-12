#!/usr/bin/env python3
"""Append-only video update operations. Never encodes the retained video prefix.

Run directory contains immutable inputs, logs, measured step timings and gates.
Node updater must complete and an exact prefix SHA256 check must pass first.
No cloud promotion or deletion is performed by this script.
"""
import argparse, contextlib, datetime, hashlib, json, os, re, shlex, shutil, socket, struct, subprocess, sys, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BASE=Path('/Volumes/4T Data/buv_render')
OLD=BASE/'utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21.mp4'
BLK=BASE/'changes.blk1.full964k'
HISTORY=BASE/'utxo_history.bin'
OLD_END=964388
OLD_BYTES=18219536984
JOIN=964380  # Last complete one-second, closed GOP before the old ending.
WARM=963000  # Transient/flow pre-roll is discarded, not encoded.
FPS=60

def save(path,value):
    tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.replace(path)

def event(run,name,**kw):
    value=dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),event=name,**kw)
    with (run/'timings.jsonl').open('a') as f:f.write(json.dumps(value)+'\n')
    print(json.dumps(value),flush=True)

@contextlib.contextmanager
def step(run,name):
    start=time.monotonic();event(run,name+'_start')
    try:yield
    except BaseException as e:
        event(run,name+'_failed',seconds=time.monotonic()-start,error=str(e));raise
    else:event(run,name+'_complete',seconds=time.monotonic()-start)

def remote(cmd,output=None):
    # Existing saved node credential; never log or interpolate it in argv.
    secret=re.search(r"sshpass -p '([^']+)'",(ROOT/'.claude/settings.local.json').read_text()).group(1)
    env=dict(os.environ,SSHPASS=secret)
    r=subprocess.run(['sshpass','-e','ssh','-o','ConnectTimeout=20','-o','PreferredAuthentications=password','-o','PubkeyAuthentication=no','-o','NumberOfPasswordPrompts=1','-o','ControlMaster=auto','-o','ControlPersist=600','-o','ControlPath=/tmp/buv-append-node-ssh','-o','ServerAliveInterval=30','umbrel@192.168.8.234',cmd],env=env,stdout=output or subprocess.PIPE,stderr=subprocess.PIPE)
    if r.returncode:raise RuntimeError(r.stderr.decode())
    return None if output else r.stdout

def remote_python(code,output=None):return remote('python3 -c '+shlex.quote(code),output)

def probe(path,count=False):
    cmd=['ffprobe','-v','error','-select_streams','v:0']
    if count:cmd+=['-count_packets']
    cmd+=['-show_streams','-show_format','-of','json',str(path)]
    return json.loads(subprocess.check_output(cmd))

def command(run,name,cmd):
    with step(run,name), (run/(name+'.log')).open('xb') as f:
        subprocess.run(cmd,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,check=True)

def prepare(run):
    event(run,'await_node_update_and_prefix_verification')
    while True:
        events=[json.loads(x) for x in (run/'timings.jsonl').read_text().splitlines()]
        if (run/'node-after.json').exists() and (run/'prefix-verification.json').exists():break
        time.sleep(15)
    assert json.loads((run/'prefix-verification.json').read_text())['equal'],'old changes differ; cannot append'
    before=json.loads((run/'node-before.json').read_text())
    after=json.loads((run/'node-after.json').read_text())
    magic,tip,size,offset,blockhash=struct.unpack('<4sIQQ32s',bytes.fromhex(after['headerHex']))
    assert magic==b'UTX3' and size==after['blkBytes'] and tip>OLD_END
    assert size>OLD_BYTES and offset<size
    with step(run,'validate_updated_node_checkpoint'):
        code=f"""import json,struct,urllib.request,hashlib
with open('/home/umbrel/buv_data/changes.blk1.v3','rb') as f:
 f.seek({offset});head=f.read(44)
 marker,height,n=struct.unpack('<4sII',head[:12]);assert marker==b'BLK\\x02' and height=={tip} and {offset}+12+n=={size}
 assert head[12:44].hex()=={blockhash.hex()!r}
 f.seek({OLD_BYTES});h=hashlib.sha256()
 while b:=f.read(8388608):h.update(b)
node=json.load(urllib.request.urlopen('http://127.0.0.1:8332/rest/blockhashbyheight/{tip}.json'))
assert node['blockhash']=={blockhash.hex()!r}
print(json.dumps({{'tip':height,'hash':node['blockhash'],'deltaSha256':h.hexdigest(),'bytes':{size-OLD_BYTES}}}))
"""
        checked=json.loads(remote_python(code));save(run/'node-delta-verified.json',checked)
    delta=run/'changes.delta.blk2'
    with step(run,'transfer_only_new_blocks'), delta.open('xb') as out:
        remote_python(f"import sys,shutil\nf=open('/home/umbrel/buv_data/changes.blk1.v3','rb');f.seek({OLD_BYTES});shutil.copyfileobj(f,sys.stdout.buffer,8388608)",out)
        out.flush();os.fsync(out.fileno())
    assert delta.stat().st_size==checked['bytes']
    assert hashlib.sha256(delta.read_bytes()).hexdigest()==checked['deltaSha256']
    with delta.open('rb') as f:
        next_h=OLD_END+1
        while head:=f.read(12):
            marker,height,n=struct.unpack('<4sII',head)
            assert marker==b'BLK\x02' and height==next_h and n>=124
            f.seek(n,1);next_h+=1
        assert f.tell()==delta.stat().st_size and next_h==tip+1
    # The verified append preserves every old byte. Nothing is overwritten.
    with step(run,'append_local_changes'):
        assert BLK.stat().st_size==OLD_BYTES
        with BLK.open('ab') as out,delta.open('rb') as src:
            shutil.copyfileobj(src,out,8388608);out.flush();os.fsync(out.fileno())
        assert BLK.stat().st_size==size
    cfg=json.loads((ROOT/'configs/buv_render_full_weighted.json').read_text())
    assert cfg['xAxisMode']=='normalizedGeometric' and cfg['epochBlocks']==105000 and cfg['epochTransitionBlocks']==120
    assert cfg['whiteHotTailMinSatoshi']==1000000000 and cfg['imageWidth']==3840
    cfg.update(blkFile=str(BLK),startShowAtBlockHeight=WARM,endShowAtBlockHeight=tip,connectionSocket=12987,repeatLastBlockTimes=300,historyFile=str(HISTORY))
    save(run/'render_append.json',cfg)
    history_cfg=dict(cfg,startShowAtBlockHeight=0,endShowAtBlockHeight=0)
    save(run/'history_update.json',history_cfg)
    save(run/'prepared.json',dict(oldEndBlock=OLD_END,newEndBlock=tip,newBlocks=tip-OLD_END,joinBlock=JOIN,warmupStart=WARM,tailFrames=tip-JOIN+1+300,finalFrames=tip+1+300,localBlk=str(BLK),oldVideo=str(OLD)))

def render(run):
    m=json.loads((run/'prepared.json').read_text())
    assert not (run/'tail.mkv').exists(),'tail output exists'
    # Match the accepted master encoder settings exactly; discard transient pre-roll.
    ff=['ffmpeg','-nostdin','-hide_banner','-n','-stats_period','10','-f','rawvideo','-pixel_format','rgb24','-video_size','3840x2160','-framerate','60','-i','tcp://127.0.0.1:12987?listen','-an','-vf',f'trim=start_frame={JOIN-WARM},setpts=PTS-STARTPTS','-c:v','libx265','-preset','superfast','-crf','21','-pix_fmt','yuv444p','-x265-params','keyint=60:min-keyint=60:scenecut=0:open-gop=0:range=full:colormatrix=bt709','-color_range','pc','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',str(run/'tail.mkv')]
    with step(run,'state_replay_and_tail_render'), (run/'ffmpeg_tail.log').open('xb') as fl, (run/'render_tail.log').open('xb') as vl:
        # Avoid starting a listener if an unrelated render is using the port.
        with socket.socket() as s:s.bind(('127.0.0.1',12987))
        fp=subprocess.Popen(ff,stdin=subprocess.DEVNULL,stdout=fl,stderr=subprocess.STDOUT)
        vp=None
        try:
            time.sleep(3);assert fp.poll() is None,'ffmpeg listener failed'
            vp=subprocess.Popen([str(ROOT/'build_local/buv'),'-ns','-tc=visualizer','-cfg='+str(run/'render_append.json')],cwd=run,stdin=subprocess.DEVNULL,stdout=vl,stderr=subprocess.STDOUT)
            save(run/'render_processes.json',dict(ffmpeg=fp.pid,visualizer=vp.pid))
            last_h=0;visible_at=None;t=time.monotonic()
            while vp.poll() is None:
                time.sleep(10)
                data=(run/'render_tail.log').read_text(errors='replace')
                blocks=re.findall(r'\| block (\d+),',data)
                if blocks:last_h=int(blocks[-1])
                if last_h>=WARM and visible_at is None:
                    visible_at=time.monotonic();event(run,'visible_preroll_reached',secondsSinceVisualizerStart=visible_at-t,block=last_h)
                save(run/'render_progress.json',dict(block=last_h,secondsSinceStart=time.monotonic()-t,encoding=last_h>=JOIN,ffmpegRunning=fp.poll() is None))
                if fp.poll() is not None and vp.poll() is None:raise RuntimeError('encoder exited before visualizer')
            assert vp.returncode==0,f'visualizer rc={vp.returncode}'
            assert fp.wait(timeout=300)==0,'ffmpeg nonzero exit'
        except BaseException:
            for p in [vp,fp]:
                if p is not None and p.poll() is None:p.terminate()
            raise
    data=(run/'render_tail.log').read_text()
    assert 'Status: SUCCESS!' in data and 'ledger misses=0, dropped decrements=0' in data
    assert 'Lsize=' in (run/'ffmpeg_tail.log').read_text()
    with step(run,'verify_tail_metadata'):
        meta=probe(run/'tail.mkv',True);s=meta['streams'][0]
        assert s['width']==3840 and s['height']==2160 and s['pix_fmt']=='yuv444p' and s['r_frame_rate']=='60/1'
        assert int(s['nb_read_packets'])==m['tailFrames']
        save(run/'tail_verified.json',meta)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('stage',choices=['prepare','render','history']);p.add_argument('run',type=Path);a=p.parse_args()
    a.run=a.run.resolve()
    try:
        if a.stage=='prepare':prepare(a.run)
        elif a.stage=='render':render(a.run)
        else:
            command(a.run,'history_update',[str(ROOT/'build_local/buv'),'-ns','-tc=utxo_history_update','-cfg='+str(a.run/'history_update.json')])
            log=(a.run/'history_update.log').read_text()
            assert 'Status: SUCCESS!' in log and '(0 unmatched total)' in log
            save(a.run/'history_updated.json',{'verified':True})
    except BaseException as e:
        event(a.run,a.stage+'_failed',error=str(e));raise
