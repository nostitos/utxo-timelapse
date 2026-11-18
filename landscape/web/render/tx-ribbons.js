// Transaction ribbons (ui/tx.js): the curves of a transaction view, drawn in the scene pass.
//
// Each curve arrives as cubic Bézier control points with a width in CSS pixels, a core colour and
// a casing colour. The strips are built on the CPU once per layout; the vertex shader turns each
// strip toward the camera and keeps its width in pixels at any distance, as the flash sprites keep
// their minimum size (terrain/flashes.js). Two meshes share the geometry, casings first, so every
// core lies over every casing, as the 2D explorer draws its lines. Transparent, no depth or
// G-buffer writes (render/gbuffer.js), after the flashes (render order 11).
import { Group, Mesh, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, MeshBasicNodeMaterial, DoubleSide } from 'three/webgpu';
import { attribute, positionGeometry, cameraPosition, modelWorldMatrix, uniform, vec3, vec4, normalize, cross, length, select } from 'three/tsl';
import { noGBufferWrites } from './gbuffer.js';

export const CASING_PX = 3;
const DASHES = 12;      // dashed curves: this many dashes
const PICK_SAMPLES = 9; // points per hoverable curve kept for picking

function bezier(p, t, out, o) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  const da = -3 * u * u, db = 3 * u * u - 6 * u * t, dc = 6 * u * t - 3 * t * t, dd = 3 * t * t;
  for (let i = 0; i < 3; i++) {
    out[o + i] = a * p[i] + b * p[3 + i] + c * p[6 + i] + d * p[9 + i];
    out[o + 3 + i] = da * p[i] + db * p[3 + i] + dc * p[6 + i] + dd * p[9 + i];
  }
}

export function createTxRibbons() {
  const hi = uniform(-1);          // highlighted curve id, -1 none
  const pxToWorld = uniform(0.001); // world units per CSS pixel at distance 1
  const group = new Group();
  group.name = 'TxRibbons';
  group.visible = false;

  function material(casing) {
    const m = new MeshBasicNodeMaterial();
    m.name = casing ? 'TxRibbonCasing' : 'TxRibbon';
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    const dir = attribute('aDir', 'vec4');   // tangent, side (-1 or 1)
    const info = attribute('aInfo', 'vec2'); // width (CSS px), curve id
    const color = attribute(casing ? 'aCase' : 'aCol', 'vec4');
    const lit = info.y.equal(hi);
    const dim = hi.greaterThanEqual(0).and(lit.not());
    const px = select(lit, info.x.mul(1.4).add(1.5), info.x).add(casing ? CASING_PX : 0);
    const toCam = cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz);
    const side = normalize(cross(dir.xyz, toCam).add(vec3(0, 1e-7, 0)));
    m.positionNode = positionGeometry.add(side.mul(dir.w.mul(px).mul(0.5).mul(length(toCam)).mul(pxToWorld)));
    m.colorNode = color.xyz;
    m.opacityNode = select(lit, color.w.max(casing ? 0.8 : 0.95), select(dim, color.w.mul(0.3), color.w));
    return noGBufferWrites(m);
  }
  const meshes = [true, false].map((casing, i) => {
    const mesh = new Mesh(new BufferGeometry(), material(casing));
    mesh.frustumCulled = false;
    mesh.renderOrder = 12 + i;
    group.add(mesh);
    return mesh;
  });
  let picks = new Float32Array(0);

  /**
   * curves: [{p: 12 control-point numbers, px, color: [r, g, b, a], casing: [r, g, b, a], id (>= 0:
   * hoverable, highlight(id) lights it), dash}]. Colours are linear.
   */
  function set(curves) {
    const pos = [], dirs = [], cols = [], cases = [], infos = [], index = [], pick = [];
    const pt = new Float64Array(6);
    for (const c of curves) {
      const p = c.p;
      let len = 0;
      for (let i = 0; i < 9; i += 3) len += Math.hypot(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
      const n = c.dash ? DASHES * 2 : Math.max(8, Math.min(32, Math.ceil(len / 2)));
      const strip = (t0, t1, steps) => {
        const first = pos.length / 3;
        for (let s = 0; s <= steps; s++) {
          bezier(p, t0 + ((t1 - t0) * s) / steps, pt, 0);
          const tl = Math.hypot(pt[3], pt[4], pt[5]) || 1;
          for (const side of [-1, 1]) {
            pos.push(pt[0], pt[1], pt[2]);
            dirs.push(pt[3] / tl, pt[4] / tl, pt[5] / tl, side);
            cols.push(...c.color);
            cases.push(...c.casing);
            infos.push(c.px, c.id ?? -1);
          }
          if (s < steps) {
            const k = first + s * 2;
            index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
          }
        }
      };
      if (c.dash) for (let d = 0; d < DASHES; d++) strip((2 * d) / n, (2 * d + 1) / n, 2);
      else strip(0, 1, n);
      if (c.id >= 0) {
        for (let s = 0; s < PICK_SAMPLES; s++) {
          bezier(p, s / (PICK_SAMPLES - 1), pt, 0);
          pick.push(c.id, pt[0], pt[1], pt[2]);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aDir', new Float32BufferAttribute(dirs, 4));
    g.setAttribute('aCol', new Float32BufferAttribute(cols, 4));
    g.setAttribute('aCase', new Float32BufferAttribute(cases, 4));
    g.setAttribute('aInfo', new Float32BufferAttribute(infos, 2));
    g.setIndex(new Uint32BufferAttribute(index, 1));
    const old = meshes[0].geometry;
    for (const m of meshes) m.geometry = g;
    old.dispose();
    picks = new Float32Array(pick);
    group.visible = index.length > 0;
  }

  return {
    object3d: group,
    set,
    /** Per frame: keeps widths in CSS pixels for this camera and canvas height. */
    update(camera, cssHeight) {
      pxToWorld.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, cssHeight);
    },
    /** Light one curve id and dim the rest; -1 or null restores them. */
    highlight(id) {
      hi.value = Number.isInteger(id) ? id : -1;
    },
    get highlighted() {
      return hi.value;
    },
    /** id, x, y, z of PICK_SAMPLES points along every hoverable curve. */
    get picks() {
      return picks;
    },
    get vertices() {
      return meshes[0].geometry.attributes.position ? meshes[0].geometry.attributes.position.count : 0;
    },
    clear() {
      set([]);
    },
    dispose() {
      group.removeFromParent();
      meshes[0].geometry.dispose();
      for (const m of meshes) m.material.dispose();
    },
  };
}
