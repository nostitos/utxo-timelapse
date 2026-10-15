// Follow tip (landscape/web/ui/follow.js). Run: node --test landscape/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTipFollow, FOLLOW_TAU_S } from '../web/ui/follow.js';

const DT = 1 / 60;
const K = 1 - Math.exp(-DT / FOLLOW_TAU_S);
// Run n frames of DT; returns the total shift and the largest single-frame shift.
function run(f, n, onFrame = null) {
  let total = 0;
  let largest = 0;
  for (let i = 0; i < n; i++) {
    if (onFrame) onFrame(i);
    const dx = f.step(DT);
    total += dx;
    largest = Math.max(largest, Math.abs(dx));
  }
  return { total, largest };
}

test('turning following on does not move the camera', () => {
  const f = createTipFollow();
  assert.equal(f.active, false);
  f.enable(300000);
  assert.equal(f.active, true);
  assert.equal(run(f, 120).total, 0);
  // Tiles and measure frames repeat the block: still nothing.
  f.frame(300000);
  f.frame(300000);
  assert.equal(run(f, 60).total, 0);
});

test('playback moves the camera exactly as far as the tip', () => {
  const f = createTipFollow();
  f.enable(300000);
  // 1x: one block a frame for one second, then three seconds to settle.
  let b = 300000;
  const play = run(f, 60, () => f.frame(++b));
  assert.ok(play.total > 0 && play.total < 0.06, 'trails the tip while playing (' + play.total + ')');
  const settle = run(f, 180);
  assert.ok(Math.abs(play.total + settle.total - 60 / 1000) < 1e-9, 'total ' + (play.total + settle.total));
  assert.equal(f.lag, 0);
  // At 1x the camera moves at the tip's 0.06 units a second once its trail has settled.
  const steady = createTipFollow();
  steady.enable(0);
  let s = 0;
  run(steady, 240, () => steady.frame(++s));
  const window = run(steady, 60, () => steady.frame(++s));
  assert.ok(Math.abs(window.total - 0.06) < 1e-6, 'steady speed ' + window.total + ' per second');
});

test('a burst of blocks becomes a glide, not a jump', () => {
  const f = createTipFollow();
  f.enable(500000);
  f.frame(500300);
  const r = run(f, 240);
  assert.ok(r.largest <= (300 * K) / 1000 + 1e-12, 'largest step ' + r.largest);
  assert.ok(Math.abs(r.total - 0.3) < 1e-9, 'total ' + r.total);
});

test('a backward step moves the camera backward', () => {
  const f = createTipFollow();
  f.enable(400000);
  f.frame(399999);
  assert.ok(Math.abs(run(f, 180).total + 0.001) < 1e-9);
});

test('a seek or scrub glides the camera as far as the tip went', () => {
  const f = createTipFollow();
  f.enable(300000);
  // Forward 5,000 blocks: 5 units, in steps no larger than one smoothing step of the gap.
  f.frame(305000);
  const fwd = run(f, 240);
  assert.ok(Math.abs(fwd.total - 5) < 1e-9, 'total ' + fwd.total);
  assert.ok(fwd.largest <= (5000 * K) / 1000 + 1e-12, 'largest step ' + fwd.largest);
  // A scrub: several seeks while dragging, then the exact block on release.
  let total = 0;
  for (const b of [310000, 320000, 315000]) {
    f.frame(b);
    total += run(f, 15).total;
  }
  f.frame(315123);
  total += run(f, 240).total;
  assert.ok(Math.abs(total - 10.123) < 1e-9, 'scrub total ' + total);
  // Backward.
  f.frame(250000);
  assert.ok(Math.abs(run(f, 300).total + 65.123) < 1e-9);
});

test('a camera-placing jump re-anchors without moving the camera', () => {
  const f = createTipFollow();
  f.enable(300000);
  // Places: the seek's frames arrive between beginJump and endJump.
  f.beginJump();
  f.frame(420000);
  f.frame(420000);
  assert.equal(run(f, 120).total, 0);
  f.endJump(420000);
  assert.equal(f.lag, 0);
  assert.equal(run(f, 60).total, 0);
  // Following carries on from there.
  f.frame(420010);
  assert.ok(Math.abs(run(f, 240).total - 0.01) < 1e-9);
  // A jump drops a glide in progress; overlapping jumps hold until the last one ends.
  f.frame(421000);
  run(f, 3);
  f.beginJump();
  f.beginJump();
  f.frame(500000);
  f.endJump(500000);
  f.frame(500500);
  assert.equal(run(f, 120).total, 0);
  f.endJump(500500);
  assert.equal(run(f, 60).total, 0);
  f.frame(500600);
  assert.ok(Math.abs(run(f, 240).total - 0.1) < 1e-9);
  // An extra endJump does not break following.
  f.endJump(500600);
  f.frame(500601);
  assert.ok(Math.abs(run(f, 240).total - 0.001) < 1e-9);
});

test('hold keeps the camera still and following resumes from there', () => {
  const f = createTipFollow();
  f.enable(600000);
  let b = 600000;
  // Plane mode: held every frame while the tip advances.
  const held = run(f, 60, () => {
    f.frame(++b);
    f.hold(b);
  });
  assert.equal(held.total, 0);
  f.frame(b + 5);
  assert.ok(Math.abs(run(f, 240).total - 0.005) < 1e-9);
  // hold without a block keeps the current anchor.
  f.frame(b + 10);
  f.hold(null);
  assert.equal(run(f, 60).total, 0);
});

test('turned off, following ignores frames and returns 0', () => {
  const f = createTipFollow();
  f.frame(10);
  assert.equal(run(f, 30).total, 0);
  f.enable(10);
  f.frame(20);
  f.disable();
  assert.equal(f.active, false);
  assert.equal(f.lag, 0);
  assert.equal(run(f, 60).total, 0);
  // Enabled before the first frame (no block yet): the first frame anchors.
  const g = createTipFollow();
  g.enable(null);
  g.frame(1000);
  assert.equal(run(g, 60).total, 0);
  g.frame(1001);
  assert.ok(Math.abs(run(g, 240).total - 0.001) < 1e-9);
});
