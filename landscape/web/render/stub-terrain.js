// Dev-only placeholder terrain with the createTerrain interface (render_post).
// A synthetic heightfield shaped like the landscape (amount bands front to back, growth left
// to right) plus optional instanced columns, so the post chain and benchmarks can run before
// render/terrain/index.js exists. main.js never uses it.
import {
  Group, Mesh, PlaneGeometry, BoxGeometry, InstancedMesh, MeshStandardNodeMaterial, Color, Matrix4,
  Vector3, Float32BufferAttribute, InstancedBufferAttribute, SRGBColorSpace,
} from 'three/webgpu';
import { uniform, attribute, vec3, float } from 'three/tsl';

const WIDTH = 966.848;
const DEPTH = 207.2;

function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b))];
}

const BANDS = [
  [8, 3, 0.35], [24, 2.5, 0.6], [36, 1.6, 1.0], [52, 5, 0.55], [72, 4, 0.8], [95, 6, 0.7],
  [118, 7, 0.9], [142, 6, 1.0], [160, 3, 0.75], [176, 2, 1.1], [190, 3, 0.6], [203, 2.5, 0.45],
];

function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function synthHeight(x, z) {
  if (x < 0 || x > WIDTH || z < 0 || z > DEPTH) return 0;
  const growth = 0.08 + 0.92 / (1 + Math.exp(-(x - 420) / 90));
  let band = 0;
  for (const [z0, w, a] of BANDS) {
    const d = (z - z0) / w;
    band += a * Math.exp(-d * d);
  }
  const ripple = 0.75 + 0.25 * Math.sin(x * 0.37 + Math.sin(z * 0.21) * 3) * Math.sin(z * 0.9);
  const grain = 0.85 + 0.3 * hash2(Math.floor(x * 4), Math.floor(z * 2));
  const spike = hash2(Math.floor(x * 2), Math.floor(z)) > 0.997 ? 6 : 0;
  return Math.max(0, 14 * growth * band * ripple * grain + spike * growth);
}

