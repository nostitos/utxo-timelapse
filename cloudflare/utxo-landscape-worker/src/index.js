// UTXO Timelapse Landscape at 3d.bitcointimelapse.com.
//
// Serves the static app (Workers Static Assets, binding ASSETS), the immutable landscape
// dataset from the private R2 bucket (landscape/<id>/… at /dataset/<id>/…, its snapshots and
// chunks stored once for every dataset at landscape/blobs/<sha256>), the owner
// highlight data (landscape/owners/<id>/… at /owners/<id>/…), and the cell lifecycle API
// (/api/landscape/cell), which reuses the 2D explorer's history shards and query code. The
// guide's film, too large for a static asset, comes from the same bucket
// (landscape/guide/film/… at /guide/film/…). See README.md.
import { RELEASE } from './release.js';
import { lifecycleJson } from '../../utxo-video-worker/src/history.js';
import { CONFIG } from '../../utxo-video-worker/src/mapping.js';
import { serveObject, parseRange, etagMatches } from '../../utxo-video-worker/src/r2_object.js';

export const BLOCKS_PER_COLUMN = 64;
export const ROWS = 2072;
const DATASET_ID = /^d\d{1,7}-\d{8}$/;
const DATASET_FILE = /^(?:manifest\.json|rows\.bin|blocktimes\.bin|blocktimes-delta\.bin|chunks\.json|chunks\/\d{5}\.bin|snapshots\/\d{7}\.bin)$/;
// Snapshots and chunks are shared by every dataset that contains them, under the SHA-256 that
// the dataset's manifest.json and chunks.json record, so a new dataset stores only new files.
const BLOB_FILE = /^(?:chunks\/\d{5}|snapshots\/\d{7})\.bin$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OWNERS_ID = /^o\d{1,7}-\d{8}$/;
const OWNERS_FILE = /^(?:owners\.json|long\.bin|short\/\d{4}\.bin)$/;
// Films named with their content hash, so they are immutable like the dataset.
const GUIDE_FILM = /^\/guide\/film\/([a-z0-9][a-z0-9.-]{0,120}\.mp4)$/;
// Every spelling of the guide's address opens it: /guide, /Guide/, /GUIDE, /guide.html and
// /guide/index.html redirect to /guide/. Files under /guide/ keep their exact paths.
const GUIDE_ALIAS = /^\/guide(?:\/(?:index\.html?)?|\.html?)?$/i;
const INT64_MAX_AS_JSON = 9223372036854776000; // C++ INT64_MAX after JSON's double conversion (as /api/pixel)

const CONTENT_TYPES = { json: 'application/json', bin: 'application/octet-stream', mp4: 'video/mp4' };
// Change chunks and the delta-coded block times are read whole and shrink by about a third when
// compressed. Cloudflare compresses responses by content type and leaves application/octet-stream
// alone, so these are labelled with a binary type it does compress; the app reads them as bytes.
// Snapshots stay octet-stream: they are read in ranges (206), which are never compressed.
const COMPRESSED_FILE = /^(?:chunks\/\d{5}\.bin|blocktimes-delta\.bin)$/;

export function datasetIds() {
  return [RELEASE.dataset.id, ...RELEASE.retainedDatasetIds];
}

export function ownersIds() {
  return [...(RELEASE.owners ? [RELEASE.owners.id] : []), ...RELEASE.retainedOwnersIds];
}

