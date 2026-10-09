// UTXO Timelapse Landscape at 3d.bitcointimelapse.com.
//
// Serves the static app (Workers Static Assets, binding ASSETS), the immutable landscape
// dataset from the private R2 bucket (landscape/<id>/… at /dataset/<id>/…), and the cell
// lifecycle API (/api/landscape/cell), which reuses the 2D explorer's history shards and
// query code. See README.md.
import { RELEASE } from './release.js';
import { lifecycleJson } from '../../utxo-video-worker/src/history.js';
import { CONFIG } from '../../utxo-video-worker/src/mapping.js';

export const BLOCKS_PER_COLUMN = 64;
export const ROWS = 2072;
const EDGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DATASET_ID = /^d\d{1,7}-\d{8}$/;
const DATASET_FILE = /^(?:manifest\.json|rows\.bin|blocktimes\.bin|chunks\.json|chunks\/\d{5}\.bin|snapshots\/\d{7}\.bin)$/;
const INT64_MAX_AS_JSON = 9223372036854776000; // C++ INT64_MAX after JSON's double conversion (as /api/pixel)

const CONTENT_TYPES = { json: 'application/json', bin: 'application/octet-stream' };

export function datasetIds() {
  return [RELEASE.dataset.id, ...RELEASE.retainedDatasetIds];
}

export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    // Cloudflare Web Analytics: the edge injects its beacon script, which reports to
    // cloudflareinsights.com. It loads with CORS, as cross-origin isolation requires.
    "script-src 'self' '" + RELEASE.importMapHash + "' https://static.cloudflareinsights.com",
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

/**
 * Parses a Range header against an object size. Returns null for "whole object" (no header,
 * or a form this server does not support, such as multiple ranges, which RFC 9110 allows a
 * server to ignore), undefined for an unsatisfiable single range, else {offset, length}.
 */
export function parseRange(value, size) {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return undefined;
    const start = Math.max(0, size - suffix);
    return { offset: start, length: size - start };
  }
  const start = Number(m[1]);
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return undefined;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

function datasetHeaders(file, size, etag) {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  return {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Object-Size': String(size),
  };
}

function datasetResponse(status, body, base, range, size) {
  const headers = { ...base };
  if (range) {
    headers['Content-Range'] = 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + size;
    headers['Content-Length'] = String(range.length);
  } else if (status === 200) {
    headers['Content-Length'] = String(size);
  }
  delete headers['X-Object-Size'];
  return respond(body, status, headers);
}

/** Edge-cache key for a dataset object or one closed byte range of it (same hostname as the request). */
function cacheKeyFor(request, key, range) {
  const u = new URL(request.url);
  u.pathname = '/__landscape-cache/' + key;
  u.search = '?r=' + (range ? range.offset + '-' + (range.offset + range.length - 1) : 'all');
  return new Request(u.toString(), { method: 'GET' });
}

/** Explicit "bytes=a-b" ranges can be looked up in the edge cache before the object size is known. */
function explicitRange(value) {
  const m = value ? /^bytes=(\d+)-(\d+)$/.exec(value.trim()) : null;
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && b >= a ? { offset: a, length: b - a + 1 } : null;
}

