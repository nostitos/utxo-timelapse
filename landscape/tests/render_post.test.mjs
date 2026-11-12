// render_post unit tests: pure modules only (no browser, no three.js).
// Run: node --test landscape/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoScaler, clampScale, quantizeScale, internalSize } from '../web/render/scale.js';
import { createIdleGate, idleGate, AFTER_CHANGE_FRAMES, IDLE_REDRAW_MS } from '../web/render/idle.js';
import { parseCubeLUT, identityCubeLUT, sampleCubeLUT } from '../web/render/cube-lut.js';
import {
  POST_DEFAULTS, POST_IDS, readSettings, planPipeline, planKey, planStages, gradeIsNeutral, lutText,
  TONE_MAPPINGS, AO_MODES, AA_MODES, SSAA_LEVELS, SHADOW_FILTERS,
} from '../web/render/post-plan.js';
import { intervalUnion, groupOfPass } from '../web/render/overlay.js';
import { parseIoreg, summarize } from '../tools/gpu-util.mjs';
import { SCHEMA, PRESETS } from '../web/settings.schema.js';

const WEBGPU = { backend: 'webgpu', compute: true, p3: true };
const WEBGL2 = { backend: 'webgl2', compute: false, p3: true };

test('scale helpers clamp, quantise and respect the maximum texture dimension', () => {
  assert.equal(clampScale(3), 2);
  assert.equal(clampScale(0.1), 0.25);
  assert.equal(clampScale(NaN), 1);
  assert.equal(clampScale(1.7, 0.5, 1.5), 1.5);
  assert.equal(quantizeScale(0.7333), 0.75);
  assert.equal(quantizeScale(1.024), 1);
  assert.deepEqual(internalSize(3840, 2160, 1, 2), { pixelRatio: 2, width: 7680, height: 4320 });
  assert.deepEqual(internalSize(1920, 1080, 2, 1), { pixelRatio: 2, width: 3840, height: 2160 });
  const capped = internalSize(3840, 2160, 2, 2, 8192);
  assert.ok(capped.width <= 8192 && capped.height <= 8192);
  assert.equal(capped.width, 8192);
});

test('AutoScaler shrinks when the GPU is slow, grows when fast, and settles in between', () => {
  const a = new AutoScaler({ enabled: true, min: 0.5, max: 2, targetFps: 60, scale: 1, windowFrames: 10, settleMs: 500 });
  let t = 0;
  let next = null;
  for (let i = 0; i < 10 && next === null; i++) { t += 33; next = a.sample(33, 33, t); }
  assert.ok(next !== null && next < 1, 'shrinks at 33 ms GPU');
  assert.ok(next >= 0.7, 'one step is bounded (maxDownFactor)');
  // Settle period: no change immediately after.
  assert.equal(a.sample(33, 33, t + 10), null);
  // Fast GPU: grows by at most maxUpFactor per step, never beyond max.
  const b = new AutoScaler({ enabled: true, min: 0.5, max: 1.2, targetFps: 60, scale: 1, windowFrames: 10, settleMs: 0 });
  let grown = null;
  t = 0;
  for (let i = 0; i < 10 && grown === null; i++) { t += 16; grown = b.sample(16.6, 4, t); }
  assert.ok(grown > 1 && grown <= 1.12 + 1e-9);
  for (let k = 0; k < 20; k++) for (let i = 0; i < 10; i++) { t += 16; b.sample(16.6, 4, t); }
  assert.equal(b.scale, 1.2);
  // Inside the band: unchanged.
  const c = new AutoScaler({ enabled: true, targetFps: 60, scale: 1, windowFrames: 10, settleMs: 0 });
  for (let i = 0; i < 30; i++) assert.equal(c.sample(16.6, 15.5, i * 16), null);
  // Disabled: never changes.
  const d = new AutoScaler({ enabled: false });
  assert.equal(d.sample(100, 100, 1000), null);
  // configure clamps to the new bounds.
  assert.equal(new AutoScaler({ scale: 1.8 }).configure({ max: 1.5 }), 1.5);
});

