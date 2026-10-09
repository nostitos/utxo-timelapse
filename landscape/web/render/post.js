// RenderPipeline chain (render_post).
//
// Order: scene pass (or SSAA) → AO / SSGI → SSR → volumetric scattering → god rays → TRAA →
// bloom → depth of field → motion blur → exposure (manual or compute auto exposure) → tone
// mapping → grade → encode (sRGB or Display P3) → 3D LUT → FXAA/SMAA → chromatic aberration →
// grain → vignette. TRAA sits before bloom/DOF/motion blur so they work on the resolved image,
// and FXAA/SMAA after the LUT because they expect display-encoded input; grain and vignette
// come last so no anti-aliasing smears them.
//
// Only enabled stages are built. A change in the plan (post-plan.js) rebuilds the output node;
// numeric and colour settings only update uniforms.
import {
  RenderPipeline, Vector2, Vector3, Layers, Data3DTexture, HalfFloatType, RGBAFormat, LinearFilter,
  ClampToEdgeWrapping, UnsignedByteType, DataUtils, NoToneMapping, LinearToneMapping, ReinhardToneMapping,
  ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, LinearSRGBColorSpace, SRGBColorSpace, Color,
} from 'three/webgpu';
import {
  pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, metalness, roughness, diffuseColor,
  velocity, uniform, vec2, vec3, vec4, float, int, ivec2, Fn, sample, screenUV, screenSize, convertToTexture,
  uv,
  toneMapping, convertColorSpace, luminance, mix, smoothstep, clamp, pow, max, dot, length, normalize, exp,
  exp2, log2, texture, texture3D, textureLoad, textureSize, rand, fract, time, hue, step, select,
  instancedArray, instanceIndex, Loop, If, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssao } from 'three/addons/tsl/display/SSAONode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { planPipeline, planKey, planStages, lutText } from './post-plan.js';
import { parseCubeLUT } from './cube-lut.js';
import { VOLUME_LAYER } from './env.js';
import { defineDisplayP3 } from './context.js';

const TONE = {
  linear: LinearToneMapping, reinhard: ReinhardToneMapping, aces: ACESFilmicToneMapping,
  agx: AgXToneMapping, neutral: NeutralToneMapping,
};
const DEG = Math.PI / 180;

const toColor = (v, fallback) => {
  const c = new Color();
  try { c.set(v === undefined || v === null ? fallback : v); } catch { c.set(fallback); }
  return c;
};

