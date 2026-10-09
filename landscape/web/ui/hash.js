// URL hash for the shareable view (landscape/SPEC.md §8). Pure module.
//
//   #b=314000&mode=map&cam=483.120,96.400,402.000,0.00,-35.00&<settings store toURL()>
//
// b is the exact block, mode is map | flight, cam is x,y,z (world units) followed by yaw
// and pitch in degrees (yaw 0 looks toward -z, pitch < 0 looks down). Every other key
// belongs to the settings store (preset and overrides) and is passed through untouched.

const SHELL_KEYS = new Set(['b', 'mode', 'cam']);
export const MODES = Object.freeze(['map', 'flight']);

function num(v, digits) {
  const s = v.toFixed(digits);
  return s === '-0' || /^-0\.0+$/.test(s) ? s.slice(1) : s;
}

export function encodeCam(cam) {
  if (!cam) return null;
  const vals = [cam.x, cam.y, cam.z, cam.yaw, cam.pitch];
  if (!vals.every(Number.isFinite)) return null;
  return [num(cam.x, 3), num(cam.y, 3), num(cam.z, 3), num(cam.yaw, 2), num(cam.pitch, 2)].join(',');
}

export function decodeCam(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split(',');
  if (parts.length !== 5) return null;
  const v = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (!v.every(Number.isFinite)) return null;
  const [x, y, z, yaw, pitch] = v;
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6) return null;
  const wrapped = yaw >= -180 && yaw < 180 ? yaw : ((((yaw + 180) % 360) + 360) % 360) - 180;
  return { x, y, z, yaw: wrapped, pitch: Math.max(-89.9, Math.min(89.9, pitch)) };
}

function stripLead(s) {
  return (s || '').replace(/^[#?&]+/, '');
}

/**
 * Build the hash. settingsQuery is the settings store's toURL() output (a
 * URLSearchParams-style string); it is appended as-is after the shell keys.
 */
export function encodeHash({ block = null, mode = null, cam = null } = {}, settingsQuery = '') {
  const parts = [];
  if (Number.isInteger(block) && block >= 0) parts.push('b=' + block);
  if (MODES.includes(mode)) parts.push('mode=' + mode);
  const c = encodeCam(cam);
  if (c) parts.push('cam=' + c);
  const rest = stripLead(settingsQuery instanceof URLSearchParams ? settingsQuery.toString() : settingsQuery);
  if (rest) parts.push(rest);
  return parts.length ? '#' + parts.join('&') : '';
}

/** Parse a hash (with or without '#'). Unknown or invalid shell values become null. */
export function decodeHash(hash) {
  const out = { block: null, mode: null, cam: null, settings: '' };
  const body = stripLead(hash);
  if (!body) return out;
  const rest = [];
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey);
      value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (!SHELL_KEYS.has(key)) {
      rest.push(part);
      continue;
    }
    if (key === 'b') {
      const b = Number(value);
      out.block = /^\d+$/.test(value) && Number.isSafeInteger(b) ? b : null;
    } else if (key === 'mode') {
      out.mode = MODES.includes(value) ? value : null;
    } else if (key === 'cam') {
      out.cam = decodeCam(value);
    }
  }
  out.settings = rest.join('&');
  return out;
}
