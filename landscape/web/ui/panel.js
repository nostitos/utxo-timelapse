// UTXO Timelapse Landscape: settings panel (contract: landscape/SPEC.md section 7).
//
// createPanel({ container, store, schema, presets, capabilities, onExport, onImport,
// getShareURL }) builds a lil-gui 0.17 panel from the settings schema: one folder per group
// and section, a preset selector showing the current preset and override count, an override
// list with per-setting revert, search, per-group and global reset (with undo), JSON
// export/import, a share link, a .cube LUT loader and a gradient editor. Controls and store
// stay in sync in both directions; WebGPU-only settings are disabled on WebGL2.

import GUI, { Controller } from '../vendor/three/addons/libs/lil-gui.module.min.js';
import { GROUPS, PRESET_INFO, REBUILD_CLASSES } from '../settings.schema.js';
import { sliderPosition, sliderValue, valuesEqual } from '../settings.js';

const STYLE_ID = 'lsp-styles';
const MESSAGE_MS = 4000;
const UNDO_MS = 9000;
const DEFAULT_OPEN_GROUPS = new Set(['color', 'amp', 'fx']);
const STRIP_IDS = new Set(['color.palette', 'color.gradient', 'color.reverse', 'color.whiteHot']);
const UNIT_TEXT = { deg: '\u00b0', x: '\u00d7' };

// ---------------------------------------------------------------------------
// Small helpers (exported for tests and other UI modules)

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'title') node.title = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return node;
}

export function formatNumber(entry, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  if (entry && entry.type === 'int') return String(Math.round(value));
  if (value === 0) return '0';
  if (Math.abs(value) >= 100000) return String(Math.round(value));
  return String(Number(value.toPrecision(4)));
}

/** Parses '0.002', '1e-5', '8M', '2.5k', '1,000,000'; NaN when it is not a number. */
export function parseNumber(text) {
  const s = String(text).replace(/[,_\s]/g, '');
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([kKmM]?)$/.exec(s);
  if (!m) return Number.NaN;
  const scale = m[2] === '' ? 1 : m[2] === 'k' || m[2] === 'K' ? 1e3 : 1e6;
  return Number(m[1]) * scale;
}

export function formatValue(entry, value) {
  switch (entry.type) {
    case 'bool': return value ? 'on' : 'off';
    case 'enum': return (entry.optionLabels && entry.optionLabels[value]) || String(value);
    case 'color': return value;
    case 'gradient': return value.length + ' stops';
    case 'file': return value ? value.name : 'none';
    default: {
      const unit = entry.unit ? (UNIT_TEXT[entry.unit] ?? ' ' + entry.unit) : '';
      return formatNumber(entry, value) + (unit && unit.length <= 7 ? unit : '');
    }
  }
}

/** Checks a .cube 3D LUT: LUT_3D_SIZE N (2..256) followed by N^3 colour rows. */
export function inspectCube(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'The LUT file is not text' };
  const size = /^\s*LUT_3D_SIZE\s+(\d+)\s*$/m.exec(text);
  if (!size) return { ok: false, reason: 'Not a 3D .cube LUT (no LUT_3D_SIZE line)' };
  const n = Number(size[1]);
  if (n < 2 || n > 256) return { ok: false, reason: 'LUT_3D_SIZE ' + n + ' is outside 2 to 256' };
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[-+]?(\d|\.\d)/.test(line)) rows++;
  }
  if (rows !== n * n * n) {
    return { ok: false, reason: 'Expected ' + n * n * n + ' colour rows for LUT_3D_SIZE ' + n + ', found ' + rows };
  }
  return { ok: true, size: n };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

/** sRGB interpolation, matching the CSS preview and the terrain's gradient tables. */
export function gradientColorAt(stops, t) {
  if (t <= stops[0].t) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 1;
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      return rgbToHex(ca.map((v, k) => v + (cb[k] - v) * f));
    }
  }
  return stops[stops.length - 1].color;
}

function cssGradient(stops) {
  return 'linear-gradient(to right, ' + stops.map((s) => s.color + ' ' + (s.t * 100).toFixed(2) + '%').join(', ') + ')';
}

const round3 = (t) => Math.round(Math.min(1, Math.max(0, t)) * 1000) / 1000;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = el('style', null, { id: STYLE_ID });
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Custom lil-gui controllers

/** Log-scale slider in lil-gui's number style; the text field shows the real value. */
class LogNumberController extends Controller {
  constructor(parent, object, property, entry) {
    super(parent, object, property, 'number');
    this.entry = entry;
    this.domElement.classList.add('hasSlider', 'lsp-log');
    this.$slider = el('div', 'slider', { tabindex: 0, role: 'slider', 'aria-labelledby': this.$name.id });
    this.$fill = el('div', 'fill');
    this.$slider.appendChild(this.$fill);
    this.$input = el('input', null, { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-labelledby': this.$name.id });
    this.$widget.append(this.$slider, this.$input);
    this.$disable = this.$input;
    this._focused = false;
    this._dragging = false;

    const fromPointer = (event) => {
      const rect = this.$slider.getBoundingClientRect();
      const value = sliderValue(entry, (event.clientX - rect.left) / rect.width);
      if (value !== this.getValue()) this.setValue(value);
    };
    this.$slider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try {
        this.$slider.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic or already released pointer: dragging still works while over the slider.
      }
      this._dragging = true;
      this.$slider.classList.add('active');
      document.body.classList.add('lil-gui-dragging');
      fromPointer(event);
    });
    this.$slider.addEventListener('pointermove', (event) => {
      if (this._dragging) fromPointer(event);
    });
    const end = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this.$slider.classList.remove('active');
      document.body.classList.remove('lil-gui-dragging');
      this._callOnFinishChange();
    };
    this.$slider.addEventListener('pointerup', end);
    this.$slider.addEventListener('pointercancel', end);
    this.$slider.addEventListener('keydown', (event) => {
      const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!delta) return;
      event.preventDefault();
      const position = sliderPosition(entry, this.getValue()) + delta * (event.shiftKey ? 0.1 : 0.01);
      this.setValue(sliderValue(entry, position));
      this._callOnFinishChange();
    });
    this.$input.addEventListener('focus', () => { this._focused = true; });
    this.$input.addEventListener('blur', () => {
      this._focused = false;
      this._commitText();
      this._callOnFinishChange();
    });
    this.$input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.$input.blur();
      if (event.key === 'Escape') {
        this._focused = false;
        this.updateDisplay();
        this.$input.blur();
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const factor = event.shiftKey ? 2 : 1.1;
        const current = this.getValue();
        const base = current > 0 ? current : (entry.logMin ?? entry.min);
        this.setValue(event.key === 'ArrowUp' ? base * factor : current / factor);
        this.$input.value = formatNumber(entry, this.getValue());
      }
    });
    this.updateDisplay();
  }

  _commitText() {
    const value = parseNumber(this.$input.value);
    if (Number.isFinite(value)) this.setValue(value);
    this.updateDisplay();
  }

  updateDisplay() {
    const value = this.getValue();
    const position = sliderPosition(this.entry, value);
    this.$fill.style.width = position * 100 + '%';
    this.$slider.setAttribute('aria-valuenow', String(value));
    if (!this._focused) this.$input.value = formatNumber(this.entry, value);
    return this;
  }
}