test('AutoScaler without GPU timing probes a larger scale, backs off when it is too slow, and holds', () => {
  // A 60 Hz display that keeps up: the frame interval sits at the target, so only a probe can grow.
  const a = new AutoScaler({ enabled: true, min: 0.5, max: 1, targetFps: 60, scale: 0.5, windowFrames: 10, settleMs: 500 });
  let t = 0;
  const run = (ms, frameMs, gpuMs = NaN) => {
    const changes = [];
    for (const end = t + ms; t < end;) { t += frameMs; const n = a.sample(frameMs, gpuMs, t); if (n !== null) changes.push([Math.round(t), n]); }
    return changes;
  };
  assert.deepEqual(run(7500, 16.7), [], 'no probe before 8 s');
  const first = run(1000, 16.7);
  assert.equal(first.length, 1);
  assert.equal(first[0][1], 0.55, 'one step up (+0.05, more than x1.1 here)');
  // The probe holds: the next one comes 8 s later and goes x1.1 once that is more than 0.05.
  assert.deepEqual(run(7000, 16.7), []);
  assert.equal(run(2000, 16.7)[0][1], 0.6);
  // Too slow right after a probe: shrinks as usual and waits twice as long before probing again.
  while (a.scale < 0.65) { t += 16.7; a.sample(16.7, NaN, t); }
  let slow = null;
  for (const end = t + 2000; slow === null && t < end;) { t += 22; slow = a.sample(22, NaN, t); }
  assert.ok(slow !== null && slow < 0.65, 'a probe that is too slow shrinks: ' + slow);
  const after = a.scale;
  assert.deepEqual(run(15000, 16.7), [], 'waits 16 s after a failed probe');
  assert.ok(run(2000, 16.7)[0][1] > after);
  // With GPU timing headroom shows directly, so there is no probing at the target.
  const g = new AutoScaler({ enabled: true, min: 0.5, max: 1, targetFps: 60, scale: 0.5, windowFrames: 10, settleMs: 0 });
  for (let i = 1; i <= 2000; i++) assert.equal(g.sample(16.7, 16, i * 16.7), null);
  // At the maximum there is nothing to probe.
  const m = new AutoScaler({ enabled: true, min: 0.5, max: 1, targetFps: 60, scale: 1, windowFrames: 10, settleMs: 0 });
  for (let i = 1; i <= 2000; i++) assert.equal(m.sample(16.7, NaN, i * 16.7), null);
});

test('AutoScaler.hold ignores frames until the hold ends', () => {
  const a = new AutoScaler({ enabled: true, min: 0.5, max: 2, targetFps: 60, scale: 1, windowFrames: 10, settleMs: 0 });
  a.hold(3000);
  for (let t = 33; t < 3000; t += 33) assert.equal(a.sample(33, 33, t), null, 'slow startup frames are ignored');
  let next = null;
  for (let t = 3000; t < 3500 && next === null; t += 33) next = a.sample(33, 33, t);
  assert.ok(next !== null && next < 1, 'slow frames after the hold shrink');
  // A later, shorter hold does not cut an earlier, longer one.
  a.hold(10000);
  a.hold(5000);
  for (let t = 4000; t < 10000; t += 33) assert.equal(a.sample(33, 33, t), null);
});

test('idle gate: draws after a change for a while, then once a second; busy frames always draw', () => {
  const g = createIdleGate();
  let now = 0;
  const frame = (o = {}) => idleGate(g, { changed: false, busy: false, now: (now += 16), ...o });
  assert.equal(frame({ changed: true }), true);
  let drawn = 0;
  for (let i = 0; i < AFTER_CHANGE_FRAMES; i++) drawn += frame() ? 1 : 0;
  assert.equal(drawn, AFTER_CHANGE_FRAMES, 'the frames after a change are drawn');
  assert.equal(frame(), false, 'then the view is idle');
  drawn = 0;
  const start = now;
  while (now - start < 3 * IDLE_REDRAW_MS) drawn += frame() ? 1 : 0;
  assert.ok(drawn >= 2 && drawn <= 3, drawn + ' safety frames in 3 s');
  assert.equal(frame({ busy: true }), true, 'busy draws');
  assert.equal(frame(), true, 'and the frames after it count as after a change');
  assert.equal(frame({ changed: true }), true);
});

