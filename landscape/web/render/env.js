// Environment: sun with cascaded shadows, hemisphere ambient, sky, stars, height fog and
// the volumetric scattering volume (render_post).
//
// Settings ids: light.* (except emissive/albedo/rim/roughness/metalness/floorReflection, which
// the terrain consumes), color.background and color.fog.
import {
  DirectionalLight, HemisphereLight, SpotLight, Object3D, Color, Vector2, Vector3, Mesh, BoxGeometry,
  VolumeNodeMaterial, BasicShadowMap, PCFShadowMap, VSMShadowMap,
} from 'three/webgpu';
import {
  Fn, uniform, vec2, vec3, vec4, float, int, positionWorld, positionWorldDirection, cameraPosition,
  exp, mix, smoothstep, max, dot, pow, normalize, length, fog, select, abs, floor, fract, rand, step, clamp,
  screenCoordinate, interleavedGradientNoise, texture, reference, renderGroup, vogelDiskSample,
  Loop, If,
} from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';

export const VOLUME_LAYER = 10;
const CASTER_EXTRA_LAYER = 30; // keeps a shadow camera's layer mask from being overwritten
const DEG = Math.PI / 180;
const SUN_DISTANCE = 1000;
const SHADOW_DEPTH_RANGE = 4000;

/** Unit vector from the scene toward the sun. Azimuth 0° = toward −z (far edge), 90° = +x. */
export function sunDirection(azimuthDeg, elevationDeg, out = new Vector3()) {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/**
 * Percentage-closer soft shadows for orthographic (directional) shadow maps.
 * shadow.radius is the softness: an angular light size multiplier (1 ≈ 4 × the real sun).
 *
 * The blocker search uses depth comparisons only (8 Vogel-disk positions × 3 reference depths
 * stepping toward the light), because a raw depth read and a comparison sampler on the same
 * shadow texture cannot share three's single binding. The occluded fraction per reference depth
 * gives the mean blocker distance; a 12-tap hardware-PCF filter then uses a radius proportional
 * to that distance (36 compares per lookup; the first 80-compare version cost 21 ms at 4K).
 */
export const pcssFilter = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const softness = reference('radius', 'float', shadow).setGroup(renderGroup);
  const right = reference('right', 'float', shadow.camera).setGroup(renderGroup);
  const near = reference('near', 'float', shadow.camera).setGroup(renderGroup);
  const far = reference('far', 'float', shadow.camera).setGroup(renderGroup);
  const texel = float(1).div(mapSize.x);
  const width = right.mul(2).max(1e-3);
  const depthRange = far.sub(near);
  const tanSize = softness.max(0.05).mul(0.0372);
  const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
  const zr = shadowCoord.z;
  const searchUV = clamp(tanSize.mul(250).div(width), texel.mul(2), texel.mul(48));
  // Reference depths step 20 world units toward the light per level (3 levels = 60 units).
  const stepDepth = float(20).div(depthRange.max(1));
  const occludedLevels = float(0).toVar();
  const occludedSamples = float(0).toVar();
  Loop(8, ({ i }) => {
    const uv = shadowCoord.xy.add(vogelDiskSample(i, int(8), phi).mul(searchUV));
    const o0 = float(1).sub(texture(depthTexture, uv).compare(zr));
    const o1 = float(1).sub(texture(depthTexture, uv).compare(zr.sub(stepDepth)));
    const o2 = float(1).sub(texture(depthTexture, uv).compare(zr.sub(stepDepth.mul(2))));
    occludedSamples.addAssign(o0);
    occludedLevels.addAssign(o0.add(o1).add(o2));
  });
  const lit = float(1).toVar();
  If(occludedSamples.greaterThan(0.01), () => {
    // Mean receiver–blocker distance in world units (half a step added for the bucket centre).
    const distance = occludedLevels.div(occludedSamples).sub(0.5).max(0.25).mul(20);
    const penumbra = distance.mul(tanSize).div(width);
    const filterUV = clamp(penumbra, texel, texel.mul(64));
    const sum = float(0).toVar();
    Loop(12, ({ i }) => {
      const uv = shadowCoord.xy.add(vogelDiskSample(i, int(12), phi.add(2.1)).mul(filterUV));
      sum.addAssign(texture(depthTexture, uv).compare(zr));
    });
    lit.assign(sum.div(12));
  });
  return lit;
});

