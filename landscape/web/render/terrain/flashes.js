// Flash sprites for spends (amp.flashSize, amp.flashThreshold, amp.heatReference).
//
// While a frame's deltas are applied, a cell whose heat grew in this block by at least
// flashThreshold BTC (heat is the cell's raw BTC sum) becomes a flash candidate. Only tiles
// currently drawn are considered, so each region spawns from exactly one level. Like the
// film, which flashes every spent output (1 to 9 pixels, larger for old coins and whales),
// every sprite keeps a minimum on-screen size, grows with the BTC moved, and spends of coins
// created near the creation edge (within amp.edgeBlocks of the current block) get smaller
// flashes. When a frame has more candidates than slots, old coins and larger amounts win.
import { Sprite, SpriteNodeMaterial, InstancedBufferAttribute, AdditiveBlending, DynamicDrawUsage } from 'three/webgpu';
import {
  instancedBufferAttribute, vec2, vec3, vec4, float, uv, smoothstep, length, pow, max, distance, uniform,
  cameraPosition, modelWorldMatrix,
} from 'three/tsl';
import { flashLook } from './curve.js';

export const FLASH_CAPACITY = 32768;
export const FLASH_LIFE_MS = 1400;
export const FLASH_MAX_NEW = 400;
export const FLASH_YOUNG_SHARE = 0.25; // at most this share of a frame's new flashes for creation-edge spends
export { flashLook };

/** Indices of up to n items with the largest weights (order not guaranteed beyond the cut). */
function topByWeight(items, n) {
  if (items.length <= n) return items;
  if (items.length > n * 4) {
    // Estimate the cut from a sample so a busy frame does not sort tens of thousands of items.
    const sample = [];
    for (let i = 0; i < 512; i++) sample.push(items[(Math.random() * items.length) | 0].weight);
    sample.sort((a, b) => b - a);
    const cut = sample[Math.min(sample.length - 1, Math.floor((n / items.length) * sample.length * 1.5))];
    const kept = items.filter((it) => it.weight >= cut);
    if (kept.length >= n) items = kept;
  }
  items.sort((a, b) => b.weight - a.weight);
  return items.slice(0, n);
}

export function createFlashes({ shading, capacity = FLASH_CAPACITY }) {
  const U = shading.uniforms;
  const posAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // x, y, z, size
  const valAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // intensity, fade, minPx, 0
  posAttr.setUsage(DynamicDrawUsage);
  valAttr.setUsage(DynamicDrawUsage);
  const pxToWorld = uniform(0.001); // world units per screen pixel at distance 1
  const material = new SpriteNodeMaterial();
  material.name = 'TerrainFlashes';
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.fog = true;
  const p = instancedBufferAttribute(posAttr);
  const v = instancedBufferAttribute(valAttr);
  const wp = modelWorldMatrix.mul(vec4(p.xyz, 1)).xyz;
  const s = max(p.w, distance(cameraPosition, wp).mul(pxToWorld).mul(v.z));
  material.positionNode = vec3(p.x, p.y.add(s.mul(0.4)), p.z); // sits on the cell, never buried in it
  material.scaleNode = vec2(s, s);
  const d = length(uv().sub(0.5)).mul(2);
  const core = pow(float(1).sub(smoothstep(0, 1, d)), 2.2);
  material.colorNode = vec4(U.heatColor.mul(v.x), core.mul(v.y));
  const sprite = new Sprite(material);
  sprite.name = 'TerrainFlashes';
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 11;
  sprite.visible = false;

  const list = []; // {x, y, z, size, minPx, intensity, t0}
  const stats = { spawned: 0, active: 0, lastFrame: 0, lastOld: 0, lastCandidates: 0 };

  /**
   * Adds flashes. items: [{x, xEnd, y, z, btc, btcCell}] in world units (x = block / 1000;
   * xEnd = the cell's newest block; btcCell = BTC per L0 cell, which sizes the flash). Old
   * coins (cells whose newest block is more than edgeBlocks before 'block') outrank
   * creation-edge spends, which get at most FLASH_YOUNG_SHARE of the slots.
   */
  function spawn(items, { size = 1, reference = 100, edge = 0.3, block = Infinity, edgeBlocks = 1008, now = performance.now(), maxNew = FLASH_MAX_NEW } = {}) {
    if (!(size > 0) || !items.length) return;
    for (const it of items) {
      it.old = !Number.isFinite(block) || block - (it.xEnd ?? it.x) * 1000 > edgeBlocks;
      it.weight = (it.btcCell ?? it.btc) * (it.old ? 1 : 0.1);
    }
    stats.lastCandidates = items.length;
    const old = [];
    const young = [];
    for (const it of items) (it.old ? old : young).push(it);
    const youngSlots = Math.max(1, Math.floor(maxNew * FLASH_YOUNG_SHARE));
    const pickYoung = topByWeight(young, Math.min(youngSlots, maxNew));
    const chosen = topByWeight(old, maxNew - pickYoung.length).concat(pickYoung);
    let oldCount = 0;
    for (const it of chosen) {
      const look = flashLook(it.btcCell ?? it.btc, { size, reference, old: it.old, edge });
      if (it.old) oldCount++;
      list.push({ x: it.x, y: it.y, z: it.z, size: look.size, minPx: look.minPx, intensity: look.intensity, t0: now });
    }
    if (list.length > capacity) list.splice(0, list.length - capacity);
    stats.spawned += chosen.length;
    stats.lastFrame = chosen.length;
    stats.lastOld = oldCount;
  }

  /** Advances the flashes; worldPerPixel = world units per screen pixel at distance 1. */
  function update(now = performance.now(), worldPerPixel = null) {
    if (Number.isFinite(worldPerPixel) && worldPerPixel > 0) pxToWorld.value = worldPerPixel;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if ((now - f.t0) / FLASH_LIFE_MS >= 1) continue;
      list[w++] = f;
    }
    list.length = w;
    const P = posAttr.array;
    const V = valAttr.array;
    for (let i = 0; i < w; i++) {
      const f = list[i];
      const a = (now - f.t0) / FLASH_LIFE_MS;
      const grow = 0.6 + 0.4 * Math.min(1, a * 4);
      P[i * 4] = f.x;
      P[i * 4 + 1] = f.y;
      P[i * 4 + 2] = f.z;
      P[i * 4 + 3] = f.size * grow;
      V[i * 4] = f.intensity;
      V[i * 4 + 1] = (1 - a) * (1 - a);
      V[i * 4 + 2] = f.minPx * grow;
    }
    if (w) {
      posAttr.clearUpdateRanges();
      posAttr.addUpdateRange(0, w * 4);
      posAttr.needsUpdate = true;
      valAttr.clearUpdateRanges();
      valAttr.addUpdateRange(0, w * 4);
      valAttr.needsUpdate = true;
    }
    sprite.count = w;
    sprite.visible = w > 0;
    stats.active = w;
  }

  function clear() {
    list.length = 0;
    sprite.count = 0;
    sprite.visible = false;
  }

  function dispose() {
    material.dispose();
    sprite.geometry?.dispose?.();
  }

  return { sprite, spawn, update, clear, stats, dispose };
}