test('cube LUT parser: identity, comments, domain and errors', () => {
  const lut = parseCubeLUT(identityCubeLUT(5, 'id5'));
  assert.equal(lut.title, 'id5');
  assert.equal(lut.size, 5);
  assert.equal(lut.data.length, 5 * 5 * 5 * 4);
  for (const rgb of [[0, 0, 0], [1, 1, 1], [0.3, 0.6, 0.9], [0.125, 0.5, 0.75]]) {
    const out = sampleCubeLUT(lut, rgb);
    out.forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) < 1e-6, 'identity at ' + rgb));
  }
  // Red varies fastest (Data3DTexture order): entry 1 is (1/(n-1), 0, 0).
  assert.ok(Math.abs(lut.data[4] - 0.25) < 1e-6 && lut.data[5] === 0 && lut.data[6] === 0);
  const text = '# comment\nTITLE "x"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\nLUT_3D_SIZE 2\n' +
    '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1 # trailing\n';
  const scaled = parseCubeLUT(text);
  assert.deepEqual(scaled.domainMax, [2, 2, 2]);
  const mid = sampleCubeLUT(scaled, [1, 1, 1]);
  mid.forEach((v) => assert.ok(Math.abs(v - 0.5) < 1e-9));
  const ranged = parseCubeLUT('LUT_3D_INPUT_RANGE 0 4\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8));
  assert.deepEqual(ranged.domainMax, [4, 4, 4]);
  assert.throws(() => parseCubeLUT('0 0 0'), /before LUT_3D_SIZE/);
  assert.throws(() => parseCubeLUT('LUT_3D_SIZE 2\n0 0 0\n'), /expected 8 entries/);
  assert.throws(() => parseCubeLUT('LUT_1D_SIZE 16\n'), /1D/);
  assert.throws(() => parseCubeLUT('TITLE "no data"\n'), /missing LUT_3D_SIZE/);
  assert.throws(() => parseCubeLUT('LUT_3D_SIZE 1\n'), /out of range/);
});

test('settings fallbacks and LUT values', () => {
  const s = readSettings({ get: (id) => (id === 'fx.bloom' ? false : undefined) });
  assert.equal(s['fx.bloom'], false);
  assert.equal(s['fx.ao'], POST_DEFAULTS['fx.ao']);
  const throwing = readSettings({ get: () => { throw new Error('unknown id'); } });
  assert.deepEqual(throwing, { ...POST_DEFAULTS });
  assert.equal(lutText(null), null);
  assert.equal(lutText(''), null);
  assert.equal(lutText({ name: 'a.cube', text: 'LUT_3D_SIZE 2' }), 'LUT_3D_SIZE 2');
  assert.equal(lutText('LUT_3D_SIZE 2'), 'LUT_3D_SIZE 2');
});

test('render_post ids exist in the settings schema with compatible options', () => {
  const byId = new Map(SCHEMA.map((e) => [e.id, e]));
  for (const id of POST_IDS) assert.ok(byId.has(id), 'schema lacks ' + id);
  const opts = (id) => byId.get(id).options.map((o) => (typeof o === 'object' && o !== null ? o.value : o));
  assert.deepEqual(opts('color.toneMapping'), [...TONE_MAPPINGS]);
  assert.deepEqual(opts('fx.ao'), [...AO_MODES]);
  assert.deepEqual(opts('display.aa'), [...AA_MODES]);
  assert.deepEqual(opts('display.ssaa').map(Number), [...SSAA_LEVELS]);
  assert.deepEqual(opts('light.shadowFilter'), [...SHADOW_FILTERS]);
});

function presetSettings(name) {
  if (!PRESETS[name]) throw new Error('Unknown preset ' + name);
  const values = {};
  for (const e of SCHEMA) values[e.id] = e.default;
  Object.assign(values, PRESETS[name] || {});
  return readSettings({ get: (id) => values[id] });
}

