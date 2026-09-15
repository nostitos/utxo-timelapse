import { RELEASE } from './release.js';
import { navigationRoute, explorerCookie, fetchGuide } from './navigation.js';
import { txidResponse } from "./bitcoin.js";
import { dateResponse, pixelResponse, rangesResponse } from "./history.js";

const FALLBACK_VIDEO_KEY =
  "videos/utxo_4k_epoch105k_60fps_exactledger_weighted_topband_splitpalette_transition_crf21.mp4";
const LATEST_MANIFEST_KEY = "manifests/latest.json";
const SITE_PREFIX = RELEASE.sitePrefix;
const WORKER_VERSION = RELEASE.version;
let cachedManifest;
let manifestExpiresAt = 0;

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  m3u8: "application/vnd.apple.mpegurl",
  m4s: "video/iso.segment",
  mp4: "video/mp4",
};

function extension(key) {
  return key.slice(key.lastIndexOf(".") + 1).toLowerCase();
}

function securityHeaders(headers = new Headers()) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; " +
      "media-src 'self' blob: https://utxo-cdn.hat39.com; " +
      "connect-src 'self'; img-src 'self' data:",
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Worker-Version", WORKER_VERSION);
  return headers;
}

function withHeaders(response, extra = {}) {
  const headers = securityHeaders(new Headers(response.headers));
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function jsonError(message, status = 500) {
  return withHeaders(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  );
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      return undefined;
    }
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1 };
}

async function serveR2(request, env, ctx, key, options = {}) {
  const metadata = await env.VIDEO_BUCKET.head(key);
  if (!metadata) return new Response("Not found\n", { status: 404 });
  const requestedRange = parseRange(request.headers.get("Range"), metadata.size);
  if (requestedRange === undefined) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${metadata.size}`, "Accept-Ranges": "bytes" },
    });
  }

  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("__r2key", key);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  if (options.edgeCache && !requestedRange && request.method === "GET") {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }

  const object = request.method === "HEAD"
    ? metadata
    : await env.VIDEO_BUCKET.get(key, requestedRange ? { range: requestedRange } : undefined);
  if (!object) return new Response("Not found\n", { status: 404 });
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", options.contentType || CONTENT_TYPES[extension(key)] || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", metadata.httpEtag);
  headers.set("Content-Disposition", options.download ? "attachment" : "inline");
  headers.set("Cache-Control", options.cacheControl || "public, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag");
  let status = 200;
  let length = metadata.size;
  if (requestedRange) {
    status = 206;
    length = requestedRange.length;
    headers.set(
      "Content-Range",
      `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${metadata.size}`,
    );
  }
  headers.set("Content-Length", String(length));
  const response = new Response(request.method === "HEAD" ? null : object.body, { status, headers });
  if (options.edgeCache && !requestedRange && request.method === "GET") {
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  }
  return response;
}

async function cachedApi(request, ctx, producer, seconds) {
  if (request.method !== "GET") return jsonError("method not allowed", 405);
  const cache = caches.default;
  const versionedUrl = new URL(request.url);
  versionedUrl.searchParams.set("__dataset", RELEASE.version);
  const cacheKey = new Request(versionedUrl, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit);
  const produced = await producer();
  const response = withHeaders(produced);
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, max-age=${seconds}, s-maxage=${seconds}`);
    const cacheable = new Response(response.body, { status: response.status, headers });
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return cacheable;
  }
  return response;
}

async function getVideoTarget(bucket) {
  const now = Date.now();
  if (cachedManifest && now < manifestExpiresAt) return cachedManifest;
  const object = await bucket.get(LATEST_MANIFEST_KEY);
  if (!object) return { key: FALLBACK_VIDEO_KEY };
  const manifest = await object.json();
  if (!manifest || typeof manifest.key !== "string" || !manifest.key.startsWith("videos/")) {
    throw new Error("invalid latest-video manifest");
  }
  cachedManifest = { key: manifest.key };
  manifestExpiresAt = now + 60000;
  return cachedManifest;
}

