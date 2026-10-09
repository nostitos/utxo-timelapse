// Touch gesture maths for ui/controls.js (pure: plain numbers in, plain numbers out).
//
// Map mode on a touch screen:
//   one finger        pan; the ground under the finger stays under it
//   two fingers       pinch to zoom, twist to rotate and move to pan, all about the point
//                     between the fingers; or drag both up or down together to tilt
//   tap               inspect the cell (after the double-tap window)
//   double tap        fly closer to that point; double tap and drag down or up zooms in or out
//   two-finger tap    zoom out
// Flight mode: one finger looks around, two fingers fly (spread to move forward, drag to
// slide sideways or climb).

export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 350;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 32;
export const CLASSIFY_PX = 10;

const wrapAngle = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/** Midpoint, spread and angle (radians, clockwise on screen because y points down) of two fingers. */
export function pairOf(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/**
 * Change from one finger pair to the next: scale > 1 when the fingers spread, rotate > 0
 * for a clockwise twist, and the midpoint shift in pixels.
 */
export function pairDelta(prev, next) {
  return {
    scale: prev.dist > 0 && next.dist > 0 ? next.dist / prev.dist : 1,
    rotate: wrapAngle(next.angle - prev.angle),
    dx: next.x - prev.x,
    dy: next.y - prev.y,
  };
}

/**
 * Classifies a two-finger gesture from where the fingers started and where they are now
 * ([a, b] in the same order): 'tilt' when fingers side by side move up or down together
 * with little pinch or twist, 'transform' (pinch, twist and pan) otherwise, or null while
 * the movement is still too small to tell.
 */
export function classifyTwoFinger(start, now) {
  const da = { x: now[0].x - start[0].x, y: now[0].y - start[0].y };
  const db = { x: now[1].x - start[1].x, y: now[1].y - start[1].y };
  const ma = Math.hypot(da.x, da.y);
  const mb = Math.hypot(db.x, db.y);
  const most = Math.max(ma, mb);
  if (most < CLASSIFY_PX) return null;
  // Wait for the second finger unless one finger alone has clearly moved (a pivot pinch).
  if (Math.min(ma, mb) < CLASSIFY_PX / 2 && most < 2.5 * CLASSIFY_PX) return null;
  const p0 = pairOf(start[0], start[1]);
  const p1 = pairOf(now[0], now[1]);
  const scale = p0.dist > 0 && p1.dist > 0 ? Math.abs(Math.log(p1.dist / p0.dist)) : 0;
  const turn = Math.abs(wrapAngle(p1.angle - p0.angle));
  const sideBySide = Math.abs(start[0].x - start[1].x) >= Math.abs(start[0].y - start[1].y);
  const vertical = (d) => Math.abs(d.y) > 1.5 * Math.abs(d.x);
  const together = da.y * db.y > 0;
  if (sideBySide && together && vertical(da) && vertical(db) && scale < 0.12 && turn < 0.12) return 'tilt';
  return 'transform';
}

/**
 * Tap bookkeeping for single and double taps. tap() returns 'double' when this tap
 * completes a double tap and 'single' otherwise; pending() tells whether a touch starting
 * at (x, y) now could still become the second tap.
 */
export function createTapTracker({ now = () => performance.now() } = {}) {
  let last = null;
  const near = (x, y) => !!last && now() - last.t <= DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_PX;
  return {
    tap(x, y) {
      if (near(x, y)) {
        last = null;
        return 'double';
      }
      last = { t: now(), x, y };
      return 'single';
    },
    pending(x, y) {
      return near(x, y);
    },
    reset() {
      last = null;
    },
  };
}