test('BitcoinTimelapse.com plans an empty chain (exact palette colours)', () => {
  const p = planPipeline(presetSettings('BitcoinTimelapse.com'), WEBGPU);
  assert.equal(p.ssaa, 1);
  for (const k of ['ssgi', 'ssr', 'volumetric', 'godRays', 'traa', 'fxaa', 'smaa', 'bloom', 'dof', 'motionBlur',
    'autoExposure', 'grade', 'lut', 'p3', 'chromatic', 'grain', 'vignette']) assert.equal(p[k], false, k);
  assert.equal(p.ao, 'off');
  assert.equal(p.toneMapping, 'none');
  assert.deepEqual(p.mrt, { normal: false, metalrough: false, diffuse: false, velocity: false });
  assert.deepEqual(planStages(p), ['scene', 'exposure', 'sRGB']);
  assert.equal(gradeIsNeutral(presetSettings('BitcoinTimelapse.com')), true);
});

test('High, Ultra and Extreme plans', () => {
  const high = planPipeline(presetSettings('High'), WEBGPU);
  // SMAA and SSAO from High up: TRAA softened the spikes and shimmered with the camera still,
  // and GTAO without TRAA left dark blotches between them.
  assert.equal(high.ao, 'ssao');
  assert.equal(high.traa, false);
  assert.equal(high.smaa, true);
  assert.equal(high.bloom, true);
  assert.equal(high.toneMapping, 'agx');
  assert.deepEqual(high.mrt, { normal: true, metalrough: false, diffuse: false, velocity: false });
  // TRAA chosen by hand still plans its velocity attachment, and steps aside under supersampling.
  const temporal = planPipeline({ ...presetSettings('High'), 'display.aa': 'traa' }, WEBGPU);
  assert.equal(temporal.traa, true);
  assert.equal(temporal.smaa, false);
  assert.equal(temporal.mrt.velocity, true);
  assert.equal(planPipeline({ ...presetSettings('High'), 'display.aa': 'traa', 'display.ssaa': 2 }, WEBGPU).traa, false);
  const ultra = planPipeline(presetSettings('Ultra'), WEBGPU);
  // Ultra (retuned after the headed 4K run): High + 3×4096 cascades, volumetric scattering
  // and god rays; SSGI and SSR are left to Extreme / manual use.
  assert.equal(ultra.ao, 'ssao');
  assert.equal(ultra.ssgi, false);
  assert.equal(ultra.ssr, false);
  assert.equal(ultra.volumetric && ultra.godRays && ultra.smaa && ultra.bloom, true);
  assert.equal(ultra.traa, false);
  assert.deepEqual(ultra.mrt, { normal: true, metalrough: false, diffuse: false, velocity: false });
  // SSGI supplies AO itself when it is on, so no second AO pass is planned.
  const gi = planPipeline({ ...presetSettings('Ultra'), 'fx.ssgi': true }, WEBGPU);
  assert.equal(gi.ssgi, true);
  assert.equal(gi.ao, 'off');
  assert.equal(gi.aoFromSsgi, true);
  assert.deepEqual(gi.mrt, { normal: true, metalrough: false, diffuse: true, velocity: false });
  // Depth of field wins over SSGI: the pipeline with both froze the page.
  const both = planPipeline({ ...presetSettings('Ultra'), 'fx.ssgi': true, 'fx.dof': true }, WEBGPU);
  assert.equal(both.dof, true);
  assert.equal(both.ssgi, false);
  assert.equal(both.ao, 'ssao', 'the AO pass returns when SSGI steps aside');
  assert.equal(both.mrt.diffuse, false);
  assert.equal(planPipeline({ ...presetSettings('Ultra'), 'fx.ssgi': true, 'fx.dof': true, 'fx.dofMaxBlur': 0 }, WEBGPU).ssgi, true);
  const extreme = planPipeline(presetSettings('Extreme'), WEBGPU);
  assert.equal(extreme.ssaa, 2);
  assert.equal(extreme.traa, false);
  assert.equal(extreme.smaa, true, 'SMAA on top of the supersampled scene');
  assert.equal(extreme.motionBlur, false);
  assert.equal(extreme.mrt.velocity, false);
  assert.equal(extreme.ssr && extreme.volumetric && extreme.godRays, true);
  assert.equal(extreme.ssgi, false);
  assert.equal(extreme.ao, 'ssao');
});