/** mapHash: the CSP hash of the page's inline import map (index.html's by default). */
export function contentSecurityPolicy(mapHash = RELEASE.importMapHash) {
  return [
    "default-src 'self'",
    // Cloudflare Web Analytics: the edge injects its beacon script, which reports to
    // cloudflareinsights.com. It loads with CORS, as cross-origin isolation requires.
    "script-src 'self' '" + mapHash + "' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    "connect-src 'self' https://cloudflareinsights.com",
    "img-src 'self' data: blob:",
    // lil-gui (the settings panel) embeds its icon font as a data: URL.
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

function securityHeaders(headers = new Headers()) {
  headers.set('Content-Security-Policy', contentSecurityPolicy());
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Worker-Version', RELEASE.version);
  if (!headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return headers;
}

function respond(body, status, headers = {}) {
  return new Response(body, { status, headers: securityHeaders(new Headers(headers)) });
}

function json(value, status = 200, cache = 'no-store') {
  return respond(JSON.stringify(value), status, { 'Content-Type': 'application/json', 'Cache-Control': cache });
}

const notFound = () => respond('Not found\n', 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });

const toGuide = (url) => respond(null, 302, { Location: '/guide/' + url.search, 'Cache-Control': 'no-store' });

/** A page below /guide/ (any case) whose last segment has no extension, e.g. /guide/views. */
export function isGuidePage(path) {
  return path.length > 7 && path.slice(0, 7).toLowerCase() === '/guide/' &&
    !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/** A dataset, owner or film file: an immutable R2 object (../../utxo-video-worker/src/r2_object.js). */
function serveFile(request, env, ctx, key, file) {
  const contentType = COMPRESSED_FILE.test(file) ? 'application/x-protobuf'
    : CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1)] || 'application/octet-stream';
  return serveObject(request, env, ctx, key, { contentType, secure: securityHeaders });
}

function datasetIndex() {
  const current = RELEASE.dataset;
  return {
    format: 'utxo-landscape-index-1',
    version: RELEASE.version,
    current: { id: current.id, url: '/dataset/' + current.id + '/', tip: current.tip },
    datasets: datasetIds().map((id) => ({ id, url: '/dataset/' + id + '/' })),
  };
}

const blobTables = new Map();
/** file -> SHA-256 of one dataset's snapshots and chunks, read once per isolate. */
function blobTable(env, id) {
  let table = blobTables.get(id);
  if (!table) {
    table = Promise.all(['manifest.json', 'chunks.json'].map(async (name) => {
      const object = await env.VIDEO_BUCKET.get('landscape/' + id + '/' + name);
      if (!object) throw new Error(id + '/' + name + ' is unavailable');
      return object.json();
    })).then(([manifest, chunks]) => new Map([...manifest.snapshots, ...chunks.chunks].map((e) => [e.file, e.sha256])))
      .catch((err) => {
        blobTables.delete(id);
        throw err;
      });
    blobTables.set(id, table);
  }
  return table;
}

/** R2 key of an allowed dataset file, or null for a snapshot or chunk the dataset does not list. */
async function datasetKey(env, id, file) {
  if (!BLOB_FILE.test(file)) return 'landscape/' + id + '/' + file;
  const sha = (await blobTable(env, id)).get(file);
  return SHA256.test(sha || '') ? 'landscape/blobs/' + sha : null;
}

// ---- cell lifecycle API -------------------------------------------------------------------

let rowsPromise = null;
/** minAmt[r] of the current dataset (landscape/<id>/rows.bin): the compiled C++ row table. */
async function rowTable(env) {
  if (!rowsPromise) {
    rowsPromise = (async () => {
      const object = await env.VIDEO_BUCKET.get('landscape/' + RELEASE.dataset.id + '/rows.bin');
      if (!object) throw new Error('rows.bin is unavailable');
      const buffer = await object.arrayBuffer();
      if (buffer.byteLength !== ROWS * 8) throw new Error('bad rows.bin length');
      return new Float64Array(buffer);
    })().catch((err) => {
      rowsPromise = null;
      throw err;
    });
  }
  return rowsPromise;
}

/**
 * Satoshi range [min, max] of graph row r from minAmt (minAmt[r] = smallest amount whose row is
 * at most r, so row r holds [minAmt[r], minAmt[r-1] - 1]); null when no amount maps to the row.
 * Identical to the native explorer's table, including the fast-math boundary at row 49.
 */
export function rowRange(minAmt, r) {
  const lo = minAmt[r];
  if (r === 0) return [lo, INT64_MAX_AS_JSON];
  const hi = minAmt[r - 1] - 1;
  return hi >= lo ? [lo, hi] : null;
}

/** {block, col, row} of a cell request, block at most the history's last, or {error}. */
export function cellQuery(url) {
  const raw = ['block', 'col', 'row'].map((n) => url.searchParams.get(n));
  if (raw.some((v) => v === null || !/^\d{1,10}$/.test(v))) return { error: 'block, col, row must be non-negative integers' };
  const [block, col, row] = raw.map(Number);
  if (col >= Math.ceil((RELEASE.dataset.tip + 1) / BLOCKS_PER_COLUMN)) return { error: 'col outside the landscape' };
  if (row >= ROWS) return { error: 'row outside the landscape' };
  return { block: Math.min(block, CONFIG.numBlocks - 1), col, row };
}

export async function cellResponse({ block, col, row }, env) {
  const tip = CONFIG.numBlocks - 1; // the history's last block, which a 3D-only update passes
  const h1 = col * BLOCKS_PER_COLUMN;
  const h2 = Math.min(h1 + BLOCKS_PER_COLUMN - 1, tip);
  const lead = { col, row };
  const sats = rowRange(await rowTable(env), row);
  if (!sats) return json({ ...lead, blockRange: null, satRange: null, count: 0, utxos: [] });
  if (h1 > tip) return json({ ...lead, block, cutoffBlock: tip, blockRange: null, satRange: sats, count: 0, utxos: [] });
  return lifecycleJson(env, { block, heights: [h1, h2], sats, row, lead });
}

function tokenBucket(ip) {
  const now = Date.now();
  const [rate, burst] = [8, 20];
  const entry = tokenBucket.entries.get(ip) || { tokens: burst, at: now };
  entry.tokens = Math.min(burst, entry.tokens + ((now - entry.at) / 1000) * rate);
  entry.at = now;
  const allowed = entry.tokens >= 1;
  if (allowed) entry.tokens -= 1;
  tokenBucket.entries.set(ip, entry);
  if (tokenBucket.entries.size > 10000) tokenBucket.entries.clear();
  return allowed;
}
tokenBucket.entries = new Map();

async function cachedCell(request, env, ctx, url) {
  const q = cellQuery(url);
  if (q.error) return json({ error: q.error }, 400);
  const cache = globalThis.caches && caches.default;
  // The validated query alone is the key: extra parameters and blocks past the history share one entry.
  const keyUrl = new URL('/api/landscape/cell?block=' + q.block + '&col=' + q.col + '&row=' + q.row + '&__release=' + RELEASE.version, url);
  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return respond(hit.body, hit.status, Object.fromEntries(hit.headers));
  }
  const produced = await cellResponse(q, env);
  if (!produced.ok) return respond(produced.body, produced.status, Object.fromEntries(produced.headers));
  const text = await produced.text();
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400, s-maxage=86400' };
  if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(text, { headers })));
  return respond(text, 200, headers);
}