/** Gradient editor: preview bar (click adds a stop), draggable stops, colour and position
 * inputs, add/remove/reverse/even buttons. Editing switches the palette to Custom. */
class GradientController extends Controller {
  constructor(parent, object, property, entry, hooks) {
    super(parent, object, property, 'lsp-gradient');
    this.entry = entry;
    this.hooks = hooks;
    this.maxStops = entry.maxStops ?? 16;
    this.stops = [];
    this.selected = 0;
    this.dragging = null;
    this.$handles = [];

    this.$editor = el('div', 'lsp-grad');
    this.$bar = el('div', 'lsp-grad-bar', { title: 'Click to add a stop. Drag a stop to move it; double-click it to remove it.' });
    this.$track = el('div', 'lsp-grad-track');
    this.$editor.append(this.$bar, this.$track);
    this.$tools = el('div', 'lsp-grad-tools');
    this.$color = el('input', null, { type: 'color', title: 'Colour of the selected stop', 'aria-label': 'Stop colour' });
    this.$pos = el('input', null, { type: 'number', min: 0, max: 1, step: 0.001, title: 'Position of the selected stop (0 to 1)', 'aria-label': 'Stop position' });
    this.$add = el('button', 'lsp-mini', { type: 'button', text: '+', title: 'Add a stop in the widest gap' });
    this.$remove = el('button', 'lsp-mini', { type: 'button', text: '\u2212', title: 'Remove the selected stop' });
    this.$reverse = el('button', 'lsp-mini', { type: 'button', text: '\u21c4', title: 'Reverse the gradient' });
    this.$even = el('button', 'lsp-mini', { type: 'button', text: 'Even', title: 'Space the stops evenly' });
    this.$tools.append(this.$color, this.$pos, this.$add, this.$remove, this.$reverse, this.$even);
    this.$hint = el('div', 'lsp-grad-hint', { text: 'Editing switches Palette to Custom gradient.' });
    this.$widget.append(this.$editor, this.$tools, this.$hint);
    this.$disable = this.$widget;

    this._onMove = (event) => this._drag(event);
    this._onUp = () => this._endDrag();
    this.$bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (this.stops.length >= this.maxStops) {
        hooks.message('A gradient has at most ' + this.maxStops + ' stops');
        return;
      }
      const t = this._tFrom(event.clientX);
      const stop = { t, color: gradientColorAt(this.stops, t) };
      this.stops.push(stop);
      this._sortAndSelect(stop);
      this._commit();
      this._startDrag(stop);
    });
    this.$color.addEventListener('input', () => {
      const stop = this.stops[this.selected];
      if (!stop) return;
      stop.color = this.$color.value;
      this._commit();
    });
    this.$pos.addEventListener('change', () => {
      const stop = this.stops[this.selected];
      const t = Number(this.$pos.value);
      if (!stop || !Number.isFinite(t)) return;
      stop.t = round3(t);
      this._sortAndSelect(stop);
      this._commit();
    });
    this.$add.addEventListener('click', () => this._addInWidestGap());
    this.$remove.addEventListener('click', () => this._removeSelected());
    this.$reverse.addEventListener('click', () => {
      const stop = this.stops[this.selected];
      this.stops = this.stops.map((s) => ({ t: round3(1 - s.t), color: s.color, src: s })).reverse();
      const flipped = this.stops.find((s) => s.src === stop);
      for (const s of this.stops) delete s.src;
      this.selected = Math.max(0, this.stops.indexOf(flipped));
      this._commit();
    });
    this.$even.addEventListener('click', () => {
      const n = this.stops.length;
      this.stops.forEach((s, i) => { s.t = round3(i / (n - 1)); });
      this._commit();
    });
    this.updateDisplay();
  }

  _tFrom(clientX) {
    const rect = this.$bar.getBoundingClientRect();
    return round3((clientX - rect.left) / rect.width);
  }

  _sortAndSelect(stop) {
    this.stops.sort((a, b) => a.t - b.t);
    this.selected = Math.max(0, this.stops.indexOf(stop));
  }

  _commit() {
    this.render();
    this.hooks.commitGradient(this.entry, this.stops.map((s) => ({ t: s.t, color: s.color })));
  }

  _startDrag(stop) {
    this.dragging = stop;
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _drag(event) {
    const stop = this.dragging;
    if (!stop) return;
    const t = this._tFrom(event.clientX);
    if (t === stop.t) return;
    stop.t = t;
    this._sortAndSelect(stop);
    this._commit();
  }

  _endDrag() {
    if (!this.dragging) return;
    this.dragging = null;
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.updateDisplay();
    this._callOnFinishChange();
  }

  _addInWidestGap() {
    if (this.stops.length >= this.maxStops) return;
    const points = [0, ...this.stops.map((s) => s.t), 1];
    let best = 0;
    let at = 0.5;
    for (let i = 1; i < points.length; i++) {
      const gap = points[i] - points[i - 1];
      if (gap > best) {
        best = gap;
        at = (points[i] + points[i - 1]) / 2;
      }
    }
    const stop = { t: round3(at), color: gradientColorAt(this.stops, at) };
    this.stops.push(stop);
    this._sortAndSelect(stop);
    this._commit();
  }

  _removeSelected() {
    if (this.stops.length <= 2) {
      this.hooks.message('A gradient needs at least 2 stops');
      return;
    }
    this.stops.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.stops.length - 1);
    this._commit();
  }

  _handle(index) {
    let handle = this.$handles[index];
    if (handle) return handle;
    handle = el('button', 'lsp-grad-stop', { type: 'button' });
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const i = this.$handles.indexOf(handle);
      this.selected = i;
      this.render();
      handle.focus();
      this._startDrag(this.stops[i]);
    });
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.selected = this.$handles.indexOf(handle);
      this._removeSelected();
    });
    handle.addEventListener('keydown', (event) => {
      const stop = this.stops[this.$handles.indexOf(handle)];
      if (!stop) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = (event.shiftKey ? 0.1 : 0.01) * (event.key === 'ArrowLeft' ? -1 : 1);
        stop.t = round3(stop.t + step);
        this._sortAndSelect(stop);
        this._commit();
        this.$handles[this.selected].focus();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this._removeSelected();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.$color.click();
      }
    });
    this.$handles[index] = handle;
    this.$track.appendChild(handle);
    return handle;
  }

  render() {
    const stops = this.stops;
    this.$bar.style.background = cssGradient(stops);
    for (let i = 0; i < stops.length; i++) {
      const handle = this._handle(i);
      handle.style.left = stops[i].t * 100 + '%';
      handle.style.background = stops[i].color;
      handle.classList.toggle('selected', i === this.selected);
      const label = 'Stop ' + (i + 1) + ' at ' + stops[i].t + ': ' + stops[i].color;
      handle.title = label;
      handle.setAttribute('aria-label', label);
    }
    while (this.$handles.length > stops.length) this.$handles.pop().remove();
    const stop = stops[this.selected];
    if (stop) {
      this.$color.value = stop.color;
      if (document.activeElement !== this.$pos) this.$pos.value = String(stop.t);
    }
    this.$add.disabled = stops.length >= this.maxStops;
    this.$remove.disabled = stops.length <= 2;
    this.$hint.hidden = this.hooks.paletteIsCustom();
  }

  updateDisplay() {
    if (!this.dragging) {
      const value = this.getValue();
      const same = value.length === this.stops.length
        && value.every((s, i) => s.t === this.stops[i].t && s.color === this.stops[i].color);
      if (!same) {
        this.stops = value.map((s) => ({ t: s.t, color: s.color }));
        this.selected = Math.min(this.selected, this.stops.length - 1);
      }
    }
    this.render();
    return this;
  }

  destroy() {
    this._endDrag();
    super.destroy();
  }
}

