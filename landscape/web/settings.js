// UTXO Timelapse Landscape: settings store (contract: landscape/SPEC.md section 7).
//
// createSettingsStore(schema, presets, {capabilities, storage}) validates and clamps
// values, batches change notifications per microtask, applies presets (capped at High on
// WebGL2), detects Custom, and serialises to JSON, the URL hash and localStorage.
// Pure module: no three.js and no DOM access at import time.

import {
  SCHEMA,
  PRESETS,
  QUALITY_ORDER,
  STARTUP_PRESET,
  WEBGL2_MAX_PRESET,
} from './settings.schema.js';

export const SETTINGS_FORMAT = 'utxo-landscape-settings-1';
export const STORAGE_KEY = 'utxo-landscape-settings-v1';
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

/** Replaces the settings keys ('preset' and schema ids) of a hash or query string with
 * settingsParams. Every other segment (b, cam, mode, ...) is kept verbatim and in order,
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
    if (key !== 'preset' && !ids.has(key)) kept.push(part);
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

// ---------------------------------------------------------------------------
// Store

/**
 * @param {object[]} schema  SCHEMA from settings.schema.js
 * @param {object}   presets PRESETS from settings.schema.js
 * @param {object}   [options]
 * @param {object}   [options.capabilities] {backend: 'webgpu'|'webgl2'} or {webgpu: bool} or
 *                   view.capabilities; capMax keys such as maxTileBudget lower entry maxima
 * @param {Storage|null} [options.storage] localStorage-like object; defaults to
 *                   globalThis.localStorage when reachable, null disables persistence
 * @param {string}   [options.storageKey] defaults to STORAGE_KEY
 * @param {boolean}  [options.autosave] save 250 ms after changes (default: when storage exists)
 * @param {string}   [options.startupPreset] defaults to STARTUP_PRESET ('High')
 */
