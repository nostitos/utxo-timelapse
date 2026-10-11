// Plane mode readout (landscape/SPEC.md §8): one line at the top centre about the ground under
// the plane (the 64-block column, its UTC date and the row's amount) with a throttle bar that
// lights up while boosting and a stick indicator (where the stick is, mouse and keys
// together), a small circle where the plane's nose points (I inspects there), and the
// controls card that stays visible while flying.

import { Vector3 } from 'three';
import { forward, groundReadout, planeKeyRows } from './plane.js';

const NOSE_DISTANCE = 60;

export function createPlaneHud({ container, nose, keys = null, camera, canvas, grid, rows, blocktimes, settings = null, sound = null }) {
  if (!container) return { update() {}, hide() {}, noseClient: () => null };
  container.innerHTML = '<span class="ph-ground"></span><span class="ph-throttle" title="Throttle"><i></i></span>' +
    '<span class="ph-stick" title="Stick"><i></i></span>';
  const groundEl = container.querySelector('.ph-ground');
  const bar = container.querySelector('.ph-throttle i');
  const stickDot = container.querySelector('.ph-stick i');
  const tmp = new Vector3();
  let lastKey = '';
  let lastWidth = '';
  let lastStick = '';
  let keysKey = '';
  let noseAt = null;

  function renderKeys() {
    if (!keys) return;
    let invertY = false;
    try {
      invertY = !!(settings && settings.get('camera.invertY'));
    } catch {
      invertY = false;
    }
    const muted = !!(sound && sound.muted);
    const k = invertY + '|' + muted;
    if (k === keysKey) return;
    keysKey = k;
    keys.innerHTML = '<div class="pk-head"><span class="eyebrow">Plane</span></div><dl>' +
      planeKeyRows({ invertY, muted }).map(([a, b]) => '<div><dt>' + a + '</dt><dd>' + b + '</dd></div>').join('') + '</dl>';
  }

  function hide() {
    container.hidden = true;
    if (nose) nose.hidden = true;
    if (keys) keys.hidden = true;
    lastKey = '';
    noseAt = null;
  }

  return {
    /** plane: ui/plane.js state or null; block: the replayed block. */
    update(plane, block) {
      if (!plane) {
        if (!container.hidden) hide();
        return;
      }
      container.hidden = false;
      if (keys) {
        keys.hidden = false;
        renderKeys();
      }
      const col = Math.floor((plane.x * 1000) / (grid ? grid.blocksPerColumn : 64));
      const row = Math.floor(plane.z * 10);
      const key = col + '|' + row + '|' + (block ?? '');
      if (key !== lastKey) {
        lastKey = key;
        groundEl.textContent = groundReadout(plane.x, plane.z, { grid, rows, blocktimes, block });
      }
      const width = Math.round(Math.max(0, Math.min(1, plane.throttle)) * 100) + '%';
      if (width !== lastWidth) {
        lastWidth = width;
        bar.style.width = width;
      }
      container.classList.toggle('boost', !!plane.boosting);
      // Stick dot: right banks right; down is the stick pulled back (nose up by default).
      const stick = 'translate(' + (Math.max(-1, Math.min(1, plane.roll || 0)) * 9).toFixed(1) + 'px,' +
        (Math.max(-1, Math.min(1, plane.pull || 0)) * 9).toFixed(1) + 'px)';
      if (stick !== lastStick) {
        lastStick = stick;
        stickDot.style.transform = stick;
      }
      if (!nose) return;
      const f = forward(plane.yaw, plane.pitch);
      tmp.set(plane.x + f.x * NOSE_DISTANCE, plane.y + f.y * NOSE_DISTANCE, plane.z + f.z * NOSE_DISTANCE).project(camera);
      const r = canvas.getBoundingClientRect();
      const visible = tmp.z > -1 && tmp.z < 1 && Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1;
      nose.hidden = !visible;
      noseAt = null;
      if (visible) {
        const x = r.left + ((tmp.x + 1) / 2) * r.width;
        const y = r.top + ((1 - tmp.y) / 2) * r.height;
        nose.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
        noseAt = { x, y };
      }
    },
    hide,
    /** Client point of the nose circle while it is on screen, else null. */
    noseClient: () => noseAt,
  };
}