/** File setting (.cube LUT): load button, file name and clear button. */
class FileController extends Controller {
  constructor(parent, object, property, entry, hooks) {
    super(parent, object, property, 'lsp-file');
    this.entry = entry;
    this.$load = el('button', 'lsp-mini', { type: 'button', text: 'Load\u2026', title: 'Load a ' + (entry.accept || '') + ' file' });
    this.$file = el('span', 'lsp-file-name');
    this.$clear = el('button', 'lsp-mini', { type: 'button', text: '\u2715', title: 'Remove' });
    this.$input = el('input', null, { type: 'file', accept: entry.accept || '' });
    this.$input.hidden = true;
    this.$widget.append(this.$load, this.$file, this.$clear, this.$input);
    this.$disable = this.$load;
    this.$load.addEventListener('click', () => this.$input.click());
    this.$input.addEventListener('change', async () => {
      const file = this.$input.files && this.$input.files[0];
      this.$input.value = '';
      if (file) await hooks.loadFile(entry, file.name, await file.text());
    });
    this.$clear.addEventListener('click', () => {
      this.setValue(null);
      this._callOnFinishChange();
      hooks.message('Removed ' + entry.label);
    });
    this.updateDisplay();
  }

  updateDisplay() {
    const value = this.getValue();
    this.$file.textContent = value ? value.name : 'None';
    this.$file.title = value
      ? value.name + ' (' + Math.max(1, Math.round(value.text.length / 1024)) + ' KB; kept in memory and JSON exports, not in links)'
      : 'Nothing loaded';
    this.$clear.disabled = !value;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Panel

/**
 * @param {object} options
 * @param {HTMLElement} [options.container] element to mount into (lil-gui autoPlaces without it)
 * @param {object} options.store settings store from createSettingsStore
 * @param {object[]} [options.schema] defaults to store.schema
 * @param {object} [options.presets] defaults to store.presets
 * @param {object} [options.capabilities] shown in the header (backend, timestamp-query); the
 *        store's capabilities decide availability, so call store.setCapabilities() first
 * @param {(json: object) => object|void|Promise} [options.onExport] may return an augmented object
 * @param {(json: object, report: object) => void|Promise} [options.onImport] runs after the store imported
 * @param {() => string} [options.getShareURL] full share URL; default merges store.toURL() into location.hash
 * @param {string} [options.title] defaults to 'Settings'
 * @param {number} [options.width] px, defaults to 360
 */
export function createPanel(options = {}) {
  const { container, store, onExport, onImport, getShareURL } = options;
  if (!store) throw new TypeError('createPanel: store is required');
  const schema = options.schema ?? store.schema;
  const presetNames = Object.keys(options.presets ?? store.presets);
  const entries = new Map(schema.map((entry) => [entry.id, entry]));
  const groupLabels = new Map(GROUPS.map((g) => [g.id, g.label]));
  const groupOrder = [...new Set(schema.map((entry) => entry.group))]
    .sort((a, b) => indexOrEnd(GROUPS.map((g) => g.id), a) - indexOrEnd(GROUPS.map((g) => g.id), b));
  injectStyles();

  const gui = new GUI({ container: container ?? undefined, title: options.title ?? 'Settings', width: options.width ?? 360 });
  gui.domElement.classList.add('lsp');

  const controllers = new Map();
  const extras = new Map();
  const folders = [];
  const resetButtons = [];
  let messageTimer = null;
  let filterActive = false;
  let savedOpen = null;
  let paletteModule = null;

  // Header: preset, status, search, actions, notes, overrides
  const header = el('div', 'lsp-header');
  const presetRow = el('div', 'lsp-hrow');
  const presetLabel = el('label', 'lsp-hlabel', { text: 'Preset', for: 'lsp-preset-' + Math.random().toString(36).slice(2) });
  const presetSelect = el('select', 'lsp-preset', { id: presetLabel.getAttribute('for') });
  for (const name of presetNames) presetSelect.appendChild(el('option', null, { value: name, text: name }));
  const presetPill = el('span', 'lsp-pill');
  const backendPill = el('span', 'lsp-pill lsp-backend');
  presetRow.append(presetLabel, presetSelect, presetPill, backendPill);
  const status = el('div', 'lsp-status', { role: 'status' });
  const description = el('div', 'lsp-desc');
  const search = el('input', 'lsp-search', { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings', spellcheck: 'false' });
  const buttons = el('div', 'lsp-buttons');
  const buttonDefs = [
    ['reset', 'Reset all', 'Reset every setting to the preset (personal preferences to defaults)'],
    ['export', 'Export', 'Download all settings as JSON'],
    ['import', 'Import', 'Load settings from a JSON file'],
    ['share', 'Copy link', 'Copy a link with the preset and the settings that differ from it'],
  ];
  const actionButtons = {};
  for (const [action, text, title] of buttonDefs) {
    const button = el('button', null, { type: 'button', text, title, 'data-action': action });
    actionButtons[action] = button;
    buttons.appendChild(button);
  }
  const importInput = el('input', null, { type: 'file', accept: '.json,application/json' });
  importInput.hidden = true;
  const note = el('div', 'lsp-note');
  note.hidden = true;
  const messageBox = el('div', 'lsp-message', { 'aria-live': 'polite' });
  messageBox.hidden = true;
  const overridesBox = el('details', 'lsp-overrides');
  const overridesSummary = el('summary', null, { text: 'Overrides (0)' });
  const overridesList = el('ul', 'lsp-ov-list');
  overridesBox.append(overridesSummary, overridesList);
  const legend = el('div', 'lsp-legend', {
    text: 'Amber names differ from the preset (double-click a name to revert). \u21bb rebuilds a pass when changed.',
  });
  header.append(presetRow, description, status, search, buttons, importInput, note, messageBox, overridesBox, legend);
  gui.domElement.insertBefore(header, gui.$children);
  // lil-gui's root stops keydown/keyup propagation, so keys typed anywhere in the panel
  // (header included) never reach the app's shortcuts.

  // Value proxy: lil-gui reads and writes store values through it.
  const proxy = {};
  for (const entry of schema) {
    Object.defineProperty(proxy, entry.id, {
      enumerable: true,
      get: () => store.get(entry.id),
      set: (value) => {
        try {
          store.set(entry.id, value);
        } catch (error) {
          message(error.message, 'error');
        }
      },
    });
  }

  const hooks = {
    message: (text, kind) => message(text, kind),
    paletteIsCustom: () => !entries.has('color.palette') || store.get('color.palette') === 'custom',
    commitGradient(entry, stops) {
      const patch = { [entry.id]: stops };
      if (entry.id === 'color.gradient' && entries.has('color.palette') && store.get('color.palette') !== 'custom') {
        patch['color.palette'] = 'custom';
      }
      try {
        store.setMany(patch);
      } catch (error) {
        message(error.message, 'error');
      }
    },
    async loadFile(entry, name, text) {
      if (entry.accept === '.cube') {
        const check = inspectCube(text);
        if (!check.ok) {
          message(name + ': ' + check.reason, 'error');
          return false;
        }
        store.set(entry.id, { name, text });
        message('Loaded ' + name + ' (' + check.size + '\u00b3 LUT)');
        return true;
      }
      store.set(entry.id, { name, text });
      message('Loaded ' + name);
      return true;
    },
  };

  // Folders and controllers
  for (const groupId of groupOrder) {
    const groupLabel = groupLabels.get(groupId) ?? groupId;
    const folder = gui.addFolder(groupLabel);
    folder.domElement.classList.add('lsp-group');
    folder.domElement.dataset.group = groupId;
    folders.push(folder);
    const sections = new Map();
    for (const entry of schema) {
      if (entry.group !== groupId) continue;
      let parent = folder;
      if (entry.section) {
        parent = sections.get(entry.section);
        if (!parent) {
          parent = folder.addFolder(entry.section);
          parent.domElement.classList.add('lsp-section');
          if (sections.size > 0) parent.close();
          sections.set(entry.section, parent);
          folders.push(parent);
        }
      }
      controllers.set(entry.id, makeController(parent, entry));
    }
    const reset = folder.add({ reset: () => resetGroup(groupId) }, 'reset').name('Reset ' + groupLabel.toLowerCase());
    reset.domElement.classList.add('lsp-reset');
    reset.domElement.title = 'Reset every ' + groupLabel.toLowerCase() + ' setting to the preset';
    resetButtons.push(reset);
    if (!DEFAULT_OPEN_GROUPS.has(groupId)) folder.close();
  }

  // Palette strip under the palette selector (terrain's pure palette module).
  const paletteController = controllers.get('color.palette');
  let strip = null;
  if (paletteController) {
    const row = el('div', 'lsp-strip-row');
    strip = el('canvas', 'lsp-strip', { width: 256, height: 2 });
    row.appendChild(strip);
    paletteController.domElement.after(row);
    extras.set('color.palette', row);
    import('../render/terrain/palette.js')
      .then((module) => {
        paletteModule = module;
        drawStrip();
      })
      .catch(() => { row.hidden = true; });
  }

  function makeController(parent, entry) {
    let controller;
    switch (entry.type) {
      case 'number':
      case 'int':
        controller = entry.scale === 'log'
          ? new LogNumberController(parent, proxy, entry.id, entry)
          : parent.add(proxy, entry.id, entry.min, entry.max, entry.step);
        break;
      case 'bool':
        controller = parent.add(proxy, entry.id);
        break;
      case 'enum': {
        const map = {};
        for (const option of entry.options) map[(entry.optionLabels && entry.optionLabels[option]) || String(option)] = option;
        controller = parent.add(proxy, entry.id, map);
        break;
      }
      case 'color':
        controller = parent.addColor(proxy, entry.id);
        break;
      case 'gradient':
        controller = new GradientController(parent, proxy, entry.id, entry, hooks);
        break;
      case 'file':
        controller = new FileController(parent, proxy, entry.id, entry, hooks);
        break;
      default:
        throw new Error('createPanel: unsupported setting type ' + entry.type);
    }
    controller.domElement.classList.add('lsp-setting');
    controller.domElement.dataset.settingId = entry.id;
    controller.$name.textContent = '';
    controller.$name.appendChild(el('span', 'lsp-label', { text: entry.label }));
    if (entry.webgpu || entry.webgpuOptions) {
      controller.$name.appendChild(el('span', 'lsp-tag lsp-tag-gpu', { text: 'WebGPU', title: entry.webgpu ? 'Needs WebGPU' : 'Some options need WebGPU' }));
    }
    if (entry.rebuild !== 'none') {
      controller.$name.appendChild(el('span', 'lsp-tag lsp-tag-rebuild', { text: '\u21bb', title: REBUILD_CLASSES[entry.rebuild] }));
    }
    controller.$name.title = tooltip(entry);
    controller.$name.addEventListener('dblclick', () => revert(entry.id));
    return controller;
  }

  function tooltip(entry) {
    const lines = [entry.label, entry.help];
    if (entry.type === 'number' || entry.type === 'int') {
      lines.push('Range ' + formatNumber(entry, entry.min) + ' to ' + formatNumber(entry, entry.max)
        + (entry.unit ? ' ' + (UNIT_TEXT[entry.unit] ?? entry.unit) : '') + (entry.scale === 'log' ? ' (log slider)' : ''));
    }
    if (entry.rebuild !== 'none') lines.push(REBUILD_CLASSES[entry.rebuild]);
    if (entry.webgpu) lines.push('Needs WebGPU.');
    if (entry.preset === false) lines.push('Personal preference: presets leave it alone.');
    if (!entry.url) lines.push('Not included in share links.');
    lines.push(entry.id + ' \u00b7 double-click the name to revert to the preset');
    return lines.join('\n');
  }

  function message(text, kind = 'info', undo = null) {
    messageBox.textContent = '';
    messageBox.className = 'lsp-message lsp-' + kind;
    messageBox.appendChild(el('span', null, { text }));
    if (undo) {
      const button = el('button', 'lsp-link', { type: 'button', text: 'Undo' });
      button.addEventListener('click', () => {
        store.fromJSON(undo);
        message('Restored the previous settings');
      });
      messageBox.appendChild(button);
    }
    messageBox.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { messageBox.hidden = true; }, undo ? UNDO_MS : kind === 'error' ? 8000 : MESSAGE_MS);
  }

  function revert(id) {
    const before = store.get(id);
    store.reset(id);
    if (!valuesEqual(before, store.get(id))) message(entries.get(id).label + ' reverted to ' + formatValue(entries.get(id), store.get(id)));
  }

  function resetGroup(groupId) {
    const snapshot = store.toJSON();
    store.reset(groupId);
    message((groupLabels.get(groupId) ?? groupId) + ' reset to ' + store.basePreset, 'info', snapshot);
  }

  function drawStrip() {
    if (!strip || !paletteModule) return;
    const name = store.get('color.palette');
    const opts = { gradient: entries.has('color.gradient') ? store.get('color.gradient') : null, reverse: entries.has('color.reverse') && store.get('color.reverse') };
    let base;
    let whale;
    try {
      base = paletteModule.paletteRGB(name, opts);
      whale = entries.has('color.whiteHot') && store.get('color.whiteHot') ? paletteModule.paletteRGB(name, { ...opts, whiteHot: true }) : base;
    } catch {
      return;
    }
    const context = strip.getContext('2d');
    const image = context.createImageData(256, 2);
    for (let i = 0; i < 256; i++) {
      for (let row = 0; row < 2; row++) {
        const rgb = row === 0 ? base : whale;
        const o = (row * 256 + i) * 4;
        image.data[o] = rgb[i * 3];
        image.data[o + 1] = rgb[i * 3 + 1];
        image.data[o + 2] = rgb[i * 3 + 2];
        image.data[o + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const btc = entries.has('color.whiteHotBTC') ? store.get('color.whiteHotBTC') : null;
    strip.title = 'Top: palette, low values to high. Bottom: '
      + (whale === base ? 'same (white-hot off).' : 'white-hot variant on whale rows' + (btc !== null ? ' (\u2265 ' + formatNumber(null, btc) + ' BTC).' : '.'));
  }

  function updateAvailability() {
    const webgpu = store.webgpu;
    gui.domElement.classList.toggle('lsp-webgl2', !webgpu);
    const caps = { ...store.capabilities, ...(options.capabilities ?? {}) };
    backendPill.textContent = webgpu ? 'WebGPU' : 'WebGL2';
    backendPill.title = webgpu
      ? 'WebGPU backend' + (caps.timestamp === true ? ' with GPU timestamps' : caps.timestamp === false ? ' (no GPU timestamps)' : '')
      : 'WebGL2 backend: compute features are off and presets stop at High';
    note.hidden = webgpu;
    note.textContent = webgpu ? '' : 'WebGL2 backend: settings marked WebGPU are disabled and Ultra and Extreme fall back to High.';
    for (const [id, controller] of controllers) {
      const entry = entries.get(id);
      controller.disable(!store.isAvailable(id));
      if (entry.webgpuOptions && controller.$select) {
        Array.from(controller.$select.options).forEach((option, index) => {
          const value = controller._values[index];
          const available = store.isAvailable(id, value);
          option.disabled = !available;
          option.textContent = controller._names[index] + (available ? '' : ' (WebGPU)');
        });
      }
    }
    for (const option of presetSelect.options) {
      const available = store.isPresetAvailable(option.value);
      option.disabled = !available;
      option.textContent = option.value + (available ? '' : ' (WebGPU only)');
    }
  }

  function updateStatus() {
    const base = store.basePreset;
    const preset = store.preset;
    const overrides = store.overrides();
    const ids = Object.keys(overrides);
    const governed = ids.filter((id) => entries.get(id).preset !== false).length;
    const preferences = ids.length - governed;
    presetSelect.value = base;
    presetPill.textContent = preset === 'Custom' ? 'Custom' : base;
    presetPill.classList.toggle('custom', preset === 'Custom');
    presetPill.title = preset === 'Custom' ? base + ' with ' + governed + ' changed setting' + (governed === 1 ? '' : 's') : 'Exactly the ' + base + ' preset';
    const parts = [];
    if (preset === 'Custom') parts.push('Custom: ' + base + ' + ' + governed + ' override' + (governed === 1 ? '' : 's'));
    else parts.push(base + ', no overrides');
    if (preferences) parts.push(preferences + ' personal preference' + (preferences === 1 ? '' : 's') + ' changed');
    status.textContent = parts.join(' \u00b7 ');
    description.textContent = PRESET_INFO[base] ?? '';
    overridesSummary.textContent = 'Overrides (' + ids.length + ')';
    overridesBox.hidden = ids.length === 0;
    overridesList.textContent = '';
    const presetValues = store.presetValues(base);
    for (const id of ids) {
      const entry = entries.get(id);
      const item = el('li', 'lsp-ov-item');
      const context = entry.section ?? groupLabels.get(entry.group) ?? entry.group;
      const name = el('button', 'lsp-ov-name', {
        type: 'button',
        title: 'Show ' + (groupLabels.get(entry.group) ?? entry.group) + (entry.section ? ' > ' + entry.section : '') + ' > ' + entry.label + ' (' + entry.id + ')',
      });
      name.append(el('span', 'lsp-ov-context', { text: context + ' \u203a ' }), entry.label);
      name.addEventListener('click', () => reveal(id));
      const value = el('span', 'lsp-ov-value', {
        text: formatValue(entry, overrides[id]),
        title: (entry.preset === false ? 'Default ' : base + ' value ') + formatValue(entry, presetValues[id]),
      });
      const undo = el('button', 'lsp-ov-revert', { type: 'button', text: '\u21ba', title: 'Revert to ' + formatValue(entry, presetValues[id]) });
      undo.addEventListener('click', () => revert(id));
      item.append(name, value, undo);
      overridesList.appendChild(item);
    }
    for (const [id, controller] of controllers) controller.domElement.classList.toggle('lsp-overridden', id in overrides);
  }

  function filter(text) {
    const query = String(text ?? '').trim().toLowerCase();
    if (search.value.trim().toLowerCase() !== query) search.value = text ?? '';
    if (query && !filterActive) {
      savedOpen = new Map(folders.map((folder) => [folder, !folder._closed]));
      filterActive = true;
    }
    const words = query.split(/\s+/).filter(Boolean);
    let matches = 0;
    for (const [id, controller] of controllers) {
      const entry = entries.get(id);
      const haystack = [entry.label, entry.id, entry.section ?? '', groupLabels.get(entry.group) ?? '', entry.help,
        ...(entry.options ? entry.options.map((o) => (entry.optionLabels && entry.optionLabels[o]) || String(o)) : [])]
        .join(' ').toLowerCase();
      const match = words.every((word) => haystack.includes(word));
      controller.show(match);
      const extra = extras.get(id);
      if (extra) extra.style.display = match ? '' : 'none';
      if (match) matches++;
    }
    for (const reset of resetButtons) reset.show(!query);
    // Folders: visible when any descendant controller is; open matches while searching.
    for (const folder of [...folders].reverse()) {
      const visible = folder.controllersRecursive().some((c) => !c._hidden && !resetButtons.includes(c));
      folder.show(visible || !query);
      if (query && visible) folder.open();
    }
    if (!query && filterActive) {
      for (const [folder, open] of savedOpen) folder.open(open);
      filterActive = false;
      savedOpen = null;
    }
    if (query) status.textContent = matches + ' setting' + (matches === 1 ? '' : 's') + ' match \u201c' + query + '\u201d';
    else updateStatus();
    return matches;
  }

  function reveal(id) {
    const controller = controllers.get(id);
    if (!controller) return false;
    if (filterActive) filter('');
    gui.show();
    gui.open();
    for (let folder = controller.parent; folder; folder = folder.parent) folder.open();
    controller.domElement.scrollIntoView({ block: 'center' });
    controller.domElement.classList.remove('lsp-flash');
    void controller.domElement.offsetWidth;
    controller.domElement.classList.add('lsp-flash');
    return true;
  }

  async function exportJSON({ download = true } = {}) {
    let data = store.toJSON();
    if (onExport) {
      const result = await onExport(data);
      if (result && typeof result === 'object') data = result;
    }
    if (download) {
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', null, { href: url, download: 'utxo-landscape-settings-' + timestamp() + '.json' });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    message('Exported ' + Object.keys(data.values ?? {}).length + ' settings (' + store.preset + ')');
    return data;
  }

  async function importJSON(text, name = 'settings file') {
    let data;
    try {
      data = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (error) {
      message(name + ' is not JSON: ' + error.message, 'error');
      return null;
    }
    const snapshot = store.toJSON();
    let report;
    try {
      report = store.fromJSON(data);
    } catch (error) {
      message(name + ': ' + error.message, 'error');
      return null;
    }
    if (onImport) await onImport(data, report);
    const extra = [];
    if (report.ignored.length) extra.push(report.ignored.length + ' unknown ignored');
    if (report.invalid.length) extra.push(report.invalid.length + ' invalid skipped');
    message('Imported ' + report.applied.length + ' settings from ' + name + (extra.length ? ' (' + extra.join(', ') + ')' : ''), 'info', snapshot);
    return report;
  }

  async function shareURL() {
    const url = getShareURL
      ? getShareURL()
      : location.origin + location.pathname + location.search + '#' + store.mergeIntoHash(location.hash);
    try {
      await navigator.clipboard.writeText(url);
      message('Link copied (' + store.preset + ')');
    } catch {
      messageBox.textContent = '';
      messageBox.className = 'lsp-message lsp-info';
      const field = el('input', null, { type: 'text', readonly: true, value: url, 'aria-label': 'Share link' });
      messageBox.append(el('span', null, { text: 'Copy:' }), field);
      messageBox.hidden = false;
      field.focus();
      field.select();
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => { messageBox.hidden = true; }, 15000);
    }
    return url;
  }

  function refresh() {
    updateAvailability();
    for (const controller of controllers.values()) controller.updateDisplay();
    drawStrip();
    if (filterActive) filter(search.value);
    else updateStatus();
  }

  // Wiring
  presetSelect.addEventListener('change', () => {
    const name = presetSelect.value;
    const snapshot = store.toJSON();
    const applied = store.applyPreset(name);
    message(applied === name ? 'Preset ' + name : name + ' needs WebGPU; applied ' + applied, 'info', snapshot);
  });
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      search.value = '';
      filter('');
    }
  });
  actionButtons.reset.addEventListener('click', () => {
    const snapshot = store.toJSON();
    store.reset();
    message('All settings reset to ' + store.basePreset, 'info', snapshot);
  });
  actionButtons.export.addEventListener('click', () => { exportJSON().catch((error) => message(error.message, 'error')); });
  actionButtons.import.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (file) await importJSON(await file.text(), file.name);
  });
  actionButtons.share.addEventListener('click', () => { shareURL(); });

  const unsubscribe = store.subscribe('*', (changes) => {
    let redrawStrip = false;
    for (const change of changes) {
      const controller = controllers.get(change.id);
      if (controller) controller.updateDisplay();
      if (STRIP_IDS.has(change.id)) redrawStrip = true;
      if (change.id === 'color.palette') controllers.get('color.gradient')?.updateDisplay();
    }
    if (redrawStrip) drawStrip();
    if (filterActive) filter(search.value);
    else updateStatus();
  });
  const offPreset = store.onPresetChange(() => {
    updateAvailability();
    if (!filterActive) updateStatus();
  });

  updateAvailability();
  updateStatus();

  return {
    gui,
    domElement: gui.domElement,
    controllers,
    open() {
      gui.show();
      gui.open();
    },
    close() { gui.close(); },
    toggle() {
      if (gui._hidden || gui._closed) {
        gui.show();
        gui.open();
      } else {
        gui.close();
      }
    },
    isOpen: () => !gui._hidden && !gui._closed,
    show() { gui.show(); },
    hide() { gui.hide(); },
    filter,
    reveal,
    refresh,
    exportJSON,
    importJSON,
    shareURL,
    loadFile: (id, name, text) => hooks.loadFile(entries.get(id), name, text),
    message,
    dispose() {
      unsubscribe();
      offPreset();
      clearTimeout(messageTimer);
      for (const controller of controllers.values()) {
        if (controller instanceof GradientController) controller._endDrag();
      }
      gui.destroy();
    },
  };
}

function indexOrEnd(list, value) {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

const CSS = [
  '.lsp.lil-gui{--background-color:rgba(11,13,19,.95);--title-background-color:#080a0f;--title-text-color:#eef1f6;',
  '--text-color:#dfe4ee;--widget-color:#232937;--hover-color:#2b3243;--focus-color:#353e53;--number-color:#7cc7ff;',
  '--string-color:#a6e07a;--font-size:11.5px;--input-font-size:11.5px;--padding:6px;--spacing:4px;--widget-height:21px;',
  '--name-width:43%;--lsp-accent:#ffb547;--lsp-muted:#8d96a8;max-height:100%;box-shadow:0 8px 30px rgba(0,0,0,.45)}',
  '.lsp.lil-gui.root>.children{flex:1 1 auto;min-height:0}',
  '.lsp.closed>.lsp-header{display:none}',
  '.lsp .lsp-header{display:flex;flex-direction:column;gap:6px;padding:7px var(--padding) 8px;border-bottom:1px solid var(--widget-color);flex:0 0 auto;line-height:1.35}',
  '.lsp .lsp-hrow{display:flex;align-items:center;gap:6px}',
  '.lsp .lsp-hlabel{color:var(--lsp-muted)}',
  '.lsp select.lsp-preset{flex:1;min-width:0;height:var(--widget-height);background:var(--widget-color);color:var(--text-color);border:0;border-radius:var(--widget-border-radius);font:inherit;padding:0 4px;cursor:pointer}',
  '.lsp select.lsp-preset:focus{background:var(--focus-color);outline:none}',
  '.lsp .lsp-pill{font-size:10px;line-height:16px;padding:0 7px;border-radius:8px;background:var(--widget-color);color:var(--lsp-muted);white-space:nowrap}',
  '.lsp .lsp-pill.custom{background:rgba(255,181,71,.18);color:var(--lsp-accent)}',
  '.lsp .lsp-desc{color:var(--lsp-muted);font-size:10.5px}',
  '.lsp .lsp-status{color:var(--text-color)}',
  '.lsp input.lsp-search{padding:0 6px}',
  '.lsp input.lsp-search::placeholder{color:var(--lsp-muted)}',
  '.lsp .lsp-buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}',
  '.lsp .lsp-buttons button{padding:0 4px}',
  '.lsp .lsp-buttons button:hover,.lsp button.lsp-mini:hover{background:var(--hover-color)}',
  '.lsp .lsp-note{color:#ffd59a;background:rgba(255,181,71,.1);border-radius:3px;padding:4px 6px}',
  '.lsp .lsp-message{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:3px;background:rgba(124,199,255,.12)}',
  '.lsp .lsp-message.lsp-error{background:rgba(255,95,95,.16);color:#ffb9b9}',
  '.lsp .lsp-message input{flex:1;min-width:0}',
  '.lsp .lsp-message[hidden],.lsp .lsp-note[hidden],.lsp .lsp-overrides[hidden]{display:none}',
  '.lsp button.lsp-link{width:auto;height:auto;background:none;border:0;padding:0;color:var(--lsp-accent);text-decoration:underline;line-height:inherit}',
  '.lsp details.lsp-overrides summary{cursor:pointer;color:var(--lsp-accent)}',
  '.lsp .lsp-ov-list{list-style:none;margin:4px 0 0;padding:0;max-height:168px;overflow:auto}',
  '.lsp .lsp-ov-item{display:grid;grid-template-columns:minmax(0,1fr) auto 22px;gap:6px;align-items:center;padding:1px 0}',
  '.lsp .lsp-ov-name{width:auto;height:18px;line-height:16px;text-align:left;background:none;border:0;padding:0;color:var(--text-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.lsp .lsp-ov-name:hover{text-decoration:underline}',
  '.lsp .lsp-ov-context{color:var(--lsp-muted)}',
  '.lsp .lsp-ov-value{color:var(--number-color);font-family:var(--font-family-mono);font-size:10.5px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}',
  '.lsp .lsp-ov-revert{height:18px;line-height:14px;padding:0}',
  '.lsp .lsp-legend{color:var(--lsp-muted);font-size:10px}',
  '.lsp .controller>.name{display:flex;align-items:center;gap:4px;max-width:var(--name-width);overflow:hidden}',
  '.lsp .lsp-label{overflow:hidden;text-overflow:ellipsis}',
  '.lsp .lsp-tag{flex-shrink:0;font-size:9px;line-height:13px;padding:0 3px;border-radius:3px}',
  '.lsp .lsp-tag-rebuild{color:var(--lsp-muted);padding:0}',
  '.lsp .lsp-tag-gpu{display:none;background:rgba(255,181,71,.18);color:var(--lsp-accent)}',
  '.lsp.lsp-webgl2 .lsp-tag-gpu{display:inline-block}',
  '.lsp .controller.lsp-overridden>.name .lsp-label{color:var(--lsp-accent)}',
  '.lsp .controller.lsp-overridden>.name:before{content:"";flex-shrink:0;width:5px;height:5px;border-radius:50%;background:var(--lsp-accent)}',
  '.lsp .controller.lsp-flash{animation:lsp-flash 1.4s ease-out}',
  '@keyframes lsp-flash{from{background:rgba(255,181,71,.35)}to{background:transparent}}',
  '.lsp .controller.lsp-reset button{color:var(--lsp-muted)}',
  '.lsp .controller.lsp-log .slider:focus{outline:1px solid var(--focus-color)}',
  '.lsp .controller.lsp-gradient{flex-wrap:wrap}',
  '.lsp .controller.lsp-gradient>.name{max-width:none;min-width:100%}',
  '.lsp .controller.lsp-gradient>.widget{flex-direction:column;align-items:stretch;gap:4px;padding:2px 0 4px}',
  '.lsp .lsp-grad{position:relative;padding:0 6px}',
  '.lsp .lsp-grad-bar{height:20px;border-radius:3px;cursor:copy;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}',
  '.lsp .lsp-grad-track{position:relative;height:15px}',
  '.lsp button.lsp-grad-stop{position:absolute;top:2px;width:12px;height:12px;margin-left:-6px;padding:0;border:2px solid rgba(0,0,0,.8);border-radius:2px 2px 7px 7px;box-shadow:0 0 0 1px rgba(255,255,255,.6);cursor:ew-resize}',
  '.lsp button.lsp-grad-stop.selected{box-shadow:0 0 0 2px var(--lsp-accent)}',
  '.lsp button.lsp-grad-stop:focus-visible{outline:1px solid #fff}',
  '.lsp .lsp-grad-tools{display:flex;gap:4px;align-items:center}',
  '.lsp .lsp-grad-tools input[type=color]{flex:0 0 32px;width:32px;height:var(--widget-height);padding:0;border:0;background:none;cursor:pointer}',
  '.lsp .lsp-grad-tools input[type=number]{flex:1 1 auto;min-width:48px}',
  '.lsp button.lsp-mini{flex:0 0 auto;width:auto;min-width:24px;padding:0 6px}',
  '.lsp button.lsp-mini:disabled{opacity:.4;cursor:default}',
  '.lsp .lsp-grad-hint{color:var(--lsp-muted);font-size:10px}',
  '.lsp .lsp-grad-hint[hidden]{display:none}',
  '.lsp .controller.lsp-file .widget{gap:4px}',
  '.lsp .lsp-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lsp-muted)}',
  '.lsp .lsp-strip-row{padding:0 var(--padding) var(--spacing) calc(var(--name-width) + var(--padding))}',
  '.lsp canvas.lsp-strip{display:block;width:100%;height:14px;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}',
].join('\n');