// ---- static app ---------------------------------------------------------------------------

function assetCacheControl(pathname, contentType) {
  if (/^text\/html/.test(contentType || '') || pathname === '/' || pathname.endsWith('/')) return 'no-cache';
  if (pathname.startsWith('/guide/')) return 'public, max-age=3600';
  if (pathname === '/og.jpg' || pathname === '/favicon.svg') return 'public, max-age=86400';
  return 'public, max-age=0, must-revalidate';
}

function assetResponse(response, pathname) {
  const headers = securityHeaders(new Headers(response.headers));
  // Link-preview images: social sites and chat apps may load them from their own origins.
  if (pathname === '/og.jpg' || pathname.startsWith('/guide/assets/social/')) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (response.status === 200 || response.status === 304) {
    headers.set('Cache-Control', assetCacheControl(pathname, response.headers.get('Content-Type')));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function serveAsset(request, env) {
  const pathname = new URL(request.url).pathname;
  const hash = pathname === '/' ? await appHash(env) : null;
  if (!hash) return assetResponse(await env.ASSETS.fetch(request), pathname);
  // The app shell names this deployment's files by content hash. Rewritten, it carries no
  // validator, so a browser never keeps a copy that names an older deployment's files.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const shell = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers }));
  if (shell.status !== 200) return assetResponse(shell, pathname);
  const html = (await shell.text()).replace(APP_LINKS, '$1="/app/' + hash + '/$2"').replaceAll('"./vendor/', '"/app/' + hash + '/vendor/');
  const out = assetResponse(new Response(request.method === 'HEAD' ? null : html, shell), pathname);
  for (const name of ['ETag', 'Last-Modified', 'Content-Length']) out.headers.delete(name);
  // The rewritten import map has its own hash, which the policy allows instead of index.html's.
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (map) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(map[1])));
    out.headers.set('Content-Security-Policy', contentSecurityPolicy('sha256-' + btoa(String.fromCharCode(...digest))));
  }
  return out;
}

