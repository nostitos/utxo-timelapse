// Settings store: validation, batching, presets, Custom detection, JSON/URL/localStorage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, SCHEMA_BY_ID, PRESETS } from '../web/settings.schema.js';
import {
  createSettingsStore, mergeHash, valuesEqual, sliderPosition, sliderValue, toSearchParams,
  SETTINGS_FORMAT, STORAGE_KEY, encodeURLValue, decodeURLValue, validateValue,
} from '../web/settings.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const make = (options = {}) => createSettingsStore(SCHEMA, PRESETS, { storage: null, ...options });

function memoryStorage(limit = Infinity) {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      if (text.length > limit) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, text);
    },
    removeItem: (key) => map.delete(key),
  };
}

const LUT = { name: 'teal.cube', text: 'TITLE "teal"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n' };
const GRADIENT = [{ t: 1, color: '#FFFFFF' }, { t: 0, color: '#000' }, { t: 0.33333, color: 'ff8800' }];

// A mix of every type, governed ids and preferences.
const EDITS = {
  'color.palette': 'custom',
  'color.gradient': GRADIENT,
  'color.gamma': 0.75,
  'color.whiteHotBTC': 0.00000001,
  'color.fog': '#123456',
  'color.lut': LUT,
  'amp.exaggeration': 42.5,
  'amp.measure': 'value',
  'geo.subdivision': 4,
  'geo.tileBudget': 300,
  'light.shadowBias': -0.00035,
  'light.shadowMapSize': 4096,
  'fx.bloom': false,
  'fx.ssr': true,
  'camera.fov': 70,
  'camera.flySpeed': 3.5,
  'display.minimap': false,
};

test('starts at High with no overrides; get returns schema defaults', () => {
  const s = make();
  assert.equal(s.basePreset, 'High');
  assert.equal(s.preset, 'High');
  assert.deepEqual(s.overrides(), {});
  for (const e of SCHEMA) assert.ok(valuesEqual(s.get(e.id), e.default), e.id);
  assert.throws(() => s.get('color.nope'), /Unknown setting/);
});

test('set validates and clamps; invalid values throw; setMany is atomic', () => {
  const s = make();
  assert.equal(s.set('amp.exaggeration', 1e9), 200);
  assert.equal(s.set('amp.exaggeration', -5), 0);
  assert.equal(s.set('light.cascades', 2.6), 3);
  assert.equal(s.set('geo.subdivision', '2'), 2, 'numeric option strings resolve to the option');
  assert.equal(s.set('display.ssaa', 4), 4);
  assert.equal(s.set('fx.bloom', 0), false);
  assert.equal(s.set('color.fog', '#ABC'), '#aabbcc');
  assert.equal(s.set('color.fog', 0x102030), '#102030');
  assert.equal(s.set('color.offset', '12.5'), 12.5);
  assert.throws(() => s.set('fx.ao', 'hbao'), TypeError);
  assert.throws(() => s.set('color.fog', 'blue'), TypeError);
  assert.throws(() => s.set('amp.floor', Number.NaN), TypeError);
  assert.throws(() => s.set('fx.bloom', 'maybe'), TypeError);
  assert.throws(() => s.set('nope.nope', 1), /Unknown setting/);
  const before = s.get('amp.floor');
  assert.throws(() => s.setMany({ 'amp.floor': 1, 'fx.ao': 'bogus' }), TypeError);
  assert.equal(s.get('amp.floor'), before, 'setMany applied nothing after a failure');
  assert.equal(s.setMany({ 'amp.floor': 1, 'fx.ao': 'ssao' }), 2);
  assert.equal(s.get('fx.ao'), 'ssao');
});

