// Share explicit snapshots, never an incidental or stale selection from location.hash.
import { encodeHash } from './hash.js';

const PUBLIC_HOSTS = new Set(['bitcoinlandscape.com', 'www.bitcoinlandscape.com', '3d.bitcointimelapse.com']);
const PREVIEW_PARAMS = ['data', 'explorer', 'explorer2d', 'startup', 'webgl'];

export function buildShareUrl(href, snapshot, { selectedCell = false, autoplay = false } = {}) {
  const source = new URL(href);
  const url = new URL(PUBLIC_HOSTS.has(source.hostname) ? 'https://bitcoinlandscape.com/' : source.origin + source.pathname);
  // Local/custom data configurations must remain usable; public links stay canonical.
  if (!PUBLIC_HOSTS.has(source.hostname)) for (const key of PREVIEW_PARAMS) {
    if (source.searchParams.has(key)) url.searchParams.set(key, source.searchParams.get(key));
  }
  const cell = selectedCell ? snapshot.cell : null;
  url.hash = encodeHash({ block: snapshot.block, cam: snapshot.cam, mode: 'map',
    follow: snapshot.follow, cell, play: !cell && autoplay }, snapshot.settings);
  return url.href;
}
