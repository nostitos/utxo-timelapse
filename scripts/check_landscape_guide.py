#!/usr/bin/env python3
"""Validates the static Bitcoin Landscape guide (landscape/web/guide/). Standard library only.

    python3 scripts/check_landscape_guide.py [--root landscape/web/guide]

HTML: unique ids, alt on every <img>, no inline <script>, no on* handlers or javascript: URLs,
every local href/src/poster/srcset/data-src target exists ('/'-rooted paths resolve against the
web root, the parent of --root), in-page #anchors exist, GitHub blob/tree links on master name an
existing repository path, and <a data-scene="ID"> matches the manifest scene's link.
assets/manifest.json: listed files exist, nothing under assets/ is unlisted (except manifest.json
and *.svg diagrams), per-file and total size budgets, and an initial-transfer estimate.
Exit 0 when valid, 1 on any error, 2 when the guide directory does not exist.
"""
import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO / 'landscape' / 'web' / 'guide'
MIB = 1024 * 1024
FILM_LIMIT = 24 * MIB
FILE_LIMIT = 8 * MIB
TOTAL_LIMIT = 120 * MIB
INITIAL_LIMIT = 1.5 * MIB
URL_ATTRS = ('href', 'src', 'poster', 'data-src')
GITHUB = re.compile(r'^https://github\.com/nostitos/utxo-timelapse/(?:blob|tree)/master/([^?#]+)')
SCHEME = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements = []  # (tag, attrs dict, line)
        self.scripts = []   # (attrs, line) of <script> start tags

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v if v is not None else '') for k, v in attrs}
        line = self.getpos()[0]
        self.elements.append((tag, a, line))
        if tag == 'script':
            self.scripts.append((a, line))

    handle_startendtag = handle_starttag


def parse(path):
    page = Page()
    page.feed(path.read_text(encoding='utf-8'))
    page.close()
    return page


def split_url(value):
    """(path, fragment) of a URL without query."""
    base, _, frag = value.partition('#')
    return base.partition('?')[0], frag


def ids_of(page):
    return {a['id'] for _, a, _ in page.elements if a.get('id')}


