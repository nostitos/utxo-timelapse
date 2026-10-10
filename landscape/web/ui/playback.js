// Playback on top of the replay client (landscape/SPEC.md §5 "Playback"). Pure module:
// no DOM, no three.js; it only calls replay.advance / replay.seek and reads replay.block.
//
//   1x   = 60 blocks/s, exact (every block applied by replay.advance)
//   10x  = 600 blocks/s, exact; when the worker is slower the playhead follows the
//          worker and state.limited reports it (the HUD shows the achieved rate)
//   100x = target moves at 6,000 blocks/s; exact advance while the gap is small, else a
//          seek to the largest snapshot <= target (snapshot to snapshot)
//   Max  = exact advance toward the tip with the whole frame budget
// Scrubbing seeks to the snapshot at/below the scrub position while dragging, then
// seeks exactly on release. Steps of 1 block use advance; 1,008-block steps use seek.

export const BASE_RATE = 60;
export const STEP_SMALL = 1;
export const STEP_LARGE = 1008;
// A link without a block opens at least this many blocks (about a week) before the tip, so
// Play has blocks to play.
export const START_BEFORE_TIP = 1008;
export const SPEEDS = Object.freeze([
  Object.freeze({ id: '1', label: '1\u00d7', rate: 60, policy: 'exact' }),
  Object.freeze({ id: '10', label: '10\u00d7', rate: 600, policy: 'exact' }),
  Object.freeze({ id: '100', label: '100\u00d7', rate: 6000, policy: 'snapshot' }),
  Object.freeze({ id: 'max', label: 'Max', rate: Infinity, policy: 'max' }),
]);
// While paused, gaps up to this size (steps, nudges) are covered by exact advance;
// larger jumps seek.
export const PAUSED_ADVANCE_LIMIT = 2016;
const RATE_WINDOW_MS = 1500;
const RATE_MIN_WINDOW_MS = 500;

export function speedById(id) {
  return SPEEDS.find((s) => s.id === String(id)) || SPEEDS[0];
}

/** Largest snapshot block <= b in a sorted array, or null. */
export function snapshotAtOrBelow(blocks, b) {
  if (!blocks || !blocks.length || !(b >= blocks[0])) return null;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (blocks[mid] <= b) lo = mid;
    else hi = mid - 1;
  }
  return blocks[lo];
}

/**
 * Startup block when the link names none: the latest snapshot at least START_BEFORE_TIP
 * blocks before the tip, which loads without replay (1,008 to about 1,450 blocks back with
 * the published snapshot spacing), or that block itself when there are no snapshots.
 */