async function serveDataset(request, env, ctx, id, file) {
  const key = 'landscape/' + id + '/' + file;
  const rangeHeader = request.headers.get('Range');
  const isGet = request.method === 'GET';
  const cache = globalThis.caches && caches.default;

  // Fast path: a cached whole object or cached closed range (immutable, so no R2 call).
  const early = rangeHeader ? explicitRange(rangeHeader) : null;
  if (cache && isGet && (!rangeHeader || early)) {
    const hit = await cache.match(cacheKeyFor(request, key, early));
    if (hit) {
      const size = Number(hit.headers.get('X-Object-Size'));
      const etag = hit.headers.get('ETag');
      const base = datasetHeaders(file, size, etag);
      if (etagMatches(request.headers.get('If-None-Match'), etag)) return datasetResponse(304, null, base, null, size);
      return datasetResponse(early ? 206 : 200, hit.body, base, early, size);
    }
  }

  const meta = await env.VIDEO_BUCKET.head(key);
  if (!meta) return notFound();
  const size = meta.size;
  const base = datasetHeaders(file, size, meta.httpEtag);
  if (etagMatches(request.headers.get('If-None-Match'), meta.httpEtag)) return datasetResponse(304, null, base, null, size);
  const range = parseRange(rangeHeader, size);
  if (range === undefined) {
    return respond(null, 416, { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  }
  const status = range ? 206 : 200;
  if (!isGet) return datasetResponse(status, null, base, range, size);
  const object = await env.VIDEO_BUCKET.get(key, range ? { range } : undefined);
  if (!object) return notFound();
  const length = range ? range.length : size;
  let body = object.body;
  if (cache && length <= EDGE_CACHE_MAX_BYTES) {
    const [client, stored] = body.tee();
    body = client;
    const storedHeaders = new Headers({
      'Content-Type': base['Content-Type'], 'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: meta.httpEtag, 'X-Object-Size': String(size), 'Content-Length': String(length),
    });
    ctx.waitUntil(cache.put(cacheKeyFor(request, key, range), new Response(stored, { status: 200, headers: storedHeaders })));
  }
  return datasetResponse(status, body, base, range, size);
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

export async function cellResponse(url, env) {
  const raw = ['block', 'col', 'row'].map((n) => url.searchParams.get(n));
  if (raw.some((v) => v === null || !/^\d{1,10}$/.test(v))) return json({ error: 'block, col, row must be non-negative integers' }, 400);
  const [rawBlock, col, row] = raw.map(Number);
  const numBlocks = CONFIG.numBlocks;
  if (col >= Math.ceil(numBlocks / BLOCKS_PER_COLUMN)) return json({ error: 'col outside the landscape' }, 400);
  if (row >= ROWS) return json({ error: 'row outside the landscape' }, 400);
  const block = Math.min(rawBlock, numBlocks - 1);
  const h1 = col * BLOCKS_PER_COLUMN;
  const h2 = Math.min(h1 + BLOCKS_PER_COLUMN - 1, numBlocks - 1);
  const lead = { col, row };
  const sats = rowRange(await rowTable(env), row);
  if (!sats) return json({ ...lead, blockRange: null, satRange: null, count: 0, utxos: [] });
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
  const cache = globalThis.caches && caches.default;
  const keyUrl = new URL(url);
  keyUrl.searchParams.set('__release', RELEASE.version);
  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return respond(hit.body, hit.status, Object.fromEntries(hit.headers));
  }
  const produced = await cellResponse(url, env);
  if (!produced.ok) return respond(produced.body, produced.status, Object.fromEntries(produced.headers));
  const text = await produced.text();
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400, s-maxage=86400' };
  if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(text, { headers })));
  return respond(text, 200, headers);
}

// ---- static app ---------------------------------------------------------------------------

function assetCacheControl(pathname, contentType) {
  if (/^text\/html/.test(contentType || '') || pathname === '/' || pathname.endsWith('/')) return 'no-cache';
  if (pathname === '/og.jpg' || pathname === '/favicon.svg') return 'public, max-age=86400';
  return 'public, max-age=0, must-revalidate';
}

async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = securityHeaders(new Headers(response.headers));
  if (response.status === 200 || response.status === 304) {
    headers.set('Cache-Control', assetCacheControl(new URL(request.url).pathname, response.headers.get('Content-Type')));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
    return respond('User-agent: *\nAllow: /\nDisallow: /dataset/\nDisallow: /api/\n', 200,
      { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  }
  if (path === '/dataset/index.json') return json(datasetIndex());
  if (path.startsWith('/dataset/')) {
    const m = /^\/dataset\/([^/]+)\/(.+)$/.exec(path);
    if (!m || !DATASET_ID.test(m[1]) || !datasetIds().includes(m[1]) || !DATASET_FILE.test(m[2])) return notFound();
    return serveDataset(request, env, ctx, m[1], m[2]);
  }
  if (path === '/api/landscape/cell') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!tokenBucket(ip)) return respond(JSON.stringify({ error: 'rate limited' }), 429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    return cachedCell(request, env, ctx, url);
  }
  if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
  return serveAsset(request, env);
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
