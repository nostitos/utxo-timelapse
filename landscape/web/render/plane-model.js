// Plane mode models (landscape/SPEC.md §8): the three Fun crafts flown by ui/plane.js, each a
// small procedural model built with a 0.8-unit wingspan and shown at its craft's modelScale.
// The plane (about 320 triangles, flown at 0.4 units, about six columns) spins its propeller;
// the bird (0.2 units) beats its hinged wings at flapRate and glides with them raised 8
// degrees below 0.15 throttle; the jet (0.48 units) has a delta wing, two canted fins, a tail
// lamp that brightens with the throttle and an afterburner cone while boosting. Only the
// flown craft is visible. They face -z like the camera, are lit like the terrain (node
// materials, so the post chain and shadows work on WebGPU and WebGL2) and cast a sun shadow
// (faint on the default, mostly self-lit cylinders; clear with a lower Emissive strength). A
// faint self-glow keeps them readable in the unlit Film preset. view.pick only tests the
// terrain, so a craft never blocks a pick.

import {
  Group, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, MeshStandardNodeMaterial,
} from 'three/webgpu';
import { CRAFTS, flapRate } from '../ui/plane.js';

const ORANGE = 0xf7931a;
const WHITE = 0xe8e4da;
const DARK = 0x1b2228;
const PROP = 0x2b2b2b;
const DEG = Math.PI / 180;
const FLAP = 30 * DEG; // wing beat amplitude
const GLIDE = 8 * DEG; // wings raised while gliding

function paint(color, { roughness = 0.55, metalness = 0.1, glow = 0.18 } = {}) {
  const m = new MeshStandardNodeMaterial({ color, roughness, metalness });
  m.emissive.set(color);
  m.emissiveIntensity = glow;
  return m;
}

function lamp(color, intensity = 4) {
  const m = new MeshStandardNodeMaterial({ color: 0x000000, roughness: 0.4 });
  m.emissive.set(color);
  m.emissiveIntensity = intensity;
  return m;
}

