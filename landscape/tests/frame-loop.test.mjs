// ui/frame-loop.js: steps with a clamped dt, and failing frames reported without a flood.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFrameLoop, MAX_DT } from '../web/ui/frame-loop.js';

test('frame loop: clamped steps, an error reported once per 5 s, failing runs counted', () => {
  const frames = [];
  const steps = [];
  const errors = [];
  let fail = null;
  startFrameLoop((dt, t) => {
    steps.push(dt);
    if (fail) throw new Error(fail);
  }, { raf: (f) => frames.push(f), now: 1000, onError: (err, info) => errors.push(info) });
  const run = (t) => frames.shift()(t);
  run(1016);
  run(3000);
  run(2990);
  assert.deepEqual(steps.map((d) => +d.toFixed(3)), [0.016, MAX_DT, 0], 'a long gap is clamped; time never runs backwards');
  fail = 'boom';
  run(3010);
  run(3020);
  run(8100);
  assert.deepEqual(errors.map((e) => [e.message, e.count, e.logged]), [['boom', 1, true], ['boom', 2, false], ['boom', 3, true]]);
  fail = null;
  run(8110);
  fail = 'boom';
  run(8120);
  assert.deepEqual([errors.at(-1).count, errors.at(-1).logged], [1, false], 'a good frame ends the run; the message waits 5 s');
  assert.equal(frames.length, 1, 'every frame, failing or not, asks for the next');
});
