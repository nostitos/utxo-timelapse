// Follow tip (landscape/SPEC.md §8): the camera moves along the block axis with the tip.
// Pure module: no DOM, no three.js.
//
// The tip is the block of the delivered state. Every replay frame that changes it moves the
// camera the same way, forward or backward: playback and the 1-block steps (advance frames)
// and the scrubber, the block and date fields and the 1,008-block steps (seek frames). Turning
// following on does not move the camera. Actions that place the camera themselves (Places,
// links, imported views, startup) wrap their seek in beginJump / endJump: frames in between
// re-anchor, so the camera stays where that action puts it.
//
// Worker frames arrive in bursts, so the camera eases toward the tip with time constant
// FOLLOW_TAU_S instead of copying each burst: it glides at the tip's speed, trailing it by
// about rate x FOLLOW_TAU_S blocks while playing, and its total shift equals the tip's motion
// (the last FOLLOW_SNAP_BLOCKS are closed in one step). A seek glides the same way, so a
// scrub sweeps the camera to the new tip in about a second.

import { BLOCKS_PER_WORLD_UNIT } from '../data/grid.js';

export const FOLLOW_TAU_S = 0.25;
export const FOLLOW_SNAP_BLOCKS = 0.01;

export function createTipFollow({ tau = FOLLOW_TAU_S } = {}) {
  let on = false;
  let goal = null; // block the camera is heading for
  let anchor = null; // fractional block the camera stands for now
  let jumps = 0; // camera-placing seeks in progress (beginJump / endJump)

  function reanchor(block) {
    goal = Number.isFinite(block) ? block : null;
    anchor = goal;
  }

  return {
    get active() {
      return on;
    },
    /** Blocks the camera still has to glide (positive: behind a tip that moved forward). */
    get lag() {
      return on && goal !== null ? goal - anchor : 0;
    },
    /** Start following from block (the camera stays where it is). */
    enable(block) {
      on = true;
      reanchor(block);
    },
    disable() {
      on = false;
      reanchor(null);
    },
    /** A replay frame's block: a change moves the camera's goal (re-anchors during a jump). */
    frame(block) {
      if (!on || !Number.isFinite(block)) return;
      if (goal === null || jumps > 0) reanchor(block);
      else goal = block;
    },
    /** A seek that places the camera itself starts: until endJump, frames re-anchor. */
    beginJump() {
      jumps++;
    },
    /** That seek is done (or cancelled): follow on from block without moving the camera. */
    endJump(block) {
      jumps = Math.max(0, jumps - 1);
      if (on && Number.isFinite(block)) reanchor(block);
    },
    /** Stay put at block (plane mode): following resumes from there without a jump. */
    hold(block) {
      if (on) reanchor(Number.isFinite(block) ? block : goal);
    },
    /** Camera shift along x (world units) for a frame of dt seconds. */
    step(dt) {
      if (!on || goal === null || anchor === goal) return 0;
      const k = Number.isFinite(dt) && dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
      const prev = anchor;
      anchor += (goal - anchor) * k;
      if (Math.abs(goal - anchor) < FOLLOW_SNAP_BLOCKS) anchor = goal;
      return (anchor - prev) / BLOCKS_PER_WORLD_UNIT;
    },
  };
}
