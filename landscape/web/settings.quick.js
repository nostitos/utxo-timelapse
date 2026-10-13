// UTXO Timelapse Landscape: quick settings (contract: landscape/SPEC.md section 7).
//
// The sixteen controls at the top of the settings panel, for the settings people change most.
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
//             'select' | 'slider'  bind one schema id (setting); a slider may narrow the range
//             'toggles'            several boolean schema ids (settings)
//   needs     like schema entries: conditions under which the control changes the image
//   rebuild   rebuild class of its costliest change (panel hint)

import {
  TIME_OF_DAY, SKY, HAZE, SHADOWS, GLOW, BIG_COINS, CELL_SHAPES, FLASHES, FLASH_TRAIL,
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

export const QUICK = deepFreeze([
  { id: 'look', section: 'Look', label: 'Look', type: 'look',
    help: 'The overall appearance. Looks you save in this browser are listed under Saved.' },
  { id: 'quality', section: 'Look', label: 'Quality', type: 'quality',
    help: 'Resolution, anti-aliasing, shadow detail and effect samples. Changing it keeps the look and your own changes.' },

  { id: 'timeOfDay', section: 'Scene', label: 'Time of day', type: 'choice',
    help: 'Moves the sun and recolours the sky, the haze and the ambient light. At night the sun sets and the stars come out.',
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
  { id: 'haze', section: 'Scene', label: 'Haze', type: 'choice',
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
  { id: 'glow', section: 'Scene', label: 'Glow', type: 'choice',
    help: 'Bloom: a soft glow around bright colours and flashes.',
    options: [
      option('off', 'Off', GLOW.off),
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
  { id: 'bigCoins', section: 'Data', label: 'Big coins', type: 'choice',
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
  { id: 'flashes', section: 'Data', label: 'Flashes', type: 'choice',
    help: 'Glow and sparks where outputs are spent while the chain plays.',
    options: [
      option('off', 'Off', FLASHES.off),
      option('subtle', 'Subtle', FLASHES.subtle),
      option('normal', 'Normal', FLASHES.normal),
      option('strong', 'Strong', FLASHES.strong),
    ] },
  { id: 'flashTrail', section: 'Data', label: 'Flash trail', type: 'choice', rebuild: 'worker',
    needs: [{ id: 'color.heatGain', gt: 0 }],
    help: 'How long the glow of a spend lingers: 10, 30 or 300 blocks to fade by half.',
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
