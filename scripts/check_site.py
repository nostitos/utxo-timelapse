#!/usr/bin/env python3
"""Validate the static guide without third-party packages or source datasets."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse, unquote
import json,re,sys
ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'site'
errors=[];checked=0
class Page(HTMLParser):
 def __init__(self,path):
  super().__init__();self.path=path;self.ids=set();self.links=[];self.settings=set();self.feed(path.read_text())
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if 'id' in attrs:
   if attrs['id'] in self.ids: errors.append(f'{self.path}: duplicate id {attrs["id"]}')
   self.ids.add(attrs['id'])
  if 'data-setting' in attrs:self.settings.add(attrs['data-setting'])
  if tag=='img' and 'alt' not in attrs:errors.append(f'{self.path}: image without alt')
  for key in ['href','src','data-src','poster']:
   if attrs.get(key):self.links.append(attrs[key])
pages={p.resolve():Page(p) for p in SITE.rglob('*.html')}
def check(source,link):
 global checked
 url=urlparse(link)
 if url.scheme or url.netloc:
  prefix='https://github.com/nostitos/utxo-timelapse/'
  if link.startswith(prefix) and re.match(r'(blob|tree)/master/',url.path[len('/nostitos/utxo-timelapse/'):]):
   path=re.sub(r'^(blob|tree)/master/','',unquote(url.path[len('/nostitos/utxo-timelapse/'):]))
   if path and not (ROOT/path).exists():errors.append(f'{source}: missing source link {link}')
  return
 if not url.path:target=source.resolve()
 else:target=(SITE/url.path.removeprefix('/utxo-timelapse').lstrip('/') if url.path.startswith('/') else source.parent/unquote(url.path)).resolve()
 if target.is_dir():target/= 'index.html'
 if not target.exists():errors.append(f'{source}: missing {link}');return
 checked+=1
 if url.fragment and target.suffix=='.html' and target in pages and unquote(url.fragment) not in pages[target].ids:errors.append(f'{source}: missing anchor {link}')
for path,page in pages.items():
 for link in page.links:check(path,link)
for css in SITE.rglob('*.css'):
 for link in re.findall(r'url\([\'\"]?([^\)\'\"]+)',css.read_text()):check(css,link)
for source in [ROOT/'README.md',ROOT/'AGENTS.md',ROOT/'CLAUDE.md',ROOT/'GLOSSARY.md',*ROOT.glob('docs/*.md'),SITE/'README.md']:
 for link in re.findall(r'\]\(([^ )]+)(?:[^)]*)\)',source.read_text()):
  if link.startswith(('/', '#')):continue
  check(source,link)
keys=set(re.findall(r'load(?:Array)?<[^\n]+?\(data, "(\w+)"\)',(ROOT/'src/cpp/app/Cfg.cpp').read_text()))
documented=pages[(SITE/'technical.html').resolve()].settings
if keys!=documented:errors.append(f'Configuration coverage differs: missing={keys-documented}, extra={documented-keys}')
files=[p for p in SITE.rglob('*') if p.is_file()]
size=sum(p.stat().st_size for p in files)
if size>80*1024**2:errors.append(f'Site exceeds 80 MiB: {size}')
for p in files:
 if p.stat().st_size>10*1024**2:errors.append(f'Asset exceeds 10 MiB: {p}')
manifest=json.loads((SITE/'assets/manifest.json').read_text())
for frame in manifest['frames']:
 for rendition in ['1080','4k']:check(SITE/'index.html',f'assets/frames/{frame["block"]}-{rendition}.webp')
for clip in manifest['clips']:
 for ext in ['mp4','webm']:check(SITE/'index.html',f'assets/clips/{clip["name"]}.{ext}')
if errors:
 print('\n'.join(errors));sys.exit(1)
print(f'Static guide: {checked} local links/assets, {len(keys)} settings, {len(files)} files, {size/1024**2:.1f} MiB. All checks passed.')