/** scene: the view's scene. Returns { object3d, update(plane, dt), dispose }. */
export function createPlaneModel({ scene }) {
  const root = new Group();
  root.name = 'craft';
  root.visible = false;
  root.rotation.order = 'YXZ';
  const geometries = [];
  const materials = [];
  const keep = (x, list) => (list.push(x), x);
  const add = (parent, geometry, material, x, y, z, { shadow = true } = {}) => {
    const mesh = new Mesh(keep(geometry, geometries), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  };
  const group = (id) => {
    const g = new Group();
    g.name = id;
    g.visible = false;
    g.scale.setScalar(CRAFTS[id].modelScale);
    root.add(g);
    return g;
  };
  const orange = keep(paint(ORANGE, { roughness: 0.45, metalness: 0.15 }), materials);
  const white = keep(paint(WHITE, { roughness: 0.6 }), materials);
  const dark = keep(paint(DARK, { roughness: 0.2, metalness: 0.4, glow: 0.05 }), materials);
  const prop = keep(paint(PROP, { glow: 0.05 }), materials);
  const red = keep(lamp(0xff3b30), materials);
  const green = keep(lamp(0x34e07a), materials);
  // Cylinders and cones are built along +y; rotateX(-90 deg) points their top at -z (the nose).
  const nose = (g) => g.rotateX(-Math.PI / 2);

  // ---- plane ----
  const plane = group('plane');
  add(plane, nose(new CylinderGeometry(0.058, 0.03, 0.5, 10)), orange, 0, 0, 0.01); // fuselage
  add(plane, nose(new CylinderGeometry(0.062, 0.058, 0.06, 10)), orange, 0, 0, -0.27); // cowling
  add(plane, nose(new ConeGeometry(0.03, 0.06, 10)), white, 0, 0, -0.33); // spinner
  const propeller = add(plane, new BoxGeometry(0.24, 0.018, 0.008), prop, 0, 0, -0.315);
  const canopy = add(plane, new SphereGeometry(0.05, 8, 5), dark, 0, 0.045, -0.08);
  canopy.scale.set(0.8, 0.65, 1.7);
  add(plane, new BoxGeometry(0.8, 0.014, 0.13), white, 0, -0.01, -0.08); // wings
  add(plane, new BoxGeometry(0.28, 0.01, 0.075), white, 0, 0.01, 0.22); // tailplane
  add(plane, new BoxGeometry(0.012, 0.11, 0.09), orange, 0, 0.06, 0.22); // fin
  // Navigation lights: red on the left (-x) wingtip, green on the right.
  add(plane, new SphereGeometry(0.016, 6, 4), red, -0.4, -0.01, -0.08, { shadow: false });
  add(plane, new SphereGeometry(0.016, 6, 4), green, 0.4, -0.01, -0.08, { shadow: false });

  // ---- bird ----
  const bird = group('bird');
  const plumage = keep(paint(0x3c4851, { roughness: 0.8, glow: 0.16 }), materials);
  const wingPaint = keep(paint(0x75848f, { roughness: 0.75, glow: 0.18 }), materials);
  const breastPaint = keep(paint(0xf1eee6, { roughness: 0.85, glow: 0.2 }), materials);
  const beakPaint = keep(paint(ORANGE, { roughness: 0.5, glow: 0.3 }), materials);
  const body = add(bird, new SphereGeometry(0.06, 12, 8), plumage, 0, 0, 0.02);
  body.scale.set(0.9, 0.8, 2.4);
  const breast = add(bird, new SphereGeometry(0.05, 10, 6), breastPaint, 0, -0.014, -0.05);
  breast.scale.set(0.85, 0.75, 1.6);
  add(bird, new SphereGeometry(0.042, 10, 8), plumage, 0, 0.026, -0.16); // head
  add(bird, nose(new ConeGeometry(0.014, 0.06, 8)), beakPaint, 0, 0.02, -0.218); // beak
  // A three-sided disc is a triangle; turned half round its point faces the body and it fans out behind.
  add(bird, new CylinderGeometry(0.09, 0.09, 0.008, 3).rotateY(Math.PI), plumage, 0, 0.004, 0.17); // tail fan
  // Wings hinge at the shoulders (pivot groups); rotation.z raises them (negative on the left).
  const wings = [-1, 1].map((side) => {
    const pivot = new Group();
    pivot.position.set(side * 0.04, 0.012, -0.03);
    bird.add(pivot);
    add(pivot, new BoxGeometry(0.36, 0.01, 0.11), wingPaint, side * 0.18, 0, 0);
    add(pivot, new BoxGeometry(0.12, 0.008, 0.07), breastPaint, side * 0.31, 0, 0.06); // pale wing tip feathers
    return { pivot, side };
  });
  const flap = { phase: 0, amp: FLAP, base: 0 };

  // ---- jet ----
  const jet = group('jet');
  const hull = keep(paint(0xd5d9dc, { roughness: 0.35, metalness: 0.45, glow: 0.14 }), materials);
  const tailLamp = keep(lamp(0xffb46b, 1), materials);
  const burner = keep(lamp(ORANGE, 6), materials);
  add(jet, nose(new CylinderGeometry(0.045, 0.055, 0.7, 12)), hull, 0, 0, 0.02); // fuselage
  add(jet, nose(new ConeGeometry(0.045, 0.18, 12)), hull, 0, 0, -0.42); // nose cone
  const jetCanopy = add(jet, new SphereGeometry(0.035, 8, 5), dark, 0, 0.042, -0.2);
  jetCanopy.scale.set(0.8, 0.7, 2.2);
  // Delta wing: a three-sided disc turned so one point faces forward; span 0.8, trailing edge at the tail.
  add(jet, new CylinderGeometry(0.462, 0.462, 0.012, 3).rotateY(Math.PI), hull, 0, -0.005, 0.12);
  for (const side of [-1, 1]) {
    const fin = add(jet, new BoxGeometry(0.01, 0.13, 0.12), orange, side * 0.05, 0.075, 0.29);
    fin.rotation.z = -side * 20 * DEG; // canted outward
  }
  add(jet, new SphereGeometry(0.016, 6, 4), red, -0.4, -0.005, 0.35, { shadow: false });
  add(jet, new SphereGeometry(0.016, 6, 4), green, 0.4, -0.005, 0.35, { shadow: false });
  add(jet, new SphereGeometry(0.03, 8, 6), tailLamp, 0, 0, 0.375, { shadow: false });
  // The afterburner cone points backward (+z) out of the tail.
  const afterburner = add(jet, new ConeGeometry(0.04, 0.22, 10).rotateX(Math.PI / 2), burner, 0, 0, 0.485, { shadow: false });
  afterburner.visible = false;

  const models = { plane, bird, jet };
  let shown = null;
  scene.add(root);

  return {
    object3d: root,
    /** plane: ui/plane.js state (angles in radians), or null to hide the model. */
    update(state, dt = 0) {
      root.visible = !!state;
      if (!state) return;
      const id = models[state.craft] ? state.craft : 'plane';
      if (id !== shown) {
        for (const [k, g] of Object.entries(models)) g.visible = k === id;
        shown = id;
      }
      const h = Math.min(Math.max(dt, 0), 0.1);
      root.position.set(state.x, state.y, state.z);
      // YXZ: heading, then pitch (nose up for pitch > 0), then roll (bank > 0 drops the right wing).
      root.rotation.set(state.pitch, state.yaw, -state.bank, 'YXZ');
      if (id === 'plane') {
        propeller.rotation.z += h * (30 + 3 * (state.speed || 0));
      } else if (id === 'bird') {
        const rate = flapRate(state.throttle, state.boosting);
        const ease = 1 - Math.exp(-6 * h);
        flap.amp += ((rate > 0 ? FLAP : 0) - flap.amp) * ease;
        flap.base += ((rate > 0 ? 0 : GLIDE) - flap.base) * ease;
        flap.phase = (flap.phase + 2 * Math.PI * rate * h) % (2 * Math.PI);
        const up = flap.base + flap.amp * Math.sin(flap.phase);
        for (const w of wings) w.pivot.rotation.z = w.side * up;
      } else {
        tailLamp.emissiveIntensity = 1 + 7 * Math.max(0, Math.min(1, state.throttle || 0));
        afterburner.visible = !!state.boosting;
        if (state.boosting) afterburner.scale.set(1, 1, 0.85 + 0.3 * Math.random());
      }
      root.updateMatrixWorld(true);
    },
    dispose() {
      scene.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
