// UTXO Timelapse Landscape: quick settings at the top of the settings panel (ui_settings).
//
// Draws the controls of settings.quick.js: Look (with Save… and Delete for presets saved in
// this browser), Quality, then the Scene, Data and View rows. Each row reads the store, shows
// the active option ('—' when the values were set by hand in Advanced) and dims, with the
// reason in its tooltip, while it has no effect. Changes go straight to the store.
// ui/panel.js mounts the element; messages (with Undo) go through its message box.

import { QUICK, QUICK_SECTIONS, quickOption, quickPatch } from '../settings.quick.js';
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
 * @returns {{domElement: HTMLElement, refresh: () => void, row: (id: string) => HTMLElement|null,
 *   openSave: (name?: string) => void, dispose: () => void}}
 */
export function createQuickSettings({ store, controls = QUICK, message = () => {} } = {}) {
  if (!store) throw new TypeError('createQuickSettings: store is required');
  const root = el('div', 'lsq');
  const built = [];

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
      case 'select': return buildSelect(control);
      case 'slider': return buildSlider(control);
      case 'toggles': return buildToggles(control);
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
  function buildSlider(control) {
    const entry = store.entry(control.setting);
    const min = control.min ?? entry.min;
    const max = control.max ?? entry.max;
    const step = control.step ?? entry.step;
    const row = el('div', 'lsq-row');
    const id = nextId(control.id);
    const label = labelFor(control, id);
    const wrap = el('div', 'lsq-range');
    const range = el('input', null, { type: 'range', id, min, max, step });
    const out = el('output', null, { for: id });
    wrap.append(range, out);
    row.append(label, wrap);
    range.addEventListener('input', () => {
      try {
        store.set(control.setting, Number(range.value));
      } catch (error) {
        message(error.message, 'error');
      }
    });
    function update() {
      const value = store.get(control.setting);
      if (document.activeElement !== range) range.value = String(Math.min(max, Math.max(min, value)));
      out.textContent = formatNumber(value) + (control.unit || '');
      out.title = value > max ? 'Set to ' + formatNumber(value) + ' in Advanced' : '';
      applyNeeds(control, row, label);
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
    },
  };
}
