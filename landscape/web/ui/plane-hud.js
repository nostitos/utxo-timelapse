// Plane mode readout (landscape/SPEC.md §8): one line at the top centre about the ground under
// the plane (the 64-block column, its UTC date and the row's amount) with a throttle bar that
// lights up while boosting and a stick indicator (where the stick is, mouse and keys
// together), a small circle where the plane's nose points (I inspects there), and the
// controls card, titled with the craft, that stays visible while flying. During a Stack sats
// run the line starts with the time left, the stack and the coins, and each collected coin
// pops its value under the line (pops: #funpops).

import { Vector3 } from 'three';
import { forward, groundReadout, planeKeyRows, craftSpec } from './plane.js';
import { fmtStack, timeLeft } from './stack-sats.js';

const NOSE_DISTANCE = 60;
const POP_MS = 800;

export function createPlaneHud({ container, nose, keys = null, pops = null, camera, canvas, grid, rows, blocktimes, settings = null, sound = null }) {
  if (!container) return { update() {}, hide() {}, pop() {}, noseClient: () => null };
  container.innerHTML = '<span class="ph-game" hidden></span><span class="ph-ground"></span><span class="ph-throttle" title="Throttle"><i></i></span>' +
    '<span class="ph-stick" title="Stick"><i></i></span>';
  const gameEl = container.querySelector('.ph-game');
  const groundEl = container.querySelector('.ph-ground');
  const bar = container.querySelector('.ph-throttle i');
  const stickDot = container.querySelector('.ph-stick i');
  const tmp = new Vector3();
  let lastKey = '';
  let lastWidth = '';
  let lastStick = '';
  let keysKey = '';
  let lastGame = '';
  let noseAt = null;

  function invertYSetting() {
    try {
      return !!(settings && settings.get('camera.invertY'));
    } catch {
      return false;
    }
  }

  function renderKeys(craft, running) {
    if (!keys) return;
    const invertY = invertYSetting();
    const muted = !!(sound && sound.muted);
    const k = invertY + '|' + muted + '|' + craft + '|' + running;
    if (k === keysKey) return;
    keysKey = k;
    keys.innerHTML = '<div class="pk-head"><span class="eyebrow">' + craftSpec(craft).name + '</span></div><dl>' +
      planeKeyRows({ invertY, muted, craft, running }).map(([a, b]) => '<div><dt>' + a + '</dt><dd>' + b + '</dd></div>').join('') + '</dl>';
  }

  function hide() {
    container.hidden = true;
    if (nose) nose.hidden = true;
    if (keys) keys.hidden = true;
    if (pops) pops.textContent = '';
    lastKey = '';
    lastGame = '';
    gameEl.hidden = true;
    noseAt = null;
  }

  return {
    /** plane: ui/plane.js state or null; block: the replayed block; game: ui/stack-sats.js state. */
    update(plane, block, game = null) {
      if (!plane) {
        if (!container.hidden) hide();
        return;
      }
      container.hidden = false;
      const running = !!(game && game.running);
      if (keys) {
        keys.hidden = false;
        renderKeys(plane.craft || 'plane', running);
      }
      const g = running ? 'Stack sats \u00b7 ' + timeLeft(game) + ' \u00b7 ' + fmtStack(game.score) + ' \u00b7 ' +
        game.collected + (game.collected === 1 ? ' coin' : ' coins') : '';
      if (g !== lastGame) {
        lastGame = g;
        gameEl.textContent = g;
        gameEl.hidden = !g;
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
      // Stick dot where the stick is pushed: right banks right; up raises the nose (with Invert Y,
      // down, the stick pulled back, raises it).
      const up = invertYSetting() ? 1 : -1;
      const stick = 'translate(' + (Math.max(-1, Math.min(1, plane.roll || 0)) * 9).toFixed(1) + 'px,' +
        (up * Math.max(-1, Math.min(1, plane.pull || 0)) * 9).toFixed(1) + 'px)';
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
    /** Show a collected coin's value (for example +50 BTC) under the line for POP_MS. */
    pop(textValue) {
      if (!pops) return;
      const el = document.createElement('span');
      el.className = 'ph-pop';
      el.textContent = textValue;
      pops.appendChild(el);
      setTimeout(() => el.remove(), POP_MS + 50);
      while (pops.childElementCount > 4) pops.firstElementChild.remove();
    },
    /** Client point of the nose circle while it is on screen, else null. */
    noseClient: () => noseAt,
  };
}
