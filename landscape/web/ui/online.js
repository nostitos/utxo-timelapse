// Online versus local behaviour of the app shell (docs/landscape.md "Online"). Pure module.
//
// Local runs (localhost, 127.0.0.1, [::1]) keep the development defaults: the dataset served by
// landscape/tools/serve.mjs at /dataset/, the native explorer on 127.0.0.1:12989 for both the
// cell API and the 2D link, and the schema's startup preset (High). Online, the site's Worker
// names the current dataset in /dataset/index.json, answers the cell API itself, the 2D link
// opens the public explorer, and a first visit starts at an adaptive quality.

export const LOCAL_EXPLORER = 'http://127.0.0.1:12989';
export const PUBLIC_2D_EXPLORER = 'https://bitcointimelapse.com/explorer';
export const ADAPTIVE_DISPLAY = Object.freeze({
  'display.autoScale': true, 'display.targetFps': 60, 'display.scaleMin': 0.5, 'display.scaleMax': 1,
});
export const LOW_END_NOTICE = 'Designed for desktop browsers with WebGPU; quality lowered for this device';

export function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname || '').toLowerCase());
}

/**
 * Cell API base and 2D explorer links. ?explorer=URL overrides the API base and
 * ?explorer2d=URL the 2D link base.
 * @returns {{local: boolean, apiBase: string, link2d: (block: number, x: number, y: number) => string}}
 */
export function resolveEndpoints({ hostname, origin, query = new URLSearchParams() }) {
  const local = isLocalHost(hostname);
  const trim = (s) => String(s).replace(/\/+$/, '');
  const apiBase = trim(query.get('explorer') || (local ? LOCAL_EXPLORER : origin));
  const linkBase = query.get('explorer2d') ? trim(query.get('explorer2d')) : local ? apiBase + '/' : PUBLIC_2D_EXPLORER;
  return { local, apiBase, link2d: (block, x, y) => linkBase + '?block=' + block + '&x=' + x + '&y=' + y };
}

/**
 * Dataset URL: ?data=URL wins; otherwise the current dataset named by /dataset/index.json
 * (the online Worker); a missing index (local serve.mjs) or any failure falls back to /dataset/.
 */
export async function resolveDataUrl({ query = new URLSearchParams(), href, fetchImpl = globalThis.fetch }) {
  const explicit = query.get('data');
  if (explicit) return new URL(explicit, href).href;
  try {
    const r = await fetchImpl(new URL('/dataset/index.json', href).href, { cache: 'no-store' });
    if (r.ok) {
      const index = await r.json();
      const url = index && index.current && index.current.url;
      if (typeof url === 'string' && url) return new URL(url, href).href;
    }
  } catch { /* fall back */ }
  return new URL('/dataset/', href).href;
}

/** 'adaptive' online and 'high' locally, unless ?startup=adaptive|high says otherwise. */
export function startupMode({ query = new URLSearchParams(), local }) {
  const v = query.get('startup');
  if (v === 'adaptive' || v === 'high') return v;
  return local ? 'high' : 'adaptive';
}

/** Device traits for chooseStartup (touch-only = coarse primary pointer without hover). */
export function deviceTraits(win = globalThis) {
  const mm = (q) => {
    try {
      return !!(win.matchMedia && win.matchMedia(q).matches);
    } catch {
      return false;
    }
  };
  const mem = win.navigator && typeof win.navigator.deviceMemory === 'number' ? win.navigator.deviceMemory : NaN;
  return { coarseOnly: mm('(pointer: coarse)') && !mm('(hover: hover)'), deviceMemory: mem };
}

/**
 * Startup quality. Only an adaptive first visit (no saved settings and none in the link)
 * changes anything: Balanced with auto resolution scaling, or Performance with a notice on a
 * WebGL2-only, touch-only or low-memory (4 GB or less) device. Returns null otherwise.
 */
export function chooseStartup({ mode, firstVisit, backend, coarseOnly = false, deviceMemory = NaN }) {
  if (mode !== 'adaptive' || !firstVisit) return null;
  const lowEnd = backend !== 'webgpu' || !!coarseOnly || (Number.isFinite(deviceMemory) && deviceMemory <= 4);
  return {
    preset: lowEnd ? 'Performance' : 'Balanced',
    settings: { ...ADAPTIVE_DISPLAY },
    notice: lowEnd ? LOW_END_NOTICE : null,
  };
}

