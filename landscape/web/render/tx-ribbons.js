// Transaction ribbons (ui/tx.js): the curves of a transaction view, drawn in the scene pass.
//
// Each curve arrives as cubic Bézier control points with a width in CSS pixels, a core colour and
// a casing colour. The strips are built on the CPU once per layout; the vertex shader turns each
// strip toward the camera and keeps its width in pixels at any distance, as the flash sprites keep
// their minimum size (terrain/flashes.js). Two meshes share the geometry, casings first, so every
// core lies over every casing, as the 2D explorer draws its lines. Transparent, no depth or
// G-buffer writes (render/gbuffer.js), after the flashes (render order 11).
//
// A curve may carry a stretch of the transaction's path (inputs 0 to 0.45, the bridge to 0.55,
// outputs to 1): pulse(front) brightens the curves where the path passes front, so value flows
// from the coins spent to the coins made. A hollow curve keeps only the edges of its core.
import { Group, Mesh, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, MeshBasicNodeMaterial, DoubleSide } from 'three/webgpu';
import { attribute, positionGeometry, cameraPosition, modelWorldMatrix, uniform, vec3, vec4, normalize, cross, length, select, exp, abs } from 'three/tsl';
import { noGBufferWrites } from './gbuffer.js';

const CASING_PX = 3;
const PULSE_WIDTH = 0.05; // of the path: the bright band's half-width
const DASHES = 12;      // dashed curves: this many dashes
const PICK_SAMPLES = 9; // points per hoverable curve kept for picking
const FADE = 0.5;       // fading curves: the share of their length, from the open end, that fades in
const FADE_FLOOR = 0.2; // and their opacity at the open end, so the line still reaches its label

const ease = (s) => s * s * (3 - 2 * s);

// A width in CSS px, or [start, middle, end] eased along the curve so it never steps.
function widthAt(px, t) {
  if (!Array.isArray(px)) return px;
  const [a, b, s] = t < 0.5 ? [px[0], px[1], 2 * t] : [px[1], px[2], 2 * t - 1];
  return a + (b - a) * ease(s);
}

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
  const front = uniform(-9);        // pulse position along the path; far outside 0..1 when off
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
    const info = attribute('aInfo', 'vec4'); // width (CSS px), curve id, path (-1: none), hollow (0 or 1)
    const color = attribute(casing ? 'aCase' : 'aCol', 'vec4');
    // Curves without an id (bridge, stub) are never the highlighted one, even when hi is -1.
    const lit = info.y.equal(hi).and(hi.greaterThanEqual(0));
    const dim = hi.greaterThanEqual(0).and(lit.not());
    const px = select(lit, info.x.mul(1.4).add(1.5), info.x).add(casing ? CASING_PX : 0);
    const toCam = cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz);
    const side = normalize(cross(dir.xyz, toCam).add(vec3(0, 1e-7, 0)));
    m.positionNode = positionGeometry.add(side.mul(dir.w.mul(px).mul(0.5).mul(length(toCam)).mul(pxToWorld)));
    const glow = select(info.z.greaterThanEqual(0), exp(info.z.sub(front).div(PULSE_WIDTH).pow(2).negate()), 0);
    const base = select(lit, color.w.max(casing ? 0.8 : 0.95), select(dim, color.w.mul(0.3), color.w));
    if (casing) {
      m.colorNode = color.xyz;
      m.opacityNode = base;
    } else {
      // dir.w runs from -1 to 1 across the strip, so a hollow core keeps its outer fifths.
      const hollow = info.w.greaterThan(0.5).and(abs(dir.w).lessThan(0.6));
      m.colorNode = color.xyz.add(vec3(glow.mul(1.6)));
      m.opacityNode = select(hollow, base.mul(0.1), base.add(glow.mul(0.6)).min(1));
    }
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
   * curves: [{p: 12 control-point numbers, px (or [start, middle, end]), color: [r, g, b, a],
   * casing: [r, g, b, a], id (>= 0: hoverable, highlight(id) lights it), dash, path: [from, to] of
   * the pulse path or null, hollow, fade: faint at the start, full by FADE}]. Colours are linear.
   */
  function set(curves) {
    const pos = [], dirs = [], cols = [], cases = [], infos = [], index = [], pick = [];
    const pt = new Float64Array(6);
    for (const c of curves) {
      const p = c.p;
      let len = 0;
      for (let i = 0; i < 9; i += 3) len += Math.hypot(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
      const n = c.dash ? DASHES * 2 : Math.max(16, Math.min(48, Math.ceil(len)));
      const path = (t) => (c.path ? c.path[0] + (c.path[1] - c.path[0]) * t : -1);
      const strip = (t0, t1, steps) => {
        const first = pos.length / 3;
        for (let s = 0; s <= steps; s++) {
          const t = t0 + ((t1 - t0) * s) / steps;
          bezier(p, t, pt, 0);
          const tl = Math.hypot(pt[3], pt[4], pt[5]) || 1;
          const f = c.fade ? FADE_FLOOR + (1 - FADE_FLOOR) * ease(Math.min(1, t / FADE)) : 1;
          for (const side of [-1, 1]) {
            pos.push(pt[0], pt[1], pt[2]);
            dirs.push(pt[3] / tl, pt[4] / tl, pt[5] / tl, side);
            cols.push(c.color[0], c.color[1], c.color[2], c.color[3] * f);
            cases.push(c.casing[0], c.casing[1], c.casing[2], c.casing[3] * f);
            infos.push(widthAt(c.px, t), c.id ?? -1, path(t), c.hollow ? 1 : 0);
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
    g.setAttribute('aInfo', new Float32BufferAttribute(infos, 4));
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
    /** The pulse's position along the path (0: the coins spent, 1: the coins made); null ends it. */
    pulse(at) {
      front.value = Number.isFinite(at) ? at : -9;
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
