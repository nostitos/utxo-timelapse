// UTXO Timelapse Landscape: settings store (contract: landscape/SPEC.md section 7).
//
// createSettingsStore(schema, presets, {capabilities, storage}) validates and clamps
// values, batches change notifications per microtask, applies a look and a quality tier
// (quality capped at High on WebGL2), detects Custom, keeps the user's saved presets, and
// serialises to JSON, the URL hash and localStorage.
// Pure module: no three.js and no DOM access at import time.

import {
  SCHEMA,
  PRESETS,
  QUALITY_ORDER,
  STARTUP_PRESET,
  WEBGL2_MAX_PRESET,
  DEFAULT_LOOK,
} from './settings.schema.js';

export const SETTINGS_FORMAT = 'utxo-landscape-settings-1';
export const STORAGE_KEY = 'utxo-landscape-settings-v1';
export const PRESETS_FORMAT = 'utxo-landscape-presets-1';
export const PRESETS_KEY = 'utxo-landscape-presets-v1';
export const MAX_USER_PRESETS = 50;
export const MAX_PRESET_NAME = 40;
const MAX_SAVED_CHARS = 2000000; // larger saves drop file values (the LUT text)
const AUTOSAVE_DELAY_MS = 250;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const ok = (value) => ({ ok: true, value });
const invalid = (reason) => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// Value helpers (pure, exported for consumers and tests)

/** Normalises '#rgb', '#rrggbb', 'rrggbb' or 0xrrggbb to lowercase '#rrggbb'; null if invalid. */
export function normalizeColor(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return '#' + value.toString(16).padStart(6, '0');
  }
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}

function roundStopT(t) {
  const r = Math.round(Math.min(1, Math.max(0, t)) * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

/** Compact URL form: 't-rrggbb' stops joined by '_' (t has at most 4 decimals). */
export function encodeGradient(stops) {
  return stops.map((s) => String(s.t) + '-' + s.color.slice(1)).join('_');
}

export function decodeGradient(text) {
  if (typeof text !== 'string' || text === '') return null;
  const stops = [];
  for (const part of text.split('_')) {
    const m = /^([0-9]*\.?[0-9]+)-([0-9a-fA-F]{6})$/.exec(part);
    if (!m) return null;
    stops.push({ t: Number(m[1]), color: '#' + m[2].toLowerCase() });
  }
  return stops;
}

/** Validates a gradient (array or compact string): 2..maxStops stops, t clamped to 0..1 and
 * rounded to 4 decimals, colours normalised, stable-sorted by t, deeply frozen. */
export function normalizeGradient(value, maxStops = 16) {
  const stops = typeof value === 'string' ? decodeGradient(value) : value;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > maxStops) return null;
  const out = [];
  for (const stop of stops) {
    if (!stop || typeof stop !== 'object') return null;
    const t = typeof stop.t === 'string' && stop.t.trim() !== '' ? Number(stop.t) : stop.t;
    const color = normalizeColor(stop.color);
    if (typeof t !== 'number' || !Number.isFinite(t) || color === null) return null;
    out.push({ t: roundStopT(t), color });
  }
  out.sort((a, b) => a.t - b.t);
  return Object.freeze(out.map((s) => Object.freeze(s)));
}

/** Structural equality for stored values (numbers, strings, booleans, gradients, files). */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].t !== b[i].t || a[i].color !== b[i].color) return false;
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return a.name === b.name && a.text === b.text;
  }
  return false;
}

/** Capabilities -> frozen copy with a boolean 'webgpu'. 'backend' wins, then 'webgpu',
 * then 'compute'; with no information WebGPU is assumed. */
export function normalizeCapabilities(capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? { ...capabilities } : {};
  let webgpu = true;
  if (typeof caps.backend === 'string') webgpu = caps.backend === 'webgpu';
  else if (typeof caps.webgpu === 'boolean') webgpu = caps.webgpu;
  else if (typeof caps.compute === 'boolean') webgpu = caps.compute;
  return Object.freeze({ ...caps, webgpu });
}

/**
 * Validates and normalises one value for an entry.
 * Numbers are clamped to [min, max] (max may be lowered by capabilities[entry.capMax]) and
 * ints rounded; WebGPU-only booleans become false and WebGPU-only enum options become the
 * entry's fallback when capabilities.webgpu is false.
 * @returns {{ok: true, value} | {ok: false, reason: string}}
 */
