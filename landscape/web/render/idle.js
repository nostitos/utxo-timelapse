// Idle drawing (render_post): the view draws a frame only while something on screen can change.
// Pure module: no DOM and no three.js, so it runs under node --test.
//
// A parked, paused camera used to redraw the same picture at the display's rate (123 frames in
// 2 s at 60 Hz, all identical). After a change the view keeps drawing for AFTER_CHANGE_FRAMES
// frames, so shadow maps, texture uploads and the column counts read back from the GPU settle,
// and while idle it still draws once every IDLE_REDRAW_MS in case a change went unnoticed.

export const AFTER_CHANGE_FRAMES = 30;
export const IDLE_REDRAW_MS = 1000;

export function createIdleGate() {
  return { quiet: 0, lastDraw: -Infinity };
}

/**
 * Whether to draw this frame. changed: the picture's inputs differ from the previous frame;
 * busy: the frame must be drawn whatever changed (playback, animated effects, the overlay).
 * Updates gate and returns true to draw.
 */
export function idleGate(gate, { changed, busy, now }) {
  gate.quiet = changed || busy ? 0 : gate.quiet + 1;
  if (gate.quiet > AFTER_CHANGE_FRAMES && now - gate.lastDraw < IDLE_REDRAW_MS) return false;
  gate.lastDraw = now;
  return true;
}
