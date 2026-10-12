// Follow tip (landscape/SPEC.md §8): the camera moves along the block axis with the tip.
// Pure module: no DOM, no three.js.
//
// The tip is the block of the delivered state. Replay frames say why they were sent:
// 'advance' frames (playback and the exact 1-block steps) move the tip block by block,
// 'seek' frames jump it, 'tiles' and 'measure' frames repeat it. Only advance motion becomes
// camera motion, forward or backward; any other change of block re-anchors, so seeks,
// scrubs, Places and links never move the camera, and turning following on does not either.
//
// Worker frames arrive in bursts, so the camera eases toward the tip with time constant
// FOLLOW_TAU_S instead of copying each burst: it glides at the tip's speed, trailing it by
// about rate x FOLLOW_TAU_S blocks while playing, and its total shift equals the tip's motion
// (the last FOLLOW_SNAP_BLOCKS are closed in one step).

import { BLOCKS_PER_WORLD_UNIT } from '../data/grid.js';

export const FOLLOW_TAU_S = 0.25;
export const FOLLOW_SNAP_BLOCKS = 0.01;

export function createTipFollow({ tau = FOLLOW_TAU_S } = {}) {
  let on = false;
  let goal = null; // block the camera is heading for
  let anchor = null; // fractional block the camera stands for now

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
    /** A replay frame: reason 'advance' moves the tip, any other change of block re-anchors. */
    frame(reason, block) {
      if (!on || !Number.isFinite(block)) return;
      if (goal === null) reanchor(block);
      else if (block === goal) return;
      else if (reason === 'advance') goal = block;
      else reanchor(block);
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
