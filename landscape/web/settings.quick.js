// UTXO Timelapse Landscape: quick settings (contract: landscape/SPEC.md section 7).
//
// The eighteen controls at the top of the settings panel, for the settings people change most.
// Most set a bundle of schema values at once (Time of day moves the sun and recolours the sky,
// haze and ambient light); a few bind one setting directly. The bundles come from
// settings.schema.js, which builds the looks from the same bundles, so every built-in look
// reads as one definite option in each control. Pure module: no DOM; ui/quick.js draws them.
//
// Control fields
//   id, section ('Look' | 'Scene' | 'Data' | 'View'), label, help
//   type      'look' | 'quality'   the two preset axes
//             'choice' | 'toggle'  options [{id, label, set, match, webgpu?}]: set is written
//                                  with setMany; the active option is the first whose match
//                                  (a subset of set) equals the current values, none = mixed
//             'blend'              a slider across its options (stops, in order): between two
//                                  stops numbers and colours blend (log: ids blended in log
//                                  space), a boolean holds true if either stop has it, and a
//                                  value only one stop names holds across the segment
//                                  (blendAs: values a stop blends from without writing them);
//                                  commit 'change' writes on release instead of while dragging;
//                                  at: the slider value of each stop (default 0, 1, 2...), with
//                                  format to show the value (Time of day runs as a clock)
//             'select' | 'slider'  bind one schema id (setting); a slider may narrow the range
//                                  (min, max), use a log scale, run high to low (invert) and
//                                  show its value through format
//             'toggles'            several boolean schema ids (settings)
//   needs     like schema entries: conditions under which the control changes the image
//   rebuild   rebuild class of its costliest change (panel hint)

import {
  TIME_OF_DAY, SKY, HAZE, SHADOWS, GLOW, BIG_COINS, CELL_SHAPES, FLASHES, FLASH_TRAIL, SCHEMA_BY_ID,
} from './settings.schema.js';
import { valuesEqual } from './settings.js';

export const QUICK_SECTIONS = Object.freeze(['Look', 'Scene', 'Data', 'View']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const only = (bundle, ids) => Object.fromEntries(ids.map((id) => [id, bundle[id]]));
const without = (bundle, id) => Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== id));
const option = (id, label, set, match = set, extra = {}) => ({ id, label, set: { ...set }, match: { ...match }, ...extra });
/** "×2.5": a reach or detail relative to High (High's value divided by the current one). */
const relative = (high) => (value) => '\u00d7' + Number((high / value).toPrecision(2));
/** "18:15" for 18.25 hours, to the nearest five minutes. */
export function clockTime(hours) {
  const minutes = Math.round((hours * 60) / 5) * 5;
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return h + ':' + String(m).padStart(2, '0');
}

