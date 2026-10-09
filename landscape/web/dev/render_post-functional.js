// browser-check --script body (render_post): functional checks of the post chain on one page.
// Load render_post-view.html (stub or real terrain) first. Returns a JSON report.
const dev = window.__dev;
const view = dev.view;
const store = dev.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { backend: view.backend, capabilities: { compute: view.capabilities.compute, timestamp: view.capabilities.timestamp, p3: view.capabilities.p3, maxTileBudget: view.capabilities.maxTileBudget, maxInstances: view.capabilities.maxInstances }, checks: [] };
const errorsBefore = () => (window.__consoleErrors || 0);
function set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); store.flush && store.flush(); }
const canvas = view.renderer.domElement;
// Renders one frame and reads pixels at fractional positions (same task, so the WebGPU canvas
// texture is still readable).
function capture(points) {
  view.update(1 / 60);
  view.render();
  const w = canvas.width, h = canvas.height;
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  return points.map(([fx, fy]) => {
    const d = ctx.getImageData(Math.floor(fx * w), Math.floor(fy * h), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
}
const PTS = [[0.3, 0.6], [0.5, 0.55], [0.7, 0.7], [0.45, 0.8], [0.6, 0.45]];
async function check(name, settings, fn, settle = 900) {
  const t0 = performance.now();
  set(settings);
  await wait(settle);
  let result;
  try { result = await fn(); } catch (e) { result = { error: String(e && e.stack || e) }; }
  const d = view.describe();
  report.checks.push({ name, ms: Math.round(performance.now() - t0), stages: d.stages, pipelineError: d.error, ...result });
}
// Baseline for comparisons: High without grading.
store.applyPreset('High');
set({ 'display.overlay': false });
await wait(1200);
const base = capture(PTS);

await check('auto exposure (compute luminance reduction)', { 'color.exposureMode': 'auto' }, async () => {
  await wait(1500);
  const ae = await view.post.readAutoExposure();
  return { ok: !!ae && ae.samples > 0 && ae.exposure > 0, autoExposure: ae };
}, 300);
set({ 'color.exposureMode': 'manual' });

await check('3D LUT (.cube swapping red and blue)', {}, async () => {
  const n = 17, lines = ['TITLE "swap-rb"', 'LUT_3D_SIZE 17'];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push((b / 16).toFixed(5) + ' ' + (g / 16).toFixed(5) + ' ' + (r / 16).toFixed(5));
  store.set('color.lut', { name: 'swap-rb.cube', text: lines.join('\n') });
  store.set('color.lutIntensity', 1);
  store.flush && store.flush();
  await wait(1200);
  const px = capture(PTS);
  const lutInfo = view.post.lut;
  const stagesWithLut = view.describe().stages;
  // Frames differ slightly (TRAA jitter, AO noise), so compare the swapped error with the
  // unswapped one instead of demanding equality.
  const swappedErr = px.map((p, i) => Math.abs(p[0] - base[i][2]) + Math.abs(p[2] - base[i][0]));
  const sameErr = px.map((p, i) => Math.abs(p[0] - base[i][0]) + Math.abs(p[2] - base[i][2]));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  store.set('color.lut', null);
  store.flush && store.flush();
  await wait(600);
  return { ok: lutInfo.size === 17 && stagesWithLut.includes('LUT') && sum(swappedErr) * 4 < sum(sameErr), lut: lutInfo, stagesWithLut,
    swappedError: sum(swappedErr), unswappedError: sum(sameErr), before: base, after: px };
}, 100);

await check('Display P3 canvas', { 'color.p3': true, 'color.saturation': 1.5 }, async () => {
  let cs = null;
  try { cs = view.backend === 'webgpu' ? view.renderer.backend.context.getConfiguration().colorSpace : view.renderer.backend.gl.drawingBufferColorSpace; } catch (e) { cs = 'unknown: ' + e.message; }
  return { ok: cs === 'display-p3' && view.post.plan.p3 === true, canvasColorSpace: cs };
}, 1000);
set({ 'color.p3': false, 'color.saturation': 1 });
await wait(600);

await check('grade: saturation 0 gives grey', { 'color.saturation': 0 }, async () => {
  const px = capture(PTS);
  const spread = Math.max(...px.map((p) => Math.max(...p) - Math.min(...p)));
  return { ok: spread <= 3, maxChannelSpread: spread, px };
});
set({ 'color.saturation': 1 });

const tm = {};
for (const t of ['none', 'linear', 'reinhard', 'aces', 'agx', 'neutral']) {
  set({ 'color.toneMapping': t });
  await wait(700);
  tm[t] = capture([[0.5, 0.55]])[0];
}
report.checks.push({ name: 'tone mapping operators', ok: new Set(Object.values(tm).map(String)).size >= 5, centrePixel: tm, stages: view.describe().stages, pipelineError: view.describe().error });
set({ 'color.toneMapping': 'agx' });

await check('DOF autofocus', { 'fx.dof': true, 'fx.dofAutoFocus': true }, async () => {
  await wait(1500);
  const fd = view.focusDistance();
  const f = view.post.uniforms.dofFocus.value;
  return { ok: Number.isFinite(fd) && Math.abs(f - fd) / fd < 0.1, focusDistance: fd, dofFocus: f, focal: view.post.uniforms.dofFocal.value };
}, 100);
set({ 'fx.dof': false });

await check('resolution scale 0.5', { 'display.scale': 0.5 }, async () => {
  const w = view.stats.width, h = view.stats.height;
  return { ok: Math.abs(w - canvas.clientWidth * devicePixelRatio * 0.5) <= 2, internal: [w, h], css: [canvas.clientWidth, canvas.clientHeight] };
});
await check('auto scale toward an unreachable 1000 fps target', { 'display.scale': 1, 'display.autoScale': true, 'display.targetFps': 1000, 'display.scaleMin': 0.5, 'display.scaleMax': 2 }, async () => {
  await wait(5000);
  return { ok: view.stats.scale < 1, scale: view.stats.scale, internal: [view.stats.width, view.stats.height] };
}, 100);
set({ 'display.autoScale': false, 'display.scale': 1, 'display.targetFps': 60 });

for (const aa of ['none', 'fxaa', 'smaa', 'traa']) {
  await check('anti-aliasing ' + aa, { 'display.aa': aa, 'display.ssaa': 1 }, async () => ({ ok: !view.describe().error }), 800);
}
for (const n of [2, 4]) {
  await check('SSAA ' + n, { 'display.ssaa': n }, async () => ({ ok: !view.describe().error && view.post.plan.ssaa === n }), 1200);
}
set({ 'display.ssaa': 1, 'display.aa': 'traa' });
await check('lens: grain, chromatic aberration, vignette', { 'fx.grain': 0.5, 'fx.chromatic': 1, 'fx.vignette': 0.8 }, async () => {
  const corner = capture([[0.02, 0.98], [0.5, 0.55]]);
  return { ok: !view.describe().error, cornerVsCentre: corner };
});
set({ 'fx.grain': 0, 'fx.chromatic': 0, 'fx.vignette': 0 });
report.passed = report.checks.filter((c) => c.ok).length;
report.total = report.checks.length;
return report;
