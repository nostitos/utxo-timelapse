// UTXO Timelapse Landscape: quick settings at the top of the settings panel (ui_settings).
//
// Draws the controls of settings.quick.js: Look (with Save… and Delete for presets saved in
// this browser), Quality, Column distance and Terrain detail, then the Scene, Data and View
// rows. Each row reads the store, shows the active option or slider position ('—' when the
// values were set by hand in Advanced) and dims, with the reason in its tooltip, while it has
// no effect. Blend sliders run between named stops, listed under them as buttons that jump to
// the stop. Changes go straight to the store.
// ui/panel.js mounts the element; messages (with Undo) go through its message box.

import {
  QUICK, QUICK_SECTIONS, quickOption, quickPatch, blendPatch, blendPosition, blendValue,
  countText,
} from '../settings.quick.js';
import { LOOK_INFO, QUALITY_INFO, REBUILD_CLASSES } from '../settings.schema.js';
import { MAX_PRESET_NAME } from '../settings.js';

let uid = 0;

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

const nextId = (prefix) => 'lsq-' + prefix + '-' + ++uid;

/** Fills the track up to the thumb's centre (fraction 0..1; the thumb is 14 px wide). */
function setFill(range, fraction) {
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  range.style.setProperty('--fill', 'calc(7px + ' + f.toFixed(4) + ' * (100% - 14px))');
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(4)));
}