export function validateValue(entry, value, capabilities) {
  const caps = capabilities && typeof capabilities.webgpu === 'boolean'
    ? capabilities : normalizeCapabilities(capabilities);
  switch (entry.type) {
    case 'number':
    case 'int': {
      let v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return invalid('expected a finite number');
      let max = entry.max;
      const capped = entry.capMax ? caps[entry.capMax] : undefined;
      if (typeof capped === 'number' && Number.isFinite(capped)) max = Math.min(max, capped);
      if (entry.type === 'int') {
        v = Math.round(v);
        max = Math.floor(max);
      }
      v = Math.min(max, Math.max(entry.min, v));
      return ok(Object.is(v, -0) ? 0 : v);
    }
    case 'bool': {
      let v = value;
      if (v === 1 || v === '1' || v === 'true') v = true;
      else if (v === 0 || v === '0' || v === 'false') v = false;
      if (typeof v !== 'boolean') return invalid('expected a boolean');
      if (v && entry.webgpu && !caps.webgpu) v = false;
      return ok(v);
    }
    case 'enum': {
      let index = entry.options.indexOf(value);
      if (index < 0 && (typeof value === 'string' || typeof value === 'number')) {
        index = entry.options.findIndex((option) => String(option) === String(value));
      }
      if (index < 0) return invalid('expected one of ' + entry.options.join(', '));
      let v = entry.options[index];
      if (!caps.webgpu && entry.webgpuOptions && entry.webgpuOptions.includes(v)) {
        v = entry.fallback ?? entry.options.find((option) => !entry.webgpuOptions.includes(option));
      }
      return ok(v);
    }
    case 'color': {
      const c = normalizeColor(value);
      return c === null ? invalid('expected a colour such as #rrggbb') : ok(c);
    }
    case 'gradient': {
      const g = normalizeGradient(value, entry.maxStops ?? 16);
      return g === null ? invalid('expected 2 to ' + (entry.maxStops ?? 16) + ' stops {t, color}') : ok(g);
    }
    case 'file': {
      if (value === null || value === undefined) return ok(null);
      if (typeof value === 'object' && typeof value.name === 'string' && typeof value.text === 'string') {
        return ok(Object.freeze({ name: value.name, text: value.text }));
      }
      return invalid('expected null or {name, text}');
    }
    default:
      return invalid('unknown setting type ' + entry.type);
  }
}

/** Encodes a value for the URL (colours without '#', booleans as 1/0, gradients compact). */
export function encodeURLValue(entry, value) {
  switch (entry.type) {
    case 'bool': return value ? '1' : '0';
    case 'color': return value.slice(1);
    case 'gradient': return encodeGradient(value);
    case 'file': return '';
    default: return String(value);
  }
}

/** Decodes a URL string for an entry; the result still goes through validateValue. */
export function decodeURLValue(entry, text) {
  switch (entry.type) {
    case 'number':
    case 'int': return text.trim() === '' ? NaN : Number(text);
    case 'bool':
      if (text === '1' || text === 'true') return true;
      if (text === '0' || text === 'false') return false;
      return null;
    case 'color': return normalizeColor(text);
    case 'gradient': return decodeGradient(text);
    case 'enum': return text;
    default: return undefined;
  }
}

