// Settings store: validation, batching, looks and quality, Custom detection, saved presets,
// JSON/URL/localStorage and the reasons a setting has no effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, SCHEMA_BY_ID, PRESETS } from '../web/settings.schema.js';
import {
  createSettingsStore, mergeHash, valuesEqual, sliderPosition, sliderValue, toSearchParams,
  SETTINGS_FORMAT, STORAGE_KEY, encodeURLValue, decodeURLValue, validateValue,
  PRESETS_KEY, PRESETS_FORMAT, MAX_USER_PRESETS, unmetNeed,
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
  assert.equal(s.quality, 'High');
  assert.equal(s.look, 'Landscape');
  assert.equal(s.modified, false);
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
  s.set('light.sunIntensity', 5); // unchanged: no notification
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

test('looks and quality: the look wins, quality keeps hand changes, preferences survive, Custom is detected', async () => {
  const s = make();
  const states = [];
  s.onPresetChange((state) => states.push(state));
  s.set('camera.fov', 80);
  assert.equal(s.applyPreset('Ultra'), 'Ultra');
  assert.equal(s.quality, 'Ultra');
  assert.equal(s.get('light.volumetric'), true);
  assert.equal(s.get('light.shadowMapSize'), 4096);
  assert.equal(s.get('camera.fov'), 80, 'presets never change preferences');
  assert.equal(s.preset, 'Ultra', 'a changed preference does not make the preset Custom');
  assert.deepEqual(s.overrides(), { 'camera.fov': 80 });
  s.set('color.palette', 'viridis');
  assert.equal(s.preset, 'Custom');
  assert.equal(s.modified, true);
  assert.deepEqual(s.overrides(), { 'color.palette': 'viridis', 'camera.fov': 80 });
  // Changing quality keeps the hand change and moves the rest to the new tier.
  assert.equal(s.setQuality('High'), 'High');
  assert.equal(s.get('color.palette'), 'viridis');
  assert.equal(s.get('light.volumetric'), false);
  assert.equal(s.get('light.shadowMapSize'), 2048);
  // Choosing a look drops hand changes and keeps the quality.
  assert.equal(s.applyPreset('BitcoinTimelapse.com'), 'BitcoinTimelapse.com');
  assert.equal(s.look, 'BitcoinTimelapse.com');
  assert.equal(s.quality, 'High');
  assert.equal(s.get('color.palette'), 'film');
  assert.equal(s.get('light.albedo'), 0);
  assert.equal(s.get('color.toneMapping'), 'none');
  assert.equal(s.preset, 'BitcoinTimelapse.com \u00b7 High');
  // The look wins over the tier where both name a setting.
  s.setQuality('Ultra');
  assert.equal(s.preset, 'BitcoinTimelapse.com \u00b7 Ultra');
  assert.equal(s.get('geo.smoothing'), 'none', 'BitcoinTimelapse.com over Ultra');
  assert.equal(s.get('light.volumetric'), false, 'BitcoinTimelapse.com over Ultra');
  assert.equal(s.get('light.shadowMapSize'), 4096, 'Ultra where BitcoinTimelapse.com says nothing');
  s.setLook('Daylight');
  s.setQuality('Performance');
  assert.equal(s.get('light.shadows'), true, 'Daylight keeps its shadows at Performance');
  assert.equal(s.get('display.scale'), 0.75, 'Performance still lowers the resolution');
  s.setLook('Golden hour');
  assert.equal(s.get('light.godRays'), true);
  s.setLook('Landscape');
  s.setQuality('High');
  assert.equal(s.get('light.albedo'), 0.85, 'Landscape at High is the schema defaults');
  assert.equal(s.get('color.toneMapping'), 'agx');
  assert.equal(s.preset, 'High');
  assert.throws(() => s.applyPreset('Ludicrous'), /Unknown preset/);
  assert.throws(() => s.setLook('High'), /Unknown look/);
  assert.throws(() => s.setQuality('BitcoinTimelapse.com'), /Unknown quality/);
  assert.throws(() => s.setQuality('Film'), /Unknown quality/);
  await tick();
  assert.deepEqual(states.at(-1), { preset: 'High', quality: 'High', look: 'Landscape', modified: false, overrides: 1, webgpu: true, userPresets: [] });
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
  a.setLook('Golden hour');
  a.setMany(EDITS);
  const text = JSON.stringify(a);
  const data = JSON.parse(text);
  assert.equal(data.format, SETTINGS_FORMAT);
  assert.equal(data.preset, 'Ultra');
  assert.equal(data.quality, 'Ultra');
  assert.equal(data.look, 'Golden hour');
  assert.equal(Object.keys(data.values).length, SCHEMA.length);
  const b = make();
  const report = b.fromJSON(text);
  assert.equal(report.applied.length, SCHEMA.length);
  assert.deepEqual(report.ignored, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(b.quality, 'Ultra');
  assert.equal(b.look, 'Golden hour');
  assert.equal(b.preset, 'Custom');
  for (const e of SCHEMA) assert.ok(valuesEqual(b.get(e.id), a.get(e.id)), e.id);
  assert.deepEqual(b.overrides(), a.overrides());
  assert.equal(JSON.stringify(b.toJSON({ files: false })).includes('teal.cube'), false);
  const partial = make().fromJSON({ preset: 'Film', 'fx.bloom': true, 'nope.id': 1, 'fx.ao': 'hbao' });
  assert.deepEqual(partial.applied, ['fx.bloom']);
  assert.deepEqual(partial.ignored, ['nope.id']);
  assert.deepEqual(partial.invalid, ['fx.ao']);
  assert.equal(partial.look, 'BitcoinTimelapse.com', 'Film is the earlier name of BitcoinTimelapse.com');
  assert.equal(partial.quality, 'High');
  assert.throws(() => make().fromJSON({ format: 'something-else', values: {} }), /Unsupported settings format/);
  assert.throws(() => make().fromJSON('[1,2]'), TypeError);
});

test('exports and links from before looks: Film loads as the BitcoinTimelapse.com look at High', () => {
  // A single-axis export from the Film preset, as the earlier app wrote it.
  const film = make();
  assert.equal(film.setLook('Film'), 'BitcoinTimelapse.com', 'the earlier name still sets the look');
  const values = film.toJSON().values;
  const old = make();
  const report = old.fromJSON({ format: SETTINGS_FORMAT, preset: 'Film', values });
  assert.equal(old.look, 'BitcoinTimelapse.com');
  assert.equal(old.quality, 'High');
  assert.equal(old.modified, false);
  assert.equal(old.preset, 'BitcoinTimelapse.com \u00b7 High');
  assert.deepEqual(report.invalid, []);
  // An earlier Balanced export: Landscape look at Balanced, nothing changed.
  const balanced = make();
  balanced.applyPreset('Balanced');
  const b = make();
  b.setLook('Pulse');
  b.fromJSON({ format: SETTINGS_FORMAT, preset: 'Balanced', values: balanced.toJSON().values });
  assert.equal(b.look, 'Landscape');
  assert.equal(b.preset, 'Balanced');
  // Links: preset=Film means the BitcoinTimelapse.com look; look= names a look; an unknown look is reported.
  const l = make();
  const r = l.fromURL('#b=1&preset=Film&color.gamma=2');
  assert.equal(r.look, 'BitcoinTimelapse.com');
  assert.equal(l.quality, 'High');
  assert.equal(l.get('color.gamma'), 2);
  assert.equal(l.get('light.albedo'), 0);
  const g = make();
  assert.equal(g.fromURL('preset=Ultra&look=Golden+hour').look, 'Golden hour');
  assert.equal(g.preset, 'Golden hour \u00b7 Ultra');
  assert.equal(g.toURL(), 'preset=Ultra&look=Golden+hour');
  assert.deepEqual(make().fromURL('look=Moonbase').invalid, ['look']);
  assert.equal(mergeHash('#b=5&look=Pulse&preset=High&fx.grain=1', 'preset=Ultra'), 'b=5&preset=Ultra');
});

test('the Film look is now BitcoinTimelapse.com: links, exports, stored settings and saved looks keep working', () => {
  // A link from between looks and the rename (look=Film) opens the look; the share link uses the new name.
  const u = make();
  const r = u.fromURL('#b=5&preset=Ultra&look=Film&fx.grain=0.2');
  assert.equal(r.look, 'BitcoinTimelapse.com');
  assert.deepEqual(r.invalid, []);
  assert.equal(u.preset, 'Custom');
  assert.equal(u.get('light.albedo'), 0);
  assert.equal(u.toURL(), 'preset=Ultra&look=BitcoinTimelapse.com&fx.grain=0.2');
  assert.equal(make().fromURL(u.toURL()).look, 'BitcoinTimelapse.com', 'the new link round-trips');
  // A JSON export of the Film look and a browser's stored settings (the same format) load it.
  const exported = { format: SETTINGS_FORMAT, preset: 'Balanced', quality: 'Balanced', look: 'Film', baseLook: 'Film', values: {} };
  const j = make();
  const report = j.fromJSON(exported);
  assert.equal(report.look, 'BitcoinTimelapse.com');
  assert.equal(report.lookFallback, null);
  assert.equal(j.preset, 'BitcoinTimelapse.com \u00b7 Balanced');
  assert.equal(j.toJSON().look, 'BitcoinTimelapse.com');
  assert.equal(j.toJSON().baseLook, 'BitcoinTimelapse.com');
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...exported, values: { 'color.gamma': 2 } }));
  const stored = make({ storage, autosave: false });
  assert.equal(stored.load(), true);
  assert.equal(stored.look, 'BitcoinTimelapse.com');
  assert.equal(stored.get('color.gamma'), 2);
  // A saved look built on Film, from another browser's export or this browser's storage.
  const elsewhere = make().fromJSON({ ...exported, look: 'Old film', baseLook: 'Film', values: { 'color.gamma': 3 } });
  assert.equal(elsewhere.lookFallback, 'Old film');
  assert.equal(elsewhere.look, 'BitcoinTimelapse.com');
  storage.setItem(PRESETS_KEY, JSON.stringify({ format: PRESETS_FORMAT, presets: [
    { name: 'Old film', savedAt: null, look: 'Film', quality: 'High', overrides: { 'color.gamma': 2.5 } },
  ] }));
  const saved = make({ storage, autosave: false });
  assert.equal(saved.userPreset('Old film').look, 'BitcoinTimelapse.com');
  assert.equal(saved.setLook('Old film'), 'Old film');
  assert.equal(saved.baseLook, 'BitcoinTimelapse.com');
  assert.equal(saved.get('light.albedo'), 0);
  assert.equal(saved.get('color.gamma'), 2.5);
  assert.match(saved.toURL(), /^preset=High&look=BitcoinTimelapse\.com&color\.gamma=2\.5$/);
  // The earlier name is reserved, accepted wherever a look is named, and never a quality.
  assert.throws(() => saved.saveUserPreset('Film'), /built-in name/);
  assert.equal(saved.isLook('Film'), true);
  assert.equal(saved.isPresetAvailable('Film'), true);
  assert.equal(saved.canonicalLook('Film'), 'BitcoinTimelapse.com');
  assert.equal(saved.canonicalLook('Paper'), 'Paper');
  assert.deepEqual(saved.baseValues('Film', 'High'), saved.baseValues('BitcoinTimelapse.com', 'High'));
  assert.equal(saved.looks.includes('Film'), false, 'the look list shows the current name only');
});