function savedOn(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * @param {object} options
 * @param {object} options.store settings store (settings.js)
 * @param {object[]} [options.controls] defaults to QUICK
 * @param {(text: string, kind?: string, undo?: object|Function) => void} [options.message]
 * @param {() => object|null} [options.perf] live frame cost for the Now readout: {gpuMs, frameMs,
 *   fps, columns: {drawn, needed, budget, reach, requested} | null, uniform: {level, short, coarser} | null}
 * @returns {{domElement: HTMLElement, refresh: () => void, row: (id: string) => HTMLElement|null,
 *   openSave: (name?: string) => void, dispose: () => void}}
 */
export function createQuickSettings({ store, controls = QUICK, message = () => {}, perf = null } = {}) {
  if (!store) throw new TypeError('createQuickSettings: store is required');
  const root = el('div', 'lsq');
  const built = [];
  const timers = [];

  for (const section of QUICK_SECTIONS) {
    const list = controls.filter((control) => control.section === section);
    if (!list.length) continue;
    const sec = el('section', 'lsq-sec', { 'data-section': section, 'aria-label': section });
    sec.appendChild(el('h3', 'lsq-h', { text: section }));
    for (const control of list) {
      const b = build(control);
      b.row.dataset.quick = control.id;
      sec.appendChild(b.row);
      built.push(b);
    }
    root.appendChild(sec);
  }

  function build(control) {
    switch (control.type) {
      case 'look': return buildLook(control);
      case 'quality': return buildQuality(control);
      case 'choice':
      case 'toggle': return buildChoice(control);
      case 'blend': return buildBlend(control);
      case 'select': return buildSelect(control);
      case 'slider': return buildSlider(control);
      case 'toggles': return buildToggles(control);
      case 'readout': return buildReadout(control);
      default: throw new Error('quick settings: unknown control type ' + control.type);
    }
  }

  function labelFor(control, forId) {
    const label = el(forId ? 'label' : 'span', 'lsq-label', { text: control.label, for: forId });
    return label;
  }

  function rebuildTag(control) {
    return control.rebuild && REBUILD_CLASSES[control.rebuild]
      ? el('span', 'lsq-tag', { text: '\u21bb', title: REBUILD_CLASSES[control.rebuild], 'aria-hidden': 'true' })
      : null;
  }

  /** Dims a row whose control has no effect now and explains why in the label's tooltip. */
  function applyNeeds(control, row, label) {
    const why = control.needs && typeof store.checkNeeds === 'function' ? store.checkNeeds(control.needs) : null;
    row.classList.toggle('lsq-inert', !!why);
    label.title = control.help + (why ? '\nNo effect with ' + why.text + '.' : '');
  }

  // ---- Look: built-in looks and saved presets --------------------------------------------
  function buildLook(control) {
    const row = el('div', 'lsq-row lsq-look');
    const id = nextId('look');
    const label = labelFor(control, id);
    label.title = control.help;
    const line = el('div', 'lsq-line');
    const select = el('select', 'lsq-select', { id });
    const saveButton = el('button', 'lsq-btn', { type: 'button', text: 'Save\u2026', 'data-act': 'save',
      title: 'Save the current settings as a look in this browser' });
    const deleteButton = el('button', 'lsq-btn', { type: 'button', text: 'Delete', 'data-act': 'delete' });
    line.append(select, saveButton, deleteButton);
    const form = el('div', 'lsq-saveform');
    form.hidden = true;
    const input = el('input', 'lsq-name', { type: 'text', maxlength: MAX_PRESET_NAME, placeholder: 'Name for this look',
      'aria-label': 'Name for the saved look', spellcheck: 'false', autocomplete: 'off' });
    const confirm = el('button', 'lsq-btn lsq-primary', { type: 'button', text: 'Save', 'data-act': 'confirm' });
    const cancel = el('button', 'lsq-btn', { type: 'button', text: 'Cancel', 'data-act': 'cancel' });
    form.append(input, confirm, cancel);
    const desc = el('p', 'lsq-desc');
    row.append(label, line, form, desc);
    let listed = '';

    function fillOptions() {
      const names = store.userPresets.map((record) => record.name);
      const key = store.looks.join('\u0000') + '\u0001' + names.join('\u0000');
      if (key === listed) return;
      listed = key;
      select.textContent = '';
      const looks = el('optgroup', null, { label: 'Looks' });
      for (const name of store.looks) looks.appendChild(el('option', null, { value: name, text: name }));
      select.appendChild(looks);
      if (names.length) {
        const saved = el('optgroup', null, { label: 'Saved' });
        for (const name of names) saved.appendChild(el('option', null, { value: name, text: name }));
        select.appendChild(saved);
      }
    }

    function openForm(name) {
      const user = store.userPreset(store.look);
      input.value = name ?? (user ? user.name : '');
      form.hidden = false;
      saveButton.setAttribute('aria-expanded', 'true');
      input.focus();
      input.select();
    }
    function closeForm() {
      form.hidden = true;
      saveButton.setAttribute('aria-expanded', 'false');
    }
    function save() {
      let result;
      try {
        result = store.saveUserPreset(input.value);
      } catch (error) {
        message(error.message, 'error');
        input.focus();
        return;
      }
      closeForm();
      const { record, replaced } = result;
      if (replaced) {
        message('Updated \u201c' + record.name + '\u201d', 'info', () => {
          store.restoreUserPreset(replaced);
          message('Restored the earlier \u201c' + replaced.name + '\u201d');
        });
      } else {
        message('Saved \u201c' + record.name + '\u201d in this browser');
      }
    }

    select.addEventListener('change', () => {
      const name = select.value;
      const snapshot = store.toJSON();
      const wasModified = store.modified;
      try {
        store.setLook(name);
      } catch (error) {
        message(error.message, 'error');
        return;
      }
      if (wasModified) message(name + ': your changes to the previous look were cleared', 'info', snapshot);
    });
    saveButton.addEventListener('click', () => (form.hidden ? openForm() : closeForm()));
    confirm.addEventListener('click', save);
    cancel.addEventListener('click', closeForm);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeForm();
        saveButton.focus();
      }
    });
    deleteButton.addEventListener('click', () => {
      const user = store.userPreset(store.look);
      if (!user) return;
      let record;
      try {
        record = store.deleteUserPreset(user.name);
      } catch (error) {
        message(error.message, 'error');
        return;
      }
      message('Deleted \u201c' + record.name + '\u201d', 'info', () => {
        store.restoreUserPreset(record, { activate: true });
        message('Restored \u201c' + record.name + '\u201d');
      });
    });

    function update() {
      fillOptions();
      select.value = store.look;
      const user = store.userPreset(store.look);
      deleteButton.hidden = !user;
      deleteButton.title = user ? 'Delete \u201c' + user.name + '\u201d from this browser' : '';
      if (user) {
        const n = Object.keys(user.overrides).length;
        const when = savedOn(user.savedAt);
        desc.textContent = 'Saved in this browser' + (when ? ' on ' + when : '') + ': ' + user.look + ' at ' + user.quality
          + (n ? ' with ' + n + ' setting' + (n === 1 ? '' : 's') + ' changed.' : '.');
      } else {
        desc.textContent = LOOK_INFO[store.look] ?? '';
      }
    }
    return { control, row, update, openForm };
  }

  // ---- Quality ----------------------------------------------------------------------------
  function buildQuality(control) {
    const row = el('div', 'lsq-row lsq-stack');
    const head = el('div', 'lsq-head');
    const label = labelFor(control);
    label.title = control.help;
    head.appendChild(label);
    const seg = el('div', 'lsq-seg', { role: 'group', 'aria-label': control.label });
    const buttons = store.qualities.map((name) => {
      const button = el('button', null, { type: 'button', text: name, 'data-option': name, 'aria-pressed': 'false' });
      button.addEventListener('click', () => {
        const applied = store.setQuality(name);
        if (applied !== name) message(name + ' needs WebGPU; using ' + applied, 'error');
      });
      seg.appendChild(button);
      return button;
    });
    row.append(head, seg);
    function update() {
      for (const button of buttons) {
        const name = button.dataset.option;
        const available = store.isPresetAvailable(name);
        button.setAttribute('aria-pressed', String(store.quality === name));
        button.disabled = !available;
        button.title = (QUALITY_INFO[name] ?? name) + (available ? '' : '\nNeeds WebGPU.');
      }
    }
    return { control, row, update };
  }

  // ---- Choice and toggle --------------------------------------------------------------------
  function buildChoice(control) {
    const stacked = control.type === 'choice';
    const row = el('div', 'lsq-row' + (stacked ? ' lsq-stack' : ''));
    const head = el('div', 'lsq-head');
    const label = labelFor(control);
    head.appendChild(label);
    const tag = rebuildTag(control);
    if (tag) head.appendChild(tag);
    const mixed = el('span', 'lsq-mixed', { text: '\u2014', title: 'Set by hand in Advanced' });
    mixed.hidden = true;
    head.appendChild(mixed);
    const seg = el('div', 'lsq-seg', { role: 'group', 'aria-label': control.label });
    const buttons = control.options.map((opt) => {
      const button = el('button', null, { type: 'button', text: opt.label, 'data-option': opt.id, 'aria-pressed': 'false' });
      button.addEventListener('click', () => {
        try {
          store.setMany(quickPatch(control, opt.id));
        } catch (error) {
          message(error.message, 'error');
        }
      });
      seg.appendChild(button);
      return [opt, button];
    });
    row.append(head, seg);
    function update() {
      const active = quickOption(control, store.get);
      for (const [opt, button] of buttons) {
        button.setAttribute('aria-pressed', String(active === opt.id));
        const available = !opt.webgpu || store.webgpu;
        button.disabled = !available;
        button.title = available ? '' : 'Needs WebGPU';
      }
      mixed.hidden = active !== null;
      applyNeeds(control, row, label);
    }
    return { control, row, update };
  }

  // ---- Blend (a slider across the stops of a bundle) ------------------------------------------
  // The slider moves evenly from stop to stop, and the stop buttons sit in equal columns with
  // the track inset by half a column, so the thumb stands exactly over the stop it reaches
  // (Time of day shows its clock time beside the label: its stops are not evenly spaced in time).
  function buildBlend(control) {
    const stops = control.options;
    const n = stops.length;
    const row = el('div', 'lsq-row lsq-stack lsq-blend');
    row.style.setProperty('--n', String(n));
    const id = nextId(control.id);
    const head = el('div', 'lsq-head');
    const label = labelFor(control, id);
    head.appendChild(label);
    const tag = rebuildTag(control);
    if (tag) head.appendChild(tag);
    const mixed = el('span', 'lsq-mixed', { text: '\u2014', title: 'Set by hand in Advanced' });
    mixed.hidden = true;
    head.appendChild(mixed);
    let out = null;
    if (control.format) {
      out = el('output', null, { for: id });
      head.appendChild(out);
    }
    const wrap = el('div', 'lsq-range');
    const range = el('input', null, { type: 'range', id, min: 0, max: n - 1, step: 0.01 });
    wrap.appendChild(range);
    const seg = el('div', 'lsq-seg lsq-stops', { role: 'group', 'aria-label': control.label });
    const buttons = stops.map((opt) => {
      const button = el('button', null, { type: 'button', text: opt.label, 'data-option': opt.id, 'aria-pressed': 'false' });
      button.addEventListener('click', () => {
        try {
          store.setMany(quickPatch(control, opt.id));
        } catch (error) {
          message(error.message, 'error');
        }
      });
      seg.appendChild(button);
      return [opt, button];
    });
    row.append(head, wrap, seg);
    // Near a stop the slider lands on it exactly, so the stop's button lights up.
    const positionOf = () => {
      const p = Number(range.value);
      const r = Math.round(p);
      return Math.abs(p - r) < 0.04 ? r : p;
    };
    const show = (position) => {
      setFill(range, position / (n - 1));
      if (out) out.textContent = control.format(blendValue(control, position));
    };
    const write = () => {
      try {
        store.setMany(blendPatch(control, positionOf()));
      } catch (error) {
        message(error.message, 'error');
      }
    };
    let dragging = false;
    range.addEventListener('pointerdown', () => { dragging = true; });
    range.addEventListener('input', () => {
      show(positionOf());
      if (control.commit !== 'change') write();
    });
    range.addEventListener('change', () => {
      dragging = false;
      if (control.commit === 'change') write();
      update();
    });
    range.addEventListener('pointerup', () => { dragging = false; });
    range.addEventListener('blur', () => { dragging = false; });
    function update() {
      const active = quickOption(control, store.get);
      for (const [opt, button] of buttons) button.setAttribute('aria-pressed', String(active === opt.id));
      const { position } = blendPosition(control, store.get);
      mixed.hidden = position !== null;
      if (position !== null && !dragging) {
        range.value = String(position);
        show(position);
      }
      applyNeeds(control, row, label);
    }
    return { control, row, update };
  }

  // ---- Select (one enum setting) -------------------------------------------------------------
  function buildSelect(control) {
    const entry = store.entry(control.setting);
    const row = el('div', 'lsq-row');
    const id = nextId(control.id);
    const head = el('div', 'lsq-head');
    const label = labelFor(control, id);
    head.appendChild(label);
    const tag = rebuildTag(control);
    if (tag) head.appendChild(tag);
    const select = el('select', 'lsq-select', { id });
    row.append(head, select);
    let listed = '';
    const hidden = new Set((control.advancedOnly || []).map(String));
    function fill(current) {
      const shown = entry.options.filter((o) => !hidden.has(String(o)) || String(o) === String(current));
      const key = shown.map(String).join('\u0000');
      if (key === listed) return;
      listed = key;
      select.textContent = '';
      for (const o of shown) {
        const text = (entry.optionLabels && entry.optionLabels[o]) || String(o);
        select.appendChild(el('option', null, { value: String(o), text: hidden.has(String(o)) ? text + ' (Advanced)' : text }));
      }
    }
    select.addEventListener('change', () => {
      const value = entry.options.find((o) => String(o) === select.value);
      try {
        store.set(control.setting, value);
      } catch (error) {
        message(error.message, 'error');
      }
    });
    function update() {
      const current = store.get(control.setting);
      fill(current);
      select.value = String(current);
      applyNeeds(control, row, label);
    }
    return { control, row, update };
  }

  // ---- Slider (one number setting) -----------------------------------------------------------
  // A log or inverted slider runs over positions 0..1000; others over the setting's own range.
  function buildSlider(control) {
    const entry = store.entry(control.setting);
    const min = control.min ?? entry.min;
    // A capability may lower the setting's maximum (Column cap, Loaded tiles).
    const capped = entry.capMax && store.capabilities ? store.capabilities[entry.capMax] : undefined;
    const max = Math.min(control.max ?? entry.max, typeof capped === 'number' && capped >= min ? capped : Infinity);
    const step = control.step ?? entry.step;
    const mapped = control.scale === 'log' || !!control.invert;
    const toValue = (pos) => {
      let f = pos / 1000;
      if (control.invert) f = 1 - f;
      const v = control.scale === 'log' ? min * Math.pow(max / min, f) : min + f * (max - min);
      return Number(v.toPrecision(3));
    };
    const toPos = (v) => {
      let f = control.scale === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
      f = Math.min(1, Math.max(0, f));
      if (control.invert) f = 1 - f;
      return Math.round(f * 1000);
    };
    const row = el('div', 'lsq-row');
    const id = nextId(control.id);
    const label = labelFor(control, id);
    const wrap = el('div', 'lsq-range');
    // A whole-number setting with few values snaps to them.
    const snap = mapped && entry.type === 'int' && control.scale !== 'log' && max - min <= 50 ? 1000 / (max - min) : 1;
    const range = el('input', null, mapped ? { type: 'range', id, min: 0, max: 1000, step: snap } : { type: 'range', id, min, max, step });
    const out = el('output', null, { for: id });
    wrap.append(range, out);
    row.append(label, wrap);
    if (control.ends) {
      const ends = el('div', 'lsq-ends', { 'aria-hidden': 'true' });
      ends.append(el('span', null, { text: control.ends[0] }), el('span', null, { text: control.ends[1] }));
      row.appendChild(ends);
    }
    let dragging = false;
    range.addEventListener('pointerdown', () => { dragging = true; });
    for (const type of ['pointerup', 'change', 'blur']) range.addEventListener(type, () => { dragging = false; });
    range.addEventListener('input', () => {
      setFill(range, mapped ? Number(range.value) / 1000 : (Number(range.value) - min) / (max - min));
      try {
        store.set(control.setting, mapped ? toValue(Number(range.value)) : Number(range.value));
      } catch (error) {
        message(error.message, 'error');
      }
    });
    function update() {
      const value = store.get(control.setting);
      if (mapped) {
        if (!dragging) range.value = String(toPos(value));
      } else if (document.activeElement !== range) range.value = String(Math.min(max, Math.max(min, value)));
      setFill(range, mapped ? Number(range.value) / 1000 : (Number(range.value) - min) / (max - min));
      out.textContent = control.format ? control.format(value) : formatNumber(value) + (control.unit || '');
      const exact = formatNumber(value) + (entry.unit ? ' ' + entry.unit : '');
      out.title = value > max || value < min ? 'Set to ' + exact + ' in Advanced' : control.describe ? control.describe(value) : control.format ? exact : '';
      applyNeeds(control, row, label);
    }
    return { control, row, update };
  }

  // ---- Readout (live frame cost) --------------------------------------------------------------
  function buildReadout(control) {
    const row = el('div', 'lsq-row lsq-readout');
    const label = labelFor(control);
    label.title = control.help;
    const out = el('div', 'lsq-now', { 'aria-live': 'off' });
    const cost = el('div', 'lsq-now-cost');
    const cols = el('div', 'lsq-now-cols');
    out.append(cost, cols);
    row.append(label, out);
    row.hidden = typeof perf !== 'function';
    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '\u2013');
    function tick() {
      if (row.hidden || !row.isConnected || row.offsetParent === null) return;
      let s = null;
      try {
        s = perf();
      } catch {
        s = null;
      }
      if (!s) return;
      cost.textContent = (Number.isFinite(s.gpuMs) ? 'GPU ' + fmt(s.gpuMs) + ' ms' : 'Frame ' + fmt(s.frameMs) + ' ms')
        + ' \u00b7 ' + fmt(s.fps, 0) + ' fps';
      const c = s.columns;
      cols.classList.remove('lsq-now-limit');
      const u = s.uniform;
      if (u) {
        // Same at every distance: say when tiles are still coarser (loading, or the tile budget).
        const size = 64 * 2 ** u.level + ' blocks';
        if (u.short) {
          cols.textContent = 'Same: ' + size + ' \u00b7 too few loaded tiles, the farthest are coarser';
          cols.classList.add('lsq-now-limit');
        } else {
          cols.textContent = 'Same: ' + size + ' everywhere' + (u.coarser > 0 ? ' \u00b7 loading' : '');
        }
      } else if (!c) {
        cols.textContent = 'Columns off';
      } else if (!(c.drawn > 0)) {
        cols.textContent = 'No columns at this distance';
      } else {
        const limited = c.needed > c.budget || (c.requested > 0 && c.reach < c.requested * 0.995);
        cols.textContent = countText(c.drawn) + ' of ' + countText(c.budget) + ' columns'
          + (limited ? ' \u00b7 cap reached, reach ' + Math.round((100 * c.reach) / Math.max(1e-6, c.requested)) + '%' : '');
        cols.classList.toggle('lsq-now-limit', limited);
      }
    }
    if (!row.hidden) timers.push(setInterval(tick, 500));
    function update() {
      tick();
    }
    return { control, row, update };
  }

  // ---- Toggles (several boolean settings) -----------------------------------------------------
  function buildToggles(control) {
    const row = el('div', 'lsq-row lsq-stack');
    const head = el('div', 'lsq-head');
    const label = labelFor(control);
    label.title = control.help;
    head.appendChild(label);
    const chips = el('div', 'lsq-chips', { role: 'group', 'aria-label': control.label });
    const buttons = control.settings.map((settingId) => {
      const entry = store.entry(settingId);
      const button = el('button', null, { type: 'button', text: (control.labels && control.labels[settingId]) || entry.label,
        'aria-pressed': 'false', 'data-setting': settingId, title: entry.help });
      button.addEventListener('click', () => store.set(settingId, !store.get(settingId)));
      chips.appendChild(button);
      return [settingId, button];
    });
    row.append(head, chips);
    function update() {
      for (const [settingId, button] of buttons) button.setAttribute('aria-pressed', String(!!store.get(settingId)));
    }
    return { control, row, update };
  }

  function refresh() {
    for (const b of built) b.update();
  }

  const offValues = store.subscribe('*', refresh);
  const offPreset = store.onPresetChange(refresh);
  refresh();

  return {
    domElement: root,
    refresh,
    row: (id) => {
      const b = built.find((x) => x.control.id === id);
      return b ? b.row : null;
    },
    openSave(name) {
      const b = built.find((x) => x.control.type === 'look');
      if (b) b.openForm(name);
    },
    dispose() {
      offValues();
      offPreset();
      for (const t of timers) clearInterval(t);
    },
  };
}