/** One hardware-filtered comparison: the volumetric light samples its shadow at every ray step. */
export const singleTapFilter = Fn(({ depthTexture, shadowCoord }) => texture(depthTexture, shadowCoord.xy).compare(shadowCoord.z));

/** CSMShadowNode whose cascades use an optional custom filter (LightShadow.copy drops filterNode). */
class LandscapeCSM extends CSMShadowNode {
  constructor(light, data, cascadeFilter) {
    super(light, data);
    this.cascadeFilter = cascadeFilter || null;
  }

  _init(builder) {
    super._init(builder);
    if (this.cascadeFilter) for (const l of this.lights) l.shadow.filterNode = this.cascadeFilter;
  }
}

const toColor = (v, fallback) => {
  const c = new Color();
  try { c.set(v === undefined || v === null ? fallback : v); } catch { c.set(fallback); }
  return c;
};

export function createEnvironment({ renderer, scene, camera, capabilities }) {
  const u = {
    sunDir: uniform(new Vector3(0, 1, 0)),
    sunColor: uniform(new Color(1, 1, 1)), // linear colour × intensity
    skyColor: uniform(new Color(0.3, 0.45, 1)),
    groundColor: uniform(new Color(0.02, 0.02, 0.02)),
    fogColor: uniform(new Color(0.3, 0.33, 0.4)),
    background: uniform(new Color(0, 0, 0)),
    fogDensity: uniform(0),
    fogFalloff: uniform(0.05),
    skyOn: uniform(1),
    starsOn: uniform(1),
    starDensity: uniform(0.5),
    starRadius: uniform(0.15),
    volDensity: uniform(1),
    volAnisotropy: uniform(0.55),
    volFrame: uniform(0),
    sunScreen: uniform(new Vector2(0.5, 0.5)),
    sunVisible: uniform(0),
  };

  // Lights ------------------------------------------------------------------
  const sunTarget = new Object3D();
  sunTarget.name = 'sun-target';
  scene.add(sunTarget);
  let sun = null;
  let csm = null;
  let shadowKey = '';
  const hemi = new HemisphereLight(0xffffff, 0x000000, 0.6);
  hemi.name = 'ambient';
  scene.add(hemi);
  const sunDirV = new Vector3(0, 1, 0);

  function disposeSun() {
    if (csm) {
      for (const l of csm.lights) if (l.shadow && l.shadow.map) l.shadow.map.dispose();
      csm.dispose();
      csm = null;
    }
    if (sun) {
      if (sun.shadow && sun.shadow.map) sun.shadow.map.dispose();
      scene.remove(sun);
      sun.dispose();
      sun = null;
    }
  }

  // A new light object for each shadow configuration: the light node caches its shadow node,
  // so swapping CSM nodes on a live light would keep the old one.
  function buildSun(s) {
    const color = sun ? sun.color.clone() : new Color(1, 1, 1);
    const intensity = sun ? sun.intensity : 3;
    disposeSun();
    sun = new DirectionalLight(color, intensity);
    sun.name = 'sun';
    sun.target = sunTarget;
    sun.castShadow = !!s.shadows;
    sun.shadow.mapSize.set(s.mapSize, s.mapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = SHADOW_DEPTH_RANGE;
    sun.shadow.bias = s.bias;
    sun.shadow.normalBias = 0;
    sun.shadow.radius = s.softness;
    sun.position.copy(sunTarget.position).addScaledVector(sunDirV, SUN_DISTANCE);
    scene.add(sun);
    if (s.shadows) {
      csm = new LandscapeCSM(sun, { cascades: s.cascades, maxFar: 1500, mode: 'practical', lightMargin: 400 },
        s.filter === 'pcss' ? pcssFilter : null);
      csm.fade = true;
      sun.shadow.shadowNode = csm;
    }
  }

  function applyShadowParams(s) {
    if (!sun) return;
    sun.shadow.bias = s.bias;
    sun.shadow.radius = s.softness;
    if (csm) {
      csm.lights.forEach((l, i) => {
        l.shadow.bias = s.bias * (i + 1);
        l.shadow.radius = s.softness;
      });
    }
  }

  // Sky, sun disc and stars (scene.backgroundNode) ---------------------------
  const skyNode = Fn(() => {
    const dir = positionWorldDirection;
    const up = dir.y;
    const above = mix(u.fogColor, u.skyColor, pow(clamp(up, 0, 1), 0.45));
    const below = mix(u.fogColor, u.groundColor, smoothstep(0, 0.25, up.negate()));
    const base = select(up.greaterThanEqual(0), above, below);
    const cosA = dot(dir, u.sunDir);
    const c0 = max(cosA, 0);
    const glow = pow(c0, 900).mul(6).add(pow(c0, 64).mul(0.3)).add(pow(c0, 6).mul(0.05));
    const disc = smoothstep(0.99985, 0.99996, cosA).mul(30);
    const sunVis = smoothstep(-0.06, 0.02, u.sunDir.y);
    const sky = base.add(u.sunColor.mul(glow.add(disc)).mul(sunVis).mul(0.25));
    const col = mix(u.background, sky, u.skyOn).toVar();
    // Stars: one candidate per cell of a 3D grid over the direction sphere.
    const p = dir.mul(300);
    const cell = floor(p);
    const h = rand(cell.xy.add(cell.z.mul(vec2(37.17, 11.13))));
    const jitter = vec3(rand(cell.yz.add(3.1)), rand(cell.zx.add(7.7)), rand(cell.xy.add(1.3)));
    const pos = cell.add(jitter.mul(0.8).add(0.1));
    const d = length(p.sub(pos));
    const share = u.starDensity.mul(0.35).max(1e-4);
    const present = step(share.oneMinus(), h);
    const mag = h.sub(share.oneMinus()).div(share).clamp(0, 1);
    const twinkle = float(0.4).add(pow(mag, 3).mul(1.6));
    const aboveHorizon = smoothstep(-0.01, 0.04, up);
    const star = smoothstep(u.starRadius, 0, d).mul(present).mul(twinkle).mul(aboveHorizon);
    const daylight = smoothstep(-0.1, 0.3, u.sunDir.y).mul(u.skyOn);
    const tint = mix(vec3(0.75, 0.82, 1), vec3(1, 0.9, 0.75), rand(cell.yx.add(5.5)));
    col.addAssign(tint.mul(star).mul(u.starsOn).mul(daylight.mul(0.95).oneMinus()));
    return vec4(col, 1);
  })();
  scene.backgroundNode = skyNode;

  // Exponential height fog (scene.fogNode), integrated analytically along the view ray.
  const heightFogFactor = Fn(() => {
    const toP = positionWorld.sub(cameraPosition);
    const dist = length(toP);
    const k = u.fogFalloff.max(1e-4);
    const dy = toP.y.mul(k);
    const camTerm = exp(clamp(cameraPosition.y.mul(k).negate(), -80, 80));
    const lineTerm = select(abs(dy).greaterThan(1e-3), exp(clamp(dy.negate(), -80, 80)).oneMinus().div(dy), dy.mul(-0.5).add(1));
    const tau = u.fogDensity.mul(dist).mul(camTerm).mul(lineTerm).max(0);
    return exp(tau.negate()).oneMinus().clamp(0, 1);
  });
  scene.fogNode = fog(u.fogColor, heightFogFactor());

  // Volumetric scattering ------------------------------------------------------
  // A VolumeNodeMaterial box around the camera, rendered in its own pass on VOLUME_LAYER.
  // VolumetricLightingModel ignores directional lights, so a distant spot light on the same
  // layer stands in for the sun; its single shadow map (terrain on layer 0) makes the shafts.
  let vol = null;
  function ensureVolume() {
    if (vol) return vol;
    const material = new VolumeNodeMaterial();
    material.name = 'volumetric-scattering';
    material.steps = 32;
    material.fog = false;
    material.offsetNode = fract(interleavedGradientNoise(screenCoordinate).add(u.volFrame));
    material.scatteringNode = Fn(({ positionRay }) => {
      const h = positionRay.y.max(0);
      const density = exp(h.mul(u.fogFalloff).negate()).mul(u.volDensity);
      const view = normalize(positionRay.sub(cameraPosition));
      const c = dot(view, u.sunDir);
      const g = u.volAnisotropy;
      const g2 = g.mul(g);
      const denom = g2.add(1).sub(g.mul(2).mul(c)).max(1e-4);
      const hg = g2.oneMinus().div(denom.mul(denom.sqrt()));
      return density.mul(hg);
    });
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
    mesh.name = 'volumetric-volume';
    mesh.layers.set(VOLUME_LAYER);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    const light = new SpotLight(0xffffff, 1, 0, 0.45, 0.02, 0);
    light.name = 'volumetric-sun';
    light.layers.set(VOLUME_LAYER);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0003;
    light.shadow.radius = 1;
    light.shadow.filterNode = singleTapFilter;
    light.shadow.camera.layers.set(0);
    light.shadow.camera.layers.enable(CASTER_EXTRA_LAYER);
    light.target.layers.set(VOLUME_LAYER);
    scene.add(mesh, light, light.target);
    vol = { material, mesh, light, radius: 400, height: 140 };
    return vol;
  }
  function removeVolume() {
    if (!vol) return;
    scene.remove(vol.mesh, vol.light, vol.light.target);
    if (vol.light.shadow.map) vol.light.shadow.map.dispose();
    vol.light.dispose();
    vol.mesh.geometry.dispose();
    vol.material.dispose();
    vol = null;
  }

  // Settings -------------------------------------------------------------------
  let volumetricOn = false;
  function sync(s) {
    sunDirection(Number(s['light.sunAzimuth']), Number(s['light.sunElevation']), sunDirV);
    u.sunDir.value.copy(sunDirV);
    const sunColor = toColor(s['light.sunColor'], '#ffffff');
    const sunIntensity = Math.max(0, Number(s['light.sunIntensity']) || 0);
    u.sunColor.value.copy(sunColor).multiplyScalar(sunIntensity);
    u.skyColor.value.copy(toColor(s['light.skyColor'], '#9bb7ff'));
    u.groundColor.value.copy(toColor(s['light.groundColor'], '#2a2420'));
    u.fogColor.value.copy(toColor(s['color.fog'], '#8a97ad'));
    u.background.value.copy(toColor(s['color.background'], '#000000'));
    u.fogDensity.value = Math.max(0, Number(s['light.fogDensity']) || 0);
    u.fogFalloff.value = Math.max(0, Number(s['light.fogHeightFalloff']) || 0);
    // VolumetricLightingModel scales in-scattering by 0.01 per unit of scattering density, so
    // 10 × fog density gives a scattering coefficient of 0.1 × the fog's extinction: the
    // analytic fog already supplies the ambient part of the haze, the volume adds sunlight.
    u.volDensity.value = 10 * u.fogDensity.value;
    u.skyOn.value = s['light.sky'] ? 1 : 0;
    u.starsOn.value = s['light.stars'] ? 1 : 0;
    u.starDensity.value = Math.min(1, Math.max(0, Number(s['light.starDensity']) || 0));
    hemi.color.copy(toColor(s['light.skyColor'], '#9bb7ff'));
    hemi.groundColor.copy(toColor(s['light.groundColor'], '#2a2420'));
    hemi.intensity = Math.max(0, Number(s['light.ambient']) || 0);

    const filter = ['basic', 'pcf', 'vsm', 'pcss'].includes(s['light.shadowFilter']) ? s['light.shadowFilter'] : 'pcf';
    const sh = {
      shadows: !!s['light.shadows'] && sunIntensity > 0,
      cascades: Math.min(4, Math.max(1, Math.round(Number(s['light.cascades']) || 3))),
      mapSize: [1024, 2048, 4096].includes(Number(s['light.shadowMapSize'])) ? Number(s['light.shadowMapSize']) : 2048,
      filter,
      softness: Math.max(0, Number(s['light.shadowSoftness']) || 0),
      bias: Number(s['light.shadowBias']) || 0,
    };
    const key = [sh.shadows, sh.cascades, sh.mapSize, sh.filter].join('|');
    let shadowsRebuilt = false;
    if (key !== shadowKey) {
      shadowKey = key;
      renderer.shadowMap.type = filter === 'basic' ? BasicShadowMap : filter === 'vsm' ? VSMShadowMap : PCFShadowMap;
      buildSun(sh);
      shadowsRebuilt = true;
    }
    sun.color.copy(sunColor);
    sun.intensity = sunIntensity;
    applyShadowParams(sh);

    volumetricOn = !!s['light.volumetric'] && Number(s['light.volumetricIntensity']) > 0 && sunIntensity > 0;
    if (volumetricOn) {
      const v = ensureVolume();
      v.material.steps = Math.min(512, Math.max(4, Math.round(Number(s['light.volumetricSteps']) || 32)));
      v.light.color.copy(sunColor);
      v.light.intensity = sunIntensity;
    } else {
      removeVolume();
    }
    return { shadowsRebuilt };
  }

  // Per frame ------------------------------------------------------------------
  const tmp = new Vector3();
  const fwd = new Vector3();
  let lastProjection = '';
  let frame = 0;
  function update(cam, viewportHeightPx) {
    frame++;
    // Sun target under the point the camera looks at (only the direction matters for CSM).
    cam.getWorldDirection(fwd);
    const t = fwd.y < -0.05 ? Math.min(4000, cam.position.y / -fwd.y) : 300;
    tmp.copy(cam.position).addScaledVector(fwd, t);
    sunTarget.position.set(tmp.x, 0, tmp.z);
    sunTarget.updateMatrixWorld();
    if (sun) {
      sun.position.copy(sunTarget.position).addScaledVector(sunDirV, SUN_DISTANCE);
      sun.updateMatrixWorld();
    }
    const projKey = cam.fov + ':' + cam.aspect.toFixed(5) + ':' + cam.near + ':' + cam.far;
    if (csm && csm.camera && projKey !== lastProjection) csm.updateFrustums();
    if (csm && csm.camera) lastProjection = projKey;

    u.starRadius.value = 1.3 * 300 * (cam.fov * DEG) / Math.max(1, viewportHeightPx);

    if (vol) {
      const height = Math.max(40, Math.min(400, vol.height));
      const r = Math.max(150, Math.min(900, cam.position.y * 3 + 250));
      vol.radius = r;
      vol.mesh.position.set(cam.position.x, height / 2, cam.position.z);
      vol.mesh.scale.set(2 * r, height, 2 * r);
      vol.mesh.updateMatrixWorld();
      const d = 3 * r;
      vol.light.target.position.set(cam.position.x, 0, cam.position.z);
      vol.light.position.copy(vol.light.target.position).addScaledVector(sunDirV, d);
      vol.light.angle = Math.atan((1.5 * r) / d);
      vol.light.shadow.camera.near = Math.max(1, d - 2.5 * r);
      vol.light.shadow.camera.far = d + 2.5 * r;
      vol.light.target.updateMatrixWorld();
      vol.light.updateMatrixWorld();
      u.volFrame.value = (frame * 0.618034) % 1;
    }

    // Sun position on screen for god rays, in post-pass uv (top-left origin, y down).
    tmp.copy(cam.position).addScaledVector(sunDirV, 10000).project(cam);
    const facing = fwd.dot(sunDirV);
    u.sunScreen.value.set(tmp.x * 0.5 + 0.5, 0.5 - tmp.y * 0.5);
    const off = Math.max(Math.abs(tmp.x), Math.abs(tmp.y));
    u.sunVisible.value = facing > 0 ? Math.max(0, Math.min(1, (1.6 - off) / 0.6)) * Math.min(1, facing * 4) * (sunDirV.y > -0.05 ? 1 : 0) : 0;
  }

  function setVolumeDepth(depthNode) {
    if (!vol) return;
    vol.material.depthNode = depthNode;
    vol.material.needsUpdate = true;
  }

  return {
    uniforms: u,
    hemi,
    get sun() { return sun; },
    get csm() { return csm; },
    get volume() { return vol; },
    get volumetricOn() { return volumetricOn; },
    sunDirection: sunDirV,
    sync,
    update,
    setVolumeDepth,
    dispose() {
      removeVolume();
      disposeSun();
      scene.remove(hemi, sunTarget);
      scene.backgroundNode = null;
      scene.fogNode = null;
    },
  };
}