test('WebGL2 drops compute and SSGI; structural keys ignore numeric changes', () => {
  const s = presetSettings('Ultra');
  s['color.exposureMode'] = 'auto';
  const gl = planPipeline(s, WEBGL2);
  assert.equal(gl.ssgi, false);
  assert.equal(gl.autoExposure, false);
  assert.equal(gl.ao, 'ssao', 'falls back to the AO pass when SSGI is unavailable');
  const gpu = planPipeline(s, WEBGPU);
  assert.equal(gpu.autoExposure, true);
  const a = presetSettings('High');
  const b = { ...a, 'fx.bloomStrength': 1.7, 'fx.aoRadius': 3, 'color.exposure': 2, 'light.volumetricSteps': 200 };
  assert.equal(planKey(planPipeline(a, WEBGPU)), planKey(planPipeline(b, WEBGPU)));
  const c = { ...a, 'fx.bloom': false };
  assert.notEqual(planKey(planPipeline(a, WEBGPU)), planKey(planPipeline(c, WEBGPU)));
  const graded = { ...a, 'color.saturation': 1.3 };
  assert.equal(gradeIsNeutral(graded), false);
  assert.equal(planPipeline(graded, WEBGPU).grade, true);
  const lens = { ...a, 'fx.vignette': 0.4, 'fx.grain': 0.2, 'fx.chromatic': 0.5 };
  const lp = planPipeline(lens, WEBGPU);
  assert.equal(lp.vignette && lp.grain && lp.chromatic, true);
  assert.equal(planPipeline({ ...a, 'color.p3': true }, { ...WEBGPU, p3: false }).p3, false);
});

test('GPU interval union credits overlapping passes once', () => {
  const u = intervalUnion([[0, 10], [2, 4], [9, 15], [20, 21]]);
  assert.equal(u.total, 16);
  assert.equal(u.span, 21);
  assert.equal(u.credit.reduce((x, y) => x + y, 0), u.total);
  assert.deepEqual(intervalUnion([]), { total: 0, span: 0, credit: [] });
  const nested = intervalUnion([[0, 100], [10, 20], [30, 40]]);
  assert.equal(nested.total, 100);
  assert.equal(groupOfPass('UnrealBloomPass.h3'), 'bloom');
  assert.equal(groupOfPass('GTAONode.AO'), 'ao');
  assert.equal(groupOfPass('SSRNode.Blur'), 'ssr');
  assert.equal(groupOfPass('TRAANode.resolve'), 'traa');
  assert.equal(groupOfPass('shadow'), 'shadows');
  assert.equal(groupOfPass('canvas'), 'output');
  assert.equal(groupOfPass('DepthOfField.Blur64'), 'dof');
});

test('gpu-util parses ioreg PerformanceStatistics', () => {
  const sample = '+-o AGXAcceleratorG16X  <class AGXAcceleratorG16X>\n  {\n    "model" = "Apple M4 Max"\n    "gpu-core-count" = 40\n' +
    '    "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=8270495744,"Tiler Utilization %"=7,' +
    '"recoveryCount"=0,"Renderer Utilization %"=15,"Device Utilization %"=16,"In use system memory"=2914402304}\n  }\n';
  const recs = parseIoreg(sample);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], { model: 'Apple M4 Max', cores: 40, device: 16, renderer: 15, tiler: 7, inUseMemory: 2914402304, allocMemory: 8270495744 });
  const s = summarize([{ device: 90 }, { device: 95 }, { device: 100 }]);
  assert.equal(s.samples, 3);
  assert.equal(s.device.p50, 95);
  assert.equal(s.device.max, 100);
  assert.equal(s.device.mean, 95);
});
