// Post-processing plan (render_post). Pure module: no three.js, no DOM.
//
// Decides which effect nodes the RenderPipeline needs for a given set of settings and
// capabilities. A change in the plan's key rebuilds the pipeline; every other setting change
// only updates uniforms.

/** Fallback values for the ids render_post reads, used when the store lacks an id. */
export const POST_DEFAULTS = Object.freeze({
  'color.background': '#000000',
  'color.fog': '#8a97ad',
  'color.hueShift': 0,
  'color.saturation': 1,
  'color.contrast': 1,
  'color.temperature': 0,
  'color.tint': 0,
  'color.lift': 0,
  'color.liftColor': '#ffffff',
  'color.gradeGamma': 1,
  'color.gain': 1,
  'color.gainColor': '#ffffff',
  'color.toneMapping': 'agx',
  'color.exposureMode': 'manual',
  'color.exposure': 1,
  'color.autoExposureMin': 0.25,
  'color.autoExposureMax': 4,
  'color.autoExposureSpeed': 1.5,
  'color.lut': null,
  'color.lutIntensity': 1,
  'color.p3': false,

  'light.sunAzimuth': 225,
  'light.sunElevation': 35,
  'light.sunIntensity': 3,
  'light.sunColor': '#fff1dc',
  'light.skyColor': '#9bb7ff',
  'light.groundColor': '#2a2420',
  'light.ambient': 0.6,
  'light.shadows': true,
  'light.cascades': 3,
  'light.shadowMapSize': 2048,
  'light.shadowFilter': 'pcfsoft',
  'light.shadowSoftness': 1,
  'light.shadowBias': -0.0005,
  'light.fogDensity': 0.002,
  'light.fogHeightFalloff': 0.05,
  'light.volumetric': false,
  'light.volumetricSteps': 32,
  'light.volumetricIntensity': 1,
  'light.godRays': false,
  'light.godRaysIntensity': 1,
  'light.sky': true,
  'light.stars': true,
  'light.starDensity': 0.5,

  'fx.ao': 'gtao',
  'fx.aoRadius': 1,
  'fx.aoIntensity': 1,
  'fx.aoSamples': 16,
  'fx.ssgi': false,
  'fx.ssgiSamples': 8,
  'fx.ssgiIntensity': 1,
  'fx.ssr': false,
  'fx.ssrIntensity': 1,
  'fx.ssrSteps': 32,
  'fx.bloom': true,
  'fx.bloomThreshold': 0.85,
  'fx.bloomStrength': 0.6,
  'fx.bloomRadius': 0.4,
  'fx.bloomMips': 5,
  'fx.dof': false,
  'fx.dofAperture': 1,
  'fx.dofFocus': 100,
  'fx.dofAutoFocus': true,
  'fx.dofMaxBlur': 4,
  'fx.motionBlur': false,
  'fx.motionBlurAmount': 0.5,
  'fx.grain': 0,
  'fx.chromatic': 0,
  'fx.vignette': 0,

  'display.scale': 1,
  'display.autoScale': false,
  'display.targetFps': 60,
  'display.scaleMin': 0.5,
  'display.scaleMax': 2,
  'display.aa': 'traa',
  'display.ssaa': 1,
  'display.overlay': false,

  'camera.fov': 50,
});

export const POST_IDS = Object.freeze(Object.keys(POST_DEFAULTS));
export const TONE_MAPPINGS = Object.freeze(['none', 'linear', 'reinhard', 'aces', 'agx', 'neutral']);
export const AO_MODES = Object.freeze(['off', 'ssao', 'gtao']);
export const AA_MODES = Object.freeze(['none', 'fxaa', 'smaa', 'traa']);
export const SSAA_LEVELS = Object.freeze([1, 2, 4]);
export const SHADOW_FILTERS = Object.freeze(['basic', 'pcf', 'vsm', 'pcss']);

/** Reads every id render_post uses from a store-like object ({get(id)}) with fallbacks. */
export function readSettings(store) {
  const s = {};
  for (const id of POST_IDS) {
    let v;
    try { v = store && typeof store.get === 'function' ? store.get(id) : undefined; } catch { v = undefined; }
    s[id] = v === undefined ? POST_DEFAULTS[id] : v;
  }
  return s;
}

/** LUT text from a setting value: a string, {text}, or null. */
export function lutText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'object' && typeof value.text === 'string' && value.text.trim()) return value.text;
  return null;
}

const near = (a, b, eps = 1e-4) => Math.abs(Number(a) - b) <= eps;
const isWhite = (c) => {
  if (typeof c === 'number') return c === 0xffffff;
  return typeof c === 'string' && /^#?f{6}$/i.test(c.trim());
};

