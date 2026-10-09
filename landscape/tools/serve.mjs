#!/usr/bin/env node
// Local static server for the UTXO landscape (landscape/SPEC.md §5). Node 20, no dependencies.
//
//   node landscape/tools/serve.mjs --data "/Volumes/4T Data/buv_render/landscape_966827" \
//     [--port 12990] [--host 127.0.0.1] [--web landscape/web] [--log]
//
// Serves the web app at / and the dataset directory at /dataset/ with single-range Range
// support (including open and suffix ranges, 416 when unsatisfiable), HEAD, MIME types,
// path-traversal protection, COOP/COEP (cross-origin isolation for the worker), immutable
// caching for /dataset/ binaries and no-cache for app files and JSON entry points.
// (/data/ is an ordinary app path: landscape/web/data/ holds the shared JS modules.)
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.cube': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
});

const DEFAULT_WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
export const DATASET_PREFIX = '/dataset';

/**
 * Parses a Range header against a file size.
 * @returns {null | 'unsatisfiable' | {start:number, end:number}} null = ignore (serve 200)
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*([^,]*)$/i.exec(header);
  if (!m) return null; // multi-range or other units: ignore and serve the whole body
  const spec = m[1].trim();
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts || (parts[1] === '' && parts[2] === '')) return null;
  let start;
  let end;
  if (parts[1] === '') {
    const suffix = Number(parts[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(parts[1]);
    end = parts[2] === '' ? size - 1 : Math.min(Number(parts[2]), size - 1);
    if (parts[2] !== '' && Number(parts[2]) < start) return null; // invalid: ignore
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

function within(root, p) {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Creates (but does not start) the server. Options: {web, data, log}.
 * @returns {import('node:http').Server}
 */
export function createLandscapeServer({ web = DEFAULT_WEB, data = null, log = false } = {}) {
  const webRoot = resolve(web);
  const dataRoot = data ? resolve(data) : null;
  const realRoots = new Map();
  async function realRoot(root) {
    if (!realRoots.has(root)) realRoots.set(root, await realpath(root).catch(() => root));
    return realRoots.get(root);
  }

  async function handle(req, res) {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const send = (status, body, extra = {}) => {
      const text = body === undefined ? '' : String(body);
      res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...extra });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', { Allow: 'GET, HEAD' });

    let pathname;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(400, 'bad request');
    }
    if (pathname.includes('\0') || pathname.includes('\\')) return send(400, 'bad path');
    if (pathname.split('/').some((seg) => seg === '..')) return send(403, 'forbidden');

    let root = webRoot;
    let rel = pathname;
    let isData = false;
    if (pathname === DATASET_PREFIX || pathname.startsWith(DATASET_PREFIX + '/')) {
      if (!dataRoot) return send(404, 'no dataset directory configured (--data)');
      root = dataRoot;
      rel = pathname.slice(DATASET_PREFIX.length) || '/';
      isData = true;
    }
    let file = resolve(root, '.' + rel);
    if (!within(root, file)) return send(403, 'forbidden');

    let st;
    try {
      st = await stat(file);
      if (st.isDirectory()) {
        if (!pathname.endsWith('/')) {
          return send(301, 'moved', { Location: pathname + '/' });
        }
        if (isData) return send(404, 'not found');
        file = join(file, 'index.html');
        st = await stat(file);
      }
      if (!st.isFile()) return send(404, 'not found');
      const real = await realpath(file);
      if (!within(await realRoot(root), real)) return send(403, 'forbidden');
    } catch {
      return send(404, 'not found');
    }

    const ext = extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const entryJson = isData && ext === '.json';
    const cache = isData && !entryJson ? 'public, max-age=31536000, immutable' : 'no-cache';
    Object.assign(headers, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
    });

    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag) && !req.headers.range) {
      res.writeHead(304, headers);
      return res.end();
    }

    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + st.size, 'Content-Length': 0 });
      return res.end();
    }
    let status = 200;
    let start = 0;
    let end = st.size - 1;
    if (range) {
      status = 206;
      ({ start, end } = range);
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  const server = createServer((req, res) => {
    const t0 = log ? performance.now() : 0;
    if (log) res.on('finish', () => console.log(req.method + ' ' + req.url + ' ' + res.statusCode + ' ' + (performance.now() - t0).toFixed(1) + 'ms' + (req.headers.range ? ' ' + req.headers.range : '')));
    handle(req, res).catch((err) => {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('internal error'); }
      else res.destroy();
      console.error(err);
    });
  });
  server.keepAliveTimeout = 30000;
  return server;
}

function parseArgs(argv) {
  const o = { port: 12990, host: '127.0.0.1', data: null, web: DEFAULT_WEB, log: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--port': o.port = Number(val()); break;
      case '--host': o.host = val(); break;
      case '--data': o.data = val(); break;
      case '--web': o.web = val(); break;
      case '--log': o.log = true; break;
      case '--help': case '-h':
        console.log('usage: node landscape/tools/serve.mjs --data DIR [--port 12990] [--host 127.0.0.1] [--web DIR] [--log]');
        process.exit(0);
        break;
      default: throw new Error('unknown argument ' + a);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('bad --port');
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.data) {
    try {
      const st = await stat(opts.data);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch (err) {
      console.error('--data ' + opts.data + ': ' + err.message);
      process.exit(2);
    }
  }
  const server = createLandscapeServer(opts);
  server.listen(opts.port, opts.host, () => {
    const addr = server.address();
    console.log('UTXO landscape: http://' + opts.host + ':' + addr.port + '/  web=' + resolve(opts.web) + (opts.data ? '  /dataset/=' + resolve(opts.data) : '  (no --data, /dataset/ is 404)'));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
