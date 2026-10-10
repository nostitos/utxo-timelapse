// Settings schema and presets (landscape/SPEC.md section 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCHEMA, SCHEMA_BY_ID, PRESETS, PRESET_NAMES, PRESET_INFO, QUALITY_ORDER, STARTUP_PRESET,
  WEBGL2_MAX_PRESET, GROUPS, TYPES, REBUILD_CLASSES, DEFAULT_GRADIENT,
} from '../web/settings.schema.js';
import { createSettingsStore, validateValue, valuesEqual, normalizeGradient } from '../web/settings.js';

// Required ids, copied from SPEC section 7 (consumers use exactly these).
const REQUIRED = {
  color: ['palette', 'gradient', 'reverse', 'measure', 'offset', 'upper', 'gamma', 'whiteHot', 'whiteHotBTC',
    'background', 'ground', 'fog', 'heat', 'heatGain', 'hueShift', 'saturation', 'contrast', 'temperature',
    'tint', 'lift', 'liftColor', 'gradeGamma', 'gain', 'gainColor', 'toneMapping', 'exposureMode', 'exposure',
    'autoExposureMin', 'autoExposureMax', 'autoExposureSpeed', 'lut', 'lutIntensity', 'p3'],
  amp: ['measure', 'curve', 'exponent', 'exposure', 'reference', 'exaggeration', 'floor', 'whale',
    'heatHalfLife', 'heatFloor', 'heatReference', 'heatEdge', 'heatEdgeBlocks', 'flashSize', 'flashThreshold', 'edgeGlow', 'edgeBlocks', 'nowPlane'],
  geo: ['smoothing', 'stepped', 'subdivision', 'columns', 'columnShape', 'cylinderSides', 'coinEdges',
    'coinThickness', 'columnRadius', 'columnPixels', 'instanceBudget', 'columnGap',
    'lodBias', 'pixelsPerCell', 'tileBudget', 'skirts', 'wireframe'],
  light: ['sunAzimuth', 'sunElevation', 'sunIntensity', 'sunColor', 'skyColor', 'groundColor', 'ambient',
    'emissive', 'albedo', 'rim', 'rimColor', 'roughness', 'metalness', 'shadows', 'cascades', 'shadowMapSize',
    'shadowFilter', 'shadowSoftness', 'shadowBias', 'fogDensity', 'fogHeightFalloff', 'volumetric',
    'volumetricSteps', 'volumetricIntensity', 'godRays', 'godRaysIntensity', 'sky', 'stars', 'starDensity',
    'floorReflection'],
  fx: ['ao', 'aoRadius', 'aoIntensity', 'aoSamples', 'ssgi', 'ssgiSamples', 'ssgiIntensity', 'ssr',
    'ssrIntensity', 'ssrSteps', 'bloom', 'bloomThreshold', 'bloomStrength', 'bloomRadius', 'bloomMips', 'dof',
    'dofAperture', 'dofFocus', 'dofAutoFocus', 'dofMaxBlur', 'motionBlur', 'motionBlurAmount', 'grain',
    'chromatic', 'vignette'],
  camera: ['fov', 'flySpeed', 'sensitivity', 'invertY', 'damping', 'collision'],
  display: ['scale', 'autoScale', 'targetFps', 'scaleMin', 'scaleMax', 'aa', 'ssaa', 'overlay', 'labels',
    'grid', 'legend', 'minimap', 'hud'],
};
const REQUIRED_IDS = Object.entries(REQUIRED).flatMap(([group, names]) => names.map((n) => group + '.' + n));

const WEBGPU = { webgpu: true };

function specRequiredIds() {
  const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  const start = spec.indexOf('Required ids');
  const end = spec.indexOf('Preset intent', start);
  assert.ok(start > 0 && end > start, 'SPEC.md section 7 required-id block not found');
  const ids = [];
  for (const m of spec.slice(start, end).matchAll(/\x60((?:color|amp|geo|light|fx|camera|display)\.[A-Za-z0-9]+)\x60/g)) {
    ids.push(m[1]);
  }
  return ids;
}

