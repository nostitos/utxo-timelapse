// Quick settings (landscape/web/settings.quick.js): bundles, looks, independence and needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, SCHEMA_BY_ID, PRESETS, LOOKS } from '../web/settings.schema.js';
import { createSettingsStore, validateValue, valuesEqual } from '../web/settings.js';
import {
  QUICK, QUICK_BY_ID, QUICK_SECTIONS, quickOption, quickState, quickPatch, quickIds,
  blendPatch, blendPosition, blendValue, blendIndex, clockTime,
} from '../web/settings.quick.js';

const make = (capabilities = { webgpu: true }) => createSettingsStore(SCHEMA, PRESETS, { storage: null, capabilities });
const choices = QUICK.filter((c) => c.type === 'choice' || c.type === 'toggle' || c.type === 'blend');
const blends = QUICK.filter((c) => c.type === 'blend');

test('quick controls: sections, ids, bundles and bound settings are valid', () => {
  assert.deepEqual([...QUICK_SECTIONS], ['Look', 'Performance', 'Scene', 'Data', 'View']);
  assert.equal(new Set(QUICK.map((c) => c.id)).size, QUICK.length);
  assert.equal(QUICK.length, 26);
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
      if (look === 'BitcoinTimelapse.com' && c.id === 'timeOfDay') continue; // The film's look turns the light off.
      assert.notEqual(quickOption(c, s.get), null, look + ': ' + c.id + ' is mixed');
    }
  }
  s.setLook('Landscape');
  const read = Object.fromEntries(choices.map((c) => [c.id, quickOption(c, s.get)]));
  assert.deepEqual(read, { timeOfDay: 'dusk', sky: 'on', haze: 'light', shadows: 'on', glow: 'normal', bigCoins: 'normal',
    cellShape: 'columns', flashes: 'normal', flashTrail: 'normal', farColumns: 'prism', farShadows: 'on', distance: 'adaptive' });
  // On WebGL2 the data looks' boxes become stepped cells, still one definite option.
  const w = make({ webgpu: false });
  w.setLook('Outputs');
  assert.equal(quickOption(QUICK_BY_ID.get('cellShape'), w.get), 'stepped');
});

test('each option selects itself and leaves the other controls alone', () => {
  for (const look of ['Landscape', 'BitcoinTimelapse.com', 'Pulse', 'Earth', 'Paper']) {
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
  // Haze decides the fog density only, so a hand-set density sits between two stops.
  const between = quickState(haze, s.get);
  assert.ok(between.option === null && Math.abs(between.position - (1 + 1 / 6)) < 1e-9);
  s.set('light.fogDensity', 0.03);
  assert.deepEqual(quickState(haze, s.get), { option: null, position: null }, 'beyond Thick');
  s.set('light.fogDensity', 0.002);
  s.set('light.sunElevation', 20); // off the sun path at the dusk colours
  assert.deepEqual(quickState(QUICK_BY_ID.get('timeOfDay'), s.get), { option: null, position: null });
  s.set('light.sunElevation', -1.5);
  s.set('fx.bloomThreshold', 0.4); // the glow options decide on bloom and strength only
  assert.equal(quickOption(QUICK_BY_ID.get('glow'), s.get), 'normal');
  assert.deepEqual(quickState(QUICK_BY_ID.get('height'), s.get), { value: 10 });
  assert.equal(quickState(QUICK_BY_ID.get('show'), s.get).values['display.grid'], true);
  assert.deepEqual(quickState(QUICK_BY_ID.get('look'), s.get), {});
  const patch = quickPatch(QUICK_BY_ID.get('sky'), 'off');
  patch['light.sky'] = true; // a fresh copy each time
  assert.equal(quickPatch(QUICK_BY_ID.get('sky'), 'off')['light.sky'], false);
  assert.throws(() => quickPatch(haze, 'soup'), /no option/);
  // Shadows have no effect on BitcoinTimelapse.com (no sun); Flash trail none with flashes off.
  s.setLook('BitcoinTimelapse.com');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('shadows').needs).text, 'Sun intensity 0');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('timeOfDay').needs), null, 'time of day turns the sun on, even on BitcoinTimelapse.com');
  s.setLook('Landscape');
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('shadows').needs), null);
  s.setMany(quickPatch(QUICK_BY_ID.get('flashes'), 'off'));
  assert.equal(s.checkNeeds(QUICK_BY_ID.get('flashTrail').needs).text, 'Heat gain 0');
});

