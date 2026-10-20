// Playback on top of the replay client (landscape/SPEC.md §5 "Playback"). Pure module:
// no DOM, no three.js; it only calls replay.advance / replay.seek and reads replay.block.
//
//   0.5x = 30 blocks/s, exact
//   1x  = 60 blocks/s, exact (every block applied by replay.advance)
//   2x  = 120 blocks/s, exact
//   5x  = 300 blocks/s, exact; when the worker is slower the playhead follows the
//         worker and state.limited reports it (the HUD shows the achieved rate)
//   Max = exact advance toward the tip with the whole frame budget
// Every speed replays every block. Only scrubbing seeks to snapshots: the snapshot at/below
// the scrub position while dragging, then an exact seek on release. Steps of 1 block use
// advance; 1,008-block steps use seek.
//
// Download pacing: the change log streams in 4 MiB chunks. When the download cannot keep up
// (always the case for Max online, and for any speed on a slow connection), the playhead
// would replay each chunk at full CPU speed and then freeze until the next one arrived.
// Instead playback runs at PACE_FLOOR x the measured download rate plus the blocks already
// downloaded spread over PACE_HORIZON_S, and never asks for blocks past the downloaded
// frontier (replay.buffer). That settles at the download rate with
// (1 - PACE_FLOOR) x PACE_HORIZON_S, about 0.9 s, of blocks in hand.
//
// Smooth exact speeds: with a client that can hold frames (replay.showThrough), the worker is asked
// for SHOW_BEHIND_S of blocks beyond the playhead and each block is shown when the playhead
// reaches it. Blocks then appear at an even pace even when the worker answers a frame late or
// pauses briefly; a longer pause holds the playhead instead of making it jump afterwards.
//
// At Bitcoin's 10-minute target, 1x shows about 10 hours of the chain every second, 36,000
// times real time (speedHint, shown as the speed buttons' tooltips).

import { fmtInt } from './format.js';

export const BASE_RATE = 60;
export const BLOCK_MINUTES = 10; // Bitcoin's target block interval
export const STEP_SMALL = 1;
export const STEP_LARGE = 1008;
// A link without a block opens at least this many blocks (about a week) before the tip, so
// Play has blocks to play.
export const START_BEFORE_TIP = 1008;
export const SPEEDS = Object.freeze([
  Object.freeze({ id: '0.5', label: '0.5\u00d7', rate: 30, policy: 'exact' }),
  Object.freeze({ id: '1', label: '1\u00d7', rate: 60, policy: 'exact' }),
  Object.freeze({ id: '2', label: '2\u00d7', rate: 120, policy: 'exact' }),
  Object.freeze({ id: '5', label: '5\u00d7', rate: 300, policy: 'exact' }),
  Object.freeze({ id: 'max', label: 'Max', rate: Infinity, policy: 'max' }),
]);
export const DEFAULT_SPEED = '1';
// Keys 0 to 4 choose the speeds in menu order (1 stays 1x).
export const SPEED_KEYS = Object.freeze({ Digit0: '0.5', Digit1: '1', Digit2: '2', Digit3: '5', Digit4: 'max' });
// While paused, gaps up to this size (steps, nudges) are covered by exact advance;
// larger jumps seek.
export const PAUSED_ADVANCE_LIMIT = 2016;
const RATE_WINDOW_MS = 1500;
const RATE_MIN_WINDOW_MS = 500;
export const PACE_FLOOR = 0.7;      // share of the download rate played with an empty buffer
export const PACE_HORIZON_S = 3;    // the downloaded blocks ahead are spread over this long
const PACE_SMOOTH_S = 0.5;          // the paced rate eases toward its goal with this time constant
const FRONTIER_WAIT_MS = 1000;      // a frontier that does not move for this long is ignored
export const SHOW_BEHIND_S = 0.1;   // exact speeds show the playhead this far behind the worker

export function speedById(id) {
  return SPEEDS.find((s) => s.id === String(id)) || SPEEDS.find((s) => s.id === DEFAULT_SPEED);
}

/**
 * How a speed compares with real time, for tooltips: blocks a second and the chain time that
 * passes every second at BLOCK_MINUTES per block (1x: 10 hours, 36,000 times real time).
 */
export function speedHint(spec) {
  if (spec.policy === 'max') return 'Max: every block, as fast as this device and connection can replay them; the HUD shows the rate';
  const minutes = spec.rate * BLOCK_MINUTES; // chain minutes per real second
  const round = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const span = minutes < 24 * 60 ? round(minutes / 60) + ' hours' : round(minutes / 1440) + ' days';
  return spec.label + ': ' + fmtInt(spec.rate) + ' blocks a second, about ' + span + ' of Bitcoin every second (' +
    fmtInt(minutes * 60) + '\u00d7 real time at 10 minutes a block)';
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
 * Download pacing from the worker's buffer report: {inflow (blocks/s the download delivers),
 * buffered (blocks downloaded past 'block'), rate (blocks/s playback can sustain)}, or null when
 * the download does not limit playback (no report or rate yet, or downloaded through the tip).
 */
export function downloadPace(buffer, block, tip) {
  if (!buffer || block == null || !Number.isFinite(buffer.frontier) || buffer.frontier >= tip) return null;
  const inflow = Number(buffer.blocksPerSec);
  if (!(inflow > 0) || !Number.isFinite(inflow)) return null;
  const buffered = Math.max(0, buffer.frontier - block);
  return { inflow, buffered, rate: PACE_FLOOR * inflow + buffered / PACE_HORIZON_S };
}

