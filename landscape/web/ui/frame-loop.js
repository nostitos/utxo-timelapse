// The app's animation frame loop: step(dt, now) once per display frame, dt the elapsed seconds
// (at most MAX_DT, so a frame after a stall or a background tab does not jump far), and a
// failing frame reported without flooding the console.
export const MAX_DT = 0.1;
export const ERROR_REPEAT_MS = 5000;

/**
 * Runs step(dt, now) every animation frame. A step that throws goes to onError(err, {message,
 * count, logged}): count is the run of consecutive failing frames; logged is false when the same
 * message was already reported within ERROR_REPEAT_MS.
 */
export function startFrameLoop(step, { onError, raf = requestAnimationFrame, now = performance.now() } = {}) {
  let last = now;
  let errors = 0;
  const reported = new Map(); // message -> when it was last reported
  function frame(t) {
    raf(frame);
    const dt = Math.min(Math.max((t - last) / 1000, 0), MAX_DT);
    last = t;
    try {
      step(dt, t);
      errors = 0;
    } catch (err) {
      errors++;
      const message = err && err.message ? err.message : String(err);
      const at = reported.get(message);
      const logged = at === undefined || t - at > ERROR_REPEAT_MS;
      if (logged) reported.set(message, t);
      onError(err, { message, count: errors, logged });
    }
  }
  raf(frame);
}