class Checker:
    def __init__(self, root):
        self.root = root
        self.web = root.parent
        self.errors = []
        self.pages = {}

    def err(self, where, msg):
        self.errors.append('%s: %s' % (where, msg))

    def rel(self, path):
        try:
            return str(path.relative_to(REPO))
        except ValueError:
            return str(path)

    def page(self, path):
        if path not in self.pages:
            self.pages[path] = parse(path)
        return self.pages[path]

    def resolve(self, html_file, url_path):
        """Local file a URL path names (directories and trailing slashes mean index.html)."""
        p = unquote(url_path)
        target = (self.web / p.lstrip('/')) if p.startswith('/') else (html_file.parent / p)
        if p.endswith('/') or p == '' or target.is_dir():
            target = target / 'index.html'
        return target.resolve()

    def check_url(self, html_file, where, attr, value, ids):
        v = value.strip()
        if not v:
            self.err(where, 'empty %s' % attr)
            return
        if re.sub(r'[\s\x00-\x1f]', '', v).lower().startswith('javascript:'):
            self.err(where, 'javascript: URL in %s' % attr)
            return
        m = GITHUB.match(v)
        if m:
            repo_path = unquote(m.group(1)).rstrip('/')
            if not (REPO / repo_path).exists():
                self.err(where, 'GitHub link to a missing repository path: %s' % repo_path)
            return
        if SCHEME.match(v) or v.startswith('//'):
            return
        path, frag = split_url(v)
        if not path:
            if frag and frag not in ids:
                self.err(where, 'in-page anchor #%s does not exist' % frag)
            return
        target = self.resolve(html_file, path)
        web = self.web.resolve()
        if target != web and web not in target.parents:
            self.err(where, '%s %s points outside the web root' % (attr, v))
        elif not target.is_file():
            self.err(where, '%s %s: missing %s' % (attr, v, self.rel(target)))
        elif frag and target.suffix == '.html' and self.root.resolve() in target.parents:
            if frag not in ids_of(self.page(target)):
                self.err(where, 'anchor #%s does not exist in %s' % (frag, self.rel(target)))

    def check_html(self, html_file, scenes):
        name = self.rel(html_file)
        page = self.page(html_file)
        seen = {}
        for tag, a, line in page.elements:
            i = a.get('id')
            if i:
                if i in seen:
                    self.err('%s:%d' % (name, line), 'duplicate id "%s" (first on line %d)' % (i, seen[i]))
                else:
                    seen[i] = line
        ids = set(seen)
        for a, line in page.scripts:
            if not a.get('src'):
                self.err('%s:%d' % (name, line), 'inline <script> (use a src file)')
        for tag, a, line in page.elements:
            where = '%s:%d' % (name, line)
            if tag == 'img' and 'alt' not in a:
                self.err(where, '<img> without alt')
            for k, v in a.items():
                if k.startswith('on'):
                    self.err(where, 'event-handler attribute %s' % k)
                elif k not in URL_ATTRS and k != 'srcset' and re.sub(r'[\s\x00-\x1f]', '', v).lower().startswith('javascript:'):
                    self.err(where, 'javascript: URL in %s' % k)
            for k in URL_ATTRS:
                if k in a:
                    self.check_url(html_file, where, k, a[k], ids)
            if 'srcset' in a and not a['srcset'].strip().startswith('data:'):
                for part in a['srcset'].split(','):
                    tokens = part.split()
                    if tokens:
                        self.check_url(html_file, where, 'srcset', tokens[0], ids)
            if tag == 'a' and 'data-scene' in a:
                sid = a['data-scene']
                if sid not in scenes:
                    self.err(where, 'data-scene "%s" is not in the manifest' % sid)
                elif a.get('href') != scenes[sid]:
                    self.err(where, 'data-scene "%s" href %r != manifest link %r' % (sid, a.get('href'), scenes[sid]))

    def media_path(self, assets, value):
        p = Path(value)
        return (self.root / p) if p.parts and p.parts[0] == 'assets' else (assets / p)

    def check_manifest(self):
        """Returns (scenes {id: link}, listed files, media count); listed files are size-checked here."""
        assets = self.root / 'assets'
        mpath = assets / 'manifest.json'
        name = self.rel(mpath)
        if not mpath.is_file():
            self.err(name, 'missing')
            return {}, set(), 0
        try:
            m = json.loads(mpath.read_text(encoding='utf-8'))
        except ValueError as e:
            self.err(name, 'invalid JSON: %s' % e)
            return {}, set(), 0
        if not isinstance(m, dict) or not isinstance(m.get('edition'), dict):
            self.err(name, '"edition" must be an object')
        m = m if isinstance(m, dict) else {}
        scenes = {}
        for i, s in enumerate(m.get('scenes') if isinstance(m.get('scenes'), list) else []):
            where = '%s scenes[%d]' % (name, i)
            if not isinstance(s, dict) or not isinstance(s.get('id'), str) or not isinstance(s.get('link'), str):
                self.err(where, 'needs string "id" and "link"')
                continue
            if s['id'] in scenes:
                self.err(where, 'duplicate scene id "%s"' % s['id'])
            link = s['link']
            if not (link.startswith('/#') and 'b=' in link and 'cam=' in link):
                self.err(where, 'link %r must start with "/#" and carry b= and cam=' % link)
            scenes[s['id']] = link
        if not isinstance(m.get('scenes'), list):
            self.err(name, '"scenes" must be a list')
        listed = set()
        media = m.get('media') if isinstance(m.get('media'), list) else []
        if not isinstance(m.get('media'), list):
            self.err(name, '"media" must be a list')
        media_ids = set()
        for i, e in enumerate(media):
            where = '%s media[%d]' % (name, i)
            if not isinstance(e, dict) or not isinstance(e.get('id'), str) or not isinstance(e.get('kind'), str) \
                    or not isinstance(e.get('files'), dict) or not e['files']:
                self.err(where, 'needs string "id", "kind" and a non-empty "files" object')
                continue
            where = '%s media "%s"' % (name, e['id'])
            if e['id'] in media_ids:
                self.err(where, 'duplicate media id')
            media_ids.add(e['id'])
            sizes = {}
            for fname, value in e['files'].items():
                if not isinstance(value, str):
                    self.err(where, 'file "%s" must be a path string' % fname)
                    continue
                f = self.media_path(assets, value).resolve()
                if self.root.resolve() not in f.parents:
                    self.err(where, 'file "%s" (%s) is outside the guide' % (fname, value))
                    continue
                if not f.is_file():
                    self.err(where, 'file "%s" missing: %s' % (fname, self.rel(f)))
                    continue
                listed.add(f)
                sizes[fname] = f.stat().st_size
                limit = FILM_LIMIT if e['kind'] == 'film' else FILE_LIMIT
                if sizes[fname] > limit:
                    self.err(where, '%s is %.2f MiB, over the %s limit of %d MiB'
                             % (value, sizes[fname] / MIB, e['kind'], limit // MIB))
            declared = e.get('bytes')
            if isinstance(declared, int) and not isinstance(declared, bool) and len(sizes) == len(e['files']):
                if declared != sum(sizes.values()):
                    self.err(where, '"bytes" %d != files total %d' % (declared, sum(sizes.values())))
            elif isinstance(declared, dict):
                for fname, b in declared.items():
                    if fname in sizes and b != sizes[fname]:
                        self.err(where, '"bytes".%s %r != actual %d' % (fname, b, sizes[fname]))
        if assets.is_dir():
            for f in sorted(assets.rglob('*')):
                if not f.is_file() or f.name.startswith('.') or f == mpath or f.suffix.lower() == '.svg':
                    continue
                if f.resolve() not in listed:
                    self.err(self.rel(f), 'not listed in any manifest media entry')
        return scenes, listed, len(media)

    def initial_estimate(self):
        total = 0
        counted = set()

        def add(path):
            nonlocal total
            p = path.resolve()
            if p not in counted and p.is_file():
                counted.add(p)
                total += p.stat().st_size

        index = self.root / 'index.html'
        for f in (index, self.root / 'guide.css', self.root / 'guide.js'):
            add(f)
        fonts_css = self.web / 'fonts' / 'fonts.css'
        add(fonts_css)
        if fonts_css.is_file():
            for u in re.findall(r'url\(\s*[\'"]?([^\'")]+\.woff2)[\'"]?\s*\)', fonts_css.read_text(encoding='utf-8')):
                add(fonts_css.parent / unquote(split_url(u)[0]))
        if index.is_file():
            for tag, a, _ in self.page(index).elements:
                if tag == 'img' and a.get('loading', '').lower() != 'lazy' and a.get('src'):
                    url = a['src']
                elif tag == 'video' and a.get('poster') and 'data-lazy-poster' not in a:
                    url = a['poster']
                else:
                    continue
                if not SCHEME.match(url) and not url.startswith('//'):
                    add(self.resolve(index, split_url(url)[0]))
        return total

    def run(self):
        scenes, listed, media_count = self.check_manifest()
        html_files = sorted(self.root.rglob('*.html'))
        if not (self.root / 'index.html').is_file():
            self.err(self.rel(self.root), 'index.html is missing')
        for f in html_files:
            self.check_html(f, scenes)
        total = 0
        for f in self.root.rglob('*'):
            if f.is_file() and not f.name.startswith('.'):
                size = f.stat().st_size
                total += size
                if f.resolve() not in listed and size > FILE_LIMIT:
                    self.err(self.rel(f), '%.2f MiB is over the %d MiB per-file limit' % (size / MIB, FILE_LIMIT // MIB))
        if total > TOTAL_LIMIT:
            self.err(self.rel(self.root), 'total %.1f MiB is over %d MiB' % (total / MIB, TOTAL_LIMIT // MIB))
        initial = self.initial_estimate()
        print('initial transfer estimate: %.0f KiB (limit %.0f KiB)' % (initial / 1024, INITIAL_LIMIT / 1024))
        if initial > INITIAL_LIMIT:
            self.err('initial transfer', '%.2f MiB is over %.1f MiB' % (initial / MIB, INITIAL_LIMIT / MIB))
        for e in self.errors:
            print('ERROR ' + e)
        status = 'OK' if not self.errors else '%d error%s' % (len(self.errors), '' if len(self.errors) == 1 else 's')
        print('check_landscape_guide: %d HTML file%s, %d media entr%s, %d scene%s, %.1f MiB total, initial %.0f KiB: %s'
              % (len(html_files), '' if len(html_files) == 1 else 's', media_count, 'y' if media_count == 1 else 'ies',
                 len(scenes), '' if len(scenes) == 1 else 's', total / MIB, initial / 1024, status))
        return 1 if self.errors else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--root', type=Path, default=DEFAULT_ROOT, help='guide directory (default landscape/web/guide)')
    args = ap.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print('check_landscape_guide: %s does not exist yet' % root)
        return 2
    return Checker(root).run()


if __name__ == '__main__':
    sys.exit(main())