/**
 * Next worker operation while playing. Pure: all inputs are plain values.
 * paced: Max follows the target like an exact speed (download pacing) instead of running
 * to the tip with the frame budget.
 * Returns {kind: 'advance', target, budgetMs} | null.
 */
export function planPlay({ speed, block, target, tip, frameMs = 16, paced = false }) {
  const spec = speedById(speed);
  const budgetMs = frameBudgetMs(frameMs);
  if (spec.policy === 'max' && !paced) return block < tip ? { kind: 'advance', target: tip, budgetMs } : null;
  const goal = Math.min(tip, Math.floor(target));
  if (!(goal > block)) return null;
  return { kind: 'advance', target: goal, budgetMs };
}

export function createPlayback({ replay, tip, snapshots = [], now = () => performance.now() } = {}) {
  let tipBlock = tip;
  let snaps = snapshots;
  let playing = false;
  let speed = DEFAULT_SPEED;
  let target = null; // fractional playhead while playing
  let requested = null; // desired block while paused (steps, seeks)
  let op = null; // {kind, block, promise} of the operation playback is waiting for
  let advancing = 0; // advances in flight (the client allows one)
  let scrub = null; // {wasPlaying, lastSnapshot}
  let frameMs = 16.7;
  let exactRate = 0;
  let samples = [];
  let lastIssued = null;
  let paced = false; // download pacing active (see downloadPace)
  let paceRate = null; // eased paced rate, blocks/s
  let waitSince = null; // when the playhead reached the downloaded frontier
  const changeFns = new Set();
  const eventFns = new Set();

  const emitChange = () => changeFns.forEach((fn) => fn(api.state));
  const emitEvent = (type, detail) => eventFns.forEach((fn) => fn(type, detail));

  function resetRate() {
    samples = [];
    paced = false;
    paceRate = null;
    waitSince = null;
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

  const canHold = typeof replay.showThrough === 'function';
  const workerBlock = () => replay.workerBlock ?? replay.block;
  /** Exact speeds hold the worker's frames for the playhead (see SHOW_BEHIND_S). */
  function holding() {
    return canHold && playing && !scrub && speedById(speed).policy === 'exact' && !(op && op.kind === 'seek');
  }

  function kick() {
    if (op || advancing || scrub) return;
    const block = workerBlock();
    if (block == null) return;
    if (playing) {
      const ahead = holding() ? (paced && paceRate !== null ? paceRate : speedById(speed).rate) * SHOW_BEHIND_S : 0;
      const plan = planPlay({ speed, block, target: (target ?? block) + ahead, tip: tipBlock, frameMs, paced });
      if (!plan) return;
      issueAdvance(plan.target, plan.budgetMs);
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
      const pace = downloadPace(replay.buffer, replay.block, tipBlock);
      // The download, not the worker, sets the speed: Max paced below the decode rate, or an
      // exact speed paced below its nominal rate.
      const netLimited = playing && paced && paceRate !== null &&
        (spec.policy === 'max' ? !(exactRate > 0) || paceRate < exactRate * 0.9 : paceRate < spec.rate * 0.95);
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
        netLimited,
        paced: playing && paced,
        paceRate: playing && paced ? paceRate : null,
        downloadRate: pace ? pace.inflow : null,
        buffered: pace ? pace.buffered : null,
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
      if (canHold) replay.showThrough(Infinity);
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
      if (block == null || scrub) {
        if (canHold) replay.showThrough(Infinity);
        return;
      }
      if (playing) {
        const spec = speedById(speed);
        const hold = holding();
        // While a seek is pending the state will continue from the seek block, so the
        // playhead moves on from there (a stale block would cap it behind the jump).
        const base = op && op.kind === 'seek' ? op.block : workerBlock();
        const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
        const want = spec.policy === 'max' ? Infinity : spec.rate;
        const pace = op && op.kind === 'seek' ? null : downloadPace(replay.buffer, base, tipBlock);
        // Max always follows the download; an exact speed only when the download is slower.
        if (pace && (spec.policy === 'max' || pace.inflow < want)) {
          const goal = Math.min(want, pace.rate);
          paceRate = paceRate === null ? goal : paceRate + (goal - paceRate) * (1 - Math.exp(-step / PACE_SMOOTH_S));
          paced = true;
        } else {
          paced = false;
          paceRate = null;
        }
        if (spec.policy !== 'max' || paced) {
          const rate = paced ? paceRate : spec.rate;
          // Holding, the playhead trails the worker and never passes it (a worker pause holds it);
          // otherwise it runs at most a quarter second ahead of the worker.
          const from = hold ? Math.max(target ?? block, block) : Math.max(target ?? base, base);
          let next = Math.min(from + rate * step, hold ? base + 1 : base + Math.max(1, rate * 0.25), tipBlock);
          if (paced && !hold) {
            // Stay inside the downloaded blocks: past them the worker would wait for the next
            // chunk and then race through it. A frontier that stops moving is ignored after
            // FRONTIER_WAIT_MS, so a stale report cannot hold playback.
            const frontier = replay.buffer.frontier;
            if (block >= frontier) waitSince = waitSince ?? t;
            else waitSince = null;
            if (waitSince === null || t - waitSince < FRONTIER_WAIT_MS) next = Math.min(next, Math.max(base, frontier));
          } else {
            waitSince = null;
          }
          target = next;
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
      if (canHold) replay.showThrough(holding() && target !== null ? Math.floor(target) : Infinity);
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
