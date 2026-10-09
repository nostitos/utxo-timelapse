// Heightfield patches for the landscape terrain (landscape/SPEC.md §6).
//
// One instanced patch geometry covers 64 x 64 cells of a tile; every drawn patch is an
// instance with per-instance tile data. The vertex stage reads cell values from the atlas
// and applies the height curve; the fragment stage looks up the exact cell colour.
//
// Smooth mode: vertices on cell centres (u = 0..64 per patch, the last one on the next
// patch's first cell), optional subdivision 2/4 with nearest/bilinear/bicubic smoothing.
// Stepped mode: two vertices per cell edge give flat cell tops joined by vertical walls.
// Skirts hang from every patch edge to hide cracks between levels.
import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute, Float32BufferAttribute,
  Mesh, MeshStandardNodeMaterial, DynamicDrawUsage,
} from 'three/webgpu';
import {
  Fn, float, int, vec2, vec3, vec4, floor, min, max, clamp, select, normalize, varying, varyingProperty,
  positionGeometry, positionLocal, positionPrevious, instancedBufferAttribute, transformNormalToView,
  normalView, normalWorldGeometry, positionWorld,
} from 'three/tsl';
import { PATCH_CELLS } from './lod.js';

export const MAX_PATCH_INSTANCES = 400 * 16;

/** Material that keeps velocity correct for displaced vertices (previous = current). */
export class TerrainNodeMaterial extends MeshStandardNodeMaterial {
  static get type() {
    return 'TerrainNodeMaterial';
  }
  setupPosition(builder) {
    const p = super.setupPosition(builder);
    if (builder.needsPreviousData()) positionPrevious.assign(positionLocal);
    return p;
  }
}

/** Per-instance attribute arrays (shared by all geometry variants). */
export function createPatchInstances(capacity = MAX_PATCH_INSTANCES) {
  const make = () => {
    const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    a.setUsage(DynamicDrawUsage);
    return a;
  };
  return { capacity, a: make(), b: make(), c: make(), d: make(), count: 0 };
}

/** Patch geometry. position = (gx, skirt flag, gz) with gx/gz vertex indices. */
export function buildPatchGeometry({ sub = 1, stepped = false, cells = PATCH_CELLS }) {
  const n = stepped ? 2 * cells + 1 : cells * sub + 1;
  const surface = n * n;
  const ring = 4 * n;
  const pos = new Float32Array((surface + ring) * 3);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pos[k++] = i;
      pos[k++] = 0;
      pos[k++] = j;
    }
  }
  // Skirt ring: copies of the four edges with the skirt flag set.
  const edge = [];
  const sideStart = [];
  for (let s = 0; s < 4; s++) {
    sideStart.push(surface + s * n);
    for (let t = 0; t < n; t++) {
      let i;
      let j;
      if (s === 0) { i = 0; j = t; } // x min
      else if (s === 1) { i = n - 1; j = t; } // x max
      else if (s === 2) { i = t; j = 0; } // z min
      else { i = t; j = n - 1; } // z max
      edge.push(j * n + i);
      pos[k++] = i;
      pos[k++] = 1;
      pos[k++] = j;
    }
  }
  const quads = (n - 1) * (n - 1) + 4 * (n - 1);
  const index = new Uint32Array(quads * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = j * n + i + 1;
      const c = (j + 1) * n + i;
      const d = (j + 1) * n + i + 1;
      index[q++] = a; index[q++] = c; index[q++] = b;
      index[q++] = b; index[q++] = c; index[q++] = d;
    }
  }
  for (let s = 0; s < 4; s++) {
    for (let t = 0; t < n - 1; t++) {
      const e0 = edge[s * n + t];
      const e1 = edge[s * n + t + 1];
      const s0 = sideStart[s] + t;
      const s1 = sideStart[s] + t + 1;
      // Outward winding: x min and z max share one orientation, x max and z min the other.
      if (s === 0 || s === 3) {
        index[q++] = e0; index[q++] = s0; index[q++] = e1;
        index[q++] = e1; index[q++] = s0; index[q++] = s1;
      } else {
        index[q++] = e0; index[q++] = e1; index[q++] = s0;
        index[q++] = e1; index[q++] = s1; index[q++] = s0;
      }
    }
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  if (!stepped) {
    const nrm = new Float32Array((surface + ring) * 3);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  }
  g.setIndex(new BufferAttribute(index, 1));
  g.instanceCount = 0;
  g.userData = { sub, stepped, n, triangles: quads * 2 };
  return g;
}