// The app shell's own references to app files (landscape/web/index.html); its import map's
// "./vendor/" addresses are rewritten too.
const APP_LINKS = /(src|href)="\.\/(entry\.js|app\.css|fonts\/fonts\.css)"/g;
let appHashPromise = null;
/** Content hash of the deployed app files (landscape/tools/app-hash.mjs, run at deploy), or null. */
function appHash(env) {
  appHashPromise ??= env.ASSETS.fetch(new Request('https://assets.local/app-hash.txt'))
    .then(async (r) => {
      const text = r.ok ? (await r.text()).trim() : '';
      return /^[0-9a-f]{16}$/.test(text) ? text : null;
    })
    .catch(() => null);
  return appHashPromise;
}

/**
 * /app/<hash>/<file>: an app file. Under the current hash its bytes never change, so browsers keep
 * it as immutable; an older tab's hash gets today's file, revalidated like any asset.
 */
async function serveAppFile(request, env, hash, file) {
  if (/^(?:guide|dev)\//.test(file) || file.split('/').some((p) => p.startsWith('.'))) return notFound();
  const url = new URL(request.url);
  url.pathname = '/' + file;
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const out = assetResponse(asset, url.pathname);
  if (hash === await appHash(env) && (asset.status === 200 || asset.status === 304)) {
    out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  return out;
}

// Guide media (<video>, <audio>, <track>): Workers Static Assets ignores Range, and Safari only
// plays a <video> whose server answers byte ranges with 206, so the Worker slices these itself.
const GUIDE_MEDIA = /^\/guide\/.+\.(?:mp4|webm|m4a|mp3|vtt)$/i;

/** Passes bytes [offset, offset + length) of a byte stream through, dropping the rest. */
function byteSlice(offset, length) {
  let skip = offset;
  let left = length;
  return new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (left <= 0) return;
      let start = 0;
      if (skip > 0) {
        if (bytes.byteLength <= skip) { skip -= bytes.byteLength; return; }
        start = skip;
        skip = 0;
      }
      const end = Math.min(bytes.byteLength, start + left);
      controller.enqueue(bytes.subarray(start, end));
      left -= end - start;
      if (left <= 0) controller.terminate();
    },
  });
}

async function serveGuideMedia(request, env, pathname) {
  // Fetch the whole asset unconditionally; the ranges and validators are answered here.
  const upstream = new Headers(request.headers);
  for (const name of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) upstream.delete(name);
  const asset = await env.ASSETS.fetch(new Request(request.url, { method: 'GET', headers: upstream, redirect: 'manual' }));
  if (asset.status !== 200) return assetResponse(asset, pathname);

  const declared = asset.headers.get('Content-Length');
  const streamable = !asset.headers.has('Content-Encoding') && declared !== null && /^\d+$/.test(declared);
  let buffered = null;
  let size;
  if (streamable) size = Number(declared);
  else {
    buffered = new Uint8Array(await asset.arrayBuffer());
    size = buffered.byteLength;
  }
  const drop = () => { if (!buffered && asset.body) asset.body.cancel().catch(() => {}); };

  const etag = asset.headers.get('ETag');
  const headers = new Headers(asset.headers);
  for (const name of ['Content-Length', 'Content-Encoding', 'Content-Range', 'Transfer-Encoding']) headers.delete(name);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', assetCacheControl(pathname, headers.get('Content-Type')));
  const reply = (status, body) => new Response(body, { status, headers: securityHeaders(headers) });

  if (etag && etagMatches(request.headers.get('If-None-Match'), etag)) {
    drop();
    return reply(304, null);
  }
  // Range only applies to GET. HEAD reports the complete representation even if the
  // caller supplied a valid or unsatisfiable range (RFC 9110 section 14.2).
  let rangeHeader = request.method === 'GET' ? request.headers.get('Range') : null;
  const ifRange = request.headers.get('If-Range');
  // If-Range needs a strong match (RFC 9110 13.1.5); a date or a stale ETag gets the whole file.
  if (rangeHeader && ifRange !== null && !(etag && !etag.startsWith('W/') && ifRange.trim() === etag)) rangeHeader = null;
  const range = parseRange(rangeHeader, size);
  if (range === undefined) {
    drop();
    return respond(null, 416, { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  }
  if (range) headers.set('Content-Range', 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + size);
  headers.set('Content-Length', String(range ? range.length : size));
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') {
    drop();
    return reply(status, null);
  }
  if (buffered) return reply(status, range ? buffered.subarray(range.offset, range.offset + range.length) : buffered);
  if (!range) return reply(status, asset.body);
  const sliced = asset.body.pipeThrough(byteSlice(range.offset, range.length));
  // A transformed stream has no known length; FixedLengthStream (Workers runtime) makes the
  // response carry the exact Content-Length a 206 needs instead of chunked encoding.
  if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(range.length);
    sliced.pipeTo(fixed.writable).catch(() => {});
    return reply(status, fixed.readable);
  }
  return reply(status, sliced);
}