export const QUICK = deepFreeze([
  { id: 'look', section: 'Look', label: 'Look', type: 'look',
    help: 'The overall appearance. Looks you save in this browser are listed under Saved.' },
  { id: 'quality', section: 'Look', label: 'Quality', type: 'quality',
    help: 'Resolution, anti-aliasing, shadow detail and effect samples. Changing it keeps the look and your own changes.' },
  // Reach and detail: quality tiers set them too, so these sliders fine-tune the tier.
  { id: 'columnDistance', section: 'Look', label: 'Column distance', type: 'slider', setting: 'geo.columnPixels',
    min: 1, max: 16, scale: 'log', invert: true, format: relative(4), ends: ['Near', 'Far'],
    needs: [{ id: 'geo.columns', is: true }],
    help: 'How far from the camera cells stand as columns instead of the spiky surface. At \u00d71 (High) a cell becomes a column while it is at least 4 pixels wide on screen; \u00d72 reaches cells half that wide, about twice as far. Measured from the camera to the ground, so flying higher brings the columns in. Farther costs more GPU time.' },
  { id: 'terrainDetail', section: 'Look', label: 'Terrain detail', type: 'slider', setting: 'geo.pixelsPerCell',
    min: 1, max: 8, scale: 'log', invert: true, format: relative(3), ends: ['Coarse', 'Fine'],
    help: 'How fine the surface is beyond the columns: at \u00d71 (High) the surface is refined until a cell is at most 3 pixels wide on screen; \u00d72 halves that. Finer shows more detail in the distance and costs more.' },

  { id: 'timeOfDay', section: 'Scene', label: 'Time of day', type: 'blend',
    at: [6.5, 12, 17.5, 18.25, 21], format: clockTime,
    help: 'A clock from sunrise to night: the sun crosses the sky, low and warm at sunrise and sunset, high at noon; after sunset the sky turns blue, the stars come out and moonlight takes over. The sky, the haze and the ambient light follow.',
    options: [
      // Stars follow the time of day but do not decide it, so a look may keep its stars.
      option('sunrise', 'Sunrise', TIME_OF_DAY.sunrise, without(TIME_OF_DAY.sunrise, 'light.stars')),
      option('day', 'Day', TIME_OF_DAY.day, without(TIME_OF_DAY.day, 'light.stars')),
      option('sunset', 'Sunset', TIME_OF_DAY.sunset, without(TIME_OF_DAY.sunset, 'light.stars')),
      option('dusk', 'Dusk', TIME_OF_DAY.dusk, without(TIME_OF_DAY.dusk, 'light.stars')),
      option('night', 'Night', TIME_OF_DAY.night, without(TIME_OF_DAY.night, 'light.stars')),
    ] },
  { id: 'sky', section: 'Scene', label: 'Sky', type: 'toggle',
    help: 'The sky dome and its stars. Off shows the plain background colour.',
    options: [
      option('on', 'On', SKY.on),
      option('off', 'Off', SKY.off, { 'light.sky': false }),
    ] },
  { id: 'haze', section: 'Scene', label: 'Haze', type: 'blend',
    help: 'Fog that thickens toward the ground and hides the distance.',
    options: [
      option('none', 'None', HAZE.none),
      option('light', 'Light', HAZE.light, only(HAZE.light, ['light.fogDensity'])),
      option('thick', 'Thick', HAZE.thick, only(HAZE.thick, ['light.fogDensity'])),
    ] },
  { id: 'shadows', section: 'Scene', label: 'Shadows', type: 'toggle',
    needs: [{ id: 'light.sunIntensity', gt: 0 }],
    help: 'Shadows cast by the sun; longest at sunrise and sunset.',
    options: [option('on', 'On', SHADOWS.on), option('off', 'Off', SHADOWS.off)] },
  { id: 'glow', section: 'Scene', label: 'Glow', type: 'blend',
    help: 'Bloom: a soft glow around bright colours and flashes.',
    options: [
      option('off', 'Off', GLOW.off, GLOW.off, { blendAs: { 'fx.bloomStrength': 0 } }),
      option('soft', 'Soft', GLOW.soft, only(GLOW.soft, ['fx.bloom', 'fx.bloomStrength'])),
      option('normal', 'Normal', GLOW.normal, only(GLOW.normal, ['fx.bloom', 'fx.bloomStrength'])),
      option('strong', 'Strong', GLOW.strong, only(GLOW.strong, ['fx.bloom', 'fx.bloomStrength'])),
    ] },

  { id: 'measure', section: 'Data', label: 'Height shows', type: 'select', setting: 'amp.measure', rebuild: 'worker',
    help: 'What the height of a cell counts: weighted density (outputs, large ones counted by amount), the number of outputs, or the BTC they hold. Colour follows it unless set otherwise in Advanced.' },
  { id: 'palette', section: 'Data', label: 'Colours', type: 'select', setting: 'color.palette', advancedOnly: ['custom'],
    help: 'Colour map from low to high values. Edit a custom gradient in Advanced > Colour.' },
  { id: 'height', section: 'Data', label: 'Height', type: 'slider', setting: 'amp.exaggeration', min: 0, max: 40, step: 0.5,
    help: 'How tall the landscape is (Advanced allows up to 200).' },
  { id: 'bigCoins', section: 'Data', label: 'Big coins', type: 'blend',
    help: 'Extra height for the rows at or above the whale threshold (10 BTC by default).',
    options: [
      option('normal', 'Normal', BIG_COINS.normal),
      option('taller', 'Taller', BIG_COINS.taller),
      option('towering', 'Towering', BIG_COINS.towering),
    ] },
  { id: 'cellShape', section: 'Data', label: 'Cell shape', type: 'choice', rebuild: 'terrain',
    help: 'How cells are drawn near the camera: a smooth surface, round columns, square boxes, or flat-topped steps everywhere.',
    options: [
      option('smooth', 'Smooth', CELL_SHAPES.smooth),
      option('columns', 'Columns', CELL_SHAPES.columns, only(CELL_SHAPES.columns, ['geo.columns', 'geo.columnShape']), { webgpu: true }),
      option('boxes', 'Boxes', CELL_SHAPES.boxes, only(CELL_SHAPES.boxes, ['geo.columns', 'geo.columnShape']), { webgpu: true }),
      option('stepped', 'Stepped', CELL_SHAPES.stepped),
    ] },
  { id: 'flashes', section: 'Data', label: 'Flashes', type: 'blend',
    help: 'Glow and sparks where outputs are spent while the chain plays.',
    options: [
      option('off', 'Off', FLASHES.off),
      option('subtle', 'Subtle', FLASHES.subtle),
      option('normal', 'Normal', FLASHES.normal),
      option('strong', 'Strong', FLASHES.strong),
    ] },
  { id: 'flashTrail', section: 'Data', label: 'Flash trail', type: 'blend', rebuild: 'worker',
    log: ['amp.heatHalfLife'], commit: 'change',
    needs: [{ id: 'color.heatGain', gt: 0 }],
    help: 'How long the glow of a spend lingers: from 10 to 300 blocks to fade by half.',
    options: [
      option('short', 'Short', FLASH_TRAIL.short),
      option('normal', 'Normal', FLASH_TRAIL.normal),
      option('long', 'Long', FLASH_TRAIL.long),
    ] },

  { id: 'fov', section: 'View', label: 'Field of view', type: 'slider', setting: 'camera.fov', unit: '\u00b0',
    help: 'How wide the camera sees. Wider shows more and exaggerates depth.' },
  { id: 'show', section: 'View', label: 'Show', type: 'toggles',
    settings: ['display.grid', 'display.labels', 'display.legend', 'display.minimap', 'display.hud'],
    labels: { 'display.grid': 'Grid', 'display.labels': 'Labels', 'display.legend': 'Legend', 'display.minimap': 'Minimap', 'display.hud': 'HUD' },
    help: 'Grid lines, axis labels and the panels around the view.' },
]);