function encodeKey(key) {
  const bytes = new TextEncoder().encode(key);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeKey(token) {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const padded = token.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function canonicalVideoRedirect(url, key, etag) {
  const target = new URL(url);
  target.pathname = `/objects/${encodeKey(key)}/${encodeURIComponent(etag)}/video.mp4`;
  target.search = "";
  return withHeaders(new Response(null, {
    status: 307,
    headers: { Location: target.toString(), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  }));
}

function tokenBucket(ip, kind) {
  const now = Date.now();
  const config = kind === "pixel" ? [8, 20] : kind === "txid" ? [0.5, 2] : [30, 60];
  const key = `${kind}:${ip}`;
  const old = tokenBucket.entries.get(key) || { tokens: config[1], at: now };
  old.tokens = Math.min(config[1], old.tokens + ((now - old.at) / 1000) * config[0]);
  old.at = now;
  const allowed = old.tokens >= 1;
  if (allowed) old.tokens -= 1;
  tokenBucket.entries.set(key, old);
  if (tokenBucket.entries.size > 10000) tokenBucket.entries.clear();
  return allowed;
}
tokenBucket.entries = new Map();

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return withHeaders(new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
      },
    }));
  }
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("method not allowed", 405);

  if (url.pathname === "/health-r2v2" || url.pathname === "/health") {
    return withHeaders(new Response("ok\n", { headers: { "Cache-Control": "no-store" } }));
  }
  if (url.pathname === "/robots.txt") {
    return withHeaders(new Response("User-agent: *\nAllow: /\nDisallow: /explorer\nDisallow: /api/\nDisallow: /hls/\n", {
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" },
    }));
  }
  const navigation = navigationRoute(request);
  if (navigation?.kind === "redirect") {
    return withHeaders(new Response(null, { status: 302, headers: {
      Location: new URL(navigation.path, url).toString(), "Cache-Control": "no-store", Vary: "Cookie",
    } }));
  }
  if (navigation?.kind === "guide") return withHeaders(await fetchGuide(request, navigation));
  if (navigation?.kind === "explorer") {
    const response = await serveR2(request, env, ctx, `${SITE_PREFIX}/explorer.html`, {
      contentType: CONTENT_TYPES.html,
      cacheControl: "no-store",
    });
    return response.ok ? withHeaders(response, { "Set-Cookie": explorerCookie(request) }) : response;
  }
  if (url.pathname === "/hls.min.js") {
    return serveR2(request, env, ctx, `${SITE_PREFIX}/hls.min.js`, {
      contentType: CONTENT_TYPES.js,
      edgeCache: true,
    });
  }
  if (url.pathname === "/api/info") {
    return serveR2(request, env, ctx, `${SITE_PREFIX}/info.json`, {
      contentType: CONTENT_TYPES.json,
      cacheControl: "no-store",
      edgeCache: false,
    });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (url.pathname === "/api/pixel") {
    if (!tokenBucket(ip, "pixel")) return jsonError("rate limited", 429);
    return cachedApi(request, ctx, () => pixelResponse(url, env), 86400);
  }
  if (url.pathname === "/api/ranges") {
    if (!tokenBucket(ip, "ranges")) return jsonError("rate limited", 429);
    return cachedApi(request, ctx, () => rangesResponse(url, env), 86400);
  }
  if (url.pathname === "/api/date") {
    return cachedApi(request, ctx, () => dateResponse(url, env), 86400);
  }
  if (url.pathname === "/api/txid") {
    if (!tokenBucket(ip, "txid")) return jsonError("rate limited", 429);
    return cachedApi(request, ctx, () => txidResponse(url), 2592000);
  }

  const hls = /^\/hls\/(v1|v2|v3|mobile966360)\/(media[.]m3u8|init[.]mp4|segment_\d{5}[.]m4s)$/.exec(url.pathname);
  if (hls) {
    return serveR2(request, env, ctx, `hls/${hls[1]}/${hls[2]}`, {
      edgeCache: true,
      contentType: CONTENT_TYPES[extension(hls[2])],
    });
  }

  // Backward-compatible direct MP4 endpoint. The web application uses HLS so
  // each R2 object is small, single-part and edge-cacheable.
  const isLatest = ["/latest-v2/video.mp4", "/latest/video.mp4", "/video.mp4"].includes(url.pathname);
  const objectMatch = /^\/objects\/([A-Za-z0-9_-]+)\/([^/]+)\/video[.]mp4$/.exec(url.pathname);
  if (isLatest) {
    const target = await getVideoTarget(env.VIDEO_BUCKET);
    const metadata = await env.VIDEO_BUCKET.head(target.key);
    if (!metadata) return new Response("Video not found\n", { status: 404 });
    return canonicalVideoRedirect(url, target.key, metadata.httpEtag);
  }
  if (objectMatch) {
    const key = decodeKey(objectMatch[1]);
    let etag;
    try { etag = decodeURIComponent(objectMatch[2]); } catch { etag = null; }
    if (!key || !key.startsWith("videos/") || !etag) return new Response("Not found\n", { status: 404 });
    const metadata = await env.VIDEO_BUCKET.head(key);
    if (!metadata || metadata.httpEtag !== etag) return new Response("Video version not found\n", { status: 404 });
    return serveR2(request, env, ctx, key, { contentType: CONTENT_TYPES.mp4 });
  }
  return withHeaders(new Response("Not found\n", { status: 404 }));
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    try {
      const response = await handle(request, env, ctx);
      console.log(request.method, new URL(request.url).pathname, response.status, `${Date.now() - started}ms`);
      return response;
    } catch (error) {
      console.error("request failed", error?.stack || error);
      return jsonError("service temporarily unavailable", 503);
    }
  },
};
