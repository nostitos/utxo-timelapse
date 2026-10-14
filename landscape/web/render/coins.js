// Stack sats coins (landscape/SPEC.md §8): the coins of ui/stack-sats.js as upright Bitcoin
// orange discs (radius 0.22, 0.05 thick) with a white B-stroke glyph on both faces, spinning
// at 2 rad/s and bobbing 0.05 at 1 Hz. A new coin grows in and a collected or expired one
// shrinks out over STACK.fade. They cast no shadow (up to 60 are out at once). Ordinary lit node materials with a strong self-glow, so they
// read in every preset; view.pick only tests the terrain, so a coin never blocks a pick.

import { Group, Mesh, CylinderGeometry, MeshStandardNodeMaterial, CanvasTexture, SRGBColorSpace } from 'three/webgpu';
import { STACK } from '../ui/stack-sats.js';

const ORANGE = 0xf7931a;
const RADIUS = 0.22;
const THICK = 0.05;
const SPIN = 2; // rad/s
const BOB = 0.05;

/** The coin face: orange disc, a darker ring and the tilted B symbol; mirror for the back face. */
function faceTexture(mirror) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f7931a';
  g.fillRect(0, 0, size, size);
  g.lineWidth = 14;
  g.strokeStyle = '#c86f0c';
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
  g.stroke();
  g.save();
  g.translate(size / 2, size / 2);
  if (mirror) g.scale(-1, 1);
  g.rotate((14 * Math.PI) / 180);
  g.fillStyle = '#ffffff';
  g.font = 'bold 170px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('\u20bf', 0, 8);
  g.restore();
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** scene: the view's scene. Returns { object3d, update(game, dt), dispose }. */
export function createCoins({ scene }) {
  const root = new Group();
  root.name = 'coins';
  // Built along +y; rotateX(90 deg) stands the coin up with its faces toward +z and -z.
  const geometry = new CylinderGeometry(RADIUS, RADIUS, THICK, 40).rotateX(Math.PI / 2);
  const front = faceTexture(false);
  const back = faceTexture(true);
  const rim = new MeshStandardNodeMaterial({ color: 0xc87412, roughness: 0.35, metalness: 0.6 });
  rim.emissive.set(ORANGE);
  rim.emissiveIntensity = 0.8;
  const face = (map) => {
    const m = new MeshStandardNodeMaterial({ map, roughness: 0.35, metalness: 0.5 });
    m.emissive.set(0xffffff);
    m.emissiveMap = map;
    m.emissiveIntensity = 0.8;
    return m;
  };
  // CylinderGeometry groups: side, top cap (+y, turned to +z), bottom cap (-z).
  const materials = [rim, face(front), face(back)];
  const pool = [];
  scene.add(root);

  function meshAt(i) {
    while (pool.length <= i) {
      const m = new Mesh(geometry, materials);
      m.castShadow = false; // up to 60 coins: no shadow pass for them
      m.receiveShadow = false;
      m.visible = false;
      root.add(m);
      pool.push(m);
    }
    return pool[i];
  }

  return {
    object3d: root,
    /** game: ui/stack-sats.js state (coins and clock). */
    update(game) {
      const coins = game ? game.coins : [];
      const now = game ? game.clock : 0;
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        const m = meshAt(i);
        let s = Math.min(1, (now - c.born) / STACK.fade);
        if (c.gone != null) s = Math.min(s, Math.max(0, 1 - (now - c.gone) / STACK.fade));
        const k = s * s * (3 - 2 * s);
        m.visible = k > 0.001;
        m.scale.setScalar(Math.max(0.001, k) * (c.taken && c.gone != null ? 1 + 0.6 * (1 - k) : 1));
        m.position.set(c.x, c.y + BOB * Math.sin(2 * Math.PI * now + c.id * 1.7), c.z);
        m.rotation.set(0, SPIN * now + c.id * 0.9, 0);
      }
      for (let i = coins.length; i < pool.length; i++) pool[i].visible = false;
      root.visible = coins.length > 0;
    },
    dispose() {
      scene.remove(root);
      geometry.dispose();
      front.dispose();
      back.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
