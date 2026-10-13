// Quick settings (landscape/web/settings.quick.js): bundles, looks, independence and needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, SCHEMA_BY_ID, PRESETS, LOOKS } from '../web/settings.schema.js';
import { createSettingsStore, validateValue, valuesEqual } from '../web/settings.js';
import { QUICK, QUICK_BY_ID, QUICK_SECTIONS, quickOption, quickState, quickPatch, quickIds } from '../web/settings.quick.js';

const make = (capabilities = { webgpu: true }) => createSettingsStore(SCHEMA, PRESETS, { storage: null, capabilities });
const choices = QUICK.filter((c) => c.type === 'choice' || c.type === 'toggle');

test('quick controls: sections, ids, bundles and bound settings are valid', () => {
  assert.deepEqual([...QUICK_SECTIONS], ['Look', 'Scene', 'Data', 'View']);
  assert.equal(new Set(QUICK.map((c) => c.id)).size, QUICK.length);
  assert.equal(QUICK.length, 16);
  for (const c of QUICK) {
    assert.ok(QUICK_SECTIONS.includes(c.section), c.id + ' section');
    assert.ok(typeof c.label === 'string' && c.label && typeof c.help === 'string' && c.help.length > 10, c.id + ' text');
    assert.equal(QUICK_BY_ID.get(c.id), c);
    if (c.options) {
      assert.ok(c.options.length >= 2, c.id + ' options');
      for (const o of c.options) {
        for (const [id, value] of Object.entries(o.set)) {
          const e = SCHEMA_BY_ID.get(id);
          assert.ok(e, c.id + '.' + o.id + ' sets unknown ' + id);
          assert.notEqual(e.preset, false, c.id + ' must not set the preference ' + id);
          const r = validateValue(e, value, { webgpu: true });
          assert.ok(r.ok && valuesEqual(r.value, value), c.id + '.' + o.id + ' ' + id + ' would be clamped');
        }
        for (const [id, value] of Object.entries(o.match)) {
          assert.ok(Object.hasOwn(o.set, id) && valuesEqual(o.set[id], value), c.id + '.' + o.id + ' matches what it sets');
        }
        assert.ok(Object.keys(o.match).length > 0, c.id + '.' + o.id + ' match');
      }
    }
    if (c.setting) {
      const e = SCHEMA_BY_ID.get(c.setting);
      assert.ok(e, c.id + ' binds ' + c.setting);
      if (c.type === 'slider') {
        assert.ok((c.min ?? e.min) >= e.min && (c.max ?? e.max) <= e.max, c.id + ' range inside the setting');
      }
      if (c.type === 'select') assert.equal(e.type, 'enum', c.id + ' binds an enum');
    }
    for (const id of c.settings || []) assert.equal(SCHEMA_BY_ID.get(id).type, 'bool', c.id + ' toggles ' + id);
    assert.ok(quickIds(c).every((id) => SCHEMA_BY_ID.has(id)));
  }
});

test('every built-in look reads one option in every quick control', () => {
  const s = make();
  for (const look of LOOKS) {
    s.setLook(look);
    for (const c of choices) {
      if (look === 'Film' && c.id === 'timeOfDay') continue; // Film turns the light off.
      assert.notEqual(quickOption(c, s.get), null, look + ': ' + c.id + ' is mixed');
    }
  }
  s.setLook('Landscape');
  const read = Object.fromEntries(choices.map((c) => [c.id, quickOption(c, s.get)]));
  assert.deepEqual(read, { timeOfDay: 'dusk', sky: 'on', haze: 'light', shadows: 'on', glow: 'normal', bigCoins: 'normal',
    cellShape: 'columns', flashes: 'normal', flashTrail: 'normal' });
  // On WebGL2 Neon night's boxes become stepped cells, still one definite option.
  const w = make({ webgpu: false });
  w.setLook('Neon night');
  assert.equal(quickOption(QUICK_BY_ID.get('cellShape'), w.get), 'stepped');
});

test('each option selects itself and leaves the other controls alone', () => {
  for (const look of ['Landscape', 'Film', 'Neon night']) {
    const s = make();
    s.setLook(look);
    for (const c of choices) {
      for (const o of c.options) {
        const before = Object.fromEntries(choices.map((k) => [k.id, quickOption(k, s.get)]));
        s.setMany(quickPatch(c, o.id));
        assert.equal(quickOption(c, s.get), o.id, look + ': ' + c.id + '.' + o.id);
        for (const k of choices) {
          if (k === c) continue;
          assert.equal(quickOption(k, s.get), before[k.id], look + ': ' + c.id + '.' + o.id + ' changed ' + k.id);
        }
      }
    }
  }
});

test('values set by hand read as mixed; state, patch and needs', () => {
  const s = make();
  const haze = QUICK_BY_ID.get('haze');
  s.set('light.fogDensity', 0.003);
  assert.deepEqual(quickState(haze, s.get), { option: null });
  s.set('fx.bloomThreshold', 0.4); // the glow options decide on bloom and strength only
  assert.equal(quickOption(QUICK_BY_ID.get('glow'), s.get), 'normal');
  assert.deepEqual(quickState(QUICK_BY_ID.get('height'), s.get), { value: 10 });
  assert.equal(quickState(QUICK_BY_ID.get('show'), s.get).values['display.grid'], true);
  assert.deepEqual(quickState(QUICK_BY_ID.get('look'), s.get), {});
  const patch = quickPatch(QUICK_BY_ID.get('sky'), 'off');
  patch['light.sky'] = true; // a fresh copy each time
  assert.equal(quickPatch(QUICK_BY_ID.get('sky'), 'off')['light.sky'], false);
  assert.throws(() => quickPatch(haze, 'soup'), /no option/);
  // Shadows have no effect on Film (no sun); Flash trail none with flashes off.
  s.setLook('Film');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('shadows').needs).text, 'Sun intensity 0');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('timeOfDay').needs), null, 'time of day turns the sun on, even on Film');
  s.setLook('Landscape');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('shadows').needs), null);
  s.setMany(quickPatch(QUICK_BY_ID.get('flashes'), 'off'));
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('flashTrail').needs).text, 'Heat gain 0');
});
