// Touch gesture maths (landscape/web/ui/touch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairOf, pairDelta, classifyTwoFinger, createTapTracker, CLASSIFY_PX, DOUBLE_TAP_MS, DOUBLE_TAP_PX } from '../web/ui/touch.js';

const P = (x, y) => ({ x, y });

test('pairDelta: spreading scales up, a clockwise twist (screen y down) is positive', () => {
  const a = pairOf(P(100, 300), P(200, 300));
  assert.equal(a.x, 150);
  assert.equal(a.dist, 100);
  assert.ok(Math.abs(pairDelta(a, pairOf(P(50, 300), P(250, 300))).scale - 2) < 1e-12);
  // Rotate the pair 30 degrees clockwise on screen about its midpoint.
  const r = 50;
  const t = (30 * Math.PI) / 180;
  const b = pairOf(P(150 - r * Math.cos(t), 300 - r * Math.sin(t)), P(150 + r * Math.cos(t), 300 + r * Math.sin(t)));
  const d = pairDelta(a, b);
  assert.ok(Math.abs(d.rotate - t) < 1e-9, 'clockwise twist is +30 degrees');
  assert.ok(Math.abs(d.scale - 1) < 1e-9 && Math.abs(d.dx) < 1e-9 && Math.abs(d.dy) < 1e-9);
  // Angles wrap: a small twist across the -x axis stays small.
  const c = pairDelta(pairOf(P(200, 300), P(100, 301)), pairOf(P(200, 300), P(100, 299)));
  assert.ok(Math.abs(c.rotate) < 0.05);
});

test('classifyTwoFinger: undecided until the fingers have moved', () => {
  const start = [P(140, 400), P(250, 400)];
  assert.equal(classifyTwoFinger(start, [P(143, 402), P(252, 401)]), null);
  // One finger moved a little, the other not yet: wait.
  assert.equal(classifyTwoFinger(start, [P(140, 400 - CLASSIFY_PX - 2), P(250, 400)]), null);
});

test('classifyTwoFinger: side-by-side fingers moving up or down together tilt', () => {
  const start = [P(140, 400), P(250, 400)];
  assert.equal(classifyTwoFinger(start, [P(142, 370), P(251, 372)]), 'tilt');
  assert.equal(classifyTwoFinger(start, [P(139, 430), P(249, 428)]), 'tilt');
});

test('classifyTwoFinger: pinch, twist, sideways pan and vertical moves of stacked fingers transform', () => {
  const start = [P(140, 400), P(250, 400)];
  assert.equal(classifyTwoFinger(start, [P(120, 400), P(270, 400)]), 'transform', 'pinch out');
  assert.equal(classifyTwoFinger(start, [P(160, 400), P(230, 400)]), 'transform', 'pinch in');
  assert.equal(classifyTwoFinger(start, [P(142, 385), P(248, 415)]), 'transform', 'twist');
  assert.equal(classifyTwoFinger(start, [P(165, 402), P(275, 401)]), 'transform', 'sideways pan');
  assert.equal(classifyTwoFinger([P(200, 300), P(205, 420)], [P(200, 270), P(205, 390)]), 'transform', 'stacked fingers move up: pan');
  assert.equal(classifyTwoFinger(start, [P(140, 400), P(290, 400)]), 'transform', 'one finger pivots far enough');
  assert.equal(classifyTwoFinger(start, [P(140, 375), P(250, 425)]), 'transform', 'opposite vertical moves twist');
});

test('createTapTracker: double taps need the second tap soon and nearby', () => {
  let t = 1000;
  const taps = createTapTracker({ now: () => t });
  assert.equal(taps.tap(100, 100), 'single');
  t += DOUBLE_TAP_MS - 50;
  assert.equal(taps.pending(110, 105), true);
  assert.equal(taps.tap(110, 105), 'double');
  assert.equal(taps.pending(110, 105), false, 'a double tap is not the start of another');
  assert.equal(taps.tap(110, 105), 'single');
  t += DOUBLE_TAP_MS + 1;
  assert.equal(taps.pending(110, 105), false, 'too late');
  assert.equal(taps.tap(110, 105), 'single');
  t += 50;
  assert.equal(taps.tap(110 + DOUBLE_TAP_PX + 5, 105), 'single', 'too far');
  taps.reset();
  assert.equal(taps.pending(110 + DOUBLE_TAP_PX + 5, 105), false);
});
