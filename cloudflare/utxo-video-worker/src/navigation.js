// The guide remains published by GitHub Pages; the Worker provides its public URL.
export const GUIDE_ORIGIN = "https://nostitos.github.io/utxo-timelapse/";
export const EXPLORER_COOKIE = "btl_explorer";
const GUIDE_FILES = new Set(["/index.html", "/technical.html", "/styles.css", "/site.js", "/axis-mapping.mjs"]);

export function navigationRoute(request) {
  const url = new URL(request.url);
  const publicHome = ["bitcointimelapse.com", "www.bitcointimelapse.com"].includes(url.hostname);
  if (url.pathname === "/guide") return { kind: "redirect", path: "/guide/" + url.search };
  if (["/explorer", "/explorer/", "/explorer.html"].includes(url.pathname)) return { kind: "explorer" };
  if (url.pathname === "/") {
    if (!publicHome) return { kind: "explorer" }; // Existing service aliases keep working.
    const remembered = (request.headers.get("Cookie") || "").split(";").some(c => c.trim() === EXPLORER_COOKIE + "=1");
    if (url.searchParams.has("block") || url.searchParams.has("x") || url.searchParams.has("y") || remembered) {
      return { kind: "redirect", path: "/explorer" + url.search };
    }
    return { kind: "guide", path: "/index.html", entry: true };
  }
  const path = url.pathname.startsWith("/guide/") ? url.pathname.slice(6) : url.pathname;
  if (path === "/") return { kind: "guide", path: "/index.html" };
  if (GUIDE_FILES.has(path)) return { kind: "guide", path };
  if (/^\/assets\/[A-Za-z0-9_./-]+$/.test(path) && !path.split("/").some(p => p.startsWith("."))) {
    return { kind: "guide", path };
  }
  return null;
}

export function explorerCookie(request) {
  return EXPLORER_COOKIE + "=1; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly" +
    (new URL(request.url).protocol === "https:" ? "; Secure" : "");
}

export async function fetchGuide(request, route) {
  const url = new URL(route.path.slice(1), GUIDE_ORIGIN);
  const headers = new Headers();
  for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  // Never forward the visitor's cookies or authorization headers to the origin.
  const html = route.path.endsWith(".html");
  if (html) { headers.delete("If-None-Match"); headers.delete("If-Modified-Since"); }
  const source = await fetch(url, { method: request.method, headers, redirect: "manual" });
  if (source.status >= 300 && source.status < 400 && source.status !== 304) {
    throw new Error("Guide origin redirected unexpectedly");
  }
  const output = new Headers(source.headers);
  output.delete("Set-Cookie");
  if (route.entry) {
    output.set("Cache-Control", "no-store");
    output.set("Vary", "Cookie");
  } else if (route.path.endsWith(".html")) output.set("Cache-Control", "no-cache");
  let body = source.body;
  if (html) for (const name of ["Content-Length", "Content-Encoding", "ETag"]) output.delete(name);
  if (html && request.method === "GET" && source.ok) {
    // Older Pages copies linked the explorer at /. Keep those links functional
    // while Pages and the Worker roll out independently or an edge cache ages out.
    body = (await source.text()).replace(/(<a\b[^>]*\bhref=")https:\/\/bitcointimelapse\.com\/(\?[^"<>]*)?"/g,
      (_match, prefix, query) => prefix + "https://bitcointimelapse.com/explorer" + (query || "") + '"');
  }
  return new Response(request.method === "HEAD" ? null : body, { status: source.status, headers: output });
}