function makeLutTexture(lut) {
  const n = lut.size;
  const half = new Uint16Array(n * n * n * 4);
  for (let i = 0; i < half.length; i++) half[i] = DataUtils.toHalfFloat(lut.data[i]);
  const tex = new Data3DTexture(half, n, n, n);
  tex.format = RGBAFormat;
  tex.type = HalfFloatType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createPost({ renderer, scene, camera, env, capabilities }) {
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  renderer.toneMapping = NoToneMapping;

  const U = {
    aoIntensity: uniform(1),
    volIntensity: uniform(1),
    godIntensity: uniform(1),
    bloomStrength: uniform(0.6),
    bloomRadius: uniform(0.4),
    bloomThreshold: uniform(0.85),
    dofFocus: uniform(100),
    dofFocal: uniform(50),
    dofBokeh: uniform(4),
    mbAmount: uniform(0.5),
    exposure: uniform(1),
    aeMin: uniform(0.25),
    aeMax: uniform(4),
    aeSpeed: uniform(1.5),
    aeDt: uniform(1 / 60),
    wb: uniform(new Vector3(1, 1, 1)),
    lift: uniform(new Vector3(0, 0, 0)),
    invGamma: uniform(new Vector3(1, 1, 1)),
    gain: uniform(new Vector3(1, 1, 1)),
    contrast: uniform(1),
    saturation: uniform(1),
    hue: uniform(0),
    lutIntensity: uniform(1),
    lutMin: uniform(new Vector3(0, 0, 0)),
    lutScale: uniform(new Vector3(1, 1, 1)),
    grain: uniform(0),
    chromatic: uniform(0),
    vignette: uniform(0),
  };

  // Auto exposure: 256 threads take 16 samples each from a 64×64 grid of the HDR scene colour,
  // skipping background pixels (depth at the far plane), and write partial sums of log2
  // luminance. One thread then forms the geometric mean, maps it to key 0.18 within the
  // bounds and eases toward it (speed per second). Runs after the frame; one frame of latency.
  let ae = null;
  function ensureAutoExposure() {
    if (ae || !capabilities.compute) return ae;
    const partial = instancedArray(512, 'float');
    const state = instancedArray(4, 'float');
    const colorTex = texture();
    const depthTex = texture();
    const reduce = Fn(() => {
      const t = instanceIndex;
      const tx = t.mod(16);
      const ty = t.div(16);
      const size = vec2(textureSize(colorTex, 0));
      const dsize = vec2(textureSize(depthTex, 0));
      const sum = float(0).toVar();
      const cnt = float(0).toVar();
      Loop(16, ({ i }) => {
        const sx = tx.mul(4).add(i.mod(4));
        const sy = ty.mul(4).add(i.div(4));
        const uvp = vec2(float(sx).add(0.5), float(sy).add(0.5)).div(64);
        const c = textureLoad(colorTex, ivec2(uvp.mul(size))).rgb;
        const d = textureLoad(depthTex, ivec2(uvp.mul(dsize))).x;
        If(d.lessThan(0.999999), () => {
          sum.addAssign(clamp(log2(max(luminance(c), 1e-6)), -16, 8));
          cnt.addAssign(1);
        });
      });
      partial.element(t.mul(2)).assign(sum);
      partial.element(t.mul(2).add(1)).assign(cnt);
    })().compute(256, [64]);
    reduce.name = 'autoExposure.reduce';
    const adapt = Fn(() => {
      const sum = float(0).toVar();
      const cnt = float(0).toVar();
      Loop(256, ({ i }) => {
        sum.addAssign(partial.element(i.mul(2)));
        cnt.addAssign(partial.element(i.mul(2).add(1)));
      });
      const avgLog = select(cnt.greaterThan(0), sum.div(cnt.max(1)), float(-2.47));
      const target = clamp(float(0.18).div(exp2(avgLog)), U.aeMin, U.aeMax);
      const prev = state.element(0);
      const k = float(1).sub(exp(U.aeSpeed.negate().mul(U.aeDt)));
      const ready = state.element(3).greaterThan(0.5);
      state.element(0).assign(select(ready, mix(prev, target, k), target));
      state.element(1).assign(avgLog);
      state.element(2).assign(cnt);
      state.element(3).assign(1);
    })().compute(1, [1]);
    adapt.name = 'autoExposure.adapt';
    ae = { partial, state, colorTex, depthTex, reduce, adapt, exposureNode: state.element(0) };
    return ae;
  }

  let lut = { text: null, parsed: null, texture: null, error: null };
  function updateLut(value) {
    const text = lutText(value);
    if (text === lut.text) return;
    if (lut.texture) lut.texture.dispose();
    lut = { text, parsed: null, texture: null, error: null };
    if (!text) return;
    try {
      lut.parsed = parseCubeLUT(text);
      lut.texture = makeLutTexture(lut.parsed);
      const { domainMin: a, domainMax: b } = lut.parsed;
      U.lutMin.value.set(a[0], a[1], a[2]);
      U.lutScale.value.set(1 / (b[0] - a[0]), 1 / (b[1] - a[1]), 1 / (b[2] - a[2]));
    } catch (e) {
      lut.error = String(e && e.message || e);
      console.warn('render_post: LUT ignored:', lut.error);
    }
  }

  let plan = null;
  let key = '';
  let built = [];
  let state = { scenePass: null, volPass: null, ao: null, gi: null, ssr: null, traa: null, bloom: null, dof: null };
  let lastError = null;
  let lutSizeForPlan = 0;
  // Render target → pass label for the GPU timer (texture names must stay as three sets them:
  // MRT attachments are matched by name).
  let targetLabels = new WeakMap();
  function label(node, name) {
    const rt = node && (node.renderTarget || (node.passNode && node.passNode.renderTarget));
    if (rt) targetLabels.set(rt, name);
    return node;
  }

  function disposeBuilt() {
    for (const n of built) {
      try { if (n && typeof n.dispose === 'function') n.dispose(); } catch { /* ignore */ }
    }
    built = [];
  }

  function track(n) { built.push(n); return n; }

  function build(p, s) {
    disposeBuilt();
    targetLabels = new WeakMap();
    const st = { scenePass: null, volPass: null, ao: null, gi: null, ssr: null, traa: null, bloom: null, dof: null };

    // Scene pass ----------------------------------------------------------------
    // SSAA renders the scene pass (geometry, materials, shadows lookups) at √N × the output
    // resolution in each axis; every later pass reads it by UV, so SSAA 4 is resolved by an exact
    // 2:1 bilinear (box) downsample. (three's SSAAPassNode cannot carry MRT attachments in r186:
    // its accumulation quad wraps the MRT node and the struct members go missing.)
    const scenePass = pass(scene, camera);
    if (p.ssaa > 1) scenePass.setResolutionScale(Math.sqrt(p.ssaa));
    track(scenePass);
    label(scenePass, 'scene');
    st.scenePass = scenePass;
    const outs = { output };
    if (p.mrt.normal) outs.normal = packNormalToRGB(normalView);
    if (p.mrt.metalrough) outs.metalrough = vec2(metalness, roughness);
    if (p.mrt.diffuse) outs.diffuse = diffuseColor;
    if (p.mrt.velocity) outs.velocity = velocity;
    if (Object.keys(outs).length > 1) scenePass.setMRT(mrt(outs));
    if (p.mrt.normal) scenePass.getTexture('normal').type = UnsignedByteType;
    if (p.mrt.metalrough) scenePass.getTexture('metalrough').type = UnsignedByteType;
    if (p.mrt.diffuse) scenePass.getTexture('diffuse').type = UnsignedByteType;

    const colorTex = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    const normalTex = p.mrt.normal ? scenePass.getTextureNode('normal') : null;
    const sceneNormal = normalTex ? sample((uvn) => unpackRGBToNormal(normalTex.sample(uvn))) : null;
    const velocityTex = p.mrt.velocity ? scenePass.getTextureNode('velocity') : null;

    // Lighting composites (AO, SSGI, SSR, volumetric, god rays) --------------------
    let litRGB = colorTex.rgb;
    let composite = false;
    if (p.ao === 'gtao') {
      const n = track(ao(depthTex, sceneNormal, camera));
      // Half resolution (temporal filtering under TRAA): full-resolution GTAO with 16 samples
      // measured 3.7 ms of a 14 ms frame at 4K in close views.
      n.resolutionScale = 0.5;
      n.useTemporalFiltering = p.traa;
      st.ao = n;
      litRGB = litRGB.mul(pow(n.getTextureNode().r.clamp(0, 1), U.aoIntensity));
      composite = true;
    } else if (p.ao === 'ssao') {
      const n = track(ssao(depthTex, sceneNormal, camera));
      n.resolutionScale = 0.5;
      st.ao = n;
      litRGB = litRGB.mul(pow(n.getTextureNode().r.clamp(0, 1), U.aoIntensity));
      composite = true;
    }
    if (p.ssgi) {
      const n = track(ssgi(colorTex, depthTex, sceneNormal, camera));
      n.useTemporalFiltering = p.traa;
      st.gi = n;
      const diffuse = scenePass.getTextureNode('diffuse');
      const giAO = p.aoFromSsgi ? n.a : float(1);
      litRGB = colorTex.rgb.mul(giAO).add(diffuse.rgb.mul(n.rgb));
      composite = true;
    }
    if (p.ssr) {
      const mr = scenePass.getTextureNode('metalrough');
      const n = track(ssr(colorTex, depthTex, sceneNormal, { metalnessNode: mr.r, roughnessNode: mr.g, camera }));
      st.ssr = n;
      // Mirror-path SSR returns the reflection already weighted by distance attenuation,
      // Fresnel and metalness in rgb (alpha is the hit distance; misses are zero): add it.
      litRGB = litRGB.add(n.rgb);
      composite = true;
    }
    if (p.volumetric && env.volume) {
      const vp = track(pass(scene, camera, { depthBuffer: false }));
      const layers = new Layers();
      layers.set(VOLUME_LAYER);
      vp.setLayers(layers);
      vp.setResolutionScale(0.5);
      label(vp, 'volumetric');
      env.setVolumeDepth(depthTex.sample(screenUV));
      st.volPass = vp;
      litRGB = litRGB.add(vp.getTextureNode().rgb.mul(U.volIntensity));
      composite = true;
    }
    if (p.godRays) {
      const eu = env.uniforms;
      const occlusion = Fn(() => {
        // uv() of the full-screen pass: top-left origin in both backends, the convention of
        // getViewPosition and of the radial blur centre (env.uniforms.sunScreen).
        const quv = uv();
        const d = depthTex.sample(quv).r;
        const sky = step(0.999999, d);
        const viewPos = getViewPosition(quv, float(1), cameraProjectionMatrixInverse);
        const dir = normalize(cameraWorldMatrix.mul(vec4(viewPos, 0)).xyz);
        const c = max(dot(dir, eu.sunDir), 0);
        const glow = pow(c, 24).add(pow(c, 400).mul(4));
        return vec4(eu.sunColor.mul(glow).mul(sky), 1);
      });
      // Occlusion and radial blur at half resolution (full-res 64-tap blur cost ~10 ms at 4K).
      const occl = convertToTexture(occlusion(), null, null, { resolutionScale: 0.5 });
      label(occl, 'god rays');
      const rays = convertToTexture(radialBlur(occl, { center: eu.sunScreen, weight: float(0.65), decay: float(0.965), count: int(64), exposure: float(3) }), null, null, { resolutionScale: 0.5 });
      label(rays, 'god rays');
      litRGB = litRGB.add(rays.rgb.mul(U.godIntensity).mul(eu.sunVisible));
      composite = true;
    }

    let current = composite ? convertToTexture(vec4(litRGB, 1)) : colorTex;
    if (composite) label(current, 'composite');

    // Temporal AA on the HDR image -----------------------------------------------
    if (p.traa) {
      const n = track(traa(current, depthTex, velocityTex, camera));
      st.traa = n;
      current = n;
    }

    // Bloom ----------------------------------------------------------------------
    if (p.bloom) {
      const n = track(bloom(current, U.bloomStrength, U.bloomRadius, U.bloomThreshold));
      st.bloom = n;
      current = vec4(current.rgb.add(n.rgb), 1);
    }

    // Depth of field -------------------------------------------------------------
    if (p.dof) {
      const n = track(dof(current, scenePass.getViewZNode(), U.dofFocus, U.dofFocal, U.dofBokeh));
      st.dof = n;
      current = n;
    }

    // Motion blur ----------------------------------------------------------------
    if (p.motionBlur) {
      const src = convertToTexture(current);
      label(src, 'motion blur');
      current = motionBlur(src, velocityTex.mul(U.mbAmount), int(16));
    }

    // Exposure and tone mapping ----------------------------------------------------
    let exposureNode = U.exposure;
    if (p.autoExposure) {
      const a = ensureAutoExposure();
      if (a) {
        a.colorTex.value = scenePass.getTexture('output');
        a.depthTex.value = scenePass.getTexture('depth');
        exposureNode = a.exposureNode.mul(U.exposure);
      }
    }
    let c = current.rgb;
    if (p.toneMapping === 'none') c = c.mul(exposureNode);
    else c = toneMapping(TONE[p.toneMapping], exposureNode, c).rgb;

    // Grade (display-referred linear) ----------------------------------------------
    if (p.grade) {
      const graded = Fn(([x0]) => {
        let x = x0.mul(U.wb);
        x = U.gain.mul(x.add(U.lift.mul(vec3(1).sub(x))));
        x = pow(max(x, vec3(0)), U.invGamma);
        x = pow(max(x, vec3(0)).div(0.18), vec3(U.contrast)).mul(0.18);
        x = mix(vec3(luminance(x)), x, U.saturation).max(0);
        x = hue(x, U.hue);
        return x;
      });
      c = graded(c);
    }

    // Encode to the canvas colour space --------------------------------------------
    const target = p.p3 ? defineDisplayP3() : SRGBColorSpace;
    let x = vec4(convertColorSpace(vec4(c, 1), LinearSRGBColorSpace, target).rgb, 1);

    // 3D LUT (display-encoded domain) -----------------------------------------------
    if (p.lut && lut.texture) {
      const src = x;
      const remapped = vec4(src.rgb.sub(U.lutMin).mul(U.lutScale).clamp(0, 1), 1);
      x = lut3D(remapped, texture3D(lut.texture), lut.parsed.size, U.lutIntensity);
      lutSizeForPlan = lut.parsed.size;
    }

    // Edge anti-aliasing ------------------------------------------------------------
    if (p.fxaa) x = track(fxaa(x));
    else if (p.smaa) x = track(smaa(x));

    // Lens effects --------------------------------------------------------------------
    if (p.chromatic) x = chromaticAberration(x, U.chromatic, vec2(0.5, 0.5), float(1.1));
    if (p.grain) {
      const n = rand(screenUV.mul(vec2(1.123, 1.731)).add(fract(time.mul(0.6180339))));
      x = vec4(x.rgb.add(n.sub(0.5).mul(U.grain).mul(0.2)), 1);
    }
    if (p.vignette) {
      const aspect = screenSize.x.div(screenSize.y);
      const d = length(screenUV.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
      const v = smoothstep(0.35, 1.05, d);
      x = vec4(x.rgb.mul(float(1).sub(U.vignette.mul(v).mul(v))), 1);
    }

    pipeline.outputNode = vec4(x.rgb, 1);
    pipeline.needsUpdate = true;
    state = st;
  }

  function applyUniforms(s, p) {
    U.aoIntensity.value = Math.max(0, Number(s['fx.aoIntensity']));
    if (state.ao) {
      const radius = Math.max(0.01, Number(s['fx.aoRadius']));
      const samples = Math.max(1, Math.round(Number(s['fx.aoSamples'])));
      if (state.ao.radius) state.ao.radius.value = radius;
      if (state.ao.samples) state.ao.samples.value = samples;
    }
    if (state.gi) {
      const steps = Math.max(2, Math.round(Number(s['fx.ssgiSamples'])));
      state.gi.stepCount.value = steps;
      state.gi.sliceCount.value = Math.min(4, Math.max(1, Math.ceil(steps / 8)));
      state.gi.giIntensity.value = 10 * Math.max(0, Number(s['fx.ssgiIntensity']));
      state.gi.aoIntensity.value = p.aoFromSsgi ? Math.max(0, Number(s['fx.aoIntensity'])) : 0;
      state.gi.radius.value = Math.max(1, 12 * Math.max(0.1, Number(s['fx.aoRadius'])));
    }
    if (state.ssr) {
      const steps = Math.min(64, Math.max(4, Math.round(Number(s['fx.ssrSteps']))));
      state.ssr.quality.value = steps / 64;
      state.ssr.intensity.value = Math.max(0, Number(s['fx.ssrIntensity']));
      state.ssr.maxDistance.value = 80;
      state.ssr.thickness.value = 0.6;
      // Half resolution always: full-resolution SSR at 64 steps measured 71 ms at 4K.
      state.ssr.resolutionScale = 0.5;
    }
    U.volIntensity.value = Math.max(0, Number(s['light.volumetricIntensity']));
    U.godIntensity.value = Math.max(0, Number(s['light.godRaysIntensity']));
    U.bloomStrength.value = Math.max(0, Number(s['fx.bloomStrength']));
    U.bloomRadius.value = Math.min(1, Math.max(0, Number(s['fx.bloomRadius'])));
    U.bloomThreshold.value = Math.max(0, Number(s['fx.bloomThreshold']));
    if (state.bloom && Array.isArray(state.bloom.bloomTintColors)) {
      const mips = Math.min(5, Math.max(1, Math.round(Number(s['fx.bloomMips']))));
      state.bloom.bloomTintColors.forEach((v, i) => v.setScalar(i < mips ? 1 : 0));
    }
    U.dofBokeh.value = Math.max(0, Number(s['fx.dofMaxBlur']));
    U.mbAmount.value = Math.max(0, Number(s['fx.motionBlurAmount']));
    U.exposure.value = Math.max(0, Number(s['color.exposure']));
    U.aeMin.value = Math.max(1e-4, Number(s['color.autoExposureMin']));
    U.aeMax.value = Math.max(U.aeMin.value, Number(s['color.autoExposureMax']));
    U.aeSpeed.value = Math.max(0.01, Number(s['color.autoExposureSpeed']));

    const temp = Number(s['color.temperature']) || 0;
    const tint = Number(s['color.tint']) || 0;
    U.wb.value.set((1 + 0.25 * temp) * (1 + 0.125 * tint), 1 - 0.25 * tint, (1 - 0.25 * temp) * (1 + 0.125 * tint));
    const lift = Number(s['color.lift']) || 0;
    const liftC = toColor(s['color.liftColor'], '#ffffff');
    U.lift.value.set(lift * liftC.r, lift * liftC.g, lift * liftC.b);
    const g = Math.max(0.01, Number(s['color.gradeGamma']) || 1);
    U.invGamma.value.setScalar(1 / g);
    const gain = Number(s['color.gain']);
    const gainC = toColor(s['color.gainColor'], '#ffffff');
    const gv = Number.isFinite(gain) ? gain : 1;
    U.gain.value.set(gv * gainC.r, gv * gainC.g, gv * gainC.b);
    U.contrast.value = Math.max(0, Number(s['color.contrast']));
    U.saturation.value = Math.max(0, Number(s['color.saturation']));
    U.hue.value = (Number(s['color.hueShift']) || 0) * DEG;
    U.lutIntensity.value = Math.min(1, Math.max(0, Number(s['color.lutIntensity'])));
    U.grain.value = Math.max(0, Number(s['fx.grain']));
    U.chromatic.value = Math.max(0, Number(s['fx.chromatic']));
    U.vignette.value = Math.min(1, Math.max(0, Number(s['fx.vignette'])));
  }

  /** Applies settings; rebuilds when the plan changes. Returns true when rebuilt. */
  function sync(s) {
    updateLut(s['color.lut']);
    const p = planPipeline(s, capabilities);
    if (p.lut && !lut.texture) p.lut = false;
    if (p.volumetric && !env.volume) p.volumetric = false;
    const k = planKey(p) + '|' + (p.lut ? lut.text.length + ':' + lut.parsed.size : '');
    let rebuilt = false;
    if (k !== key) {
      try {
        build(p, s);
        plan = p;
        key = k;
        lastError = null;
        rebuilt = true;
      } catch (e) {
        lastError = String(e && e.stack || e);
        console.error('render_post: pipeline build failed', e);
        const fallback = planPipeline({}, capabilities);
        Object.assign(fallback, { ao: 'off', ssgi: false, ssr: false, volumetric: false, godRays: false, traa: false, bloom: false, dof: false, motionBlur: false, autoExposure: false, grade: false, lut: false, fxaa: false, smaa: false, chromatic: false, grain: false, vignette: false, toneMapping: 'none', ssaa: 1, mrt: { normal: false, metalrough: false, diffuse: false, velocity: false } });
        build(fallback, s);
        plan = fallback;
        key = k;
        rebuilt = true;
      }
    }
    applyUniforms(s, plan);
    return rebuilt;
  }

  function setFocus(distance, s) {
    const auto = !!s['fx.dofAutoFocus'];
    const manual = Math.max(0.1, Number(s['fx.dofFocus']) || 100);
    const target = auto && Number.isFinite(distance) && distance > 0 ? distance : manual;
    // Ease focus changes so autofocus does not pump.
    const cur = U.dofFocus.value;
    U.dofFocus.value = cur + (target - cur) * 0.15;
    const aperture = Math.max(0.05, Number(s['fx.dofAperture']) || 1);
    U.dofFocal.value = Math.max(0.25, U.dofFocus.value / (2 * aperture));
  }

  function render(dt) {
    U.aeDt.value = Math.min(0.25, Math.max(0.001, dt || 1 / 60));
    pipeline.render();
    if (plan && plan.autoExposure && ae && capabilities.compute) renderer.compute([ae.reduce, ae.adapt]);
  }

  async function readAutoExposure() {
    if (!ae) return null;
    const buf = await renderer.getArrayBufferAsync(ae.state.value);
    const f = new Float32Array(buf);
    return { exposure: f[0], avgLog2: f[1], samples: f[2] };
  }

  return {
    pipeline,
    uniforms: U,
    sync,
    render,
    setFocus,
    readAutoExposure,
    /** Pass label for a render target (GPU timer), or null. */
    labelForTarget(rt) { return rt ? targetLabels.get(rt) || null : null; },
    get plan() { return plan; },
    get stages() { return plan ? planStages(plan) : []; },
    get nodes() { return state; },
    get lastError() { return lastError; },
    get lut() { return { title: lut.parsed ? lut.parsed.title : null, size: lut.parsed ? lut.parsed.size : 0, error: lut.error }; },
    dispose() {
      disposeBuilt();
      if (lut.texture) lut.texture.dispose();
      pipeline.dispose();
    },
  };
}