/**
 * Builds the terrain material for a mode.
 * mode: {stepped, sub, smoothing: 'none'|'bilinear'|'bicubic'}
 */
export function buildTerrainMaterial({ atlas, shading, instances, mode }) {
  const U = shading.uniforms;
  const I0 = int(0);
  const I1 = int(1);
  const I256 = int(256);
  const iA = instancedBufferAttribute(instances.a); // slot, local col0, local row0, rowScale (2^rowShift)
  const iB = instancedBufferAttribute(instances.b); // tile col0, tile row0, cell width, cell depth (world)
  const iC = instancedBufferAttribute(instances.c); // tile id, tilesX, tx, ty
  const iD = instancedBufferAttribute(instances.d); // tilesY, level, tile cols, tile rows (cells inside the grid)
  const sub = mode.stepped ? 1 : mode.sub;

  // Cell fetch within the own slot (local coordinates clamped to the border, -1..256).
  const fetchOwn = (slot, ix, iy) => atlas.fetch(slot, clamp(ix, int(-1), I256).add(I1), clamp(iy, int(-1), I256).add(I1));
  // Cell fetch that may reach one cell beyond the +x/+z border (257): neighbour via page table.
  const fetchAny = (slot, ix, iy) => {
    const tileIdN = int(iC.x);
    const tilesX = int(iC.y);
    const tx = int(iC.z);
    const ty = int(iC.w);
    const tilesY = int(iD.x);
    const ox = ix.greaterThan(I256);
    const oy = iy.greaterThan(I256);
    const dx = select(ox, I1, I0);
    const dy = select(oy, I1, I0);
    const valid = ox.or(oy).and(tx.add(dx).lessThan(tilesX)).and(ty.add(dy).lessThan(tilesY));
    const nid = clamp(tileIdN.add(dx).add(dy.mul(tilesX)), I0, int(atlas.grid.tiles - 1));
    const ps = select(valid, int(atlas.page(nid)), int(-1));
    const useN = ps.greaterThanEqual(I0);
    const s = select(useN, ps, slot);
    const sx = select(useN, ix.sub(dx.mul(I256)).add(I1), min(ix, I256).add(I1));
    const sy = select(useN, iy.sub(dy.mul(I256)).add(I1), min(iy, I256).add(I1));
    return atlas.fetch(s, sx, sy);
  };

  const material = new TerrainNodeMaterial();
  material.name = 'TerrainMaterial';
  material.fog = true;
  material.flatShading = !!mode.stepped;

  const vCell = varyingProperty('vec2', 'vTerrainCell');
  const vNormal = varyingProperty('vec3', 'vTerrainNormal');

  // ---- vertex (one graph; writes the varyings as side effects) ---------------------------
  material.positionNode = Fn(() => {
    const slot = int(iA.x);
    const lc0 = iA.y;
    const lr0 = iA.z;
    const rowScale = iA.w;
    const tc0 = iB.x;
    const tr0 = iB.y;
    const cw = iB.z;
    const ch = iB.w;
    const gx = positionGeometry.x;
    const gz = positionGeometry.z;
    const colsT = iD.z;
    const rowsT = iD.w;
    const isSkirt = positionGeometry.y.greaterThan(0.5).and(U.skirt.greaterThan(0.5));
    const H = (ix, iy, any = false) => {
      const raw = any ? fetchAny(slot, ix, iy) : fetchOwn(slot, ix, iy);
      return shading.heightOf(raw.x, tr0.add(float(iy)).mul(rowScale)).toVar();
    };
    let height;
    let px;
    let pz;
    if (mode.stepped) {
      // Cell boundaries clamp to the grid edge; the cell just outside reads 0, closing the
      // last prism with a wall.
      const bx = min(floor(gx.add(1).mul(0.5)), colsT.sub(lc0));
      const bz = min(floor(gz.add(1).mul(0.5)), rowsT.sub(lr0));
      const cx = min(floor(gx.mul(0.5)), colsT.sub(lc0));
      const cz = min(floor(gz.mul(0.5)), rowsT.sub(lr0));
      height = H(int(lc0.add(cx)), int(lr0.add(cz)));
      px = tc0.add(lc0).add(bx).mul(cw);
      pz = tr0.add(lr0).add(bz).mul(ch);
      vCell.assign(vec2(lc0.add(bx), lr0.add(bz)));
    } else {
      // Vertices beyond the grid edge collapse onto it (no ground strip past the landscape).
      const uu = min(lc0.add(gx.div(sub)), colsT.sub(0.5));
      const vv = min(lr0.add(gz.div(sub)), rowsT.sub(0.5));
      px = tc0.add(uu).add(0.5).mul(cw);
      pz = tr0.add(vv).add(0.5).mul(ch);
      vCell.assign(vec2(uu.add(0.5), vv.add(0.5)));
      let dhdu;
      let dhdv;
      if (sub === 1) {
        const ci = int(uu);
        const cj = int(vv);
        height = H(ci, cj);
        dhdu = H(ci.add(I1), cj, true).sub(H(ci.sub(I1), cj)).mul(0.5);
        dhdv = H(ci, cj.add(I1), true).sub(H(ci, cj.sub(I1))).mul(0.5);
      } else {
        const i0 = int(min(floor(uu), 255));
        const j0 = int(min(floor(vv), 255));
        const fx = uu.sub(float(i0));
        const fy = vv.sub(float(j0));
        const h = [];
        for (let b = -1; b <= 2; b++) {
          const rowH = [];
          for (let a = -1; a <= 2; a++) {
            const corner = (a === -1 || a === 2) && (b === -1 || b === 2);
            if (mode.smoothing !== 'bicubic' && corner) {
              rowH.push(null); // corners are not needed by central differences
              continue;
            }
            rowH.push(H(i0.add(int(a)), j0.add(int(b)), a === 2 || b === 2));
          }
          h.push(rowH);
        }
        const at = (a, b) => h[b + 1][a + 1];
        const gU = (a, b) => at(a + 1, b).sub(at(a - 1, b)).mul(0.5);
        const gV = (a, b) => at(a, b + 1).sub(at(a, b - 1)).mul(0.5);
        if (mode.smoothing === 'bicubic') {
          const w = (t) => {
            const t2 = t.mul(t);
            const t3 = t2.mul(t);
            return [
              t3.negate().add(t2.mul(2)).sub(t).mul(0.5),
              t3.mul(3).sub(t2.mul(5)).add(2).mul(0.5),
              t3.mul(-3).add(t2.mul(4)).add(t).mul(0.5),
              t3.sub(t2).mul(0.5),
            ];
          };
          const dw = (t) => {
            const t2 = t.mul(t);
            return [
              t2.mul(-3).add(t.mul(4)).sub(1).mul(0.5),
              t2.mul(9).sub(t.mul(10)).mul(0.5),
              t2.mul(-9).add(t.mul(8)).add(1).mul(0.5),
              t2.mul(3).sub(t.mul(2)).mul(0.5),
            ];
          };
          const wx = w(fx);
          const wy = w(fy);
          const dwx = dw(fx);
          const dwy = dw(fy);
          let hh = float(0);
          let hu = float(0);
          let hv = float(0);
          for (let b = 0; b < 4; b++) {
            let rx = float(0);
            let rdx = float(0);
            for (let a = 0; a < 4; a++) {
              rx = rx.add(h[b][a].mul(wx[a]));
              rdx = rdx.add(h[b][a].mul(dwx[a]));
            }
            hh = hh.add(rx.mul(wy[b]));
            hu = hu.add(rdx.mul(wy[b]));
            hv = hv.add(rx.mul(dwy[b]));
          }
          height = max(hh, 0);
          dhdu = hu;
          dhdv = hv;
        } else if (mode.smoothing === 'bilinear') {
          const lerp2 = (v00, v10, v01, v11) => v00.mul(float(1).sub(fx)).add(v10.mul(fx)).mul(float(1).sub(fy))
            .add(v01.mul(float(1).sub(fx)).add(v11.mul(fx)).mul(fy));
          height = lerp2(at(0, 0), at(1, 0), at(0, 1), at(1, 1));
          dhdu = lerp2(gU(0, 0), gU(1, 0), gU(0, 1), gU(1, 1));
          dhdv = lerp2(gV(0, 0), gV(1, 0), gV(0, 1), gV(1, 1));
        } else {
          // nearest cell centre (terraced)
          const sx = fx.greaterThanEqual(0.5);
          const sz = fy.greaterThanEqual(0.5);
          const pick = (f) => select(sz, select(sx, f(1, 1), f(0, 1)), select(sx, f(1, 0), f(0, 0)));
          height = pick(at);
          dhdu = pick(gU);
          dhdv = pick(gV);
        }
      }
      vNormal.assign(normalize(vec3(dhdu.div(cw).negate(), 1, dhdv.div(ch).negate())));
    }
    const py = select(isSkirt, U.skirtDepth.negate(), height);
    return vec3(px, py, pz);
  })();

  const vInfo = varying(vec4(iA.x, iB.y, iA.w, iD.y), 'vTerrainInfo');
  vInfo.setInterpolation('flat');
  if (!mode.stepped) material.normalNode = transformNormalToView(normalize(vNormal));

  // ---- fragment (shared nodes so colour and emissive evaluate the cell once) -------------
  const slotF = int(vInfo.x);
  const tr0F = vInfo.y;
  const rowScaleF = vInfo.z;
  let raw;
  let cy;
  let heat;
  if (mode.stepped) {
    // Exact: one palette colour per cell (walls take the taller neighbour's cell).
    const c = vCell.sub(normalWorldGeometry.xz.mul(0.01));
    const cx = clamp(int(floor(c.x)), int(-1), I256).toVar();
    cy = clamp(int(floor(c.y)), int(-1), I256).toVar();
    raw = atlas.fetch(slotF, cx.add(I1), cy.add(I1)).toVar();
    heat = shading.heatEmissive(raw.y, raw.z, positionWorld.x);
  } else {
    // Smooth surfaces: bilinear colour value between cell centres, so slopes around isolated
    // cells keep their palette colour instead of the ground colour. Heat blends the final
    // flash brightness of the four cells, so a single spent cell flashes at full strength
    // at its centre instead of being diluted by its cold neighbours.
    const f = vCell.sub(0.5);
    const fx0 = floor(f.x);
    const fy0 = floor(f.y);
    const tx = f.x.sub(fx0);
    const ty = f.y.sub(fy0);
    const x0 = clamp(int(fx0), int(-1), I256).toVar();
    const y0 = clamp(int(fy0), int(-1), I256).toVar();
    const x1 = min(x0.add(I1), I256);
    const y1 = min(y0.add(I1), I256);
    const c00 = atlas.fetch(slotF, x0.add(I1), y0.add(I1)).toVar();
    const c10 = atlas.fetch(slotF, x1.add(I1), y0.add(I1)).toVar();
    const c01 = atlas.fetch(slotF, x0.add(I1), y1.add(I1)).toVar();
    const c11 = atlas.fetch(slotF, x1.add(I1), y1.add(I1)).toVar();
    const lerp2 = (a, b, c, d) => a.mul(float(1).sub(tx)).add(b.mul(tx)).mul(float(1).sub(ty))
      .add(c.mul(float(1).sub(tx)).add(d.mul(tx)).mul(ty));
    raw = lerp2(c00, c10, c01, c11).toVar();
    const hi = (cc) => shading.heatIntensity(cc.y, cc.z, positionWorld.x);
    heat = shading.heatEmissiveOf(lerp2(hi(c00), hi(c10), hi(c01), hi(c11)));
    cy = select(ty.lessThan(0.5), y0, y1).toVar();
  }
  const l0row = tr0F.add(float(cy)).mul(rowScaleF);
  const col = shading.cellColor(raw.w, l0row).toVar();
  const wp = positionWorld;
  const occupied = select(raw.w.greaterThan(0), float(1), float(0));
  const glow = shading.edgeGlow(wp.x).mul(occupied);
  const gridI = shading.gridLines(wp.x, wp.z);
  const emissive = col.mul(U.emissive).add(col.mul(glow)).add(heat).add(shading.rimTerm(normalView).mul(occupied))
    .add(U.gridColor.mul(gridI));
  material.colorNode = vec4(col.mul(U.albedo), 1);
  material.emissiveNode = emissive;
  material.roughnessNode = U.roughness;
  material.metalnessNode = U.metalness;
  if (mode.columns) {
    // Column mode: hide the heightfield where the columns stand (L0 cell centres inside the
    // focus circle, on resident L0 tiles). The same test selects the columns.
    const cf = U.columnFocus;
    const L0 = atlas.grid.levels[0];
    const l0c = clamp(floor(wp.x.div(0.064)), 0, L0.columns - 1);
    const l0r = clamp(floor(wp.z.div(0.1)), 0, L0.rows - 1);
    const dx = l0c.add(0.5).mul(0.064).sub(cf.x);
    const dz = l0r.add(0.5).mul(0.1).sub(cf.y);
    const inside = dx.mul(dx).add(dz.mul(dz)).lessThan(cf.z.mul(cf.z));
    const tid = int(l0r).div(I256).mul(int(L0.tilesX)).add(int(l0c).div(I256)).add(int(L0.firstTile));
    const resident = atlas.page(tid).greaterThanEqual(0);
    material.maskNode = inside.and(resident).not();
  }
  material.userData.mode = { ...mode };
  return material;
}

export function createHeightfieldMesh(geometry, material) {
  const mesh = new Mesh(geometry, material);
  mesh.name = 'TerrainHeightfield';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