/** Accepts URLSearchParams, '#a=1&b=2', '?a=1', 'a=1', a full URL or a Location. */
export function toSearchParams(input) {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  if (input === null || input === undefined) return new URLSearchParams();
  let s = String(input);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const url = new URL(s);
    s = url.hash.length > 1 ? url.hash : url.search;
  }
  return new URLSearchParams(s.replace(/^[#?]/, ''));
}

/** Replaces the settings keys ('preset', 'look' and schema ids) of a hash or query string
 * with settingsParams. Every other segment (b, cam, mode, ...) is kept verbatim and in order,
 * so 'cam=1,2,3' stays unencoded. Returns the string without a leading '#'. */
export function mergeHash(hash, settingsParams, schema = SCHEMA) {
  const ids = new Set(schema.map((entry) => entry.id));
  let source = hash instanceof URLSearchParams ? hash.toString() : hash === null || hash === undefined ? '' : String(hash);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = new URL(source);
    source = url.hash.length > 1 ? url.hash : url.search;
  }
  const kept = [];
  for (const part of source.replace(/^[#?]/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      // keep the raw key
    }
    if (key !== 'preset' && key !== 'look' && !ids.has(key)) kept.push(part);
  }
  const settings = settingsParams instanceof URLSearchParams ? settingsParams.toString()
    : String(settingsParams ?? '').replace(/^[#?]/, '');
  if (settings !== '') kept.push(settings);
  return kept.join('&');
}

// Slider mapping shared by the panel (log entries) and tests.
const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

function logFloor(entry) {
  return entry.min > 0 ? entry.min : entry.logMin;
}

/** Slider position 0..1 for a value (log entries map logarithmically; 0 sits at the far left). */
export function sliderPosition(entry, value) {
  if (entry.scale === 'log') {
    const lo = logFloor(entry);
    if (!(value > lo)) return 0;
    return clamp01(Math.log(value / lo) / Math.log(entry.max / lo));
  }
  return clamp01((value - entry.min) / (entry.max - entry.min));
}

/** Value for a slider position 0..1, rounded to 3 significant digits (log) or the step (linear). */
export function sliderValue(entry, position) {
  const p = clamp01(position);
  let v;
  if (entry.scale === 'log') {
    const lo = logFloor(entry);
    v = entry.min <= 0 && p === 0 ? entry.min : Number((lo * Math.pow(entry.max / lo, p)).toPrecision(3));
  } else {
    v = entry.min + p * (entry.max - entry.min);
    if (entry.step) v = entry.min + Math.round((v - entry.min) / entry.step) * entry.step;
    v = Number(v.toPrecision(12));
  }
  if (entry.type === 'int') v = Math.round(v);
  return Math.min(entry.max, Math.max(entry.min, v));
}

function plainValue(value) {
  if (Array.isArray(value)) return value.map((s) => ({ t: s.t, color: s.color }));
  if (value && typeof value === 'object') return { name: value.name, text: value.text };
  return value;
}

function reportError(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

function defaultStorage() {
  try {
    const storage = globalThis.localStorage;
    if (storage && typeof storage.getItem === 'function') return storage;
  } catch {
    // Storage blocked (sandboxed frame or privacy mode).
  }
  return null;
}

/** Short text for a value: on/off, an option label, a number, a colour or a file name. */
export function describeValue(entry, value) {
  if (!entry) return String(value);
  switch (entry.type) {
    case 'bool': return value ? 'on' : 'off';
    case 'enum': return (entry.optionLabels && entry.optionLabels[value]) || String(value);
    case 'file': return value ? value.name : 'none';
    case 'gradient': return Array.isArray(value) ? value.length + ' stops' : String(value);
    case 'number':
    case 'int': return typeof value === 'number' ? String(Number(value.toPrecision(4))) : String(value);
    default: return String(value);
  }
}

function conditionHolds(cond, value) {
  if (Object.prototype.hasOwnProperty.call(cond, 'is')) return valuesEqual(value, cond.is) || String(value) === String(cond.is);
  if (Object.prototype.hasOwnProperty.call(cond, 'ne')) return !(valuesEqual(value, cond.ne) || String(value) === String(cond.ne));
  if (Object.prototype.hasOwnProperty.call(cond, 'gt')) return typeof value === 'number' && value > cond.gt;
  if (cond.notNull) return value !== null && value !== undefined;
  return true;
}

function failingCondition(cond, get, byId, stack, deep) {
  if (cond.any) {
    const parts = [];
    const conds = [];
    for (const alternative of cond.any) {
      const failed = failingCondition(alternative, get, byId, stack, deep);
      if (!failed) return null;
      for (const part of failed.parts) if (!parts.includes(part)) parts.push(part);
      conds.push(...failed.conds);
    }
    return { conds, parts };
  }
  const entry = byId.get(cond.id);
  const value = get(cond.id);
  if (!conditionHolds(cond, value)) {
    return { conds: [cond], parts: [(entry ? entry.label : cond.id) + ' ' + describeValue(entry, value)] };
  }
  // The parent has the required value but may itself have no effect (shadow map size while
  // shadows have no sun): report the parent's own failing condition, the root cause.
  if (deep && entry && entry.needs && !stack.has(cond.id)) {
    stack.add(cond.id);
    const deeper = unmetNeed(entry.needs, get, byId, stack);
    stack.delete(cond.id);
    if (deeper) return { conds: deeper.conds, parts: deeper.parts };
  }
  return null;
}

/**
 * The first condition of a 'needs' list (settings.schema.js) that keeps a setting from
 * changing the image, or null when every condition holds.
 * @param {object[]|undefined} needs
 * @param {(id: string) => any} get current value of a setting
 * @param {Map<string, object>} byId schema entries by id (labels for the text)
 * @returns {null | {conds: object[], parts: string[], text: string}} text such as 'Bloom off'
 *          or 'Heat gain 0 and Flash size 0', to follow 'No effect with '
 */
export function unmetNeed(needs, get, byId, stack = new Set()) {
  if (!needs || !needs.length) return null;
  // Conditions that fail on their own value come first (the setting to change); then
  // parents that hold the right value but have no effect themselves.
  for (const deep of [false, true]) {
    for (const cond of needs) {
      const failed = failingCondition(cond, get, byId, stack, deep);
      if (failed) {
        const { parts } = failed;
        const text = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
        return { conds: failed.conds, parts, text };
      }
    }
  }
  return null;
}
// ---------------------------------------------------------------------------
// Store

/**
 * @param {object[]} schema  SCHEMA from settings.schema.js
 * @param {object}   presets PRESETS from settings.schema.js: looks and quality tiers in one map
 *                   (names in options.qualityOrder are quality tiers, every other name a look)
 * @param {object}   [options]
 * @param {object}   [options.capabilities] {backend: 'webgpu'|'webgl2'} or {webgpu: bool} or
 *                   view.capabilities; capMax keys such as maxTileBudget lower entry maxima
 * @param {Storage|null} [options.storage] localStorage-like object; defaults to
 *                   globalThis.localStorage when reachable, null disables persistence (and
 *                   saving presets)
 * @param {string}   [options.storageKey] defaults to STORAGE_KEY
 * @param {string}   [options.presetsKey] saved presets; defaults to PRESETS_KEY
 * @param {boolean}  [options.autosave] save 250 ms after changes (default: when storage exists)
 * @param {string}   [options.startupPreset] startup quality (default 'High'), or a look name
 * @param {string}   [options.defaultLook] defaults to DEFAULT_LOOK ('Landscape')
 */
export function createSettingsStore(schema = SCHEMA, presets = PRESETS, options = {}) {
  const entries = Object.freeze(Array.from(schema));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const governed = entries.filter((entry) => entry.preset !== false);
  const groupIds = new Set(entries.map((entry) => entry.group));
  const presetNames = Object.freeze(Object.keys(presets));
  const qualityNames = Object.freeze((options.qualityOrder ?? QUALITY_ORDER).filter((name) => hasOwn(presets, name)));
  const defaultLook = options.defaultLook ?? DEFAULT_LOOK;
  const lookNames = Object.freeze([...new Set([defaultLook, ...presetNames.filter((name) => !qualityNames.includes(name))])]);
  const webgl2MaxPreset = options.webgl2MaxPreset ?? WEBGL2_MAX_PRESET;
  const storageKey = options.storageKey ?? STORAGE_KEY;
  const presetsKey = options.presetsKey ?? PRESETS_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let autosave = options.autosave ?? Boolean(storage);
  let caps = normalizeCapabilities(options.capabilities);

  const isQuality = (name) => typeof name === 'string' && qualityNames.includes(name);
  const isLook = (name) => typeof name === 'string' && lookNames.includes(name);
  const keyOf = (name) => String(name).trim().toLowerCase();
  const startupQuality = isQuality(options.startupPreset) ? options.startupPreset
    : isQuality(STARTUP_PRESET) ? STARTUP_PRESET : (qualityNames[0] ?? null);

  const values = new Map();
  const subscribers = new Set();
  const presetListeners = new Set();
  let pending = null; // Map id -> {previous, value}
  let flushQueued = false;
  let saveTimer = null;
  let disposed = false;
  let users = []; // saved presets, sorted by name
  let usersByKey = new Map(); // lower-case name -> record
  let quality = capQuality(startupQuality);
  let look = isLook(options.startupPreset) ? options.startupPreset : defaultLook;
  let lookBuiltin = look; // the built-in look under the active look (itself, or a saved preset's)

  loadUsers();
  for (const entry of entries) values.set(entry.id, baseValue(entry));
  let lastPresetState = presetState();

  function entryOf(id) {
    const entry = byId.get(id);
    if (!entry) throw new Error('Unknown setting "' + id + '"');
    return entry;
  }

  function capQuality(name) {
    if (caps.webgpu || name === null) return name;
    const index = qualityNames.indexOf(name);
    const cap = qualityNames.indexOf(webgl2MaxPreset);
    return cap >= 0 && index > cap ? webgl2MaxPreset : name;
  }

  // ---- saved presets -------------------------------------------------------------------

  function userRecord(name) {
    return typeof name === 'string' ? usersByKey.get(keyOf(name)) ?? null : null;
  }

  function setLookState(name) {
    look = name;
    const user = userRecord(name);
    lookBuiltin = user ? user.look : name;
  }

  function reservedName(name) {
    const key = keyOf(name);
    return key === 'custom' || lookNames.some((n) => keyOf(n) === key) || qualityNames.some((n) => keyOf(n) === key);
  }

  /** A stored record, validated: null when unusable. Overrides keep only valid governed values. */
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > MAX_PRESET_NAME || reservedName(name)) return null;
    const overrides = {};
    if (raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
      for (const [id, value] of Object.entries(raw.overrides)) {
        const entry = byId.get(id);
        if (!entry || entry.preset === false) continue;
        // Validated as on WebGPU, so a preset saved there keeps its values when opened on WebGL2.
        const result = validateValue(entry, value, { webgpu: true });
        if (result.ok) overrides[id] = result.value;
      }
    }
    return Object.freeze({
      name,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
      look: isLook(raw.look) ? raw.look : defaultLook,
      quality: isQuality(raw.quality) ? raw.quality : startupQuality,
      overrides: Object.freeze(overrides),
    });
  }

  function setUsers(list) {
    const byKey = new Map();
    for (const record of list) byKey.set(keyOf(record.name), record); // the later record wins
    users = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    usersByKey = new Map(users.map((record) => [keyOf(record.name), record]));
  }

  function readUsers() {
    if (!storage) return null;
    let text;
    try {
      text = storage.getItem(presetsKey);
    } catch {
      return [];
    }
    if (!text) return [];
    try {
      const data = JSON.parse(text);
      if (!data || data.format !== PRESETS_FORMAT || !Array.isArray(data.presets)) return [];
      return data.presets.map(normalizeRecord).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Re-reads saved presets (another tab may have changed them). */
  function loadUsers() {
    const list = readUsers();
    if (list) setUsers(list);
    // The active saved preset was deleted elsewhere: keep the values on its built-in look.
    if (!isLook(look) && !userRecord(look)) look = lookBuiltin;
  }

  function plainRecord(record) {
    const overrides = {};
    for (const [id, value] of Object.entries(record.overrides)) overrides[id] = plainValue(value);
    return { name: record.name, savedAt: record.savedAt, look: record.look, quality: record.quality, overrides };
  }

  function writeUsers(list) {
    if (!storage) throw new Error('This browser blocks local storage here, so presets cannot be saved');
    const text = JSON.stringify({ format: PRESETS_FORMAT, presets: list.map(plainRecord) });
    try {
      storage.setItem(presetsKey, text);
    } catch (cause) {
      const error = new Error('Could not save: browser storage is full or blocked');
      error.cause = cause;
      throw error;
    }
  }

  function checkName(name) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean) throw new Error('Type a name for the preset');
    if (clean.length > MAX_PRESET_NAME) throw new Error('Use at most ' + MAX_PRESET_NAME + ' characters for a name');
    if (reservedName(clean)) throw new Error('\u201c' + clean + '\u201d is a built-in name; choose another');
    return clean;
  }

  /**
   * Saves the current look as a named preset (overwriting one with the same name, in any
   * case) and makes it the active look. It stores the built-in look underneath, the quality
   * and every preset-governed value that differs from them; personal preferences stay out.
   * @returns {{record: object, replaced: object|null}}
   */
  function saveUserPreset(name) {
    const clean = checkName(name);
    loadUsers();
    const previous = userRecord(clean);
    if (!previous && users.length >= MAX_USER_PRESETS) {
      throw new Error('You already have ' + MAX_USER_PRESETS + ' saved presets; delete one first');
    }
    const overrides = {};
    for (const entry of governed) {
      const value = values.get(entry.id);
      if (!valuesEqual(value, baseValue(entry, lookBuiltin, quality))) overrides[entry.id] = value;
    }
    const record = normalizeRecord({ name: clean, savedAt: new Date().toISOString(), look: lookBuiltin, quality, overrides });
    const next = users.filter((r) => r !== previous).concat(record);
    writeUsers(next);
    setUsers(next);
    setLookState(record.name);
    queueFlush();
    return { record, replaced: previous };
  }

  /** Deletes a saved preset. When it is active, the values stay and its built-in look becomes active. */
  function deleteUserPreset(name) {
    loadUsers();
    const record = userRecord(name);
    if (!record) throw new Error('No saved preset named \u201c' + name + '\u201d');
    const active = userRecord(look) === record;
    const next = users.filter((r) => r !== record);
    writeUsers(next);
    setUsers(next);
    if (active) setLookState(record.look);
    queueFlush();
    return record;
  }

  /** Puts a record back as it was (undo of an overwrite or a delete); activate makes it the look. */
  function restoreUserPreset(raw, { activate = false } = {}) {
    const record = normalizeRecord(raw);
    if (!record) throw new Error('Not a saved preset');
    loadUsers();
    const previous = userRecord(record.name);
    if (!previous && users.length >= MAX_USER_PRESETS) {
      throw new Error('You already have ' + MAX_USER_PRESETS + ' saved presets; delete one first');
    }
    const next = users.filter((r) => r !== previous).concat(record);
    writeUsers(next);
    setUsers(next);
    if (activate) setLookState(record.name);
    else if (userRecord(look)) setLookState(look);
    queueFlush();
    return record;
  }

  // ---- base values -----------------------------------------------------------------------

  /** Unvalidated base value: saved preset value, then look, then quality tier, then default. */
  function rawBase(entry, lk, q) {
    if (entry.preset === false) return entry.default;
    const user = userRecord(lk);
    if (user && hasOwn(user.overrides, entry.id)) return user.overrides[entry.id];
    const builtin = user ? user.look : lk;
    const lookPartial = isLook(builtin) ? presets[builtin] : null;
    if (lookPartial && hasOwn(lookPartial, entry.id)) return lookPartial[entry.id];
    const qualityPartial = isQuality(q) ? presets[q] : null;
    if (qualityPartial && hasOwn(qualityPartial, entry.id)) return qualityPartial[entry.id];
    return entry.default;
  }

  function baseValue(entry, lk = look, q = quality) {
    const result = validateValue(entry, rawBase(entry, lk, q), caps);
    if (result.ok) return result.value;
    const fallback = validateValue(entry, entry.default, caps);
    return fallback.ok ? fallback.value : entry.default;
  }

  function write(entry, value) {
    const previous = values.get(entry.id);
    if (valuesEqual(previous, value)) return false;
    values.set(entry.id, value);
    if (!pending) pending = new Map();
    const change = pending.get(entry.id);
    if (change) change.value = value;
    else pending.set(entry.id, { previous, value });
    queueFlush();
    return true;
  }

  function queueFlush() {
    if (flushQueued || disposed) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  function isModified() {
    for (const entry of governed) {
      if (!valuesEqual(values.get(entry.id), baseValue(entry))) return true;
    }
    return false;
  }

  /** 'Custom' when changed; else the quality (Landscape) or 'Look · Quality'. */
  function label(modified = isModified()) {
    if (modified) return 'Custom';
    if (look === defaultLook || quality === null) return quality ?? look;
    return look + ' \u00b7 ' + quality;
  }

  function overrides() {
    const out = {};
    for (const entry of entries) {
      const value = values.get(entry.id);
      if (!valuesEqual(value, baseValue(entry))) out[entry.id] = value;
    }
    return out;
  }

  function presetState() {
    const modified = isModified();
    return {
      preset: label(modified), quality, look, modified, overrides: Object.keys(overrides()).length,
      webgpu: caps.webgpu, userPresets: users.map((record) => record.name),
    };
  }

  function sameState(a, b) {
    return a.preset === b.preset && a.quality === b.quality && a.look === b.look && a.modified === b.modified
      && a.overrides === b.overrides && a.webgpu === b.webgpu
      && a.userPresets.length === b.userPresets.length && a.userPresets.every((name, i) => name === b.userPresets[i]);
  }

  function flush() {
    flushQueued = false;
    if (disposed) return;
    const batch = pending;
    pending = null;
    const changes = [];
    if (batch) {
      for (const [id, { previous, value }] of batch) {
        if (!valuesEqual(previous, value)) changes.push({ id, value, previous, entry: byId.get(id) });
      }
    }
    if (changes.length) {
      for (const sub of Array.from(subscribers)) {
        if (!subscribers.has(sub)) continue;
        const list = sub.match ? changes.filter(sub.match) : changes.slice();
        if (list.length) {
          try { sub.fn(list); } catch (error) { reportError(error); }
        }
      }
    }
    const state = presetState();
    const stateChanged = !sameState(state, lastPresetState);
    if (stateChanged) {
      lastPresetState = state;
      for (const fn of Array.from(presetListeners)) {
        try { fn({ ...state, userPresets: state.userPresets.slice() }); } catch (error) { reportError(error); }
      }
    }
    if (autosave && (changes.length || stateChanged)) scheduleSave();
  }

  function makeMatcher(filter) {
    if (filter === undefined || filter === null || filter === '*') return null;
    if (typeof filter === 'function') return (change) => Boolean(filter(change.entry));
    const ids = new Set();
    const groups = new Set();
    for (const item of Array.isArray(filter) ? filter : [filter]) {
      if (item === '*') return null;
      if (byId.has(item)) ids.add(item);
      else if (groupIds.has(item)) groups.add(item);
      else throw new Error('settings.subscribe: unknown id or group "' + item + '"');
    }
    return (change) => ids.has(change.id) || groups.has(change.entry.group);
  }

  function subscribe(filter, fn) {
    if (typeof filter === 'function' && fn === undefined) {
      fn = filter;
      filter = '*';
    }
    if (typeof fn !== 'function') throw new TypeError('settings.subscribe(filter, fn): fn must be a function');
    const sub = { fn, match: makeMatcher(filter) };
    subscribers.add(sub);
    return () => { subscribers.delete(sub); };
  }

  function onPresetChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('settings.onPresetChange(fn): fn must be a function');
    presetListeners.add(fn);
    return () => { presetListeners.delete(fn); };
  }

  function get(id) {
    entryOf(id);
    return values.get(id);
  }

  function set(id, value) {
    const entry = entryOf(id);
    const result = validateValue(entry, value, caps);
    if (!result.ok) throw new TypeError(id + ': ' + result.reason);
    write(entry, result.value);
    return values.get(id);
  }

  function setMany(object) {
    const staged = [];
    for (const [id, value] of Object.entries(object ?? {})) {
      const entry = entryOf(id);
      const result = validateValue(entry, value, caps);
      if (!result.ok) throw new TypeError(id + ': ' + result.reason);
      staged.push([entry, result.value]);
    }
    for (const [entry, value] of staged) write(entry, value);
    return staged.length;
  }

  /**
   * Makes a look (built-in or saved) active and sets every preset-governed setting to it at the
   * current quality, dropping changes made by hand. A saved preset also brings its quality.
   */
  function setLook(name) {
    const user = userRecord(name);
    if (!user && !isLook(name)) throw new Error('Unknown look "' + name + '"');
    setLookState(user ? user.name : name);
    if (user && isQuality(user.quality)) quality = capQuality(user.quality);
    for (const entry of governed) write(entry, baseValue(entry));
    queueFlush();
    return look;
  }

  /**
   * Changes the quality tier and keeps changes made by hand: settings still at the old base
   * value move to the new one; changed settings stay. Returns the quality applied (capped at
   * High on WebGL2).
   */
  function setQuality(name) {
    if (!isQuality(name)) throw new Error('Unknown quality "' + name + '"');
    const next = capQuality(name);
    if (next !== quality) {
      const before = new Map(governed.map((entry) => [entry.id, baseValue(entry)]));
      quality = next;
      for (const entry of governed) {
        if (valuesEqual(values.get(entry.id), before.get(entry.id))) write(entry, baseValue(entry));
      }
    }
    queueFlush();
    return next;
  }

  /** A quality name sets the quality (setQuality); a look or saved preset name sets the look. */
  function applyPreset(name) {
    if (isQuality(name)) return setQuality(name);
    if (isLook(name) || userRecord(name)) return setLook(name);
    throw new Error('Unknown preset "' + name + '"');
  }

  function reset(target) {
    let list = entries;
    if (target !== undefined && target !== null) {
      list = [];
      for (const item of Array.isArray(target) ? target : [target]) {
        if (groupIds.has(item)) list.push(...entries.filter((entry) => entry.group === item));
        else list.push(entryOf(item));
      }
    }
    for (const entry of list) write(entry, baseValue(entry));
  }

  /** Base value of every setting for a look (built-in or saved) and a quality tier. */
  function baseValues(lk = look, q = quality) {
    if (!isLook(lk) && !userRecord(lk)) throw new Error('Unknown look "' + lk + '"');
    if (q !== null && !isQuality(q)) throw new Error('Unknown quality "' + q + '"');
    const out = {};
    for (const entry of entries) out[entry.id] = baseValue(entry, lk, q);
    return out;
  }

  function toJSON(opts) {
    const includeFiles = !(opts && typeof opts === 'object' && opts.files === false);
    const out = {};
    for (const entry of entries) {
      if (entry.type === 'file' && !includeFiles) continue;
      out[entry.id] = plainValue(values.get(entry.id));
    }
    // 'preset' repeats the quality for readers from before looks existed.
    return { format: SETTINGS_FORMAT, preset: quality, quality, look, baseLook: lookBuiltin, values: out };
  }

  function fromJSON(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Settings JSON must be an object');
    if (data.format !== undefined && data.format !== SETTINGS_FORMAT) {
      throw new Error('Unsupported settings format "' + data.format + '" (expected ' + SETTINGS_FORMAT + ')');
    }
    const report = { preset: null, quality: null, look: null, lookFallback: null, applied: [], ignored: [], invalid: [], capped: [] };
    let map = data.values;
    if (!map || typeof map !== 'object') {
      map = { ...data }; // plain {id: value} map, optionally with 'preset', 'quality' and 'look'
      for (const key of ['preset', 'format', 'quality', 'look', 'baseLook', 'view']) delete map[key];
    }
    let targetQuality = null;
    let targetLook = null;
    let legacyLook = false;
    if (data.quality !== undefined) {
      if (isQuality(data.quality)) targetQuality = data.quality;
      else report.invalid.push('quality');
    }
    if (data.preset !== undefined && targetQuality === null) {
      if (isQuality(data.preset)) targetQuality = data.preset;
      else if (isLook(data.preset)) {
        // Before looks, Film was a preset of its own at High quality.
        targetLook = data.preset;
        legacyLook = true;
      } else report.invalid.push('preset');
    }
    if (data.look !== undefined) {
      const user = userRecord(data.look);
      if (user) targetLook = user.name;
      else if (isLook(data.look)) targetLook = data.look;
      else {
        // A saved preset of another browser: its values still arrive, on its built-in look.
        report.lookFallback = String(data.look);
        targetLook = isLook(data.baseLook) ? data.baseLook : defaultLook;
      }
    }
    // When the quality is capped (Ultra or Extreme on WebGL2), values that merely repeat that
    // tier are dropped so only the user's own changes land on High.
    let cappedFrom = null;
    if (targetQuality !== null || targetLook !== null) {
      const wanted = targetQuality ?? (legacyLook ? startupQuality : quality);
      const effective = capQuality(wanted);
      if (effective !== wanted) cappedFrom = wanted;
      setLookState(targetLook ?? defaultLook);
      quality = effective;
      for (const entry of governed) write(entry, baseValue(entry));
      queueFlush();
    }
    for (const [id, value] of Object.entries(map)) {
      const entry = byId.get(id);
      if (!entry) {
        report.ignored.push(id);
        continue;
      }
      const result = validateValue(entry, value, caps);
      if (!result.ok) {
        report.invalid.push(id);
        continue;
      }
      if (cappedFrom && entry.preset !== false && valuesEqual(result.value, baseValue(entry, look, cappedFrom))) {
        report.capped.push(id);
        continue;
      }
      write(entry, result.value);
      report.applied.push(id);
    }
    report.preset = quality;
    report.quality = quality;
    report.look = look;
    return report;
  }

  /** Share string: preset (the quality), look (a built-in look) and the url settings that differ. */
  function toURL() {
    const params = new URLSearchParams();
    if (quality !== null) params.set('preset', quality);
    if (lookBuiltin !== defaultLook) params.set('look', lookBuiltin);
    // A saved preset is shared as its built-in look plus explicit values, so the link works
    // in any browser.
    for (const entry of entries) {
      if (!entry.url || entry.type === 'file') continue;
      const value = values.get(entry.id);
      if (!valuesEqual(value, baseValue(entry, lookBuiltin, quality))) params.set(entry.id, encodeURLValue(entry, value));
    }
    return params.toString();
  }

  function fromURL(input) {
    const params = toSearchParams(input);
    const report = { found: false, preset: null, quality: null, look: null, applied: [], ignored: [], invalid: [] };
    const presetParam = params.get('preset');
    const lookParam = params.get('look');
    let found = presetParam !== null || lookParam !== null;
    for (const key of new Set(params.keys())) {
      if (byId.has(key)) found = true;
      else if (key !== 'preset' && key !== 'look' && key.includes('.')) report.ignored.push(key);
    }
    if (!found) return report;
    report.found = true;
    let wanted = startupQuality;
    let lk = defaultLook;
    if (presetParam !== null) {
      if (isQuality(presetParam)) wanted = presetParam;
      else if (isLook(presetParam)) lk = presetParam; // links from before looks: preset=Film
      else report.invalid.push('preset');
    }
    if (lookParam !== null) {
      if (isLook(lookParam)) lk = lookParam;
      else report.invalid.push('look');
    }
    const effective = capQuality(wanted);
    setLookState(lk);
    quality = effective;
    const staged = [];
    for (const entry of entries) {
      if (entry.url && entry.type !== 'file' && params.has(entry.id)) {
        const result = validateValue(entry, decodeURLValue(entry, params.get(entry.id)), caps);
        if (result.ok) {
          staged.push([entry, result.value]);
          report.applied.push(entry.id);
          continue;
        }
        report.invalid.push(entry.id);
      }
      // URL-borne entries absent from the URL take the base value; personal preferences
      // that never travel in URLs (url: false) keep their current value.
      if (entry.url || entry.preset !== false) staged.push([entry, baseValue(entry)]);
    }
    for (const [entry, value] of staged) write(entry, value);
    queueFlush();
    report.preset = effective;
    report.quality = effective;
    report.look = lk;
    return report;
  }

  function save() {
    if (!storage) return false;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    let text = JSON.stringify(toJSON());
    if (text.length > MAX_SAVED_CHARS) text = JSON.stringify(toJSON({ files: false }));
    try {
      storage.setItem(storageKey, text);
      return true;
    } catch {
      try {
        storage.setItem(storageKey, JSON.stringify(toJSON({ files: false })));
        return true;
      } catch {
        return false;
      }
    }
  }

  function load() {
    if (!storage) return false;
    let text;
    try {
      text = storage.getItem(storageKey);
    } catch {
      return false;
    }
    if (!text) return false;
    try {
      const data = JSON.parse(text);
      if (!data || data.format !== SETTINGS_FORMAT || !data.values || typeof data.values !== 'object') return false;
      fromJSON(data);
      return true;
    } catch {
      return false;
    }
  }

  function scheduleSave() {
    if (!storage || disposed) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, AUTOSAVE_DELAY_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function setCapabilities(next) {
    const before = overrides();
    const merged = { ...caps };
    delete merged.webgpu;
    if (next && typeof next === 'object' && ('webgpu' in next || 'compute' in next) && !('backend' in next)) {
      delete merged.backend;
    }
    caps = normalizeCapabilities({ ...merged, ...(next ?? {}) });
    quality = capQuality(quality);
    // Settings at their base value follow the (possibly capped) base; changed settings stay,
    // revalidated for the new capabilities.
    for (const entry of entries) {
      if (hasOwn(before, entry.id)) {
        const result = validateValue(entry, before[entry.id], caps);
        write(entry, result.ok ? result.value : baseValue(entry));
      } else {
        write(entry, baseValue(entry));
      }
    }
    queueFlush();
    return caps;
  }

  function isAvailable(id, value) {
    const entry = entryOf(id);
    if (caps.webgpu) return true;
    if (value === undefined) return !entry.webgpu;
    return !(entry.webgpu || (entry.webgpuOptions && entry.webgpuOptions.some((o) => String(o) === String(value))));
  }

  function isPresetAvailable(name) {
    if (isQuality(name)) return capQuality(name) === name;
    return isLook(name) || !!userRecord(name);
  }

  function dispose() {
    if (disposed) return;
    if (saveTimer !== null) save();
    disposed = true;
    subscribers.clear();
    presetListeners.clear();
    pending = null;
  }

  return {
    get,
    set,
    setMany,
    subscribe,
    onPresetChange,
    applyPreset,
    setLook,
    setQuality,
    reset,
    overrides,
    baseValues,
    saveUserPreset,
    deleteUserPreset,
    restoreUserPreset,
    userPreset: (name) => userRecord(name),
    reloadUserPresets() {
      loadUsers();
      queueFlush();
      return users.slice();
    },
    /** Why a setting has no effect now ({text, conds}), or null when it does. */
    inert: (id) => unmetNeed(entryOf(id).needs, get, byId),
    /** Evaluates a needs list (quick settings use it for their own conditions). */
    checkNeeds: (needs) => unmetNeed(needs, get, byId),
    toJSON,
    fromJSON,
    toURL,
    fromURL,
    mergeIntoHash: (hash) => mergeHash(hash, toURL(), entries),
    load,
    save,
    setCapabilities,
    isAvailable,
    isPresetAvailable,
    isQuality,
    isLook: (name) => isLook(name) || !!userRecord(name),
    entry: (id) => byId.get(id) ?? null,
    values: () => Object.fromEntries(values),
    flush,
    dispose,
    /** Display label: 'Custom', the quality (Landscape) or 'Look · Quality'. */
    get preset() { return label(); },
    get quality() { return quality; },
    get look() { return look; },
    /** The built-in look under the active look (itself, or a saved preset's base). */
    get baseLook() { return lookBuiltin; },
    get modified() { return isModified(); },
    get userPresets() { return users.slice(); },
    get capabilities() { return caps; },
    get webgpu() { return caps.webgpu; },
    get schema() { return entries; },
    get presets() { return presets; },
    get presetNames() { return presetNames; },
    get looks() { return lookNames; },
    get qualities() { return qualityNames; },
    get defaultLook() { return defaultLook; },
    get storageKey() { return storageKey; },
    get presetsKey() { return presetsKey; },
    get autosave() { return autosave; },
    set autosave(on) { autosave = Boolean(on); },
  };
}