test('schema ids: exactly the SPEC section 7 required ids, unique, grouped by prefix', () => {
  const ids = SCHEMA.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  assert.deepEqual([...ids].sort(), [...REQUIRED_IDS].sort());
  assert.deepEqual([...new Set(specRequiredIds())].sort(), [...REQUIRED_IDS].sort(), 'SPEC.md and this test disagree');
  const groupIds = GROUPS.map((g) => g.id);
  for (const e of SCHEMA) {
    assert.equal(e.group, e.id.split('.')[0], e.id);
    assert.ok(groupIds.includes(e.group), e.id + ' group');
    assert.equal(SCHEMA_BY_ID.get(e.id), e);
  }
  assert.equal(SCHEMA.length, 142);
});

test('schema entries: types, labels, help, flags and ranges are well formed', () => {
  for (const e of SCHEMA) {
    const where = e.id;
    assert.ok(TYPES.includes(e.type), where + ' type');
    assert.ok(typeof e.label === 'string' && e.label.length > 0, where + ' label');
    assert.ok(typeof e.help === 'string' && e.help.length > 8, where + ' help');
    assert.ok(Object.hasOwn(REBUILD_CLASSES, e.rebuild), where + ' rebuild ' + e.rebuild);
    for (const flag of ['url', 'webgpu', 'preset']) assert.equal(typeof e[flag], 'boolean', where + ' ' + flag);
    assert.ok(e.scale === 'linear' || e.scale === 'log', where + ' scale');
    assert.ok(e.section === null || (typeof e.section === 'string' && e.section.length > 0), where + ' section');
    assert.ok(Object.isFrozen(e), where + ' frozen');
    if (e.type === 'number' || e.type === 'int') {
      assert.ok(Number.isFinite(e.min) && Number.isFinite(e.max) && e.min < e.max, where + ' range');
      assert.ok(e.step > 0, where + ' step');
      assert.ok(e.default >= e.min && e.default <= e.max, where + ' default in range');
      if (e.type === 'int') {
        for (const k of ['min', 'max', 'default', 'step']) assert.ok(Number.isInteger(e[k]), where + ' int ' + k);
      }
      if (e.scale === 'log') {
        if (e.min > 0) assert.equal(e.logMin, undefined, where + ' logMin only for min 0');
        else assert.ok(e.min === 0 && e.logMin > 0 && e.logMin < e.max, where + ' logMin');
      }
      if (e.capMax !== undefined) assert.equal(typeof e.capMax, 'string', where + ' capMax');
    } else {
      assert.equal(e.scale, 'linear', where + ' scale only for numbers');
      assert.equal(e.min, undefined, where + ' no min');
      assert.equal(e.max, undefined, where + ' no max');
    }
    if (e.type === 'enum') {
      assert.ok(Array.isArray(e.options) && e.options.length >= 2, where + ' options');
      assert.equal(new Set(e.options.map(String)).size, e.options.length, where + ' unique options');
      assert.ok(e.options.includes(e.default), where + ' default option');
      if (e.optionLabels) for (const o of e.options) assert.ok(e.optionLabels[o], where + ' label for ' + o);
      if (e.webgpuOptions) {
        for (const o of e.webgpuOptions) assert.ok(e.options.includes(o), where + ' webgpuOption ' + o);
        assert.ok(e.options.includes(e.fallback) && !e.webgpuOptions.includes(e.fallback), where + ' fallback');
        assert.ok(!e.webgpuOptions.includes(e.default), where + ' default must work on WebGL2');
      }
    } else {
      assert.equal(e.options, undefined, where + ' options only for enums');
    }
    if (e.type === 'bool') assert.equal(typeof e.default, 'boolean', where);
    if (e.type === 'color') assert.match(e.default, /^#[0-9a-f]{6}$/, where);
    if (e.type === 'gradient') {
      assert.equal(e.maxStops, 16, where);
      assert.ok(valuesEqual(normalizeGradient(e.default, e.maxStops), e.default), where + ' default is normalised');
    }
    if (e.type === 'file') {
      assert.equal(e.default, null, where);
      assert.equal(e.url, false, where + ' files never go in URLs');
      assert.equal(typeof e.accept, 'string', where + ' accept');
    }
    const checked = validateValue(e, e.default, WEBGPU);
    assert.ok(checked.ok && valuesEqual(checked.value, e.default), where + ' default survives validation');
  }
  assert.ok(valuesEqual(SCHEMA_BY_ID.get('color.gradient').default, DEFAULT_GRADIENT));
});

test('schema flags: compute-dependent entries need WebGPU; preferences stay out of presets', () => {
  const webgpuIds = SCHEMA.filter((e) => e.webgpu).map((e) => e.id).sort();
  assert.deepEqual(webgpuIds, ['color.autoExposureMax', 'color.autoExposureMin', 'color.autoExposureSpeed',
    'fx.ssgi', 'fx.ssgiIntensity', 'fx.ssgiSamples', 'geo.coinEdges', 'geo.coinThickness', 'geo.columnGap',
    'geo.columnPixels', 'geo.columnRadius', 'geo.columnShape', 'geo.columns', 'geo.cylinderSides',
    'geo.instanceBudget']);
  assert.deepEqual(SCHEMA_BY_ID.get('color.exposureMode').webgpuOptions, ['auto']);
  const preferences = SCHEMA.filter((e) => !e.preset).map((e) => e.id).sort();
  assert.deepEqual(preferences, ['camera.collision', 'camera.damping', 'camera.flySpeed', 'camera.fov',
    'camera.invertY', 'camera.sensitivity', 'color.lut', 'display.autoScale', 'display.hud', 'display.labels',
    'display.legend', 'display.minimap', 'display.overlay', 'display.scaleMax', 'display.scaleMin',
    'display.targetFps', 'geo.wireframe']);
  const notInUrl = SCHEMA.filter((e) => !e.url).map((e) => e.id).sort();
  assert.deepEqual(notInUrl, ['camera.collision', 'camera.damping', 'camera.flySpeed', 'camera.invertY',
    'camera.sensitivity', 'color.lut', 'display.hud', 'display.legend', 'display.minimap', 'display.overlay']);
  assert.equal(SCHEMA_BY_ID.get('geo.tileBudget').capMax, 'maxTileBudget');
  assert.equal(SCHEMA_BY_ID.get('geo.instanceBudget').capMax, 'maxInstances');
  assert.equal(SCHEMA_BY_ID.get('geo.instanceBudget').max, 8000000);
  assert.deepEqual([SCHEMA_BY_ID.get('geo.tileBudget').min, SCHEMA_BY_ID.get('geo.tileBudget').max], [32, 400]);
  assert.deepEqual([SCHEMA_BY_ID.get('display.scale').min, SCHEMA_BY_ID.get('display.scale').max], [0.25, 2]);
  assert.deepEqual([SCHEMA_BY_ID.get('light.cascades').min, SCHEMA_BY_ID.get('light.cascades').max], [1, 4]);
  assert.deepEqual(SCHEMA_BY_ID.get('light.shadowMapSize').options, [1024, 2048, 4096]);
  assert.deepEqual(SCHEMA_BY_ID.get('geo.subdivision').options, [1, 2, 4]);
  assert.deepEqual(SCHEMA_BY_ID.get('display.ssaa').options, [1, 2, 4]);
  assert.deepEqual(SCHEMA_BY_ID.get('color.toneMapping').options, ['none', 'linear', 'reinhard', 'aces', 'agx', 'neutral']);
  assert.deepEqual(SCHEMA_BY_ID.get('display.aa').options, ['none', 'fxaa', 'smaa', 'traa']);
  assert.deepEqual(SCHEMA_BY_ID.get('fx.ao').options, ['off', 'ssao', 'gtao']);
});

test('presets: names, metadata and every value valid without clamping', () => {
  assert.deepEqual(Object.keys(PRESETS), [...PRESET_NAMES]);
  assert.deepEqual(Object.keys(PRESET_INFO), [...PRESET_NAMES]);
  assert.equal(STARTUP_PRESET, 'High');
  assert.equal(WEBGL2_MAX_PRESET, 'High');
  assert.deepEqual([...QUALITY_ORDER], ['Performance', 'Balanced', 'High', 'Ultra', 'Extreme']);
  for (const [name, partial] of Object.entries(PRESETS)) {
    for (const [id, value] of Object.entries(partial)) {
      const e = SCHEMA_BY_ID.get(id);
      assert.ok(e, name + ': unknown id ' + id);
      assert.notEqual(e.preset, false, name + ': presets must not set preference ' + id);
      const checked = validateValue(e, value, WEBGPU);
      assert.ok(checked.ok, name + ': invalid ' + id);
      assert.ok(valuesEqual(checked.value, value), name + ': ' + id + ' would be clamped or normalised');
    }
  }
  assert.deepEqual(PRESETS.High, {}, 'High is the schema defaults');
});

function resolved(name, capabilities = WEBGPU) {
  return createSettingsStore(SCHEMA, PRESETS, { storage: null, capabilities }).presetValues(name);
}

test('Film preset reproduces the film colours: unlit, film palette, every effect off', () => {
  const f = resolved('Film');
  const expected = {
    'color.measure': 'density', 'color.palette': 'film', 'color.reverse': false,
    'color.whiteHot': true, 'color.whiteHotBTC': 10, 'color.offset': 30, 'color.upper': 500, 'color.gamma': 1,
    'light.albedo': 0, 'light.emissive': 1, 'light.sunIntensity': 0, 'light.ambient': 0, 'light.rim': 0,
    'light.shadows': false, 'light.sky': false, 'light.stars': false, 'light.fogDensity': 0,
    'light.volumetric': false, 'light.godRays': false, 'light.floorReflection': 0,
    'fx.ao': 'off', 'fx.ssgi': false, 'fx.ssr': false, 'fx.bloom': false, 'fx.dof': false, 'fx.motionBlur': false,
    'fx.grain': 0, 'fx.chromatic': 0, 'fx.vignette': 0,
    'color.toneMapping': 'none', 'color.exposureMode': 'manual', 'color.exposure': 1,
    'color.hueShift': 0, 'color.saturation': 1, 'color.contrast': 1, 'color.temperature': 0, 'color.tint': 0,
    'color.lift': 0, 'color.liftColor': '#ffffff', 'color.gradeGamma': 1, 'color.gain': 1,
    'color.gainColor': '#ffffff', 'color.lutIntensity': 0, 'color.p3': false,
    'display.aa': 'none', 'display.ssaa': 1, 'display.scale': 1,
    'color.background': '#000000', 'color.ground': '#000000',
    'geo.stepped': true, 'geo.columns': false, 'geo.smoothing': 'none', 'amp.edgeGlow': 0, 'amp.nowPlane': 0,
    'display.grid': false,
  };
  for (const [id, value] of Object.entries(expected)) assert.deepEqual(f[id], value, 'Film ' + id);
  // Heat glow and flashes stay on, like the film's activity flashes (both are zero after a seek).
  assert.equal(f['color.heatGain'], SCHEMA_BY_ID.get('color.heatGain').default);
  assert.ok(f['color.heatGain'] > 0);
  assert.equal(f['amp.flashSize'], SCHEMA_BY_ID.get('amp.flashSize').default);
  assert.ok(f['amp.flashSize'] > 0);
  // Film is allowed on WebGL2 and resolves identically there.
  assert.deepEqual(resolved('Film', { webgpu: false }), f);
});

test('quality presets scale up from Performance to Extreme', () => {
  const tiers = QUALITY_ORDER.map((name) => resolved(name));
  const nonDecreasing = ['geo.tileBudget', 'light.cascades', 'light.shadowMapSize', 'fx.aoSamples', 'display.scale',
    'display.ssaa', 'geo.subdivision', 'geo.instanceBudget', 'geo.columnRadius', 'fx.ssgiSamples', 'fx.ssrSteps',
    'light.volumetricSteps', 'fx.bloomMips'];
  for (const id of nonDecreasing) {
    for (let i = 1; i < tiers.length; i++) {
      assert.ok(tiers[i][id] >= tiers[i - 1][id], id + ': ' + QUALITY_ORDER[i] + ' < ' + QUALITY_ORDER[i - 1]);
    }
  }
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i]['geo.pixelsPerCell'] <= tiers[i - 1]['geo.pixelsPerCell'], 'pixelsPerCell must not grow');
    assert.ok(tiers[i]['geo.columnPixels'] <= tiers[i - 1]['geo.columnPixels'], 'columnPixels must not grow');
  }
  for (const id of ['light.shadows', 'fx.ssgi', 'fx.ssr', 'light.volumetric', 'light.godRays', 'geo.columns', 'fx.bloom']) {
    let seen = false;
    for (let i = 0; i < tiers.length; i++) {
      if (seen) assert.equal(tiers[i][id], true, id + ' switched off again at ' + QUALITY_ORDER[i]);
      seen = seen || tiers[i][id] === true;
    }
  }
  const aoRank = { off: 0, ssao: 1, gtao: 2 };
  for (let i = 1; i < tiers.length; i++) assert.ok(aoRank[tiers[i]['fx.ao']] >= aoRank[tiers[i - 1]['fx.ao']]);
  const [perf, , high, ultra, extreme] = tiers;
  assert.equal(perf['light.shadows'], false);
  assert.ok(perf['display.scale'] < 1);
  assert.equal(high['display.scale'], 1);
  // Ultra (measured retune, headed 4K run): native 4K plus 3x4096 cascades, volumetric light
  // and god rays.
  assert.equal(ultra['display.scale'], 1, 'Ultra targets native 4K');
  assert.equal(ultra['display.ssaa'], 1);
  assert.equal(ultra['light.cascades'], 3);
  assert.equal(ultra['light.shadowMapSize'], 4096);
  assert.equal(ultra['light.volumetric'], true);
  assert.equal(ultra['light.godRays'], true);
  // Extreme (measured retune): SSAA, 4x4096 cascades, more AO and volumetric samples, SSR,
  // motion blur, subdivision 2 and instanced columns.
  assert.ok(extreme['display.scale'] >= 1.5 || extreme['display.ssaa'] >= 2);
  assert.equal(extreme['light.cascades'], 4);
  assert.equal(extreme['light.shadowMapSize'], 4096);
  assert.equal(extreme['geo.columns'], true);
  assert.ok(extreme['geo.subdivision'] >= 2);
  assert.ok(extreme['geo.instanceBudget'] >= 2000000);
  assert.equal(extreme['fx.ssr'], true);
  assert.equal(extreme['fx.motionBlur'], true);
  assert.ok(extreme['fx.aoSamples'] > ultra['fx.aoSamples']);
  assert.ok(extreme['light.volumetricSteps'] > ultra['light.volumetricSteps']);
  // Look settings stay constant across quality tiers (Film alone turns the grid off).
  for (const id of ['color.toneMapping', 'color.palette', 'light.albedo', 'light.emissive', 'fx.dof', 'display.grid']) {
    for (const t of tiers) assert.deepEqual(t[id], high[id], id + ' should not vary by quality tier');
  }
  assert.equal(high['display.grid'], true);
});

test('High preset equals the schema defaults', () => {
  const high = resolved('High');
  for (const e of SCHEMA) assert.ok(valuesEqual(high[e.id], e.default), e.id);
});