test('gradients and files are normalised and frozen', () => {
  const s = make();
  const g = s.set('color.gradient', GRADIENT);
  assert.deepEqual(g.map((x) => x.t), [0, 0.3333, 1]);
  assert.deepEqual(g.map((x) => x.color), ['#000000', '#ff8800', '#ffffff']);
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g[0]));
  assert.deepEqual(s.set('color.gradient', [{ t: -2, color: '#000000' }, { t: 7, color: '#ffffff' }]).map((x) => x.t), [0, 1]);
  assert.deepEqual(s.set('color.gradient', '0-000000_0.5-ff0000_1-ffffff').map((x) => x.color), ['#000000', '#ff0000', '#ffffff']);
  assert.throws(() => s.set('color.gradient', [{ t: 0, color: '#000000' }]), TypeError);
  const many = Array.from({ length: 17 }, (_, i) => ({ t: i / 16, color: '#000000' }));
  assert.throws(() => s.set('color.gradient', many), TypeError);
  assert.equal(s.set('color.gradient', many.slice(0, 16)).length, 16);
  const lut = s.set('color.lut', LUT);
  assert.deepEqual(lut, LUT);
  assert.ok(Object.isFrozen(lut));
  assert.throws(() => s.set('color.lut', 'LUT_3D_SIZE 2'), TypeError);
  assert.equal(s.set('color.lut', null), null);
});

test('subscribe batches per microtask, coalesces, filters and unsubscribes', async () => {
  const s = make();
  const all = [];
  const bloom = [];
  const fxAndColor = [];
  const posts = [];
  s.subscribe('*', (changes) => all.push(changes));
  const off = s.subscribe('fx.bloom', (changes) => bloom.push(changes));
  s.subscribe(['fx', 'color.gamma'], (changes) => fxAndColor.push(changes));
  s.subscribe((entry) => entry.rebuild === 'post', (changes) => posts.push(changes));
  s.set('color.gamma', 2);
  s.set('color.gamma', 3);
  s.set('fx.bloom', false);
  s.set('amp.floor', 0.5);
  s.set('amp.floor', 0.05); // back to the original: no notification
  s.set('light.sunIntensity', 3); // unchanged: no notification
  assert.equal(all.length, 0, 'delivery is asynchronous');
  await tick();
  assert.equal(all.length, 1, 'one batch');
  assert.deepEqual(all[0].map((c) => [c.id, c.previous, c.value]), [['color.gamma', 1, 3], ['fx.bloom', true, false]]);
  assert.equal(all[0][0].entry, SCHEMA_BY_ID.get('color.gamma'));
  assert.deepEqual(bloom.map((b) => b.map((c) => c.id)), [['fx.bloom']]);
  assert.deepEqual(fxAndColor.map((b) => b.map((c) => c.id)), [['color.gamma', 'fx.bloom']]);
  assert.deepEqual(posts.map((b) => b.map((c) => c.id)), [['fx.bloom']]);
  off();
  s.set('fx.bloom', true);
  await tick();
  assert.equal(bloom.length, 1, 'unsubscribed');
  assert.equal(all.length, 2);
  assert.throws(() => s.subscribe('nope', () => {}), /unknown id or group/);
});

test('a throwing subscriber does not block the others', async () => {
  const s = make();
  const seen = [];
  const originalError = console.error;
  const errors = [];
  console.error = (e) => errors.push(e);
  try {
    s.subscribe('*', () => { throw new Error('boom'); });
    s.subscribe('*', (changes) => seen.push(changes.length));
    s.set('fx.grain', 0.5);
    await tick();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, [1]);
  assert.equal(errors.length, 1);
});

test('presets apply, preferences survive, and Custom is detected', async () => {
  const s = make();
  const states = [];
  s.onPresetChange((state) => states.push(state));
  s.set('camera.fov', 80);
  assert.equal(s.applyPreset('Ultra'), 'Ultra');
  assert.equal(s.get('light.volumetric'), true);
  assert.equal(s.get('light.shadowMapSize'), 4096);
  assert.equal(s.get('camera.fov'), 80, 'presets never change preferences');
  assert.equal(s.preset, 'Ultra', 'a changed preference does not make the preset Custom');
  assert.deepEqual(s.overrides(), { 'camera.fov': 80 });
  s.set('color.palette', 'viridis');
  assert.equal(s.preset, 'Custom');
  assert.equal(s.basePreset, 'Ultra');
  assert.deepEqual(s.overrides(), { 'color.palette': 'viridis', 'camera.fov': 80 });
  s.set('color.palette', 'film');
  assert.equal(s.preset, 'Ultra');
  s.applyPreset('Film');
  assert.equal(s.get('light.albedo'), 0);
  assert.equal(s.get('color.toneMapping'), 'none');
  s.applyPreset('High');
  assert.equal(s.get('light.albedo'), 0.85, 'applying a preset restores defaults for ids it does not name');
  assert.equal(s.get('color.toneMapping'), 'agx');
  assert.throws(() => s.applyPreset('Ludicrous'), /Unknown preset/);
  await tick();
  assert.deepEqual(states.at(-1), { preset: 'High', basePreset: 'High', overrides: 1, webgpu: true });
});

