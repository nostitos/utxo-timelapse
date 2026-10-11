// Plane mode readout (landscape/SPEC.md §8): one line at the top centre about the ground under
// the plane (the 64-block column, its UTC date and the row's amount) with a throttle bar that
// lights up while boosting, and a small circle where the plane's nose points (the crosshair
// at the screen centre is the aim).

import { Vector3 } from 'three';
import { forward, groundReadout } from './plane.js';

const NOSE_DISTANCE = 60;

export function createPlaneHud({ container, nose, camera, canvas, grid, rows, blocktimes }) {
  container.innerHTML = '<span class="ph-ground"></span><span class="ph-throttle" title="Throttle"><i></i></span>';
  const groundEl = container.querySelector('.ph-ground');
  const bar = container.querySelector('.ph-throttle i');
  const tmp = new Vector3();
  let lastKey = '';
  let lastWidth = '';

  function hide() {
    container.hidden = true;
    if (nose) nose.hidden = true;
    lastKey = '';
  }

  return {
    /** plane: ui/plane.js state or null; block: the replayed block. */
    update(plane, block) {
      if (!plane) {
        if (!container.hidden) hide();
        return;
      }
      container.hidden = false;
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
      if (!nose) return;
      const f = forward(plane.yaw, plane.pitch);
      tmp.set(plane.x + f.x * NOSE_DISTANCE, plane.y + f.y * NOSE_DISTANCE, plane.z + f.z * NOSE_DISTANCE).project(camera);
      const r = canvas.getBoundingClientRect();
      const visible = tmp.z > -1 && tmp.z < 1 && Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1;
      nose.hidden = !visible;
      if (visible) {
        const x = r.left + ((tmp.x + 1) / 2) * r.width;
        const y = r.top + ((1 - tmp.y) / 2) * r.height;
        nose.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      }
    },
    hide,
  };
}