export const QUICK_BY_ID = new Map(QUICK.map((control) => [control.id, control]));

/** Id of the active option of a choice or toggle, or null when the values match none (mixed). */
export function quickOption(control, get) {
  for (const opt of control.options || []) {
    if (Object.entries(opt.match).every(([id, value]) => valuesEqual(get(id), value))) return opt.id;
  }
  return null;
}

/**
 * Current state of a control: {option} (null = mixed) for choice and toggle, {value} for
 * select and slider, {values: {id: bool}} for toggles; look and quality return {}.
 */
export function quickState(control, get) {
  switch (control.type) {
    case 'choice':
    case 'toggle': return { option: quickOption(control, get) };
    case 'blend': return { option: quickOption(control, get), position: blendPosition(control, get).position };
    case 'select':
    case 'slider': return { value: get(control.setting) };
    case 'toggles': return { values: Object.fromEntries(control.settings.map((id) => [id, get(id)])) };
    default: return {};
  }
}

/** The values an option writes (a fresh object for store.setMany). */
export function quickPatch(control, optionId) {
  const opt = (control.options || []).find((o) => o.id === optionId);
  if (!opt) throw new Error('Quick setting ' + control.id + ' has no option "' + optionId + '"');
  return { ...opt.set };
}

/** Every schema id a control writes or binds. */
export function quickIds(control) {
  const ids = new Set();
  for (const opt of control.options || []) for (const id of Object.keys(opt.set)) ids.add(id);
  if (control.setting) ids.add(control.setting);
  for (const id of control.settings || []) ids.add(id);
  return [...ids];
}

// ---- blend sliders --------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
const isColor = (value) => typeof value === 'string' && HEX.test(value);
const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');

/** The value stop a takes for id on its segment toward stop b: its own, its blendAs, else b's. */
function endValue(a, b, id) {
  if (Object.hasOwn(a.set, id)) return a.set[id];
  if (a.blendAs && Object.hasOwn(a.blendAs, id)) return a.blendAs[id];
  if (Object.hasOwn(b.set, id)) return b.set[id];
  return b.blendAs ? b.blendAs[id] : undefined;
}

const logBlend = (control, id, a, b) => !!(control.log && control.log.includes(id) && a > 0 && b > 0);

/** The slider value of a stop index position (control.at, else the index itself). */
export function blendValue(control, position) {
  const at = control.at;
  if (!at) return position;
  const i = Math.min(at.length - 2, Math.max(0, Math.floor(position)));
  return at[i] + (at[i + 1] - at[i]) * (position - i);
}

