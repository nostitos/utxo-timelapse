// Immutable R2 objects for both Workers (the 3D landscape Worker imports this file): single
// byte ranges, ETag and 304, and an edge cache that answers whole objects and ranges up to 8 MiB
// without an R2 call.
const EDGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';

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

export function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

/** Explicit "bytes=a-b" ranges can be looked up in the edge cache before the object size is known. */
function explicitRange(value) {
  const m = value ? /^bytes=(\d+)-(\d+)$/.exec(value.trim()) : null;
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && b >= a ? { offset: a, length: b - a + 1 } : null;
}

/** Edge-cache key for an object or one closed byte range of it (same hostname as the request). */
function cacheKeyFor(request, key, range) {
  const u = new URL(request.url);
  u.pathname = '/__r2-cache/' + key;
  u.search = '?r=' + (range ? range.offset + '-' + (range.offset + range.length - 1) : 'all');
  return new Request(u.toString(), { method: 'GET' });
}

/**
 * R2 object 'key' as contentType. secure(headers) adds the Worker's own headers to every
 * response. edgeCache only for keys whose bytes never change.
 */
export async function serveObject(request, env, ctx, key, { contentType, secure, cacheControl = IMMUTABLE, edgeCache = true }) {
  const respond = (body, status, headers) => new Response(body, { status, headers: secure(new Headers(headers)) });
  const reply = (status, body, etag, range, size) => {
    const headers = {
      'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: etag, 'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (range) {
      headers['Content-Range'] = 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + size;
      headers['Content-Length'] = String(range.length);
    } else if (status === 200) {
      headers['Content-Length'] = String(size);
    }
    return respond(body, status, headers);
  };
  const notFound = () => respond('Not found\n', 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  const rangeHeader = request.headers.get('Range');
  const isGet = request.method === 'GET';
  const cache = edgeCache && globalThis.caches && caches.default;

  // Fast path: a cached whole object or cached closed range (immutable, so no R2 call).
  const early = rangeHeader ? explicitRange(rangeHeader) : null;
  if (cache && isGet && (!rangeHeader || early)) {
    const hit = await cache.match(cacheKeyFor(request, key, early));
    if (hit) {
      const size = Number(hit.headers.get('X-Object-Size'));
      const etag = hit.headers.get('ETag');
      if (etagMatches(request.headers.get('If-None-Match'), etag)) return reply(304, null, etag, null, size);
      return reply(early ? 206 : 200, hit.body, etag, early, size);
    }
  }

  const meta = await env.VIDEO_BUCKET.head(key);
  if (!meta) return notFound();
  const size = meta.size;
  if (etagMatches(request.headers.get('If-None-Match'), meta.httpEtag)) return reply(304, null, meta.httpEtag, null, size);
  const range = parseRange(rangeHeader, size);
  if (range === undefined) {
    return respond(null, 416, { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  }
  const status = range ? 206 : 200;
  if (!isGet) return reply(status, null, meta.httpEtag, range, size);
  const object = await env.VIDEO_BUCKET.get(key, range ? { range } : undefined);
  if (!object) return notFound();
  const length = range ? range.length : size;
  let body = object.body;
  if (cache && length <= EDGE_CACHE_MAX_BYTES) {
    const [client, stored] = body.tee();
    body = client;
    const storedHeaders = new Headers({
      'Content-Type': contentType, 'Cache-Control': IMMUTABLE,
      ETag: meta.httpEtag, 'X-Object-Size': String(size), 'Content-Length': String(length),
    });
    ctx.waitUntil(cache.put(cacheKeyFor(request, key, range), new Response(stored, { status: 200, headers: storedHeaders })));
  }
  return reply(status, body, meta.httpEtag, range, size);
}
