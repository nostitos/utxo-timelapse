// Entry preference mirrors BitcoinTimelapse: enter the explorer once, then remember it
// for a year. Shared views and explicit app options bypass the introductory guide.
export const EXPLORER_COOKIE = 'bl_explorer';
export const SETTINGS_KEY = 'utxo-landscape-settings-v1';
const PUBLIC_HOME = new Set(['bitcoinlandscape.com', 'www.bitcoinlandscape.com']);
const APP_OPTIONS = ['startup', 'webgl', 'data', 'explorer', 'explorer2d'];

export function entryDestination(location, remembered = false) {
  if (!PUBLIC_HOME.has(location.hostname) || !['/', '/index.html'].includes(location.pathname)) return null;
  if (remembered || location.hash) return null;
  const query = new URLSearchParams(location.search);
  if (APP_OPTIONS.some(key => query.has(key))) return null;
  return '/guide/' + location.search;
}

export function hasExplorerCookie(cookie) {
  return cookie.split(';').some(part => part.trim() === EXPLORER_COOKIE + '=1');
}

export function explorerCookie(protocol) {
  return EXPLORER_COOKIE + '=1; Path=/; Max-Age=31536000; SameSite=Lax' +
    (protocol === 'https:' ? '; Secure' : '');
}