export async function createTerrain({ camera, settings, capabilities }) {
  const get = (id, fallback) => {
    try {
      const v = settings && typeof settings.get === 'function' ? settings.get(id) : undefined;
      return v === undefined ? fallback : v;
    } catch { return fallback; }
  };
  const group = new Group();
  group.name = 'stub-terrain';

  // Heightfield ------------------------------------------------------------------
  const NX = 1536;
  const NZ = 384;
  const heights = new Float32Array((NX + 1) * (NZ + 1));
  let hmax = 0;
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      const h = synthHeight((i / NX) * WIDTH, (j / NZ) * DEPTH);
      heights[j * (NX + 1) + i] = h;
      if (h > hmax) hmax = h;
    }
  }
  const geo = new PlaneGeometry(WIDTH, DEPTH, NX, NZ);
  geo.rotateX(-Math.PI / 2);
  geo.translate(WIDTH / 2, 0, DEPTH / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const z = pos.getZ(k);
    const i = Math.round((x / WIDTH) * NX);
    const j = Math.round((z / DEPTH) * NZ);
    const h = heights[j * (NX + 1) + i];
    pos.setY(k, h);
    const t = h > 0.02 ? Math.log(1 + h * 3) / Math.log(1 + hmax * 3) : 0;
    const [r, g, b] = h > 0.02 ? turbo(0.08 + 0.92 * t) : [0, 0, 0];
    c.setRGB(r, g, b, SRGBColorSpace);
    colors[k * 3] = c.r;
    colors[k * 3 + 1] = c.g;
    colors[k * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const u = {
    albedo: uniform(1),
    emissive: uniform(0.25),
    roughness: uniform(0.65),
    metalness: uniform(0),
    floorColor: uniform(new Color(0, 0, 0)),
    floorMetal: uniform(0),
    floorRough: uniform(1),
  };
  const vcol = attribute('color', 'vec3');
  const mat = new MeshStandardNodeMaterial();
  mat.name = 'stub-terrain';
  mat.colorNode = vcol.mul(u.albedo);
  mat.emissiveNode = vcol.mul(u.emissive);
  mat.roughnessNode = u.roughness;
  mat.metalnessNode = u.metalness;
  const mesh = new Mesh(geo, mat);
  mesh.name = 'stub-heightfield';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // Floor ------------------------------------------------------------------------
  const floorMat = new MeshStandardNodeMaterial();
  floorMat.name = 'stub-floor';
  floorMat.colorNode = u.floorColor;
  floorMat.metalnessNode = u.floorMetal;
  floorMat.roughnessNode = u.floorRough;
  const floorGeo = new PlaneGeometry(6000, 6000);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new Mesh(floorGeo, floorMat);
  floor.name = 'stub-floor';
  floor.position.set(WIDTH / 2, -0.02, DEPTH / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // Instanced columns (GPU load stand-in for geo.columns) ----------------------------
  const CX = 1024;
  const CZ = 512;
  const colCount = CX * CZ;
  const x0 = 380;
  const z0 = 0;
  const dx = 0.064 * 0.5;
  const dz = DEPTH / CZ;
  const colGeo = new BoxGeometry(dx * 0.86, 1, dz * 0.86);
  colGeo.translate(0, 0.5, 0);
  const colColors = new Float32Array(colCount * 3);
  const colMat = new MeshStandardNodeMaterial();
  colMat.name = 'stub-columns';
  const icol = attribute('instanceColor', 'vec3');
  colMat.colorNode = icol.mul(u.albedo);
  colMat.emissiveNode = icol.mul(u.emissive);
  colMat.roughnessNode = u.roughness;
  colMat.metalnessNode = u.metalness;
  const columns = new InstancedMesh(colGeo, colMat, colCount);
  columns.name = 'stub-columns';
  const m = new Matrix4();
  let n = 0;
  for (let j = 0; j < CZ; j++) {
    for (let i = 0; i < CX; i++) {
      const x = x0 + (i + 0.5) * dx;
      const z = z0 + (j + 0.5) * dz;
      const h = synthHeight(x, z) * 1.05 + 0.01;
      m.makeScale(1, h, 1);
      m.setPosition(x, 0, z);
      columns.setMatrixAt(n, m);
      const t = Math.log(1 + h * 3) / Math.log(1 + hmax * 3);
      const [r, g, b] = turbo(0.08 + 0.92 * t);
      c.setRGB(r, g, b, SRGBColorSpace);
      colColors[n * 3] = c.r;
      colColors[n * 3 + 1] = c.g;
      colColors[n * 3 + 2] = c.b;
      n++;
    }
  }
  colGeo.setAttribute('instanceColor', new InstancedBufferAttribute(colColors, 3));
  columns.instanceMatrix.needsUpdate = true;
  columns.castShadow = true;
  columns.receiveShadow = true;
  columns.frustumCulled = false;
  columns.visible = false;
  group.add(columns);

  function heightAt(x, z) {
    if (x < 0 || x > WIDTH || z < 0 || z > DEPTH) return 0;
    const fx = (x / WIDTH) * NX;
    const fz = (z / DEPTH) * NZ;
    const i = Math.min(NX - 1, Math.floor(fx));
    const j = Math.min(NZ - 1, Math.floor(fz));
    const tx = fx - i;
    const tz = fz - j;
    const a = heights[j * (NX + 1) + i];
    const b = heights[j * (NX + 1) + i + 1];
    const cc = heights[(j + 1) * (NX + 1) + i];
    const d = heights[(j + 1) * (NX + 1) + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
  }

  // Ray march against the heightfield; returns the distance along the ray or null.
  function march(origin, dir, maxT = 6000) {
    let t = 0;
    // Start at the top of the bounding box when above it.
    const top = hmax + 1;
    if (origin.y > top) {
      if (dir.y >= 0) return null;
      t = (origin.y - top) / -dir.y;
    }
    let prevT = t;
    let prevDiff = Infinity;
    const p = new Vector3();
    for (let k = 0; k < 40000 && t < maxT; k++) {
      p.copy(origin).addScaledVector(dir, t);
      if (p.y < -1 && dir.y < 0) return null;
      const diff = p.y - heightAt(p.x, p.z);
      if (diff <= 0) {
        let lo = prevT;
        let hi = t;
        for (let r = 0; r < 24; r++) {
          const mid = 0.5 * (lo + hi);
          p.copy(origin).addScaledVector(dir, mid);
          if (p.y - heightAt(p.x, p.z) > 0) lo = mid; else hi = mid;
        }
        return hi;
      }
      prevT = t;
      prevDiff = diff;
      t += Math.max(0.02, Math.min(4, diff * 0.5, 0.004 * t + 0.05));
    }
    void prevDiff;
    return null;
  }

  const fwd = new Vector3();
  const api = {
    object3d: group,
    applyFrame() {},
    setBlock() {},
    update() {
      u.albedo.value = Number(get('light.albedo', 1));
      u.emissive.value = Number(get('light.emissive', 0.25));
      u.roughness.value = Number(get('light.roughness', 0.65));
      u.metalness.value = Number(get('light.metalness', 0));
      const refl = Number(get('light.floorReflection', 0));
      u.floorMetal.value = refl;
      u.floorRough.value = 1 - 0.9 * refl;
      try { u.floorColor.value.set(get('color.ground', '#000000')); } catch { /* keep */ }
      columns.visible = !!get('geo.columns', false);
      api.stats.instances = columns.visible ? colCount : 0;
      return null;
    },
    pick(ray) {
      const t = march(ray.origin, ray.direction);
      if (t === null) return null;
      const p = ray.origin.clone().addScaledVector(ray.direction, t);
      const col = Math.floor((p.x * 1000) / 64);
      const row = Math.floor(p.z * 10);
      const h = heightAt(p.x, p.z);
      return { x: p.x, y: p.y, z: p.z, level: 0, col, row, l0Col: col, l0Row: row, value: h, colorValue: h, heat: 0 };
    },
    heightAt,
    focusDistance(cam) {
      cam.getWorldDirection(fwd);
      const t = march(cam.position, fwd);
      return t === null ? null : t;
    },
    stats: { instances: 0, tiles: 0, resident: 0, maxTiles: capabilities ? capabilities.maxTileBudget : 0, stub: true },
    dispose() {
      geo.dispose();
      mat.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      colGeo.dispose();
      colMat.dispose();
      columns.dispose();
    },
  };
  void camera;
  return api;
}
