// Camera navigation (landscape/SPEC.md §8): map mode, flight mode and plane mode.
//
// The camera pose is a position plus yaw and pitch (no roll); yaw 0 looks toward -z,
// pitch < 0 looks down. Map mode expresses every gesture as a rigid move of that pose:
//   left-drag      pan; the grabbed terrain point stays under the cursor
//   right/Shift    orbit around the terrain point under the cursor
//   wheel          zoom toward the point under the cursor
//   double-click   fly to the clicked point
//   arrows pan, Q/E rotate and PageUp/PageDown tilt around the screen centre
// Touch (gesture maths in ui/touch.js): one finger pans; two fingers pinch, twist and pan
// together about the point between them, or tilt when both move up or down; a tap
// inspects, a double tap flies closer (double tap and drag zooms), a two-finger tap zooms out.
// Flight mode (F): pointer lock and mouse look (drag to look when the lock is refused),
// WASD, E/Q up/down, Shift 4x, wheel sets speed, speed scales with height above the
// terrain, and collision keeps the camera above the surface. On touch, one finger looks
// and two fingers fly (spread to go forward, drag to slide or climb).
// Plane mode (T or the Fun menu, desktop only): the chosen craft (plane, bird or jet; setCraft,
// also in flight) flies on from the view centre (ui/plane.js) and flies like a plane: the
// mouse is a stick that springs back to the centre, sideways banks and the bank turns, back
// raises the nose (A/D and the left/right arrows bank, the down and up arrows pitch), W/S set
// the throttle, Shift boosts, the wheel sets the chase distance (kept per craft). The chase
// camera swings after the craft. Esc, losing the pointer lock or T again returns to map mode
// where the camera is; releaseLock() frees the cursor without landing (the Stack sats end
// card). A standard gamepad also works: left stick banks and pitches, RT/LT throttle, A boost,
// Start takes off or lands, B lands, Y and X call onPad('craft') and onPad('game').
// Follow tip (ui/follow.js) moves map and flight mode along x with shiftX, carrying the
// points a gesture or animation in progress is anchored to.

import { Vector3, Quaternion, Euler } from 'three';
import { TAP_SLOP_PX, TAP_MAX_MS, DOUBLE_TAP_MS, pairOf, pairDelta, classifyTwoFinger, createTapTracker } from './touch.js';
import { CRAFTS, craftSpec, createPlane, switchCraft, stepPlane, stickByMouse, chasePose, shakeOffset, gamepadInput } from './plane.js';

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const MIN_CLEARANCE = 0.03;
const FLIGHT_CLEARANCE = 0.08;
const MIN_DIST = 0.05;
const MAX_DIST = 4000;
const CLICK_PX = 5;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'ShiftLeft', 'ShiftRight']);
const MODES = ['map', 'flight', 'plane'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const capture = (el, id) => {
  try {
    el.setPointerCapture(id);
  } catch {
    /* not an active pointer (synthetic event); the gesture still works without capture */
  }
};
const wrap = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};
const shortest = (from, to) => wrap(to - from);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes(type);
  }
  return !!el.isContentEditable;
}

/** Unit view direction for a yaw/pitch pair. */
export function forwardOf(yaw, pitch, out = new Vector3()) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/**
 * extent ({minX, maxX, minZ, maxZ}, world units) is the landscape's ground rectangle. Points
 * that miss the terrain are kept within it, so gestures over empty background or the sky
 * move the camera at the landscape's scale. canFly = false refuses plane mode (touch-only
 * devices, which have no keys or mouse to steer it). onPad(action) receives the gamepad's
 * 'craft' (Y) and, in plane mode, 'game' (X) presses.
 */
