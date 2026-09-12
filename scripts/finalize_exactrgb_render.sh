#!/bin/bash
set -euo pipefail
D='/Volumes/4T Data/buv_render'
W='/Users/t/Documents/Kode/Workspaces/Clone UTXO visualizer'
MKV="$D/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_flashvaluefix_crisp_exactrgb.mkv"
MP4="$D/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_flashvaluefix_crisp_exactrgb.mp4"
R="$D/render_4k_weighted_topband_flashvaluefix_crisp_exactrgb.log"
F="$D/ffmpeg_4k_weighted_topband_flashvaluefix_crisp_exactrgb.log"
S="$D/status_4k_weighted_topband_flashvaluefix_crisp_exactrgb.txt"
LOG="$D/finalize_4k_weighted_topband_flashvaluefix_crisp_exactrgb.log"
DONE="$D/finalize_4k_weighted_topband_flashvaluefix_crisp_exactrgb.status"
EXPECTED=964689
exec > >(tee -a "$LOG") 2>&1
say(){ echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $*"; }
req(){ grep -Fq "$1" "$2" || { say "FAIL missing '$1' in $2"; exit 1; }; }
probe(){
  local video="$1" json="$2"
  ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,color_range,color_space,color_primaries,color_transfer,nb_read_packets -of json "$video" > "$json"
  python3 - "$json" "$EXPECTED" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))['streams'][0]
e={'codec_name':'hevc','profile':'Rext','pix_fmt':'gbrp','width':3840,'height':2160,'r_frame_rate':'60/1','avg_frame_rate':'60/1','color_range':'pc','color_space':'gbr','nb_read_packets':sys.argv[2]}
for k,v in e.items():
    if s.get(k)!=v: raise SystemExit(f'{k}: expected {v!r}, got {s.get(k)!r}')
print(json.dumps(s,indent=2,sort_keys=True))
PY
}
[[ -f "$MKV" ]] || { say "FAIL missing MKV"; exit 1; }
[[ ! -e "$MP4" ]] || { say "FAIL refusing to overwrite $MP4"; exit 17; }
req 'visualizer_exit_code=0' "$S"; req 'ffmpeg_exit_code=0' "$S"
req '[doctest] Status: SUCCESS!' "$R"; req 'Density diagnostics: ledger misses=0, dropped decrements=0' "$R"; req 'Lsize=' "$F"
say 'Validating 4K MKV metadata and exact packet count'
probe "$MKV" "$D/exactrgb_4k_mkv_probe.json"
for block in 100000 500000 900000 964388; do sec=$(python3 -c "print($block/60)"); ffmpeg -v error -ss "$sec" -i "$MKV" -frames:v 1 -f null -; say "MKV spot decode passed near block $block"; done
mkv_bytes=$(stat -f%z "$MKV"); avail_kib=$(df -Pk "$D"|awk 'NR==2{print $4}'); avail=$((avail_kib*1024)); need=$((mkv_bytes+50*1024*1024*1024)); ((avail>=need)) || { say "FAIL remux needs $need bytes, have $avail"; exit 28; }
say "Remux space passed: need=$need available=$avail"
ffmpeg -nostdin -hide_banner -n -i "$MKV" -map 0:v:0 -c copy -tag:v hvc1 -movflags +faststart "$MP4"
say 'Validating 4K MP4 metadata and exact packet count'
probe "$MP4" "$D/exactrgb_4k_mp4_probe.json"
for block in 100000 500000 900000 964388; do sec=$(python3 -c "print($block/60)"); ffmpeg -v error -ss "$sec" -i "$MP4" -frames:v 1 -f null -; say "MP4 spot decode passed near block $block"; done
REPO="$W/configs/buv_explorer.json"; LIVE='/Users/t/.local/share/buv-explorer/configs/buv_explorer.json'; FALL='/Users/t/.local/share/buv-explorer/configs/buv_explorer.lossy-fallback.json'
[[ -e "$FALL" ]] || cp "$LIVE" "$FALL"
python3 - "$REPO" "$MP4" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text()); c['explorerVideoFile']=sys.argv[2]
t=p.with_suffix('.json.tmp'); t.write_text(json.dumps(c,indent=4)+'\n'); t.replace(p)
PY
cp "$REPO" "$LIVE.tmp"; mv "$LIVE.tmp" "$LIVE"
old=$(cat /tmp/utxo_explorer.pid 2>/dev/null || true); touch /tmp/utxo_explorer.restart_requested
for _ in $(seq 1 40); do new=$(cat /tmp/utxo_explorer.pid 2>/dev/null || true); if [[ -n "$new" && "$new" != "$old" ]] && curl -fsS --max-time 5 http://127.0.0.1:12988/api/info > "$D/exactrgb_4k_explorer_info.json"; then break; fi; sleep 2; done
new=$(cat /tmp/utxo_explorer.pid 2>/dev/null || true); [[ -n "$new" && "$new" != "$old" ]]
curl -fsS --max-time 10 http://127.0.0.1:12988/ >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --range 0-1023 http://127.0.0.1:12988/video.mp4)" == 206 ]]
printf 'complete\n' > "$DONE"
say "PASS finalized exact-RGB 4K MP4: $MP4"