test('blend sliders: stops read exactly, points between read back and leave the other controls', () => {
  for (const look of ['Landscape', 'Daylight', 'Pulse']) {
    const s = make();
    s.setLook(look);
    for (const c of blends) {
      for (let i = 0; i < c.options.length; i++) {
        s.setMany(blendPatch(c, i));
        assert.equal(blendPosition(c, s.get).position, i, look + ': ' + c.id + ' stop ' + i);
        assert.equal(quickOption(c, s.get), c.options[i].id);
      }
      for (let i = 0; i < c.options.length - 1; i++) {
        for (const t of [0.2, 0.5, 0.85]) {
          const p = i + t;
          const patch = blendPatch(c, p);
          for (const [id, value] of Object.entries(patch)) {
            const r = validateValue(SCHEMA_BY_ID.get(id), value, { webgpu: true });
            assert.ok(r.ok && valuesEqual(r.value, value), c.id + ' at ' + p + ': ' + id + ' ' + value + ' would be clamped');
          }
          const before = Object.fromEntries(choices.filter((k) => k !== c).map((k) => [k.id, quickOption(k, s.get)]));
          s.setMany(patch);
          const got = blendPosition(c, s.get).position;
          assert.ok(got !== null && Math.abs(got - p) < 0.02, look + ': ' + c.id + ' at ' + p + ' reads ' + got);
          assert.equal(quickOption(c, s.get), null, c.id + ' between stops is no stop');
          for (const k of choices) if (k !== c) assert.equal(quickOption(k, s.get), before[k.id], c.id + ' at ' + p + ' changed ' + k.id);
        }
      }
    }
  }
});

test('blend details: Glow fades in from Off, Flash trail blends half-lives in log space', () => {
  const glow = QUICK_BY_ID.get('glow');
  const g = blendPatch(glow, 0.5);
  assert.equal(g['fx.bloom'], true);
  assert.ok(Math.abs(g['fx.bloomStrength'] - 0.175) < 1e-9);
  const trail = QUICK_BY_ID.get('flashTrail');
  assert.ok(Math.abs(blendPatch(trail, 1.5)['amp.heatHalfLife'] - Math.sqrt(30 * 300)) < 0.1);
  assert.equal(trail.commit, 'change', 'the worker rebuilds once, on release');
});

test('time of day is a clock along one sun path', () => {
  const c = QUICK_BY_ID.get('timeOfDay');
  assert.deepEqual(c.options.map((o) => clockTime(blendValue(c, c.options.indexOf(o)))), ['6:30', '12:00', '17:30', '18:15', '21:00']);
  assert.equal(blendIndex(c, blendValue(c, 2.4)).toFixed(6), '2.400000');
  // From sunrise to dusk the sun turns one way at a steady rate and rises then sets.
  const at = (h) => blendPatch(c, blendIndex(c, h));
  const rate = (h0, h1) => (at(h0)['light.sunAzimuth'] - at(h1)['light.sunAzimuth']) / (h1 - h0);
  for (const [h0, h1] of [[6.5, 12], [12, 17.5], [17.5, 18.25]]) {
    assert.ok(rate(h0, h1) > 14 && rate(h0, h1) < 18, 'azimuth ' + rate(h0, h1).toFixed(1) + ' degrees an hour ' + h0 + '-' + h1);
  }
  let peak = 0;
  for (let h = 6.5; h <= 18.25; h += 0.25) peak = Math.max(peak, at(h)['light.sunElevation']);
  assert.equal(peak, at(12)['light.sunElevation']);
  assert.ok(at(18.25)['light.sunElevation'] < 0 && at(18.25)['light.stars'] === true, 'dusk: sun below the horizon, stars out');
  assert.equal(at(15)['light.stars'], false);
});

test('column distance and terrain detail are sliders over the quality settings', () => {
  const s = make();
  s.setQuality('High');
  const dist = QUICK_BY_ID.get('columnDistance');
  const detail = QUICK_BY_ID.get('terrainDetail');
  assert.equal(dist.format(s.get('geo.columnPixels')), '\u00d71');
  assert.equal(detail.format(s.get('geo.pixelsPerCell')), '\u00d71');
  assert.equal(dist.format(2), '\u00d72');
  s.setQuality('Performance');
  assert.equal(dist.format(s.get('geo.columnPixels')), '\u00d70.33');
  s.setMany(quickPatch(QUICK_BY_ID.get('cellShape'), 'smooth'));
  assert.equal(s.checkNeeds(dist.needs).text, 'Column cells off');
});