/** True when every grading control is at its identity value. */
export function gradeIsNeutral(s) {
  return near(s['color.hueShift'], 0) && near(s['color.saturation'], 1) && near(s['color.contrast'], 1) &&
    near(s['color.temperature'], 0) && near(s['color.tint'], 0) && near(s['color.gradeGamma'], 1) &&
    (near(s['color.lift'], 0)) && (near(s['color.gain'], 1) && isWhite(s['color.gainColor']));
}

/**
 * Pipeline structure for settings s and capabilities caps
 * ({backend: 'webgpu'|'webgl2', compute, p3}).
 */
export function planPipeline(s, caps = {}) {
  const webgpu = caps.backend !== 'webgl2';
  const compute = !!caps.compute;
  const ssaa = SSAA_LEVELS.includes(Number(s['display.ssaa'])) ? Number(s['display.ssaa']) : 1;
  const aa = AA_MODES.includes(s['display.aa']) ? s['display.aa'] : 'none';
  // SSGI's shader uses bit operations (countOneBits) that GLSL ES 3.0 lacks.
  const ssgi = !!s['fx.ssgi'] && webgpu;
  const aoMode = AO_MODES.includes(s['fx.ao']) ? s['fx.ao'] : 'off';
  // SSGI computes ambient occlusion as well; a separate AO pass would darken twice.
  const ao = ssgi ? 'off' : aoMode;
  const aoFromSsgi = ssgi && aoMode !== 'off';
  const ssr = !!s['fx.ssr'];
  const volumetric = !!s['light.volumetric'] && Number(s['light.volumetricIntensity']) > 0 && Number(s['light.sunIntensity']) > 0;
  const godRays = !!s['light.godRays'] && Number(s['light.godRaysIntensity']) > 0 && Number(s['light.sunIntensity']) > 0;
  // TRAA copies the scene depth into an output-sized history texture, so it cannot run on a
  // supersampled scene pass; SSAA is the anti-aliasing then.
  const traa = aa === 'traa' && ssaa === 1;
  const fxaa = aa === 'fxaa';
  const smaa = aa === 'smaa';
  const bloom = !!s['fx.bloom'] && Number(s['fx.bloomStrength']) > 0;
  const dof = !!s['fx.dof'] && Number(s['fx.dofMaxBlur']) > 0;
  const motionBlur = !!s['fx.motionBlur'] && Number(s['fx.motionBlurAmount']) > 0;
  const toneMapping = TONE_MAPPINGS.includes(s['color.toneMapping']) ? s['color.toneMapping'] : 'none';
  const autoExposure = s['color.exposureMode'] === 'auto' && compute;
  const grade = !gradeIsNeutral(s);
  const lut = !!lutText(s['color.lut']) && Number(s['color.lutIntensity']) > 0;
  const p3 = !!s['color.p3'] && !!caps.p3;
  const chromatic = Number(s['fx.chromatic']) > 0;
  const grain = Number(s['fx.grain']) > 0;
  const vignette = Number(s['fx.vignette']) > 0;
  const mrt = {
    normal: ao !== 'off' || ssgi || ssr,
    metalrough: ssr,
    diffuse: ssgi,
    velocity: traa || motionBlur,
  };
  return {
    ssaa, ao, aoFromSsgi, ssgi, ssr, volumetric, godRays, traa, fxaa, smaa, bloom, dof, motionBlur,
    toneMapping, autoExposure, grade, lut, p3, chromatic, grain, vignette, mrt,
  };
}

export function planKey(plan) {
  return JSON.stringify(plan);
}

/** Short list of the enabled stages, in pipeline order (overlay and reports). */
export function planStages(plan) {
  const out = [plan.ssaa > 1 ? 'scene×' + plan.ssaa + ' (SSAA)' : 'scene'];
  if (plan.ao !== 'off') out.push(plan.ao.toUpperCase());
  if (plan.ssgi) out.push('SSGI' + (plan.aoFromSsgi ? '+AO' : ''));
  if (plan.ssr) out.push('SSR');
  if (plan.volumetric) out.push('volumetric');
  if (plan.godRays) out.push('god rays');
  if (plan.traa) out.push('TRAA');
  if (plan.bloom) out.push('bloom');
  if (plan.dof) out.push('DOF');
  if (plan.motionBlur) out.push('motion blur');
  out.push(plan.autoExposure ? 'auto exposure' : 'exposure');
  if (plan.toneMapping !== 'none') out.push(plan.toneMapping);
  if (plan.grade) out.push('grade');
  out.push(plan.p3 ? 'P3' : 'sRGB');
  if (plan.lut) out.push('LUT');
  if (plan.fxaa) out.push('FXAA');
  if (plan.smaa) out.push('SMAA');
  if (plan.chromatic) out.push('CA');
  if (plan.grain) out.push('grain');
  if (plan.vignette) out.push('vignette');
  return out;
}