test('links and saved settings from the removed Neon night look open Pulse', () => {
  const n = make();
  const r = n.fromURL('#b=5&look=Neon%20night');
  assert.equal(r.look, 'Pulse');
  assert.deepEqual(r.invalid, []);
  assert.match(n.toURL(), /look=Pulse/);
  assert.equal(make().fromJSON({ format: SETTINGS_FORMAT, look: 'Neon night', values: {} }).look, 'Pulse');
  assert.throws(() => n.saveUserPreset('Neon night'), /built-in name/);
  assert.equal(n.looks.includes('Neon night'), false);
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
  assert.equal(c.look, 'BitcoinTimelapse.com');

  // No settings keys: nothing changes.
  const d = make();
  d.set('fx.grain', 0.4);
  assert.deepEqual(d.fromURL('#b=1&cam=1,2,3&mode=fly'), { found: false, preset: null, quality: null, look: null, applied: [], ignored: [], invalid: [] });
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
  assert.equal(b.quality, 'Extreme');

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
  assert.equal(s.quality, 'High');
  assert.equal(s.applyPreset('Ultra'), 'High');
  assert.equal(s.applyPreset('Extreme'), 'High');
  assert.equal(s.preset, 'High');
  assert.equal(s.applyPreset('BitcoinTimelapse.com'), 'BitcoinTimelapse.com');
  // The data looks' boxes need compute: on WebGL2 their far landscape stays stepped.
  s.setLook('Outputs');
  assert.equal(s.get('geo.columns'), false);
  assert.equal(s.get('geo.stepped'), true);
  assert.equal(s.modified, false);
  s.setLook('BitcoinTimelapse.com');
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
  assert.equal(t.quality, 'High');
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
  assert.equal(onWebGL2.quality, 'High');
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
  assert.equal(s.quality, 'High');
  assert.equal(s.get('geo.columns'), false);
  assert.equal(s.get('fx.ssr'), false);
  assert.equal(s.get('display.ssaa'), 1);
  assert.equal(s.get('light.shadowMapSize'), 2048);
  assert.equal(s.get('color.palette'), 'viridis');
  assert.equal(s.get('camera.fov'), 65);
  assert.equal(s.get('color.exposureMode'), 'manual');
  assert.deepEqual(s.overrides(), { 'color.palette': 'viridis', 'camera.fov': 65 });
  await tick();
  assert.deepEqual(states.at(-1), { preset: 'Custom', quality: 'High', look: 'Landscape', modified: true, overrides: 2, webgpu: false, userPresets: [] });
  // A capability change alone (no value changes) still notifies preset listeners.
  const quiet = make();
  const seen = [];
  quiet.onPresetChange((state) => seen.push(state));
  quiet.setCapabilities({ backend: 'webgl2' });
  await tick();
  assert.deepEqual(seen, [{ preset: 'High', quality: 'High', look: 'Landscape', modified: false, overrides: 0, webgpu: false, userPresets: [] }]);
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
  assert.equal(s.baseValues('Landscape', 'Extreme')['geo.tileBudget'], 200);
});