export function createSettingsStore(schema = SCHEMA, presets = PRESETS, options = {}) {
  const entries = Object.freeze(Array.from(schema));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const groupIds = new Set(entries.map((entry) => entry.group));
  const presetNames = Object.freeze(Object.keys(presets));
  const qualityOrder = options.qualityOrder ?? QUALITY_ORDER;
  const webgl2MaxPreset = options.webgl2MaxPreset ?? WEBGL2_MAX_PRESET;
  const storageKey = options.storageKey ?? STORAGE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let autosave = options.autosave ?? Boolean(storage);
  let caps = normalizeCapabilities(options.capabilities);

  const hasPreset = (name) => typeof name === 'string' && hasOwn(presets, name);
  const startupPreset = hasPreset(options.startupPreset) ? options.startupPreset
    : hasPreset(STARTUP_PRESET) ? STARTUP_PRESET : presetNames[0];

  const values = new Map();
  const subscribers = new Set();
  const presetListeners = new Set();
  let pending = null; // Map id -> {previous, value}
  let flushQueued = false;
  let saveTimer = null;
  let disposed = false;
  let basePreset = capPreset(startupPreset);

  for (const entry of entries) values.set(entry.id, presetValue(entry, basePreset));
  let lastPresetState = presetState();

  function entryOf(id) {
    const entry = byId.get(id);
    if (!entry) throw new Error('Unknown setting "' + id + '"');
    return entry;
  }

  function capPreset(name) {
    if (caps.webgpu) return name;
    const index = qualityOrder.indexOf(name);
    const cap = qualityOrder.indexOf(webgl2MaxPreset);
    return cap >= 0 && index > cap ? webgl2MaxPreset : name;
  }

  function presetValue(entry, name) {
    let raw = entry.default;
    if (entry.preset !== false) {
      const partial = presets[name];
      if (partial && hasOwn(partial, entry.id)) raw = partial[entry.id];
    }
    const result = validateValue(entry, raw, caps);
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

  function currentPreset() {
    for (const entry of entries) {
      if (entry.preset !== false && !valuesEqual(values.get(entry.id), presetValue(entry, basePreset))) return 'Custom';
    }
    return basePreset;
  }

  function overrides() {
    const out = {};
    for (const entry of entries) {
      const value = values.get(entry.id);
      if (!valuesEqual(value, presetValue(entry, basePreset))) out[entry.id] = value;
    }
    return out;
  }

  function presetState() {
    return { preset: currentPreset(), basePreset, overrides: Object.keys(overrides()).length, webgpu: caps.webgpu };
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
      if (autosave) scheduleSave();
    }
    const state = presetState();
    if (state.preset !== lastPresetState.preset || state.basePreset !== lastPresetState.basePreset
      || state.overrides !== lastPresetState.overrides || state.webgpu !== lastPresetState.webgpu) {
      lastPresetState = state;
      for (const fn of Array.from(presetListeners)) {
        try { fn({ ...state }); } catch (error) { reportError(error); }
      }
    }
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

  function setBase(name) {
    if (basePreset !== name) {
      basePreset = name;
      queueFlush();
    }
  }

  function applyPreset(name) {
    if (!hasPreset(name)) throw new Error('Unknown preset "' + name + '"');
    const effective = capPreset(name);
    for (const entry of entries) {
      if (entry.preset !== false) write(entry, presetValue(entry, effective));
    }
    setBase(effective);
    return effective;
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
    for (const entry of list) write(entry, presetValue(entry, basePreset));
  }

  function presetValues(name = basePreset) {
    if (!hasPreset(name)) throw new Error('Unknown preset "' + name + '"');
    const out = {};
    for (const entry of entries) out[entry.id] = presetValue(entry, name);
    return out;
  }

  function toJSON(opts) {
    const includeFiles = !(opts && typeof opts === 'object' && opts.files === false);
    const out = {};
    for (const entry of entries) {
      if (entry.type === 'file' && !includeFiles) continue;
      out[entry.id] = plainValue(values.get(entry.id));
    }
    return { format: SETTINGS_FORMAT, preset: basePreset, values: out };
  }

  function fromJSON(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Settings JSON must be an object');
    if (data.format !== undefined && data.format !== SETTINGS_FORMAT) {
      throw new Error('Unsupported settings format "' + data.format + '" (expected ' + SETTINGS_FORMAT + ')');
    }
    const report = { preset: null, applied: [], ignored: [], invalid: [], capped: [] };
    let map = data.values;
    if (!map || typeof map !== 'object') {
      map = { ...data }; // plain {id: value} map, optionally with 'preset'
      delete map.preset;
      delete map.format;
    }
    // When the saved preset is capped (Ultra or Extreme on WebGL2), values that merely
    // repeat that preset are dropped so only the user's own overrides land on High.
    let cappedFrom = null;
    if (data.preset !== undefined) {
      if (hasPreset(data.preset)) {
        if (applyPreset(data.preset) !== data.preset) cappedFrom = data.preset;
      } else {
        report.invalid.push('preset');
      }
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
      if (cappedFrom && entry.preset !== false && valuesEqual(result.value, presetValue(entry, cappedFrom))) {
        report.capped.push(id);
        continue;
      }
      write(entry, result.value);
      report.applied.push(id);
    }
    report.preset = basePreset;
    return report;
  }

  function toURL() {
    const params = new URLSearchParams();
    params.set('preset', basePreset);
    for (const entry of entries) {
      if (!entry.url || entry.type === 'file') continue;
      const value = values.get(entry.id);
      if (!valuesEqual(value, presetValue(entry, basePreset))) params.set(entry.id, encodeURLValue(entry, value));
    }
    return params.toString();
  }

  function fromURL(input) {
    const params = toSearchParams(input);
    const report = { found: false, preset: null, applied: [], ignored: [], invalid: [] };
    const presetParam = params.get('preset');
    let found = presetParam !== null;
    for (const key of new Set(params.keys())) {
      if (byId.has(key)) found = true;
      else if (key !== 'preset' && key.includes('.')) report.ignored.push(key);
    }
    if (!found) return report;
    report.found = true;
    let name = startupPreset;
    if (presetParam !== null) {
      if (hasPreset(presetParam)) name = presetParam;
      else report.invalid.push('preset');
    }
    const effective = capPreset(name);
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
      // URL-borne entries absent from the URL take the preset value; personal
      // preferences that never travel in URLs (url: false) keep their current value.
      if (entry.url || entry.preset !== false) staged.push([entry, presetValue(entry, effective)]);
    }
    for (const [entry, value] of staged) write(entry, value);
    setBase(effective);
    report.preset = effective;
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
    const effective = capPreset(basePreset);
    if (effective !== basePreset) {
      for (const entry of entries) {
        if (entry.preset !== false) write(entry, presetValue(entry, effective));
      }
      setBase(effective);
      for (const [id, value] of Object.entries(before)) {
        const entry = byId.get(id);
        const result = validateValue(entry, value, caps);
        if (result.ok) write(entry, result.value);
      }
    } else {
      for (const entry of entries) {
        const result = validateValue(entry, values.get(entry.id), caps);
        if (result.ok) write(entry, result.value);
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
    reset,
    overrides,
    presetValues,
    toJSON,
    fromJSON,
    toURL,
    fromURL,
    mergeIntoHash: (hash) => mergeHash(hash, toURL(), entries),
    load,
    save,
    setCapabilities,
    isAvailable,
    isPresetAvailable: (name) => hasPreset(name) && capPreset(name) === name,
    entry: (id) => byId.get(id) ?? null,
    values: () => Object.fromEntries(values),
    flush,
    dispose,
    get preset() { return currentPreset(); },
    get basePreset() { return basePreset; },
    get capabilities() { return caps; },
    get webgpu() { return caps.webgpu; },
    get schema() { return entries; },
    get presets() { return presets; },
    get presetNames() { return presetNames; },
    get storageKey() { return storageKey; },
    get autosave() { return autosave; },
    set autosave(on) { autosave = Boolean(on); },
  };
}
