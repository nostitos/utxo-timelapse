#!/usr/bin/env python3
"""Extract the guide's curated previews. Never changes the source master/history.
Usage: python3 scripts/build_site_media.py --master /path/to/master.mp4 --history /path/to/utxo_history.bin
Requires ffmpeg, cwebp and ImageMagick. Existing previews are retained unless --force.
"""
import argparse, concurrent.futures, datetime, json, pathlib, struct, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
ASSETS=ROOT/'site/assets'
WORK=ROOT/'buv_output/site-work'
BLOCKS=[100000,202933,210000,314000,420000,500000,630000,661045,700000,840000,900000,966360]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--master',type=pathlib.Path,required=True)
p.add_argument('--history',type=pathlib.Path,required=True)
p.add_argument('--force',action='store_true')
a=p.parse_args()

def run(args):
    subprocess.run([str(x) for x in args],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
def make(out,args):
    if out.exists() and not a.force:return
    out.parent.mkdir(parents=True,exist_ok=True);run(args)
def ff(*args):return ['ffmpeg','-hide_banner','-loglevel','error','-y','-threads','2',*args]
WORK.mkdir(parents=True,exist_ok=True)
for folder in ['frames','crops','clips','readme']:(ASSETS/folder).mkdir(parents=True,exist_ok=True)
manifest={'sourceMaster':a.master.name,'sourceVersion':'append-966360-20260910-r3','fps':60,'dataCutoff':'2026-09-10','frames':[],'clips':[]}
with a.history.open('rb') as f:
    header=f.read(64)
    assert header[:8]==b'BUVHIST1'
    nblocks,nrecords,timesoff=struct.unpack_from('<QQQ',header,8)
    for b in BLOCKS:
        assert b<nblocks
        f.seek(timesoff+b*4);ts=struct.unpack('<I',f.read(4))[0]
        manifest['frames'].append({'block':b,'date':datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).isoformat(),'seconds':b/60})
manifest.update(numBlocks=nblocks,numHistoryRecords=nrecords)

def frame(b):
    src=WORK/f'frame-{b}.png'
    make(src,ff('-ss',str(b//60),'-i',a.master,'-vf',rf'select=eq(n\,{b%60})','-frames:v','1',src))
    for size,q in [(1920,84),(3840,90)]:
        out=ASSETS/'frames'/f'{b}-{"1080" if size==1920 else "4k"}.webp'
        make(out,['cwebp','-quiet','-q',str(q),'-resize',str(size),'0',src,'-o',out])
    print('frame',b,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:list(ex.map(frame,BLOCKS))
# Pixel crops preserve the source sampling; enlarged with nearest-neighbour only.
for name,b,geometry in [('top-band',202933,'1500x80+1700+0'),('1000-btc',202933,'1400x120+1700+190'),('100-btc',202933,'1400x120+1700+380'),('palette-boundary',202933,'1400x120+1700+570'),('dust',900000,'1400x220+2000+1860'),('creation-edge',314000,'440x1250+3400+680')]:
    png=WORK/(name+'.png');out=ASSETS/'crops'/(name+'.webp')
    make(png,['magick',WORK/f'frame-{b}.png','-crop',geometry,'+repage','-filter','point','-resize','200%' if name=='creation-edge' else '400%',png])
    make(out,['cwebp','-quiet','-lossless',png,'-o',out])
for name,srcname in [('palette-flash-comparison','comparison_block202933_flash_global-left_split-right.png'),('palette-row-comparison','comparison_block202933_10BTC_global-left_split-right.png')]:
    src=ROOT/'diagnostics/split_palette_10btc'/srcname
    if src.exists():make(ASSETS/'crops'/(name+'.webp'),['cwebp','-quiet','-q','90',src,'-o',ASSETS/'crops'/(name+'.webp')])

def clip(args):
    name,start,duration=args
    for ext in ['mp4','webm']:
        out=ASSETS/'clips'/f'{name}.{ext}'
        codec=['-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart'] if ext=='mp4' else ['-c:v','libvpx-vp9','-crf','30','-b:v','0','-row-mt','1','-cpu-used','4','-pix_fmt','yuv420p']
        make(out,ff('-ss',str(start//60),'-i',a.master,'-t',str(duration),'-an','-vf',f'trim=start_frame={start%60},setpts=PTS-STARTPTS,scale=1920:-2:flags=lanczos','-threads','2',*codec,out))
    print('clip',name,flush=True)
clips=[('hero',313700,10),('epoch-slide',209940,4),('whale-flash',202880,3),('tip',966240,7)]
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:list(ex.map(clip,clips))
manifest['clips']=[{'name':n,'startBlock':b,'durationSeconds':d,'previewOnly':True} for n,b,d in clips]
make(ASSETS/'readme/hero.gif',ff('-i',ASSETS/'clips/hero.mp4','-t','6','-filter_complex','fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer','-loop','0',ASSETS/'readme/hero.gif'))
(ASSETS/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('media complete',flush=True)