test('reset restores the base preset for a group, an id or everything', () => {
  const s = make();
  s.applyPreset('Balanced');
  s.setMany({ 'fx.ao': 'gtao', 'fx.bloomStrength': 2, 'color.gamma': 2, 'camera.fov': 90 });
  s.reset('fx');
  assert.equal(s.get('fx.ao'), 'ssao');
  assert.equal(s.get('fx.bloomStrength'), 0.6);
  assert.equal(s.get('color.gamma'), 2);
  s.reset('color.gamma');
  assert.equal(s.get('color.gamma'), 1);
  assert.equal(s.preset, 'Balanced');
  s.reset();
  assert.deepEqual(s.overrides(), {});
  assert.equal(s.get('camera.fov'), 50);
  assert.throws(() => s.reset('nope'), /Unknown setting/);
});

test('JSON round trip restores every value, the base preset and the Custom state', () => {
  const a = make();
  a.applyPreset('Ultra');
  a.setMany(EDITS);
  const text = JSON.stringify(a);
  const data = JSON.parse(text);
  assert.equal(data.format, SETTINGS_FORMAT);
  assert.equal(data.preset, 'Ultra');
  assert.equal(Object.keys(data.values).length, SCHEMA.length);
  const b = make();
  const report = b.fromJSON(text);
  assert.equal(report.applied.length, SCHEMA.length);
  assert.deepEqual(report.ignored, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(b.basePreset, 'Ultra');
  assert.equal(b.preset, 'Custom');
  for (const e of SCHEMA) assert.ok(valuesEqual(b.get(e.id), a.get(e.id)), e.id);
  assert.deepEqual(b.overrides(), a.overrides());
  assert.equal(JSON.stringify(b.toJSON({ files: false })).includes('teal.cube'), false);
  const partial = make().fromJSON({ preset: 'Film', 'fx.bloom': true, 'nope.id': 1, 'fx.ao': 'hbao' });
  assert.deepEqual(partial.applied, ['fx.bloom']);
  assert.deepEqual(partial.ignored, ['nope.id']);
  assert.deepEqual(partial.invalid, ['fx.ao']);
  assert.equal(partial.preset, 'Film');
  assert.throws(() => make().fromJSON({ format: 'something-else', values: {} }), /Unsupported settings format/);
  assert.throws(() => make().fromJSON('[1,2]'), TypeError);
});

test('URL round trip: preset plus url ids that differ, foreign keys ignored', () => {
  const a = make();
  a.applyPreset('Ultra');
  a.setMany(EDITS);
  const url = a.toURL();
  const params = new URLSearchParams(url);
  assert.equal(params.get('preset'), 'Ultra');
  const expected = Object.keys(a.overrides()).filter((id) => SCHEMA_BY_ID.get(id).url);
  assert.deepEqual([...params.keys()].slice(1).sort(), expected.sort());
  for (const id of ['color.lut', 'camera.flySpeed', 'display.minimap']) assert.equal(params.has(id), false, id);
  assert.equal(params.get('color.fog'), '123456');
  assert.equal(params.get('fx.bloom'), '0');
  assert.equal(params.get('color.gradient'), '0-000000_0.3333-ff8800_1-ffffff');
  assert.equal(params.get('color.whiteHotBTC'), '1e-8');

  const b = make();
  b.set('camera.flySpeed', 9); // url:false preferences keep their local value
  const hash = '#b=314000&cam=1,2,3,0.5,-0.2&mode=map&' + url;
  const report = b.fromURL(hash);
  assert.equal(report.found, true);
  assert.equal(report.preset, 'Ultra');
  assert.deepEqual(report.ignored, []);
  assert.deepEqual(report.invalid, []);
  for (const e of SCHEMA) {
    if (e.url) assert.ok(valuesEqual(b.get(e.id), a.get(e.id)), e.id);
  }
  assert.equal(b.get('camera.flySpeed'), 9);
  assert.equal(b.get('color.lut'), null);
  assert.equal(b.get('display.minimap'), true);
  assert.equal(b.toURL(), url, 'stable encoding');

  // A URL with fewer overrides resets the other url ids to the preset.
  const c = make();
  c.setMany({ 'fx.grain': 0.4, 'camera.fov': 75 });
  c.fromURL('preset=Film&color.gamma=2');
  assert.equal(c.get('fx.grain'), 0);
  assert.equal(c.get('camera.fov'), 50);
  assert.equal(c.get('color.gamma'), 2);
  assert.equal(c.preset, 'Custom');
  assert.equal(c.basePreset, 'Film');

  // No settings keys: nothing changes.
  const d = make();
  d.set('fx.grain', 0.4);
  assert.deepEqual(d.fromURL('#b=1&cam=1,2,3&mode=fly'), { found: false, preset: null, applied: [], ignored: [], invalid: [] });
  assert.equal(d.get('fx.grain'), 0.4);

  // Unknown preset, malformed values and unknown dotted keys are reported.
  const r = make().fromURL('?preset=Ludicrous&fx.ao=hbao&fx.nope=1&fx.grain=0.2');
  assert.deepEqual(r.invalid, ['preset', 'fx.ao']);
  assert.deepEqual(r.ignored, ['fx.nope']);
  assert.equal(r.preset, 'High');

  // Full URLs and URLSearchParams work too.
  assert.equal(make().fromURL('http://127.0.0.1:12990/?x=1#mode=map&preset=Balanced').preset, 'Balanced');
  assert.equal(make().fromURL(new URLSearchParams('preset=Performance')).preset, 'Performance');
});

test('URL value encoding round-trips exactly', () => {
  const samples = {
    'light.shadowBias': [-0.00035, 0.01, 0],
    'color.whiteHotBTC': [1e-8, 0.12345678, 100000],
    'geo.instanceBudget': [8000000, 12345],
    'geo.subdivision': [1, 4],
    'color.toneMapping': ['aces', 'none'],
    'fx.ssr': [true, false],
  };
  for (const [id, list] of Object.entries(samples)) {
    const e = SCHEMA_BY_ID.get(id);
    assert.ok(e, id);
    for (const v of list) {
      const back = validateValue(e, decodeURLValue(e, encodeURLValue(e, v)), { webgpu: true });
      assert.ok(back.ok && valuesEqual(back.value, v), id + ' ' + v);
    }
  }
});

test('mergeHash keeps foreign keys and replaces settings keys', () => {
  const merged = mergeHash('#b=314000&preset=Ultra&color.gamma=2&cam=1,2,3&mode=map', 'preset=Film&fx.grain=0.5');
  assert.equal(merged, 'b=314000&cam=1,2,3&mode=map&preset=Film&fx.grain=0.5', 'foreign segments stay verbatim');
  assert.equal(mergeHash('', 'preset=High'), 'preset=High');
  assert.equal(mergeHash('http://127.0.0.1:12990/#mode=fly&color%2Egamma=3', 'preset=High'), 'mode=fly&preset=High');
  const s = make();
  s.set('fx.grain', 0.25);
  assert.equal(s.mergeIntoHash('#b=5&mode=fly&fx.grain=0.9'), 'b=5&mode=fly&preset=High&fx.grain=0.25');
  assert.equal(toSearchParams('#a=1').get('a'), '1');
});

test('localStorage save/load, corrupted data and quota fallback', () => {
  const storage = memoryStorage();
  const a = make({ storage, autosave: false });
  a.applyPreset('Extreme');
  a.setMany(EDITS);
  assert.equal(a.save(), true);
  assert.ok(storage.map.has(STORAGE_KEY));
  const b = make({ storage, autosave: false });
  assert.equal(b.load(), true);
  for (const e of SCHEMA) assert.ok(valuesEqual(b.get(e.id), a.get(e.id)), e.id);
  assert.equal(b.basePreset, 'Extreme');

  storage.setItem(STORAGE_KEY, '{not json');
  assert.equal(make({ storage }).load(), false);
  storage.setItem(STORAGE_KEY, JSON.stringify({ format: 'other', values: {} }));
  assert.equal(make({ storage }).load(), false);
  assert.equal(make({ storage: memoryStorage() }).load(), false, 'nothing saved yet');
  assert.equal(make({ storage: null }).save(), false);

  // A quota smaller than the LUT text: saved without the file instead of failing.
  const small = memoryStorage(JSON.stringify(a.toJSON({ files: false })).length + 10);
  const c = make({ storage: small, autosave: false });
  c.fromJSON(a.toJSON());
  assert.equal(c.save(), true);
  const d = make({ storage: small, autosave: false });
  assert.equal(d.load(), true);
  assert.equal(d.get('color.lut'), null);
  assert.equal(d.get('amp.exaggeration'), 42.5);
});

test('autosave writes shortly after changes', async () => {
  const storage = memoryStorage();
  const s = make({ storage });
  assert.equal(s.autosave, true);
  s.set('fx.grain', 0.3);
  await tick();
  assert.equal(storage.map.has(STORAGE_KEY), false, 'debounced');
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(JSON.parse(storage.map.get(STORAGE_KEY)).values['fx.grain'], 0.3);
  s.dispose();
});

test('WebGL2 caps presets at High and keeps WebGPU-only features off', () => {
  const s = make({ capabilities: { backend: 'webgl2' } });
  assert.equal(s.webgpu, false);
  assert.equal(s.basePreset, 'High');
  assert.equal(s.applyPreset('Ultra'), 'High');
  assert.equal(s.applyPreset('Extreme'), 'High');
  assert.equal(s.preset, 'High');
  assert.equal(s.applyPreset('Film'), 'Film');
  assert.equal(s.set('geo.columns', true), false);
  assert.equal(s.set('fx.ssgi', true), false);
  assert.equal(s.set('color.exposureMode', 'auto'), 'manual');
  assert.equal(s.isAvailable('geo.columns'), false);
  assert.equal(s.isAvailable('color.exposureMode'), true);
  assert.equal(s.isAvailable('color.exposureMode', 'auto'), false);
  assert.equal(s.isAvailable('fx.ssr'), true);
  assert.equal(s.isPresetAvailable('Extreme'), false);
  assert.equal(s.isPresetAvailable('High'), true);
  const r = s.fromURL('preset=Extreme&geo.columns=1&fx.ssgi=1&light.cascades=4');
  assert.equal(r.preset, 'High');
  assert.equal(s.get('geo.columns'), false);
  assert.equal(s.get('light.cascades'), 4);
  const t = make({ capabilities: { webgpu: false } });
  const capped = t.fromJSON({ preset: 'Extreme', values: { 'geo.columns': true, 'fx.ssr': true, 'light.cascades': 4, 'color.palette': 'magma' } });
  assert.equal(t.basePreset, 'High');
  assert.equal(t.get('geo.columns'), false);
  assert.equal(t.get('fx.ssr'), false, "Extreme's own values do not become overrides of High");
  assert.equal(t.get('light.cascades'), 3);
  assert.equal(t.get('color.palette'), 'magma', 'real overrides survive the cap');
  assert.deepEqual(capped.capped.sort(), ['fx.ssr', 'geo.columns', 'light.cascades']);
  assert.deepEqual(t.overrides(), { 'color.palette': 'magma' });
  // A full export from a WebGPU Ultra session imports as High plus the real overrides.
  const ultra = make();
  ultra.applyPreset('Ultra');
  ultra.setMany({ 'color.gamma': 1.4, 'camera.fov': 70 });
  const onWebGL2 = make({ capabilities: { backend: 'webgl2' } });
  onWebGL2.fromJSON(JSON.stringify(ultra));
  assert.equal(onWebGL2.basePreset, 'High');
  assert.deepEqual(onWebGL2.overrides(), { 'color.gamma': 1.4, 'camera.fov': 70 });
});

test('setCapabilities after a late WebGPU failure caps the preset and keeps overrides', async () => {
  const s = make();
  s.applyPreset('Extreme');
  s.setMany({ 'color.palette': 'viridis', 'camera.fov': 65 });
  s.set('color.exposureMode', 'auto');
  assert.equal(s.get('geo.columns'), true);
  const states = [];
  s.onPresetChange((state) => states.push(state));
  s.setCapabilities({ webgpu: false });
  assert.equal(s.basePreset, 'High');
  assert.equal(s.get('geo.columns'), false);
  assert.equal(s.get('fx.ssr'), false);
  assert.equal(s.get('display.ssaa'), 1);
  assert.equal(s.get('light.shadowMapSize'), 2048);
  assert.equal(s.get('color.palette'), 'viridis');
  assert.equal(s.get('camera.fov'), 65);
  assert.equal(s.get('color.exposureMode'), 'manual');
  assert.deepEqual(s.overrides(), { 'color.palette': 'viridis', 'camera.fov': 65 });
  await tick();
  assert.deepEqual(states.at(-1), { preset: 'Custom', basePreset: 'High', overrides: 2, webgpu: false });
  // A capability change alone (no value changes) still notifies preset listeners.
  const quiet = make();
  const seen = [];
  quiet.onPresetChange((state) => seen.push(state));
  quiet.setCapabilities({ backend: 'webgl2' });
  await tick();
  assert.deepEqual(seen, [{ preset: 'High', basePreset: 'High', overrides: 0, webgpu: false }]);
  // backend information wins over earlier flags.
  const v = make({ capabilities: { backend: 'webgpu', compute: true } });
  v.setCapabilities({ webgpu: false });
  assert.equal(v.webgpu, false);
});

test('capability limits lower capMax entries without making the preset Custom', () => {
  const s = make();
  s.setCapabilities({ backend: 'webgpu', maxTileBudget: 200, maxInstances: 1500000 });
  assert.equal(s.get('geo.tileBudget'), 200);
  assert.equal(s.preset, 'High');
  assert.equal(s.set('geo.tileBudget', 400), 200);
  s.applyPreset('Extreme');
  assert.equal(s.get('geo.instanceBudget'), 1500000);
  assert.equal(s.preset, 'Extreme');
  assert.equal(s.presetValues('Extreme')['geo.tileBudget'], 200);
});

test('slider mapping: log entries are logarithmic, min-0 log entries reach 0', () => {
  const exposure = SCHEMA_BY_ID.get('color.exposure'); // 0.01..16 log
  assert.equal(sliderPosition(exposure, 0.01), 0);
  assert.equal(sliderPosition(exposure, 16), 1);
  const mid = Math.sqrt(0.01 * 16);
  assert.ok(Math.abs(sliderPosition(exposure, mid) - 0.5) < 1e-12);
  assert.equal(sliderValue(exposure, 0.5), Number(mid.toPrecision(3)));
  for (const v of [0.02, 0.37, 1, 2.5, 9.9]) {
    assert.ok(Math.abs(sliderValue(exposure, sliderPosition(exposure, v)) - v) / v < 0.005, 'round trip ' + v);
  }
  const fog = SCHEMA_BY_ID.get('light.fogDensity'); // 0..0.05, logMin 5e-5
  assert.equal(sliderValue(fog, 0), 0);
  assert.equal(sliderPosition(fog, 0), 0);
  assert.equal(sliderValue(fog, 1), 0.05);
  assert.ok(sliderValue(fog, 0.001) > 0);
  const budget = SCHEMA_BY_ID.get('geo.instanceBudget');
  assert.ok(Number.isInteger(sliderValue(budget, 0.37)));
  const gain = SCHEMA_BY_ID.get('color.gain'); // linear 0..4 step 0.01
  assert.equal(sliderValue(gain, 0.25), 1);
  assert.equal(sliderPosition(gain, 1), 0.25);
  assert.equal(sliderValue(SCHEMA_BY_ID.get('light.cascades'), 0.5), 3);
});
