// Follow tip (landscape/web/ui/follow.js). Run: node --test landscape/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTipFollow, FOLLOW_TAU_S } from '../web/ui/follow.js';

const DT = 1 / 60;
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
  // A tiles or measure frame repeats the block: still nothing.
  f.frame('tiles', 300000);
  f.frame('measure', 300000);
  assert.equal(run(f, 60).total, 0);
});

test('advance frames move the camera exactly as far as the tip', () => {
  const f = createTipFollow();
  f.enable(300000);
  // 1x: one block a frame for one second, then three seconds to settle.
  let b = 300000;
  const play = run(f, 60, () => f.frame('advance', ++b));
  assert.ok(play.total > 0 && play.total < 0.06, 'trails the tip while playing (' + play.total + ')');
  const settle = run(f, 180);
  assert.ok(Math.abs(play.total + settle.total - 60 / 1000) < 1e-9, 'total ' + (play.total + settle.total));
  assert.equal(f.lag, 0);
  // At 1x the camera moves at the tip's 0.06 units a second once its trail has settled.
  const steady = createTipFollow();
  steady.enable(0);
  let s = 0;
  run(steady, 240, () => steady.frame('advance', ++s));
  const window = run(steady, 60, () => steady.frame('advance', ++s));
  assert.ok(Math.abs(window.total - 0.06) < 1e-6, 'steady speed ' + window.total + ' per second');
});

test('a burst of blocks becomes a glide, not a jump', () => {
  const f = createTipFollow();
  f.enable(500000);
  f.frame('advance', 500300);
  const k = 1 - Math.exp(-DT / FOLLOW_TAU_S);
  const r = run(f, 240);
  assert.ok(r.largest <= (300 * k) / 1000 + 1e-12, 'largest step ' + r.largest);
  assert.ok(Math.abs(r.total - 0.3) < 1e-9, 'total ' + r.total);
});

test('a backward advance moves the camera backward', () => {
  const f = createTipFollow();
  f.enable(400000);
  f.frame('advance', 399999);
  assert.ok(Math.abs(run(f, 180).total + 0.001) < 1e-9);
});

test('seeks and other jumps re-anchor without moving the camera', () => {
  const f = createTipFollow();
  f.enable(300000);
  f.frame('advance', 300030);
  const part = run(f, 3).total;
  assert.ok(part > 0);
  // A seek drops the rest of the glide and anchors at the new block.
  f.frame('seek', 305000);
  assert.equal(f.lag, 0);
  assert.equal(run(f, 120).total, 0);
  // A changed block without a reason (a stub client) also re-anchors.
  f.frame(undefined, 290000);
  assert.equal(run(f, 60).total, 0);
  // Advancing from the new anchor follows again.
  f.frame('advance', 290010);
  assert.ok(Math.abs(run(f, 240).total - 0.01) < 1e-9);
});

test('hold keeps the camera still and following resumes from there', () => {
  const f = createTipFollow();
  f.enable(600000);
  let b = 600000;
  // Plane mode: held every frame while the tip advances.
  const held = run(f, 60, () => {
    f.frame('advance', ++b);
    f.hold(b);
  });
  assert.equal(held.total, 0);
  f.frame('advance', b + 5);
  assert.ok(Math.abs(run(f, 240).total - 0.005) < 1e-9);
  // hold without a block keeps the current anchor.
  f.frame('advance', b + 10);
  f.hold(null);
  assert.equal(run(f, 60).total, 0);
});

test('turned off, following ignores frames and returns 0', () => {
  const f = createTipFollow();
  f.frame('advance', 10);
  assert.equal(run(f, 30).total, 0);
  f.enable(10);
  f.frame('advance', 20);
  f.disable();
  assert.equal(f.active, false);
  assert.equal(f.lag, 0);
  assert.equal(run(f, 60).total, 0);
  // Enabled before the first frame (no block yet): the first frame anchors.
  const g = createTipFollow();
  g.enable(null);
  g.frame('advance', 1000);
  assert.equal(run(g, 60).total, 0);
  g.frame('advance', 1001);
  assert.ok(Math.abs(run(g, 240).total - 0.001) < 1e-9);
});