test('saved presets: save, list, reload, overwrite, delete, name rules and storage errors', async () => {
  const storage = memoryStorage();
  const s = make({ storage, autosave: false });
  s.setLook('Daylight');
  s.setQuality('Ultra');
  s.setMany({ 'light.fogDensity': 0.01, 'fx.grain': 0.2, 'camera.fov': 70 });
  const { record, replaced } = s.saveUserPreset('  Foggy noon ');
  assert.equal(replaced, null);
  assert.equal(record.name, 'Foggy noon');
  assert.equal(record.look, 'Daylight');
  assert.equal(record.quality, 'Ultra');
  assert.deepEqual(Object.keys(record.overrides).sort(), ['fx.grain', 'light.fogDensity'], 'preferences stay out');
  assert.equal(s.look, 'Foggy noon');
  assert.equal(s.baseLook, 'Daylight');
  assert.equal(s.modified, false);
  assert.equal(s.preset, 'Foggy noon \u00b7 Ultra');
  const stored = JSON.parse(storage.map.get(PRESETS_KEY));
  assert.equal(stored.format, PRESETS_FORMAT);
  assert.equal(stored.presets.length, 1);

  // Another store on the same storage lists it; choosing it brings its quality and values.
  const t = make({ storage, autosave: false });
  assert.deepEqual(t.userPresets.map((p) => p.name), ['Foggy noon']);
  assert.equal(t.setLook('foggy NOON'), 'Foggy noon', 'names match in any case');
  assert.equal(t.quality, 'Ultra');
  assert.equal(t.get('light.fogDensity'), 0.01);
  assert.equal(t.get('color.palette'), 'viridis');
  assert.equal(t.get('camera.fov'), 50, 'preferences are not part of a saved look');
  // Quality changes keep it; reset returns to it.
  t.setQuality('Balanced');
  assert.equal(t.get('light.fogDensity'), 0.01);
  assert.equal(t.get('display.aa'), 'smaa');
  t.set('fx.grain', 0.9);
  assert.equal(t.preset, 'Custom');
  t.reset();
  assert.equal(t.get('fx.grain'), 0.2);
  assert.equal(t.modified, false);

  // A link from a saved look is self-contained: the built-in look plus explicit values.
  const url = t.toURL();
  assert.match(url, /^preset=Balanced&look=Daylight&/);
  const elsewhere = make();
  elsewhere.fromURL(url);
  for (const e of SCHEMA) if (e.url) assert.ok(valuesEqual(elsewhere.get(e.id), t.get(e.id)), e.id);
  // A JSON export names the saved look; a browser without it falls back to the built-in look.
  const report = make().fromJSON(t.toJSON());
  assert.equal(report.lookFallback, 'Foggy noon');
  assert.equal(report.look, 'Daylight');

  // Overwrite (any case) replaces the record and reports the previous one.
  s.set('fx.grain', 0.5);
  const again = s.saveUserPreset('FOGGY NOON');
  assert.equal(again.replaced.overrides['fx.grain'], 0.2);
  assert.equal(again.record.overrides['fx.grain'], 0.5);
  assert.equal(s.userPresets.length, 1);
  // Undo of the overwrite puts the earlier record back.
  s.restoreUserPreset(again.replaced);
  assert.equal(s.userPreset('foggy noon').overrides['fx.grain'], 0.2);
  assert.equal(s.preset, 'Custom', 'the current values now differ from the restored record');

  // Name rules.
  for (const bad of ['', '   ', 'x'.repeat(41), 'High', 'film', 'bitcointimelapse.COM', 'Custom', 'golden HOUR', 'money MAP']) {
    assert.throws(() => s.saveUserPreset(bad), Error, JSON.stringify(bad));
  }
  assert.equal(s.saveUserPreset('x'.repeat(40)).record.name.length, 40);

  // Deleting the active one keeps the values on its built-in look.
  s.setLook('Foggy noon');
  const before = s.values();
  const removed = s.deleteUserPreset('Foggy noon');
  assert.equal(removed.name, 'Foggy noon');
  assert.equal(s.look, 'Daylight');
  assert.deepEqual(s.values(), before);
  assert.equal(s.modified, true);
  assert.throws(() => s.deleteUserPreset('Foggy noon'), /No saved preset/);
  s.restoreUserPreset(removed, { activate: true });
  assert.equal(s.look, 'Foggy noon');
  assert.equal(s.modified, false);

  // At most 50.
  const full = make({ storage: memoryStorage(), autosave: false });
  for (let i = 0; i < MAX_USER_PRESETS; i++) full.saveUserPreset('P' + i);
  assert.throws(() => full.saveUserPreset('one more'), /50 saved presets/);
  assert.equal(full.saveUserPreset('P7').replaced.name, 'P7', 'overwriting still works when full');

  // Corrupt storage reads as no presets; a failed write throws; no storage cannot save.
  const broken = memoryStorage();
  broken.setItem(PRESETS_KEY, '{oops');
  assert.deepEqual(make({ storage: broken }).userPresets, []);
  broken.setItem(PRESETS_KEY, JSON.stringify({ format: PRESETS_FORMAT, presets: [{ name: 'ok', look: 'Nope', quality: 'Turbo', overrides: { 'fx.grain': 2, 'camera.fov': 99, 'nope.x': 1 } }, { name: 'High' }, 7] }));
  const loaded = make({ storage: broken }).userPresets;
  assert.deepEqual(loaded.map((p) => [p.name, p.look, p.quality, p.overrides]), [['ok', 'Landscape', 'High', { 'fx.grain': 1 }]]);
  const tiny = memoryStorage(10);
  assert.throws(() => make({ storage: tiny, autosave: false }).saveUserPreset('big'), /storage is full or blocked/);
  assert.throws(() => make({ storage: null }).saveUserPreset('nowhere'), /presets cannot be saved/);

  // Preset listeners hear about the list.
  const u = make({ storage: memoryStorage(), autosave: false });
  const states = [];
  u.onPresetChange((state) => states.push(state));
  u.saveUserPreset('Mine');
  await tick();
  assert.deepEqual(states.at(-1).userPresets, ['Mine']);
  assert.equal(states.at(-1).look, 'Mine');
});

