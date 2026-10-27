// Entry preference mirrors BitcoinTimelapse: a first visit to the bare public domain opens the
// app behind a welcome that offers the guide or the explorer, and entering the app is remembered
// for a year. Shared views and explicit app options open the app without the welcome.
export const EXPLORER_COOKIE = 'bl_explorer';
export const SETTINGS_KEY = 'utxo-landscape-settings-v1';
const PUBLIC_HOME = new Set(['bitcoinlandscape.com', 'www.bitcoinlandscape.com']);
const APP_OPTIONS = ['startup', 'webgl', 'data', 'explorer', 'explorer2d'];

/** True for a first visit to the bare public domain: nothing remembered, no view hash, no app option. */
export function showsWelcome(location, remembered = false) {
  if (!PUBLIC_HOME.has(location.hostname) || !['/', '/index.html'].includes(location.pathname)) return false;
  if (remembered || location.hash) return false;
  const query = new URLSearchParams(location.search);
  return !APP_OPTIONS.some(key => query.has(key));
}

export function hasExplorerCookie(cookie) {
  return cookie.split(';').some(part => part.trim() === EXPLORER_COOKIE + '=1');
}

export function explorerCookie(protocol) {
  return EXPLORER_COOKIE + '=1; Path=/; Max-Age=31536000; SameSite=Lax' +
    (protocol === 'https:' ? '; Secure' : '');
}