/** The stop index position of a slider value (the inverse of blendValue). */
export function blendIndex(control, value) {
  const at = control.at;
  if (!at) return Math.min(control.options.length - 1, Math.max(0, value));
  if (value <= at[0]) return 0;
  for (let i = 0; i < at.length - 1; i++) {
    if (value <= at[i + 1]) return i + (value - at[i]) / (at[i + 1] - at[i]);
  }
  return at.length - 1;
}

function mixValue(control, id, a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') {
    const v = logBlend(control, id, a, b) ? a * Math.pow(b / a, t) : a + (b - a) * t;
    const entry = SCHEMA_BY_ID.get(id);
    return entry && entry.type === 'int' ? Math.round(v) : Number(v.toPrecision(4));
  }
  if (isColor(a) && isColor(b)) {
    const A = rgbOf(a);
    const B = rgbOf(b);
    return hexOf(A.map((c, k) => c + (B[k] - c) * t));
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
  return t < 0.5 ? a : b;
}

/** The values a blend control writes at a position from 0 (first stop) to stops - 1 (last). */
export function blendPatch(control, position) {
  const stops = control.options;
  const p = Math.min(stops.length - 1, Math.max(0, Number(position) || 0));
  const i = Math.min(stops.length - 2, Math.floor(p));
  const t = p - i;
  if (t < 1e-6) return quickPatch(control, stops[i].id);
  if (t > 1 - 1e-6) return quickPatch(control, stops[i + 1].id);
  const a = stops[i];
  const b = stops[i + 1];
  const out = {};
  for (const id of new Set([...Object.keys(a.set), ...Object.keys(b.set)])) {
    out[id] = mixValue(control, id, endValue(a, b, id), endValue(b, a, id), t);
  }
  return out;
}

function nearlyEqual(id, x, y) {
  if (typeof x === 'number' && typeof y === 'number') {
    const entry = SCHEMA_BY_ID.get(id);
    const range = entry && entry.max > entry.min ? entry.max - entry.min : 1;
    return Math.abs(x - y) <= Math.max(0.003 * Math.max(Math.abs(x), Math.abs(y)), 2e-4 * range);
  }
  if (isColor(x) && isColor(y)) {
    const A = rgbOf(x);
    const B = rgbOf(y);
    return A.every((c, k) => Math.abs(c - B[k]) <= 3);
  }
  return valuesEqual(x, y);
}

/**
 * Where the current values sit on a blend control: {position} from 0 to stops - 1, or
 * {position: null} when they lie on no point of it (set by hand in Advanced). The setting
 * that changes most along a segment locates the point (a number when any changes: colour
 * channels are too coarse to place it); every setting the two stops decide (their match)
 * must then agree with the blend there.
 */
export function blendPosition(control, get) {
  const stops = control.options;
  const at = quickOption(control, get);
  if (at !== null) return { position: stops.findIndex((o) => o.id === at) };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const ids = [...new Set([...Object.keys(a.match), ...Object.keys(b.match)])];
    let best = null;
    for (const id of ids) {
      const va = endValue(a, b, id);
      const vb = endValue(b, a, id);
      const cur = get(id);
      let t = null;
      let weight = 0;
      if (typeof va === 'number' && typeof vb === 'number' && va !== vb && typeof cur === 'number') {
        if (logBlend(control, id, va, vb) && cur > 0) {
          t = Math.log(cur / va) / Math.log(vb / va);
          weight = 10 + Math.abs(Math.log(vb / va));
        } else {
          const entry = SCHEMA_BY_ID.get(id);
          const range = entry && entry.max > entry.min ? entry.max - entry.min : Math.abs(vb - va);
          t = (cur - va) / (vb - va);
          weight = 10 + Math.abs(vb - va) / range;
        }
      } else if (isColor(va) && isColor(vb) && isColor(cur)) {
        const A = rgbOf(va);
        const B = rgbOf(vb);
        const C = rgbOf(cur);
        let k = 0;
        for (let j = 1; j < 3; j++) if (Math.abs(B[j] - A[j]) > Math.abs(B[k] - A[k])) k = j;
        if (B[k] !== A[k]) {
          t = (C[k] - A[k]) / (B[k] - A[k]);
          weight = Math.abs(B[k] - A[k]) / 255;
        }
      }
      if (t !== null && (!best || weight > best.weight)) best = { t, weight };
    }
    if (!best || !(best.t > -1e-3 && best.t < 1 + 1e-3)) continue;
    const position = i + Math.min(1, Math.max(0, best.t));
    const patch = blendPatch(control, position);
    if (ids.every((id) => nearlyEqual(id, get(id), patch[id]))) return { position };
  }
  return { position: null };
}