test('needs: a setting without effect names the root cause', () => {
  const s = make();
  assert.equal(s.inert('fx.bloomStrength'), null);
  s.set('fx.bloom', false);
  assert.equal(s.inert('fx.bloomStrength').text, 'Bloom off');
  // Shadow settings while shadows are on but the sun is out: the sun is the cause.
  s.set('light.sunIntensity', 0);
  assert.equal(s.inert('light.shadowMapSize').text, 'Sun intensity 0');
  s.set('light.sunIntensity', 3);
  // The shadow filter also sets the volumetric light's shadow-map type.
  s.set('light.shadows', false);
  assert.equal(s.inert('light.shadowFilter').text, 'Shadows off and Volumetric light off');
  s.set('light.volumetric', true);
  assert.equal(s.inert('light.shadowFilter'), null);
  s.setMany({ 'light.volumetric': false, 'light.shadows': true });
  // With albedo 0 the sun still makes specular highlights; ambient light shows nowhere.
  s.set('light.albedo', 0);
  assert.equal(s.inert('light.sunElevation'), null);
  assert.equal(s.inert('light.ambient').text, 'Albedo 0');
  // Alternatives: the heat reference matters for the glow or the flash sprites.
  s.set('color.heatGain', 0);
  assert.equal(s.inert('amp.heatReference'), null, 'flash sprites still read it');
  s.set('amp.flashSize', 0);
  assert.equal(s.inert('amp.heatReference').text, 'Heat gain 0 and Flash size 0');
  // BitcoinTimelapse.com: no sky, no sun, no fog, so the sun direction does nothing.
  const f = make();
  f.setLook('BitcoinTimelapse.com');
  assert.equal(f.inert('light.sunElevation').text, 'Sun intensity 0, Sky off, Volumetric light off and God rays off');
  assert.equal(f.inert('color.background'), null, 'the background shows when the sky is off');
  assert.equal(f.inert('geo.subdivision').text, 'Stepped cells on');
  f.set('geo.stepped', false);
  assert.equal(f.inert('geo.smoothing').text, 'Subdivision 1x');
  // The pure helper works on any getter.
  const byId = new Map(SCHEMA.map((e) => [e.id, e]));
  const values = { 'fx.dof': true, 'fx.dofAutoFocus': true };
  assert.equal(unmetNeed(SCHEMA_BY_ID.get('fx.dofFocus').needs, (id) => values[id], byId).text, 'Auto focus on');
  assert.equal(unmetNeed(undefined, () => 0, byId), null);
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
