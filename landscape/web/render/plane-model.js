// Plane mode model (landscape/SPEC.md §8): a small procedural propeller plane, about 320
// triangles with a 0.8-unit wingspan, flown by ui/plane.js. It faces -z like the camera, is
// lit like the terrain (node materials, so the post chain and shadows work on WebGPU and
// WebGL2) and casts a sun shadow (faint on the default, mostly self-lit coin stacks; clear
// with a lower Emissive strength). A faint self-glow keeps the plane readable in the unlit
// Film preset. view.pick only tests the terrain, so the plane never blocks a pick.

import {
  Group, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, MeshStandardNodeMaterial,
} from 'three/webgpu';

const ORANGE = 0xf7931a;
const WHITE = 0xe8e4da;
const DARK = 0x1b2228;
const PROP = 0x2b2b2b;

function paint(color, { roughness = 0.55, metalness = 0.1, glow = 0.18 } = {}) {
  const m = new MeshStandardNodeMaterial({ color, roughness, metalness });
  m.emissive.set(color);
  m.emissiveIntensity = glow;
  return m;
}

function lamp(color) {
  const m = new MeshStandardNodeMaterial({ color: 0x000000, roughness: 0.4 });
  m.emissive.set(color);
  m.emissiveIntensity = 4;
  return m;
}

/** scene: the view's scene. Returns { object3d, update(plane, dt), dispose }. */
export function createPlaneModel({ scene }) {
  const root = new Group();
  root.name = 'plane';
  root.visible = false;
  root.rotation.order = 'YXZ';
  const geometries = [];
  const materials = [];
  const keep = (x, list) => (list.push(x), x);
  const add = (geometry, material, x, y, z, { shadow = true } = {}) => {
    const mesh = new Mesh(keep(geometry, geometries), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    root.add(mesh);
    return mesh;
  };
  const orange = keep(paint(ORANGE, { roughness: 0.45, metalness: 0.15 }), materials);
  const white = keep(paint(WHITE, { roughness: 0.6 }), materials);
  const dark = keep(paint(DARK, { roughness: 0.2, metalness: 0.4, glow: 0.05 }), materials);
  const prop = keep(paint(PROP, { glow: 0.05 }), materials);
  const red = keep(lamp(0xff3b30), materials);
  const green = keep(lamp(0x34e07a), materials);

  // Cylinders and cones are built along +y; rotateX(-90 deg) points their top at -z (the nose).
  const nose = (g) => g.rotateX(-Math.PI / 2);
  add(nose(new CylinderGeometry(0.058, 0.03, 0.5, 10)), orange, 0, 0, 0.01); // fuselage
  add(nose(new CylinderGeometry(0.062, 0.058, 0.06, 10)), orange, 0, 0, -0.27); // cowling
  add(nose(new ConeGeometry(0.03, 0.06, 10)), white, 0, 0, -0.33); // spinner
  const propeller = add(new BoxGeometry(0.24, 0.018, 0.008), prop, 0, 0, -0.315);
  const canopy = add(new SphereGeometry(0.05, 8, 5), dark, 0, 0.045, -0.08);
  canopy.scale.set(0.8, 0.65, 1.7);
  add(new BoxGeometry(0.8, 0.014, 0.13), white, 0, -0.01, -0.08); // wings
  add(new BoxGeometry(0.28, 0.01, 0.075), white, 0, 0.01, 0.22); // tailplane
  add(new BoxGeometry(0.012, 0.11, 0.09), orange, 0, 0.06, 0.22); // fin
  // Navigation lights: red on the left (-x) wingtip, green on the right.
  add(new SphereGeometry(0.016, 6, 4), red, -0.4, -0.01, -0.08, { shadow: false });
  add(new SphereGeometry(0.016, 6, 4), green, 0.4, -0.01, -0.08, { shadow: false });
  scene.add(root);

  return {
    object3d: root,
    /** plane: ui/plane.js state (angles in radians), or null to hide the model. */
    update(plane, dt = 0) {
      root.visible = !!plane;
      if (!plane) return;
      root.position.set(plane.x, plane.y, plane.z);
      // YXZ: heading, then pitch (nose up for pitch > 0), then roll (bank > 0 drops the right wing).
      root.rotation.set(plane.pitch, plane.yaw, -plane.bank, 'YXZ');
      propeller.rotation.z += Math.min(Math.max(dt, 0), 0.1) * (30 + 3 * (plane.speed || 0));
      root.updateMatrixWorld(true);
    },
    dispose() {
      scene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