export function defaultStartBlock(tip, snapshots) {
  const goal = Math.max(0, tip - START_BEFORE_TIP);
  return snapshotAtOrBelow(snapshots, goal) ?? goal;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Budget handed to the worker per advance: about one display frame. */
export function frameBudgetMs(frameMs) {
  return clamp(Math.round(Number.isFinite(frameMs) ? frameMs : 16), 8, 50);
}

/**
 * Next worker operation while playing. Pure: all inputs are plain values.
 * Returns {kind: 'advance', target, budgetMs} | {kind: 'seek', block} | null.
 */
export function planPlay({ speed, block, target, tip, snapshots, exactRate = 0, frameMs = 16 }) {
  const spec = speedById(speed);
  const budgetMs = frameBudgetMs(frameMs);
  if (spec.policy === 'max') return block < tip ? { kind: 'advance', target: tip, budgetMs } : null;
  const goal = Math.min(tip, Math.floor(target));
  if (!(goal > block)) return null;
  if (spec.policy === 'exact') return { kind: 'advance', target: goal, budgetMs };
  // 100x: exact when the worker can close the gap quickly, else snapshot to snapshot.
  const small = Math.max(spec.rate / BASE_RATE, (exactRate || 0) * 0.25);
  if (goal - block <= small) return { kind: 'advance', target: goal, budgetMs };
  const s = snapshotAtOrBelow(snapshots, goal);
  if (s !== null && s - block > small) return { kind: 'seek', block: s };
  return { kind: 'advance', target: goal, budgetMs };
}

/**
 * Lead the playhead target may have over the delivered block. Exact speeds keep a
 * quarter second of lead so a slow worker is followed rather than skipped; 100x allows
 * one second so snapshot seeks always have somewhere to go.
 */
export function maxLead(speed) {
  const spec = speedById(speed);
  if (spec.policy === 'exact') return Math.max(1, spec.rate * 0.25);
  if (spec.policy === 'snapshot') return spec.rate;
  return Infinity;
}

export function createPlayback({ replay, tip, snapshots = [], now = () => performance.now() } = {}) {
  let tipBlock = tip;
  let snaps = snapshots;
  let playing = false;
  let speed = '1';
  let target = null; // fractional playhead while playing
  let requested = null; // desired block while paused (steps, seeks)
  let op = null; // {kind, block, promise} of the operation playback is waiting for
  let advancing = 0; // advances in flight (the client allows one)
  let scrub = null; // {wasPlaying, lastSnapshot}
  let frameMs = 16.7;
  let exactRate = 0;
  let samples = [];
  let lastIssued = null;
  const changeFns = new Set();
  const eventFns = new Set();

  const emitChange = () => changeFns.forEach((fn) => fn(api.state));
  const emitEvent = (type, detail) => eventFns.forEach((fn) => fn(type, detail));

  function resetRate() {
    samples = [];
  }

  function sampleRate(t) {
    const b = replay.block;
    if (!playing || b == null) return;
    samples.push([t, b]);
    while (samples.length > 2 && t - samples[1][0] >= RATE_WINDOW_MS) samples.shift();
  }

  function achievedRate() {
    if (samples.length < 2) return null;
    const [t0, b0] = samples[0];
    const [t1, b1] = samples[samples.length - 1];
    if (t1 - t0 < RATE_MIN_WINDOW_MS) return null;
    return ((b1 - b0) * 1000) / (t1 - t0);
  }

  function finish(myOp, fail) {
    if (op === myOp) op = null;
    if (fail) {
      playing = false;
      emitEvent('error', fail);
      emitChange();
    }
  }

  // Call the client synchronously so requests keep their order; a synchronous throw
  // becomes a rejected promise.
  function call(fn) {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function issueAdvance(targetBlock, budgetMs) {
    const myOp = { kind: 'advance', block: targetBlock };
    op = myOp;
    advancing++;
    lastIssued = myOp;
    myOp.promise = call(() => replay.advance(targetBlock, { budgetMs }))
      .then((res) => {
        advancing--;
        if (res && res.blocks > 0 && res.ms > 0) {
          const inst = (res.blocks * 1000) / res.ms;
          exactRate = exactRate ? exactRate * 0.7 + inst * 0.3 : inst;
        }
        finish(myOp);
        kick();
        return res;
      }, (err) => {
        advancing--;
        finish(myOp, err);
        throw err;
      });
    myOp.promise.catch(() => {});
    return myOp.promise;
  }

  function issueSeek(block) {
    const myOp = { kind: 'seek', block };
    op = myOp;
    lastIssued = myOp;
    myOp.promise = call(() => replay.seek(block))
      .then((res) => {
        finish(myOp);
        if (!(res && res.cancelled)) kick();
        return res;
      }, (err) => {
        finish(myOp, err);
        throw err;
      });
    myOp.promise.catch(() => {});
    return myOp.promise;
  }

  function kick() {
    if (op || advancing || scrub) return;
    const block = replay.block;
    if (block == null) return;
    if (playing) {
      const plan = planPlay({ speed, block, target: target ?? block, tip: tipBlock, snapshots: snaps, exactRate, frameMs });
      if (!plan) return;
      if (plan.kind === 'seek') issueSeek(plan.block);
      else issueAdvance(plan.target, plan.budgetMs);
      return;
    }
    if (requested == null || requested === block) return;
    if (Math.abs(requested - block) <= PAUSED_ADVANCE_LIMIT) issueAdvance(requested, 50);
    else issueSeek(requested);
  }

  const api = {
    get state() {
      const spec = speedById(speed);
      const achieved = achievedRate();
      return {
        playing,
        speed,
        label: spec.label,
        rate: spec.rate,
        policy: spec.policy,
        block: replay.block,
        target: playing ? target : requested,
        achieved,
        exactRate,
        limited: playing && spec.policy === 'exact' && achieved != null && achieved < spec.rate * 0.9,
        op: op ? op.kind : null,
        scrubbing: !!scrub,
        tip: tipBlock,
      };
    },
    get lastOperation() {
      return lastIssued ? { kind: lastIssued.kind, block: lastIssued.block } : null;
    },
    setTip(t) {
      tipBlock = t;
    },
    setSnapshots(s) {
      snaps = s || [];
    },
    play() {
      if (playing) return;
      if (replay.block == null) return;
      if (replay.block >= tipBlock) {
        emitEvent('end', { block: replay.block });
        return;
      }
      playing = true;
      target = replay.block;
      requested = null;
      resetRate();
      emitChange();
      kick();
    },
    pause() {
      if (!playing) return;
      playing = false;
      // Keep the block where the in-flight exact advance lands. Returning to the block shown
      // at the moment of the click would be a backward replay, and backward replays clear the
      // spend heat, so the flashes the user paused to look at would vanish.
      requested = null;
      target = null;
      resetRate();
      emitChange();
    },
    toggle() {
      if (playing) api.pause();
      else api.play();
    },
    setSpeed(id) {
      const spec = speedById(id);
      if (spec.id === speed) return;
      speed = spec.id;
      if (playing && replay.block != null) target = replay.block;
      resetRate();
      emitChange();
    },
    /** Exact seek; playback keeps playing from the new block when it was playing. */
    seek(block) {
      const b = clamp(Math.round(block), 0, tipBlock);
      if (playing) target = b;
      else requested = b;
      resetRate();
      emitChange();
      return issueSeek(b);
    },
    step(n) {
      if (replay.block == null) return null;
      if (playing) api.pause();
      const base = requested ?? replay.block;
      const dest = clamp(base + n, 0, tipBlock);
      requested = dest;
      emitChange();
      if (Math.abs(n) >= STEP_LARGE) return issueSeek(dest);
      kick();
      return op ? op.promise : null;
    },
    scrubTo(block) {
      const b = clamp(Math.round(block), 0, tipBlock);
      if (!scrub) {
        scrub = { wasPlaying: playing, lastSnapshot: null };
        if (playing) {
          playing = false;
          target = null;
          resetRate();
        }
        emitChange();
      }
      const s = snapshotAtOrBelow(snaps, b) ?? b;
      if (s === scrub.lastSnapshot) return null;
      scrub.lastSnapshot = s;
      requested = s;
      return issueSeek(s);
    },
    scrubEnd(block) {
      const wasPlaying = scrub ? scrub.wasPlaying : false;
      scrub = null;
      const b = clamp(Math.round(block), 0, tipBlock);
      requested = b;
      emitChange();
      const p = issueSeek(b);
      if (wasPlaying) {
        p.then((res) => {
          if (!(res && res.cancelled) && !scrub) api.play();
        }, () => {});
      }
      return p;
    },
    /** Called once per animation frame with the elapsed seconds. */
    tick(dt) {
      const t = now();
      if (Number.isFinite(dt) && dt > 0) frameMs = frameMs * 0.9 + Math.min(dt * 1000, 100) * 0.1;
      const block = replay.block;
      if (block == null || scrub) return;
      if (playing) {
        const spec = speedById(speed);
        if (spec.policy !== 'max') {
          // While a seek is pending the state will continue from the seek block, so the
          // playhead moves on from there (a stale block would cap it behind the jump).
          const base = op && op.kind === 'seek' ? op.block : block;
          const from = Math.max(target ?? base, base);
          target = Math.min(from + spec.rate * Math.min(dt, 0.25), base + maxLead(speed), tipBlock);
        }
        if (block >= tipBlock && !op && !advancing) {
          playing = false;
          requested = block;
          target = null;
          resetRate();
          emitChange();
          emitEvent('end', { block });
          return;
        }
      }
      kick();
      sampleRate(t);
    },
    onChange(fn) {
      changeFns.add(fn);
      return () => changeFns.delete(fn);
    },
    onEvent(fn) {
      eventFns.add(fn);
      return () => eventFns.delete(fn);
    },
  };
  return api;
}