export function createControls({ view, canvas, settings, onInspect, onModeChange, onNotice, onPad, bounds, extent, canFly = true } = {}) {
  const camera = view.camera;
  const lim = Object.assign({ minX: -400, maxX: 1400, minZ: -400, maxZ: 650, maxY: 4000 }, bounds || {});
  const pos = new Vector3(483, 260, 560);
  let yaw = 0;
  let pitch = -32 * DEG;
  let mode = 'map';
  let anim = null;
  let drag = null;
  // Touch: fingers on the canvas, the gesture they form and the touch sequence (first finger
  // down to last finger up) that decides taps.
  const fingers = new Map();
  let tg = null;
  let session = null;
  let tapTimer = 0;
  let lastTouchAt = -Infinity;
  const taps = createTapTracker();
  const held = new Set();
  const vel = new Vector3();
  const keyOrbit = { pivot: null };
  let speedMul = 1;
  let hadLock = false;
  let lastPointer = null;
  let lastPick = null;
  let moving = 0;
  let zoom = null; // {point, pending}: wheel zoom glides toward the cursor point
  let plane = null; // ui/plane.js state while in plane mode
  let craft = 'plane'; // the craft plane mode takes off in
  // Chase distance per craft: the wheel sets the flown craft's, and each starts at its default.
  const chaseBy = Object.fromEntries(Object.values(CRAFTS).map((c) => [c.id, c.chaseDistance]));
  let chase = chaseBy[craft];
  const pad = { start: false, exit: false, craft: false, game: false, input: null };
  let reduceMotion = null;
  try {
    reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    reduceMotion = null;
  }
  const euler = new Euler(0, 0, 0, 'YXZ');
  const tmpO = new Vector3();
  const tmpD = new Vector3();
  const tmpV = new Vector3();

  const setting = (id, fallback) => {
    try {
      const v = settings && settings.get(id);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };

  // camera.damping in 0..0.95: the fraction of a velocity change still to go after one
  // 60 Hz frame (0 = immediate). Returns the blend factor for a step of dt seconds.
  function blend(dt) {
    const d = clamp(Number(setting('camera.damping', 0.2)) || 0, 0, 0.95);
    return d <= 0 ? 1 : 1 - Math.pow(d, dt * 60);
  }

  function sync() {
    camera.position.copy(pos);
    camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
    camera.updateMatrixWorld(true);
  }

  function ground(x, z) {
    let h = 0;
    try {
      h = view.heightAt(x, z);
    } catch {
      h = 0;
    }
    return Number.isFinite(h) ? h : 0;
  }

  function rect() {
    return canvas.getBoundingClientRect();
  }

  function ray(cx, cy, origin = tmpO, dir = tmpD) {
    const r = rect();
    const nx = ((cx - r.left) / r.width) * 2 - 1;
    const ny = -(((cy - r.top) / r.height) * 2 - 1);
    sync();
    origin.copy(camera.position);
    dir.set(nx, ny, 0.5).unproject(camera).sub(origin).normalize();
    return { origin, dir };
  }

  function planeHit(origin, dir, y, out = new Vector3()) {
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = (y - origin.y) / dir.y;
    if (!(t > 0)) return null;
    return out.copy(dir).multiplyScalar(t).add(origin);
  }

  /** Terrain point under a client position (pick), else the y = 0 plane, else null. */
  function pointAt(cx, cy) {
    sync();
    let hit = null;
    try {
      hit = view.pick(cx, cy);
    } catch {
      hit = null;
    }
    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y) && Number.isFinite(hit.z)) {
      return new Vector3(hit.x, hit.y, hit.z);
    }
    const { origin, dir } = ray(cx, cy);
    return planeHit(origin, dir, 0);
  }

  /**
   * Gesture anchor under a client position (never null): the terrain point; else the ground
   * plane inside the landscape; else, over empty ground, a point along the ray no farther
   * than the landscape; else, above the horizon, a ground point straight ahead at the
   * landscape's distance, marked sky = true (zoom and rotate use it, panning does not).
   */
  function anchorAt(cx, cy) {
    sync();
    let hit = null;
    try {
      hit = view.pick(cx, cy);
    } catch {
      hit = null;
    }
    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y) && Number.isFinite(hit.z)) {
      return new Vector3(hit.x, hit.y, hit.z);
    }
    const { origin, dir } = ray(cx, cy);
    const p = planeHit(origin, dir, 0, new Vector3());
    const height = Math.max(1, origin.y - ground(origin.x, origin.z));
    if (p) {
      const inside = extent && p.x >= extent.minX && p.x <= extent.maxX && p.z >= extent.minZ && p.z <= extent.maxZ;
      if (inside) return p;
      // Empty ground: no farther than the landscape's nearest point (or a few heights away).
      const q = extent ? new Vector3(clamp(p.x, extent.minX, extent.maxX), 0, clamp(p.z, extent.minZ, extent.maxZ)) : null;
      const reach = Math.max(20, q ? origin.distanceTo(q) : 6 * height);
      const d = p.distanceTo(origin);
      return d <= reach ? p : origin.clone().addScaledVector(dir, reach);
    }
    const flat = new Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-8) flat.copy(forwardOf(yaw, 0));
    flat.normalize();
    const centre = extent ? new Vector3((extent.minX + extent.maxX) / 2, 0, (extent.minZ + extent.maxZ) / 2) : null;
    const reach = Math.max(20, centre ? origin.distanceTo(centre) : 6 * height);
    const s = new Vector3(origin.x + flat.x * reach, 0, origin.z + flat.z * reach);
    s.y = ground(s.x, s.z);
    s.sky = true;
    return s;
  }

  /** Pan anchor: like anchorAt, but null above the horizon (panning starts once a finger reaches the ground). */
  function grabAt(cx, cy) {
    const p = anchorAt(cx, cy);
    return p.sky ? null : p;
  }

  function centerClient() {
    const r = rect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function centerPoint() {
    const c = centerClient();
    const p = pointAt(c.x, c.y);
    if (p) return p;
    // Looking above the horizon: a point ahead at the current height scale.
    const h = Math.max(1, pos.y - ground(pos.x, pos.z));
    return pos.clone().add(forwardOf(yaw, pitch).multiplyScalar(h * 2));
  }

  function constrain(clearance = MIN_CLEARANCE) {
    pos.x = clamp(pos.x, lim.minX, lim.maxX);
    pos.z = clamp(pos.z, lim.minZ, lim.maxZ);
    const minY = ground(pos.x, pos.z) + clearance;
    if (pos.y < minY) pos.y = minY;
    if (pos.y > lim.maxY) pos.y = lim.maxY;
  }

  function touched() {
    moving = performance.now();
    zoom = null;
    // In plane mode the only animation is the takeoff, which input does not interrupt.
    if (anim && mode !== 'plane') {
      const a = anim;
      anim = null;
      a.resolve({ cancelled: true });
    }
  }

  // ---- map gestures --------------------------------------------------------------
  function panTo(grab, planeY, cx, cy) {
    const { origin, dir } = ray(cx, cy);
    const q = planeHit(origin, dir, planeY, tmpV);
    if (!q) return;
    const dx = grab.x - q.x;
    const dz = grab.z - q.z;
    const len = Math.hypot(dx, dz);
    const maxStep = Math.max(5, 3 * pos.distanceTo(grab));
    const k = len > maxStep ? maxStep / len : 1;
    pos.x += dx * k;
    pos.z += dz * k;
    constrain();
  }

  function orbit(pivot, dYaw, dPitch, { minPitch = -89 * DEG, maxPitch = 10 * DEG } = {}) {
    const newPitch = clamp(pitch + dPitch, minPitch, maxPitch);
    const dp = newPitch - pitch;
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const q = new Quaternion().setFromAxisAngle(UP, dYaw).multiply(new Quaternion().setFromAxisAngle(right, dp));
    const cand = pos.clone().sub(pivot).applyQuaternion(q).add(pivot);
    if (cand.y < ground(cand.x, cand.z) + MIN_CLEARANCE) {
      // Keep the turn but refuse a tilt that would put the camera under the surface.
      const qy = new Quaternion().setFromAxisAngle(UP, dYaw);
      pos.sub(pivot).applyQuaternion(qy).add(pivot);
    } else {
      pos.copy(cand);
      pitch = newPitch;
    }
    yaw = wrap(yaw + dYaw);
    constrain();
  }

  function zoomAt(point, factor) {
    const off = pos.clone().sub(point);
    const dist = off.length();
    if (!(dist > 0)) return;
    const next = clamp(dist * factor, MIN_DIST, MAX_DIST);
    pos.copy(point).addScaledVector(off, next / dist);
    constrain();
  }

  // ---- flight ----------------------------------------------------------------------
  function look(dx, dy) {
    if (mode === 'plane') {
      if (plane && !anim) stickByMouse(plane, dx, dy, { sensitivity: setting('camera.sensitivity', 1), invertY: !!setting('camera.invertY', false) });
      return;
    }
    const sens = setting('camera.sensitivity', 1) * 0.0022;
    const inv = setting('camera.invertY', false) ? -1 : 1;
    yaw = wrap(yaw - dx * sens);
    pitch = clamp(pitch - dy * sens * inv, -89 * DEG, 89 * DEG);
  }

  function requestLock(message = 'Pointer lock unavailable: drag to look') {
    if (!canvas.requestPointerLock) return;
    if (document.pointerLockElement === canvas) return;
    try {
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') {
        p.catch(() => onNotice && onNotice(message, 'warn'));
      }
    } catch {
      if (onNotice) onNotice(message, 'warn');
    }
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    if (next === 'plane' && !canFly) return;
    if (next === mode) return;
    touched();
    if (anim) {
      // Leaving plane mode during the takeoff: stop where the camera is.
      const a = anim;
      anim = null;
      a.resolve({ cancelled: true });
    }
    mode = next;
    vel.set(0, 0, 0);
    held.clear();
    keyOrbit.pivot = null;
    plane = null;
    if (mode === 'flight') {
      speedMul = 1;
      requestLock();
    } else if (mode === 'plane') {
      takeOff();
      requestLock('Pointer lock unavailable: drag to steer');
    } else if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }
    canvas.classList.toggle('flight', mode !== 'map');
    if (onModeChange) onModeChange(mode);
  }

  // ---- plane -----------------------------------------------------------------------
  /** Spawn the plane above the ground point at the view centre, heading along the view, and ease the camera behind it. */
  function takeOff() {
    const c = centerPoint();
    const e = extent || lim;
    const x = clamp(c.x, e.minX, e.maxX);
    const z = clamp(c.z, e.minZ, e.maxZ);
    const S = craftSpec(craft);
    chase = chaseBy[S.id];
    plane = createPlane({ craft: S.id, x, y: ground(x, z) + S.spawnHeight, z, yaw });
    const cam = chasePose(plane, chase, ground);
    const dist = pos.distanceTo(tmpV.set(cam.x, cam.y, cam.z));
    api.flyTo({
      position: { x: cam.x, y: cam.y, z: cam.z }, yaw: cam.yaw / DEG, pitch: cam.pitch / DEG,
      duration: clamp(0.6 + Math.log10(1 + dist) * 0.2, 0.6, 1.2),
    });
  }

  function updatePlane(dt) {
    if (!plane) return;
    const inv = setting('camera.invertY', false) ? -1 : 1;
    const input = {
      throttle: key('KeyW') - key('KeyS'),
      roll: key('KeyD') + key('ArrowRight') - key('KeyA') - key('ArrowLeft'),
      pitch: (key('ArrowDown') - key('ArrowUp')) * inv,
      boost: !!(key('ShiftLeft') || key('ShiftRight')),
    };
    if (pad.input) {
      input.roll += pad.input.roll;
      input.pitch += pad.input.pitch;
      input.throttle += pad.input.throttle;
      input.boost = input.boost || pad.input.boost;
    }
    stepPlane(plane, input, dt, { ground, collision: !!setting('camera.collision', true), bounds: extent || lim });
    placeChase();
  }

  /** Camera behind the plane (swinging after it), with the bump shake unless reduced motion is on. */
  function placeChase() {
    const c = chasePose(plane, chase, ground);
    pos.set(c.x, c.y, c.z);
    yaw = c.yaw;
    pitch = c.pitch;
    if (plane.shake > 0 && !(reduceMotion && reduceMotion.matches)) {
      const s = shakeOffset(plane, chase);
      pos.x += Math.cos(yaw) * s.x;
      pos.z -= Math.sin(yaw) * s.x;
      pos.y += s.y;
    }
    moving = performance.now();
  }

  /** First connected standard gamepad: Start takes off or lands, B lands, the rest steers. */
  function pollGamepad() {
    let gp = null;
    try {
      const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
      for (const g of list || []) {
        if (g && g.connected && g.mapping === 'standard') {
          gp = g;
          break;
        }
      }
    } catch {
      gp = null;
    }
    const input = gp ? gamepadInput(gp, { invertY: !!setting('camera.invertY', false) }) : null;
    const start = !!(input && input.start);
    const exit = !!(input && input.exit);
    const craftBtn = !!(input && input.craft);
    const gameBtn = !!(input && input.game);
    if (start && !pad.start) setMode(mode === 'plane' ? 'map' : 'plane');
    else if (exit && !pad.exit && mode === 'plane') setMode('map');
    if (craftBtn && !pad.craft && onPad) onPad('craft');
    if (gameBtn && !pad.game && mode === 'plane' && onPad) onPad('game');
    pad.start = start;
    pad.exit = exit;
    pad.craft = craftBtn;
    pad.game = gameBtn;
    pad.input = mode === 'plane' ? input : null;
  }

  // ---- events ----------------------------------------------------------------------
  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch') {
      touchDown(e);
      return;
    }
    if (mode === 'flight' || mode === 'plane') {
      if (document.pointerLockElement !== canvas) {
        drag = { kind: 'look', id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, t0: performance.now() };
        capture(canvas, e.pointerId);
      }
      return;
    }
    const orbitGesture = e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey);
    if (e.button !== 0 && !orbitGesture) return;
    touched();
    const p = anchorAt(e.clientX, e.clientY);
    drag = {
      kind: orbitGesture ? 'orbit' : 'pan',
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      lx: e.clientX,
      ly: e.clientY,
      moved: false,
      t0: performance.now(),
      grab: p.sky ? null : p,
      pivot: p.sky ? centerPoint() : p,
    };
    capture(canvas, e.pointerId);
    canvas.classList.add('dragging');
  }

  function onPointerMove(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch') {
      touchMove(e);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.lx;
    const dy = e.clientY - drag.ly;
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > CLICK_PX) drag.moved = true;
    if (!drag.moved) return;
    touched();
    if (drag.kind === 'look') {
      look(dx, dy);
    } else if (drag.kind === 'pan') {
      if (drag.grab) panTo(drag.grab, drag.grab.y, e.clientX, e.clientY);
      else drag.grab = grabAt(e.clientX, e.clientY);
    } else {
      const k = 0.005 * setting('camera.sensitivity', 1);
      orbit(drag.pivot, -dx * k, -dy * k);
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') {
      touchUp(e);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('dragging');
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (e.type === 'pointerup' && !d.moved && performance.now() - d.t0 < 600 && onInspect && d.kind !== 'orbit') {
      onInspect(e.clientX, e.clientY);
    }
  }

  function onDblClick(e) {
    // Touch double taps are handled in touchUp; ignore the dblclick some browsers add.
    if (mode !== 'map' || performance.now() - lastTouchAt < 1000) return;
    flyCloser(anchorAt(e.clientX, e.clientY));
  }

  /** Fly so that p is at the centre of the view, 35% of its current distance away. */
  function flyCloser(p) {
    if (!p) return;
    const next = Math.max(0.4, pos.distanceTo(p) * 0.35);
    api.flyTo({ position: p.clone().addScaledVector(forwardOf(yaw, pitch), -next) });
  }

  /** Fly back to twice the distance from the point under (cx, cy), keeping the view direction. */
  function zoomOutAt(cx, cy) {
    const p = anchorAt(cx, cy);
    api.flyTo({ position: p.clone().add(pos.clone().sub(p).multiplyScalar(2)), duration: 0.4 });
  }

  // ---- touch -------------------------------------------------------------------------
  function startPan(id, x, y) {
    tg = { kind: 'pan', id, grab: grabAt(x, y) };
  }

  function startLook(id, x, y) {
    tg = { kind: 'look', id, lx: x, ly: y };
  }

  /** Two-finger gesture on the first two fingers down; classified once they move. */
  function startTwo() {
    const ids = [...fingers.keys()].slice(0, 2);
    const a = fingers.get(ids[0]);
    const b = fingers.get(ids[1]);
    const pair = pairOf(a, b);
    tg = {
      kind: mode === 'flight' ? 'fly' : mode === 'plane' ? 'ignore' : 'two',
      ids,
      start: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      prev: pair,
      grab: mode === 'map' ? anchorAt(pair.x, pair.y) : null,
    };
    return pair;
  }

  function touchDown(e) {
    lastTouchAt = performance.now();
    if (e.isPrimary && fingers.size) {
      // A new touch sequence while old fingers are still listed (a lost pointerup): start clean.
      fingers.clear();
      tg = null;
      session = null;
    }
    capture(canvas, e.pointerId);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (!session) session = { t0: lastTouchAt, maxFingers: 0, moved: false, pair: null };
    session.maxFingers = Math.max(session.maxFingers, fingers.size);
    touched();
    canvas.classList.add('dragging');
    if (fingers.size === 1) {
      // A touch near a tap that just ended is the second tap of a double tap: the first tap
      // no longer inspects, and dragging this finger up or down zooms.
      const second = mode === 'map' && taps.pending(e.clientX, e.clientY);
      if (second || mode !== 'map') {
        clearTimeout(tapTimer);
        tapTimer = 0;
      }
      if (mode !== 'map') startLook(e.pointerId, e.clientX, e.clientY);
      else if (second) tg = { kind: 'tapzoom', id: e.pointerId, ly: e.clientY, anchor: anchorAt(e.clientX, e.clientY) };
      else startPan(e.pointerId, e.clientX, e.clientY);
    } else if (fingers.size === 2) {
      clearTimeout(tapTimer);
      tapTimer = 0;
      session.pair = startTwo();
    }
  }

  function touchMove(e) {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    f.x = e.clientX;
    f.y = e.clientY;
    if (!session || !tg) return;
    if (Math.hypot(f.x - f.x0, f.y - f.y0) > TAP_SLOP_PX) session.moved = true;
    if (tg.kind === 'pan' || tg.kind === 'look' || tg.kind === 'tapzoom') {
      if (e.pointerId !== tg.id || !session.moved) return;
      touched();
      if (tg.kind === 'pan') {
        if (tg.grab) panTo(tg.grab, tg.grab.y, f.x, f.y);
        else tg.grab = grabAt(f.x, f.y);
      } else if (tg.kind === 'look') {
        // Drag the scene: moving the finger right turns the view left, down looks up.
        const k = 0.004 * setting('camera.sensitivity', 1);
        const inv = setting('camera.invertY', false) ? -1 : 1;
        if (mode === 'plane') {
          if (plane && !anim) stickByMouse(plane, f.x - tg.lx, f.y - tg.ly, { sensitivity: setting('camera.sensitivity', 1), invertY: inv < 0 });
        } else {
          yaw = wrap(yaw + (f.x - tg.lx) * k);
          pitch = clamp(pitch + (f.y - tg.ly) * k * inv, -89 * DEG, 89 * DEG);
        }
        tg.lx = f.x;
        tg.ly = f.y;
      } else {
        // Double tap and drag: down zooms in, up zooms out, about the tapped point.
        zoomAt(tg.anchor, Math.exp(-(f.y - tg.ly) * 0.008));
        tg.ly = f.y;
      }
      return;
    }
    if (!tg.ids.includes(e.pointerId)) return;
    if (tg.kind === 'ignore') return;
    const a = fingers.get(tg.ids[0]);
    const b = fingers.get(tg.ids[1]);
    if (!a || !b) return;
    if (tg.kind === 'two') {
      const kind = classifyTwoFinger(tg.start, [a, b]);
      if (!kind) return;
      tg.kind = kind;
    }
    const pair = pairOf(a, b);
    const d = pairDelta(tg.prev, pair);
    tg.prev = pair;
    touched();
    if (tg.kind === 'transform') {
      // Zoom and twist about the point between the fingers, then keep it between them.
      if (Math.abs(d.scale - 1) > 1e-6) zoomAt(tg.grab, 1 / d.scale);
      if (Math.abs(d.rotate) > 1e-6) orbit(tg.grab, d.rotate, 0);
      if (!tg.grab.sky) panTo(tg.grab, tg.grab.y, pair.x, pair.y);
    } else if (tg.kind === 'tilt') {
      // Both fingers up tilts toward the horizon, down toward a top view.
      orbit(tg.grab, 0, -d.dy * 0.006 * setting('camera.sensitivity', 1));
    } else if (tg.kind === 'fly') {
      const h = Math.max(0.05, pos.y - ground(pos.x, pos.z));
      const s = 2 * setting('camera.flySpeed', 1) * clamp(h, 0.25, 400);
      const span = Math.max(1, rect().height);
      pos.addScaledVector(forwardOf(yaw, pitch), Math.log(d.scale) * s);
      pos.addScaledVector(new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), (-d.dx / span) * s);
      pos.addScaledVector(UP, (d.dy / span) * s);
      flightLimits();
    }
  }

  function touchUp(e) {
    if (!fingers.has(e.pointerId)) return;
    fingers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (fingers.size) {
      if (fingers.size === 1) {
        // Carry on with the remaining finger, grabbing the ground under it afresh.
        const [id, r] = [...fingers.entries()][0];
        if (mode !== 'map') startLook(id, r.x, r.y);
        else startPan(id, r.x, r.y);
      } else if (tg && tg.ids && tg.ids.includes(e.pointerId)) {
        startTwo();
      }
      return;
    }
    const s = session;
    const g = tg;
    session = null;
    tg = null;
    canvas.classList.remove('dragging');
    const tap = e.type === 'pointerup' && s && !s.moved && performance.now() - s.t0 <= TAP_MAX_MS;
    if (!tap) {
      if (g && g.kind === 'tapzoom') taps.reset();
      return;
    }
    if (s.maxFingers === 2) {
      taps.reset();
      if (mode === 'map') zoomOutAt(s.pair.x, s.pair.y);
      return;
    }
    if (s.maxFingers !== 1) return;
    const x = e.clientX;
    const y = e.clientY;
    if (mode !== 'map') {
      if (onInspect) onInspect(x, y);
      return;
    }
    if (taps.tap(x, y) === 'double') {
      flyCloser(anchorAt(x, y));
      return;
    }
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      if (onInspect) onInspect(x, y);
    }, DOUBLE_TAP_MS);
  }

  // Safari's own pinch events would zoom the page, also over the panels; touch-action in
  // app.css covers other browsers.
  function onGesture(e) {
    e.preventDefault();
  }

  function onWheel(e) {
    e.preventDefault();
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (mode === 'plane') {
      // Wheel down moves the chase camera back, up brings it closer.
      const S = craftSpec(craft);
      chase = clamp(chase * Math.exp(clamp(dy, -400, 400) * 0.0015), S.chaseMin, S.chaseMax);
      chaseBy[S.id] = chase;
      return;
    }
    if (mode === 'flight') {
      let next;
      if (settings && typeof settings.set === 'function') {
        next = clamp(setting('camera.flySpeed', 1) * Math.exp(-dy * 0.0015), 0.05, 50);
        settings.set('camera.flySpeed', next);
      } else {
        speedMul = clamp(speedMul * Math.exp(-dy * 0.0015), 0.05, 50);
        next = speedMul;
      }
      if (onNotice) onNotice('Flight speed \u00d7' + (next >= 10 ? next.toFixed(0) : next.toFixed(2)), 'info', 'flight-speed');
      return;
    }
    if (e.ctrlKey) dy *= 4; // macOS trackpad pinch arrives as ctrl+wheel with small deltas
    const now = performance.now();
    let p = null;
    if (lastPick && now - lastPick.t < 250 && Math.hypot(lastPick.x - e.clientX, lastPick.y - e.clientY) < 3) {
      p = lastPick.p;
    } else {
      p = anchorAt(e.clientX, e.clientY);
      lastPick = p ? { t: now, x: e.clientX, y: e.clientY, p } : null;
    }
    if (!p) return;
    const step = clamp(dy, -400, 400) * 0.0015;
    const pending = zoom && zoom.point.distanceToSquared(p) < 1e-12 ? zoom.pending : 0;
    touched();
    zoom = { point: p, pending: pending + step };
  }

  function onKeyDown(e) {
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!MOVE_KEYS.has(e.code)) return;
    if (e.code.startsWith('Arrow') || e.code.startsWith('Page')) e.preventDefault();
    if (!held.has(e.code) && mode === 'map' && ['KeyQ', 'KeyE', 'PageUp', 'PageDown'].includes(e.code)) {
      keyOrbit.pivot = centerPoint();
    }
    held.add(e.code);
    touched();
  }

  function onKeyUp(e) {
    held.delete(e.code);
  }

  function onBlur() {
    held.clear();
  }

  function onLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      hadLock = true;
    } else if (hadLock && mode !== 'map') {
      hadLock = false;
      setMode('map');
    }
  }

  function onMouseMove(e) {
    if (mode !== 'map' && document.pointerLockElement === canvas) {
      touched();
      look(e.movementX || 0, e.movementY || 0);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', onGesture, { passive: false });
  document.addEventListener('gesturechange', onGesture, { passive: false });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const key = (code) => (held.has(code) ? 1 : 0);

  function updateMap(dt) {
    const boost = key('ShiftLeft') || key('ShiftRight') ? 4 : 1;
    const fwd = key('ArrowUp') - key('ArrowDown');
    const side = key('ArrowRight') - key('ArrowLeft');
    const h = Math.max(1, pos.y - ground(pos.x, pos.z));
    const speed = h * 0.9 * boost;
    const want = new Vector3(-Math.sin(yaw) * fwd + Math.cos(yaw) * side, 0, -Math.cos(yaw) * fwd - Math.sin(yaw) * side);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(speed);
    vel.lerp(want, blend(dt));
    if (vel.lengthSq() > 1e-10) {
      pos.addScaledVector(vel, dt);
      constrain();
    }
    if (zoom) {
      // Apply the pending zoom (log units) with the damping; anchored at the cursor point.
      const k = blend(dt);
      const s = Math.abs(zoom.pending) < 1e-4 ? zoom.pending : zoom.pending * k;
      zoomAt(zoom.point, Math.exp(s));
      zoom.pending -= s;
      moving = performance.now();
      if (Math.abs(zoom.pending) < 1e-6) zoom = null;
    }
    const rot = key('KeyQ') - key('KeyE');
    const tilt = key('PageUp') - key('PageDown');
    if ((rot || tilt) && keyOrbit.pivot) {
      orbit(keyOrbit.pivot, rot * 60 * DEG * dt * boost, tilt * 45 * DEG * dt * boost);
    }
  }

  function updateFlight(dt) {
    const boost = key('ShiftLeft') || key('ShiftRight') ? 4 : 1;
    const fwd = key('KeyW') + key('ArrowUp') - key('KeyS') - key('ArrowDown');
    const side = key('KeyD') + key('ArrowRight') - key('KeyA') - key('ArrowLeft');
    const up = key('KeyE') + key('PageUp') - key('KeyQ') - key('PageDown');
    const h = Math.max(0.05, pos.y - ground(pos.x, pos.z));
    const speed = setting('camera.flySpeed', 1) * speedMul * clamp(h, 0.25, 400) * boost;
    const f = forwardOf(yaw, pitch);
    const r = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const want = new Vector3().addScaledVector(f, fwd).addScaledVector(r, side).addScaledVector(UP, up);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(speed);
    vel.lerp(want, blend(dt));
    pos.addScaledVector(vel, dt);
    flightLimits();
  }

  /** Flight collision and bounds, shared by keyboard flight and the two-finger fly gesture. */
  function flightLimits() {
    if (setting('camera.collision', true)) {
      const minY = ground(pos.x, pos.z) + FLIGHT_CLEARANCE;
      if (pos.y < minY) {
        pos.y = minY;
        if (vel.y < 0) vel.y = 0;
      }
    }
    pos.x = clamp(pos.x, lim.minX, lim.maxX);
    pos.z = clamp(pos.z, lim.minZ, lim.maxZ);
    pos.y = Math.min(pos.y, lim.maxY);
  }

  function updateAnim(dt) {
    const a = anim;
    a.t = Math.min(1, a.t + dt / a.duration);
    const e = easeInOut(a.t);
    pos.lerpVectors(a.from.pos, a.to.pos, e);
    pos.y += a.arc * Math.sin(Math.PI * e);
    yaw = wrap(a.from.yaw + shortest(a.from.yaw, a.to.yaw) * e);
    pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
    const minY = ground(pos.x, pos.z) + MIN_CLEARANCE;
    if (pos.y < minY) pos.y = minY;
    if (a.t >= 1) {
      anim = null;
      a.resolve({ cancelled: false });
    }
  }

  const api = {
    get mode() {
      return mode;
    },
    get moving() {
      return mode === 'plane' || !!anim || !!drag || !!tg || held.size > 0 || vel.lengthSq() > 1e-8 || performance.now() - moving < 250;
    },
    get pointer() {
      return lastPointer;
    },
    get speedMultiplier() {
      return speedMul;
    },
    /** Live ui/plane.js state while in plane mode (null otherwise). */
    get plane() {
      return plane;
    },
    /** True while the plane is taking off (the camera is easing in behind it). */
    get takingOff() {
      return mode === 'plane' && !!anim;
    },
    get chaseDistance() {
      return chase;
    },
    /** The craft plane mode flies (ui/plane.js CRAFTS id). */
    get craft() {
      return craft;
    },
    /** Choose the craft; in flight it changes at once (same pose and throttle). False for an unknown id. */
    setCraft(id) {
      if (!CRAFTS[id]) return false;
      craft = id;
      chase = chaseBy[id];
      if (plane) switchCraft(plane, id);
      return true;
    },
    /** Free the cursor (exit pointer lock) without leaving flight or plane mode. */
    releaseLock() {
      if (typeof document !== 'undefined' && document.pointerLockElement === canvas) {
        hadLock = false;
        document.exitPointerLock();
      }
    },
    /** Ask for pointer lock again in flight or plane mode (call from a key press or click). */
    lock() {
      if (mode === 'plane') requestLock('Pointer lock unavailable: drag to steer');
      else if (mode === 'flight') requestLock();
    },
    setMode,
    toggleFlight() {
      setMode(mode === 'flight' ? 'map' : 'flight');
    },
    togglePlane() {
      setMode(mode === 'plane' ? 'map' : 'plane');
    },
    /** Client point to inspect: the crosshair in flight and plane mode, else the last pointer position. */
    inspectPoint() {
      if (mode !== 'map' || !lastPointer) return centerClient();
      return lastPointer;
    },
    centerPoint,
    pointAt,
    ray,
    update(dt) {
      const step = Math.min(Math.max(dt, 0), 0.1);
      pollGamepad();
      if (anim) updateAnim(step);
      else if (mode === 'plane') updatePlane(step);
      else if (mode === 'flight') updateFlight(step);
      else updateMap(step);
      const fov = setting('camera.fov', camera.fov);
      if (Number.isFinite(fov) && Math.abs(fov - camera.fov) > 1e-6) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      sync();
    },
    getPose() {
      return { x: pos.x, y: pos.y, z: pos.z, yaw: yaw / DEG, pitch: pitch / DEG };
    },
    setPose(p) {
      if (!p) return;
      touched();
      if ([p.x, p.y, p.z].every(Number.isFinite)) pos.set(p.x, p.y, p.z);
      if (Number.isFinite(p.yaw)) yaw = wrap(p.yaw * DEG);
      if (Number.isFinite(p.pitch)) pitch = clamp(p.pitch * DEG, -89.9 * DEG, 89.9 * DEG);
      vel.set(0, 0, 0);
      sync();
    },
    /** Camera position that looks at target from distance with yaw/pitch in degrees. */
    poseLookingAt(target, { distance, yaw: yawDeg = yaw / DEG, pitch: pitchDeg = pitch / DEG } = {}) {
      const f = forwardOf(yawDeg * DEG, pitchDeg * DEG);
      const p = new Vector3(target.x, target.y || 0, target.z).addScaledVector(f, -distance);
      return { position: p, yaw: yawDeg, pitch: pitchDeg };
    },
    /** Animate to {position, yaw?, pitch?} (degrees); resolves when done or interrupted. */
    flyTo({ position, yaw: yawDeg, pitch: pitchDeg, duration } = {}) {
      touched();
      const to = {
        pos: new Vector3(position.x, position.y, position.z),
        yaw: Number.isFinite(yawDeg) ? wrap(yawDeg * DEG) : yaw,
        pitch: Number.isFinite(pitchDeg) ? clamp(pitchDeg * DEG, -89.9 * DEG, 89.9 * DEG) : pitch,
      };
      to.pos.x = clamp(to.pos.x, lim.minX, lim.maxX);
      to.pos.z = clamp(to.pos.z, lim.minZ, lim.maxZ);
      to.pos.y = clamp(to.pos.y, ground(to.pos.x, to.pos.z) + MIN_CLEARANCE, lim.maxY);
      const dist = pos.distanceTo(to.pos);
      const dur = Number.isFinite(duration) ? duration : clamp(0.6 + Math.log10(1 + dist) * 0.35, 0.6, 1.8);
      return new Promise((resolve) => {
        vel.set(0, 0, 0);
        anim = {
          from: { pos: pos.clone(), yaw, pitch },
          to,
          t: 0,
          duration: Math.max(0.001, dur),
          arc: dist > 40 ? Math.min(dist * 0.2, 300) : 0,
          resolve,
        };
        if (dur <= 0) updateAnim(1);
      });
    },
    /**
     * Slide the camera sideways (same height and direction) so the world point p appears at
     * client position (cx, cy); used to keep an inspected cell clear of the phone's sheet.
     */
    panPointTo(p, cx, cy, { duration = 0.45 } = {}) {
      if (!p || mode !== 'map') return Promise.resolve({ cancelled: true });
      const g = new Vector3(p.x, p.y, p.z);
      const save = pos.clone();
      panTo(g, g.y, cx, cy);
      const to = pos.clone();
      pos.copy(save);
      sync();
      if (to.distanceToSquared(save) < 1e-10) return Promise.resolve({ cancelled: false });
      return api.flyTo({ position: to, duration });
    },
    /**
     * Follow tip: move the camera dx along x (world units), keeping its direction, together
     * with every point an animation or gesture in progress is anchored to, so they carry on
     * in the moving frame. Cancels nothing; does nothing in plane mode.
     */
    shiftX(dx) {
      if (!Number.isFinite(dx) || dx === 0 || mode === 'plane') return;
      // A pan drag's grab and pivot can be the same point: shift each point once.
      const points = new Set();
      const add = (p) => {
        if (p && Number.isFinite(p.x)) points.add(p);
      };
      if (anim) {
        add(anim.from.pos);
        add(anim.to.pos);
      }
      if (zoom) add(zoom.point);
      add(keyOrbit.pivot);
      if (drag) {
        add(drag.grab);
        add(drag.pivot);
      }
      if (tg) {
        add(tg.grab);
        add(tg.anchor);
      }
      for (const p of points) p.x += dx;
      pos.x += dx;
      if (mode === 'flight') flightLimits();
      else constrain();
      sync();
    },
    /** Ground footprint of the view as [x, z] corners (for the minimap). */
    footprint(maxDistance = 2500) {
      const r = rect();
      const corners = [[r.left, r.bottom], [r.right, r.bottom], [r.right, r.top], [r.left, r.top]];
      const out = [];
      for (const [cx, cy] of corners) {
        const { origin, dir } = ray(cx, cy);
        let p = planeHit(origin, dir, 0, new Vector3());
        if (!p || p.distanceTo(origin) > maxDistance) {
          const flat = new Vector3(dir.x, 0, dir.z);
          if (flat.lengthSq() < 1e-8) flat.set(-Math.sin(yaw), 0, -Math.cos(yaw));
          flat.normalize();
          p = new Vector3(origin.x, 0, origin.z).addScaledVector(flat, maxDistance);
        }
        out.push([p.x, p.z]);
      }
      return out;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('gesturestart', onGesture);
      document.removeEventListener('gesturechange', onGesture);
      clearTimeout(tapTimer);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
  sync();
  return api;
}
