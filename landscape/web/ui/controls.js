// Camera navigation (landscape/SPEC.md §8): map mode and flight mode.
//
// The camera pose is a position plus yaw and pitch (no roll); yaw 0 looks toward -z,
// pitch < 0 looks down. Map mode expresses every gesture as a rigid move of that pose:
//   left-drag      pan; the grabbed terrain point stays under the cursor
//   right/Shift    orbit around the terrain point under the cursor
//   wheel / pinch  zoom toward the point under the cursor
//   double-click   fly to the clicked point
//   arrows pan, Q/E rotate and PageUp/PageDown tilt around the screen centre
// Flight mode (F): pointer lock and mouse look (drag to look when the lock is refused),
// WASD, E/Q up/down, Shift 4x, wheel sets speed, speed scales with height above the
// terrain, and collision keeps the camera above the surface.

import { Vector3, Quaternion, Euler } from 'three';

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);
const MIN_CLEARANCE = 0.03;
const FLIGHT_CLEARANCE = 0.08;
const MIN_DIST = 0.05;
const MAX_DIST = 4000;
const CLICK_PX = 5;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'ShiftLeft', 'ShiftRight']);

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

export function createControls({ view, canvas, settings, onInspect, onModeChange, onNotice, bounds } = {}) {
  const camera = view.camera;
  const lim = Object.assign({ minX: -400, maxX: 1400, minZ: -400, maxZ: 650, maxY: 4000 }, bounds || {});
  const pos = new Vector3(483, 260, 560);
  let yaw = 0;
  let pitch = -32 * DEG;
  let mode = 'map';
  let anim = null;
  let drag = null;
  const touches = new Map();
  let pinch = null;
  const held = new Set();
  const vel = new Vector3();
  const keyOrbit = { pivot: null };
  let speedMul = 1;
  let hadLock = false;
  let lastPointer = null;
  let lastPick = null;
  let moving = 0;
  let zoom = null; // {point, pending}: wheel zoom glides toward the cursor point
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
    if (anim) {
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
    const sens = setting('camera.sensitivity', 1) * 0.0022;
    const inv = setting('camera.invertY', false) ? -1 : 1;
    yaw = wrap(yaw - dx * sens);
    pitch = clamp(pitch - dy * sens * inv, -89 * DEG, 89 * DEG);
  }

  function requestLock() {
    if (!canvas.requestPointerLock) return;
    try {
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') {
        p.catch(() => onNotice && onNotice('Pointer lock unavailable: drag to look', 'warn'));
      }
    } catch {
      if (onNotice) onNotice('Pointer lock unavailable: drag to look', 'warn');
    }
  }

  function setMode(next) {
    if (next !== 'map' && next !== 'flight') return;
    if (next === mode) return;
    touched();
    mode = next;
    vel.set(0, 0, 0);
    held.clear();
    keyOrbit.pivot = null;
    if (mode === 'flight') {
      speedMul = 1;
      requestLock();
    } else if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }
    canvas.classList.toggle('flight', mode === 'flight');
    if (onModeChange) onModeChange(mode);
  }

  // ---- events ----------------------------------------------------------------------
  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        drag = null;
        const [a, b] = [...touches.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), point: pointAt(mid.x, mid.y) };
        return;
      }
    }
    if (mode === 'flight') {
      if (document.pointerLockElement !== canvas) {
        drag = { kind: 'look', id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, t0: performance.now() };
        capture(canvas, e.pointerId);
      }
      return;
    }
    const orbitGesture = e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey);
    if (e.button !== 0 && !orbitGesture) return;
    touched();
    const p = pointAt(e.clientX, e.clientY);
    drag = {
      kind: orbitGesture ? 'orbit' : 'pan',
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      lx: e.clientX,
      ly: e.clientY,
      moved: false,
      t0: performance.now(),
      grab: p,
      pivot: p || centerPoint(),
    };
    capture(canvas, e.pointerId);
    canvas.classList.add('dragging');
  }

  function onPointerMove(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.point && dist > 0) zoomAt(pinch.point, pinch.dist / dist);
        pinch.dist = dist;
        touched();
        return;
      }
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
      else drag.grab = pointAt(e.clientX, e.clientY);
    } else {
      const k = 0.005 * setting('camera.sensitivity', 1);
      orbit(drag.pivot, -dx * k, -dy * k);
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
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
    if (mode !== 'map') return;
    const p = pointAt(e.clientX, e.clientY);
    if (!p) return;
    const dist = pos.distanceTo(p);
    const next = Math.max(0.4, dist * 0.35);
    api.flyTo({ position: p.clone().addScaledVector(forwardOf(yaw, pitch), -next) });
  }

  function onWheel(e) {
    e.preventDefault();
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
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
      p = pointAt(e.clientX, e.clientY);
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
    } else if (hadLock && mode === 'flight') {
      hadLock = false;
      setMode('map');
    }
  }

  function onMouseMove(e) {
    if (mode === 'flight' && document.pointerLockElement === canvas) {
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
      return !!anim || !!drag || held.size > 0 || vel.lengthSq() > 1e-8 || performance.now() - moving < 250;
    },
    get pointer() {
      return lastPointer;
    },
    get speedMultiplier() {
      return speedMul;
    },
    setMode,
    toggleFlight() {
      setMode(mode === 'flight' ? 'map' : 'flight');
    },
    /** Client point to inspect: the crosshair in flight, else the last pointer position. */
    inspectPoint() {
      if (mode === 'flight' || !lastPointer) return centerClient();
      return lastPointer;
    },
    centerPoint,
    pointAt,
    ray,
    update(dt) {
      const step = Math.min(Math.max(dt, 0), 0.1);
      if (anim) updateAnim(step);
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