// ---- router -------------------------------------------------------------------------------

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') {
    return respond(null, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, If-None-Match',
      'Access-Control-Max-Age': '86400',
      Allow: 'GET, HEAD, OPTIONS',
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respond('Method not allowed\n', 405, { Allow: 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (path === '/health') return respond('ok\n', 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  if (path === '/robots.txt') {
    return respond('User-agent: *\nAllow: /\nDisallow: /dataset/\nDisallow: /owners/\nDisallow: /api/\n', 200,
      { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  }
  if (path === '/dataset/index.json') return json(datasetIndex());
  if (path.startsWith('/dataset/')) {
    const m = /^\/dataset\/([^/]+)\/(.+)$/.exec(path);
    if (!m || !DATASET_ID.test(m[1]) || !datasetIds().includes(m[1]) || !DATASET_FILE.test(m[2])) return notFound();
    const key = await datasetKey(env, m[1], m[2]);
    return key ? serveFile(request, env, ctx, key, m[2]) : notFound();
  }
  if (path === '/owners/index.json') {
    const owners = RELEASE.owners;
    return owners ? json({ id: owners.id, url: '/owners/' + owners.id + '/', tip: owners.tip }) : notFound();
  }
  if (path.startsWith('/owners/')) {
    const m = /^\/owners\/([^/]+)\/(.+)$/.exec(path);
    if (!m || !OWNERS_ID.test(m[1]) || !ownersIds().includes(m[1]) || !OWNERS_FILE.test(m[2])) return notFound();
    return serveFile(request, env, ctx, 'landscape/owners/' + m[1] + '/' + m[2], m[2]);
  }
  if (path === '/api/landscape/cell') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!tokenBucket(ip)) return respond(JSON.stringify({ error: 'rate limited' }), 429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    return cachedCell(request, env, ctx, url);
  }
  if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
  if (path === '/explorer/' || path === '/explorer.html') {
    return respond(null, 302, { Location: '/explorer' + url.search, 'Cache-Control': 'no-store' });
  }
  if (path === '/explorer') {
    // Serve the same shell at a stable explicit entry. Relative module URLs still
    // resolve from / because this URL has no trailing slash.
    const app = new URL(request.url);
    app.pathname = '/';
    return serveAsset(new Request(app, request), env);
  }
  if (path !== '/guide/' && GUIDE_ALIAS.test(path)) return toGuide(url);
  const appFile = /^\/app\/([0-9a-f]{16})\/(.+)$/.exec(path);
  if (appFile) return serveAppFile(request, env, appFile[1], appFile[2]);
  const film = GUIDE_FILM.exec(path);
  if (film) return serveFile(request, env, ctx, 'landscape/guide/film/' + film[1], film[1]);
  if (GUIDE_MEDIA.test(path)) return serveGuideMedia(request, env, path);
  const asset = await serveAsset(request, env);
  // A mistyped or retired page under the guide (/guide/views, /Guide/places/) opens the guide;
  // a missing file such as /guide/missing.css stays a 404.
  if (asset.status === 404 && isGuidePage(path)) return toGuide(url);
  return asset;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('request failed', new URL(request.url).pathname, error && error.stack ? error.stack : error);
      return json({ error: 'service temporarily unavailable' }, 503);
    }
  },
};
