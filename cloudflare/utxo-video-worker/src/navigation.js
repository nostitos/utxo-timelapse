// The guide remains published by GitHub Pages; the Worker provides its public URL.
export const GUIDE_ORIGIN = "https://nostitos.github.io/utxo-timelapse/";
export const EXPLORER_COOKIE = "btl_explorer";
// The explorer's own address options (explorer.html: readSharedView and the quality choice).
// A link that carries one opens that view directly; campaign tags and other parameters do not.
const EXPLORER_OPTIONS = ["block", "x", "y", "autoplay", "quality"];
const GUIDE_FILES = new Set(["/index.html", "/technical.html", "/styles.css", "/site.js", "/axis-mapping.mjs"]);
// Every spelling of the guide's address opens it: /guide, /Guide/, /GUIDE and /guide.html.
const GUIDE_ALIAS = /^\/guide(?:\/|\.html?)?$/i;

export function navigationRoute(request) {
  const url = new URL(request.url);
  const publicHome = ["bitcointimelapse.com", "www.bitcointimelapse.com"].includes(url.hostname);
  if (url.pathname !== "/guide/" && GUIDE_ALIAS.test(url.pathname)) return { kind: "redirect", path: "/guide/" + url.search };
  if (["/explorer", "/explorer/", "/explorer.html"].includes(url.pathname)) return { kind: "explorer" };
  if (url.pathname === "/") {
    if (!publicHome) return { kind: "explorer" }; // Existing service aliases keep working.
    const remembered = (request.headers.get("Cookie") || "").split(";").some(c => c.trim() === EXPLORER_COOKIE + "=1");
    if (remembered || EXPLORER_OPTIONS.some(name => url.searchParams.has(name))) {
      return { kind: "redirect", path: "/explorer" + url.search };
    }
    // A first visit to the bare domain: the explorer opens behind a choice between the guide and the explorer.
    return { kind: "explorer", welcome: true };
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

/** The explorer page marked for a first visit: explorer.html then opens its welcome dialog. */
export function welcomeHtml(html) {
  return html.replace(/<html\b/i, "<html data-welcome");
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
  if (html) output.set("Cache-Control", "no-cache");
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
