// ui_shell pure-logic tests: formatting, date <-> block, URL hash, playback policy,
// places. Run: node --test landscape/tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtBtc, fmtAge, fmtInt, fmtCompact, fmtAmount, isoUtc, escapeHtml } from '../web/ui/format.js';
import { dateToBlock, parseUtc, toDateTimeInput, blockTime } from '../web/ui/time.js';
import { encodeHash, decodeHash, encodeCam, decodeCam } from '../web/ui/hash.js';
import {
  createPlayback, planPlay, snapshotAtOrBelow, speedById, defaultStartBlock, SPEEDS, STEP_LARGE,
  START_BEFORE_TIP,
} from '../web/ui/playback.js';
import { ERAS, BANDS, bandRows, resolvePlace, eraBlock } from '../web/ui/places.js';
import { buildMinAmtTable, rowOfAmount } from '../web/data/axis.js';
import { existsSync, readFileSync } from 'node:fs';

const flush = () => new Promise((r) => setImmediate(r));

test('format mirrors the explorer', () => {
  assert.equal(fmtBtc(42430), '42,430 sat');
  assert.equal(fmtBtc(100000), '0.001 BTC');
  assert.equal(fmtBtc(123456), '0.00123456 BTC');
  assert.equal(fmtBtc(5e9), '50 BTC');
  assert.equal(fmtBtc(2100000000000000), '21,000,000 BTC');
  assert.equal(fmtAge(52560), '1.0 y');
  assert.equal(fmtAge(144), '1 d');
  assert.equal(fmtAge(10), '10 blk');
  assert.equal(fmtInt(966827), '966,827');
  assert.equal(fmtCompact(1234), '1.23K');
  assert.equal(fmtCompact(500), '500');
  assert.equal(fmtCompact(31.5), '31.5');
  assert.equal(fmtCompact(0.25), '0.25');
  assert.equal(fmtAmount(546), '546 sat');
  assert.equal(fmtAmount(5e9), '50 BTC');
  assert.equal(isoUtc(1231006505), '2009-01-03 18:15 UTC');
  assert.equal(isoUtc(1231006505, { withSeconds: true }), '2009-01-03 18:15:05 UTC');
  assert.equal(isoUtc(1231006505, { time: false }), '2009-01-03');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

// Literal port of /api/date in src/cpp/app/utxo_explorer.cpp for cross-checking.
function explorerDate(times, target) {
  const numBlocks = times.length;
  let lo = 0;
  let hi = numBlocks;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  for (let h = lo; h > 0 && h + 24 > lo; --h) {
    if (times[h - 1] >= target) best = h - 1;
  }
  return best >= numBlocks ? null : best;
}

test('dateToBlock matches the explorer on drifting timestamps', () => {
  // Monotone: first block at or after the time.
  const mono = Uint32Array.from({ length: 1000 }, (_, i) => 1e9 + i * 600);
  assert.equal(dateToBlock(mono, 1e9), 0);
  assert.equal(dateToBlock(mono, 1e9 + 600 * 500), 500);
  assert.equal(dateToBlock(mono, 1e9 + 600 * 500 - 1), 500);
  assert.equal(dateToBlock(mono, 1e9 + 600 * 999 + 1), null);
  // Out-of-order example: a later block with an earlier time.
  const drift = Uint32Array.from([100, 200, 300, 290, 400, 500]);
  assert.equal(dateToBlock(drift, 295), 2);
  // Random drift up to two hours, compared against the literal port.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const times = Uint32Array.from({ length: 5000 }, (_, i) => 1.2e9 + i * 600 + Math.floor((rnd() - 0.5) * 7200));
  for (let k = 0; k < 2000; k++) {
    const target = 1.2e9 - 4000 + Math.floor(rnd() * 5000 * 610);
    assert.equal(dateToBlock(times, target), explorerDate(times, target));
  }
  assert.equal(blockTime(times, 3), times[3]);
  assert.equal(blockTime(times, 5000), null);
});

// Real block times: the native explorer's /api/date answers (utxo_explorer, history
// 966,828 blocks, queried 2026-10-07) for dates inside the dev and full datasets.
const EXPLORER_DATES = [
  ['2009-01-09', 1], ['2010-07-17', 68607], ['2012-11-28', 209887],
  ['2013-01-01', 214563], ['2014-08-04', 313878], ['2014-11-14', 329897],
];
const REAL_BLOCKTIMES = ['/Volumes/4T Data/buv_render/landscape_966827/blocktimes.bin', '/tmp/landscape_dev/blocktimes.bin'].find((p) => existsSync(p));
test('dateToBlock on real blocktimes.bin equals the explorer /api/date', { skip: !REAL_BLOCKTIMES && 'no dataset blocktimes.bin on this machine' }, () => {
  const buf = readFileSync(REAL_BLOCKTIMES);
  const times = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  for (const [day, block] of EXPLORER_DATES) {
    if (block >= times.length) continue;
    assert.equal(dateToBlock(times, parseUtc(day)), block, day);
  }
});

test('parseUtc and datetime-local values', () => {
  assert.equal(parseUtc('2014-08-04'), Date.UTC(2014, 7, 4) / 1000);
  assert.equal(parseUtc('2014-08-04T14:31:05'), Date.UTC(2014, 7, 4, 14, 31, 5) / 1000);
  assert.equal(parseUtc('2014-08-04 14:31 UTC'), Date.UTC(2014, 7, 4, 14, 31) / 1000);
  assert.equal(parseUtc('2014-08-04T14:31:05Z'), Date.UTC(2014, 7, 4, 14, 31, 5) / 1000);
  assert.equal(parseUtc('2014-02-30'), null);
  assert.equal(parseUtc('2014-08-04T25:00'), null);
  assert.equal(parseUtc('yesterday'), null);
  assert.equal(toDateTimeInput(1231006505), '2009-01-03T18:15:05');
  assert.equal(parseUtc(toDateTimeInput(1407162665)), 1407162665);
});

test('hash round trip keeps settings untouched', () => {
  const cam = { x: 483.1204, y: 96.4, z: 402, yaw: -12.345, pitch: -35 };
  const settings = 'preset=Film&color.gamma=1.2&fx.bloom=1';
  const h = encodeHash({ block: 314000, mode: 'flight', cam }, settings);
  assert.equal(h, '#b=314000&mode=flight&cam=483.120,96.400,402.000,-12.35,-35.00&preset=Film&color.gamma=1.2&fx.bloom=1');
  const d = decodeHash(h);
  assert.equal(d.block, 314000);
  assert.equal(d.mode, 'flight');
  assert.deepEqual(d.cam, { x: 483.12, y: 96.4, z: 402, yaw: -12.35, pitch: -35 });
  assert.equal(d.settings, settings);
  // Without '#', with a leading '?' settings string, and with URLSearchParams.
  assert.deepEqual(decodeHash('b=5&mode=map'), { block: 5, mode: 'map', cam: null, settings: '' });
  assert.equal(encodeHash({ block: 7 }, '?preset=High'), '#b=7&preset=High');
  assert.equal(encodeHash({ block: 7 }, new URLSearchParams({ preset: 'Ultra' })), '#b=7&preset=Ultra');
  assert.equal(encodeHash({}), '');
  // Invalid shell values are dropped, unknown keys survive in order.
  const bad = decodeHash('#b=-3&mode=orbit&cam=1,2,3&x=1&b2=4');
  assert.equal(bad.block, null);
  assert.equal(bad.mode, null);
  assert.equal(bad.cam, null);
  assert.equal(bad.settings, 'x=1&b2=4');
  assert.equal(decodeHash('#b=12.5').block, null);
  // Yaw wraps into [-180, 180), pitch clamps, negative zero prints as 0.
  assert.deepEqual(decodeCam('0,1,2,190,-120'), { x: 0, y: 1, z: 2, yaw: -170, pitch: -89.9 });
  assert.equal(encodeCam({ x: -0.0001, y: 0, z: 0, yaw: -0.001, pitch: 0 }), '0.000,0.000,0.000,0.00,0.00');
  assert.equal(encodeCam({ x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }), null);
});

// Simulated worker: fixed exact-apply throughput (blocks/s of worker time) and a fixed
// seek latency. advance resolves when the target is reached or its budget is used; a
// seek supersedes a pending seek ({cancelled: true}) like the real client.
function simWorker({ start, rate, seekMs = 60 }) {
  // frac carries partial progress across jobs so throughput equals rate.
  const w = { block: start, calls: [], job: null, busyErrors: 0, frac: 0 };
  const resolveJob = (res) => {
    const j = w.job;
    w.job = null;
    j.resolve(res);
  };
  w.advance = (target, { budgetMs } = {}) => new Promise((resolve, reject) => {
    if (w.job) {
      w.busyErrors++;
      reject(new Error('advance while busy: ' + w.job.kind));
      return;
    }
    w.calls.push({ kind: 'advance', target, budgetMs, from: w.block });
    w.job = { kind: 'advance', target, budgetMs, elapsed: 0, blocks: 0, resolve };
  });
  w.seek = (block) => new Promise((resolve) => {
    if (w.job) {
      const j = w.job;
      w.job = null;
      j.resolve(j.kind === 'seek' ? { cancelled: true } : { block: w.block, reached: false, blocks: j.blocks, ms: j.elapsed });
    }
    w.calls.push({ kind: 'seek', block, from: w.block });
    w.job = { kind: 'seek', block, elapsed: 0, resolve };
  });
  w.run = async (ms) => {
    let left = ms;
    while (left > 1e-6 && w.job) {
      const j = w.job;
      if (j.kind === 'seek') {
        const need = seekMs - j.elapsed;
        if (left < need) {
          j.elapsed += left;
          return;
        }
        left -= need;
        w.block = j.block;
        resolveJob({ block: j.block });
      } else {
        const remaining = Math.abs(j.target - w.block);
        const tTarget = Math.max(0, ((remaining - w.frac) / rate) * 1000);
        const tBudget = Math.max(0, j.budgetMs - j.elapsed);
        const t = Math.min(left, tTarget, tBudget);
        const total = w.frac + (rate * t) / 1000;
        const n = Math.min(remaining, Math.floor(total + 1e-9));
        w.frac = n === remaining ? 0 : total - n;
        w.block += Math.sign(j.target - w.block) * n;
        j.blocks += n;
        j.elapsed += t;
        left -= t;
        if (w.block === j.target || j.elapsed >= j.budgetMs - 1e-6) {
          resolveJob({ block: w.block, reached: w.block === j.target, blocks: j.blocks, ms: j.elapsed });
        } else {
          return;
        }
      }
      await flush();
    }
  };
  return w;
}

async function setup({ start, tip, rate, seekMs, snapshots = [], speed = '1' }) {
  const clock = { t: 0 };
  const w = simWorker({ start, rate, seekMs });
  const pb = createPlayback({ replay: w, tip, snapshots, now: () => clock.t });
  const events = [];
  pb.onEvent((type, detail) => events.push({ type, detail }));
  pb.setSpeed(speed);
  const run = async (seconds, fps = 60) => {
    const dt = 1 / fps;
    for (let i = 0; i < Math.round(seconds * fps); i++) {
      clock.t += dt * 1000;
      await w.run(dt * 1000);
      pb.tick(dt);
      await flush();
    }
  };
  return { clock, w, pb, events, run };
}

test('1x plays 60 exact blocks per second', async () => {
  const { w, pb, events, run } = await setup({ start: 300000, tip: 966827, rate: 5000, speed: '1' });
  pb.play();
  await run(10);
  const advanced = w.block - 300000;
  assert.ok(Math.abs(advanced - 600) <= 3, 'advanced ' + advanced);
  assert.equal(w.calls.filter((c) => c.kind === 'seek').length, 0);
  assert.ok(w.calls.every((c) => c.target > c.from), 'forward only');
  const s = pb.state;
  assert.ok(Math.abs(s.achieved - 60) < 3, 'achieved ' + s.achieved);
  assert.equal(s.limited, false);
  assert.equal(w.busyErrors, 0);
  assert.deepEqual(events, []);
});

test('10x follows a slower worker exactly and reports it', async () => {
  const { w, pb, run } = await setup({ start: 700000, tip: 966827, rate: 350, speed: '10' });
  pb.play();
  await run(10);
  const advanced = w.block - 700000;
  assert.ok(advanced > 3300 && advanced <= 3510, 'advanced ' + advanced);
  assert.equal(w.calls.filter((c) => c.kind === 'seek').length, 0);
  const s = pb.state;
  assert.equal(s.limited, true);
  assert.ok(Math.abs(s.achieved - 350) < 35, 'achieved ' + s.achieved);
  assert.equal(w.busyErrors, 0);
});

test('10x keeps up with a fast worker', async () => {
  const { w, pb, run } = await setup({ start: 150000, tip: 966827, rate: 5400, speed: '10' });
  pb.play();
  await run(5);
  const advanced = w.block - 150000;
  assert.ok(Math.abs(advanced - 3000) <= 160, 'advanced ' + advanced);
  assert.equal(pb.state.limited, false);
});

test('100x steps snapshot to snapshot when the worker is slow', async () => {
  const snapshots = Array.from({ length: 2200 }, (_, i) => i * 450);
  const { w, pb, run } = await setup({ start: 700000, tip: 966827, rate: 350, seekMs: 80, snapshots, speed: '100' });
  pb.play();
  await run(5);
  const advanced = w.block - 700000;
  const seeks = w.calls.filter((c) => c.kind === 'seek');
  assert.ok(seeks.length > 5, 'seeks ' + seeks.length);
  assert.ok(advanced > 350 * 5 * 3, 'advanced ' + advanced);
  assert.ok(advanced <= 6000 * 5 + 450, 'not faster than 6000 blocks/s: ' + advanced);
  for (const s of seeks) {
    assert.ok(snapshots.includes(s.block), 'seek to snapshot ' + s.block);
    assert.ok(s.block > s.from, 'forward seek');
  }
  assert.equal(w.busyErrors, 0);
});

test('100x stays exact when the worker is fast enough', async () => {
  const snapshots = Array.from({ length: 200 }, (_, i) => i * 5000);
  const { w, pb, run } = await setup({ start: 100000, tip: 966827, rate: 60000, snapshots, speed: '100' });
  pb.play();
  await run(3);
  assert.equal(w.calls.filter((c) => c.kind === 'seek').length, 0);
  assert.ok(Math.abs(w.block - 100000 - 18000) <= 200, 'advanced ' + (w.block - 100000));
});

test('Max advances toward the tip with the frame budget and stops there', async () => {
  const { w, pb, events, run } = await setup({ start: 966827 - 2500, tip: 966827, rate: 1000, speed: 'max' });
  pb.play();
  await run(1);
  assert.ok(Math.abs(w.block - (966827 - 2500) - 1000) <= 40, 'advanced ' + (w.block - 966827 + 2500));
  assert.ok(w.calls.every((c) => c.kind === 'advance' && c.target === 966827));
  assert.ok(w.calls.every((c) => c.budgetMs >= 8 && c.budgetMs <= 50));
  await run(2);
  assert.equal(w.block, 966827);
  assert.equal(pb.state.playing, false);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  pb.play();
  assert.equal(pb.state.playing, false, 'cannot play past the tip');
});

test('steps: 1 block by exact advance, 1,008 by seek', async () => {
  const { w, pb, run } = await setup({ start: 5000, tip: 966827, rate: 2000, speed: '1' });
  pb.step(1);
  await run(0.1);
  assert.equal(w.block, 5001);
  pb.step(1);
  pb.step(1);
  await run(0.2);
  assert.equal(w.block, 5003);
  assert.ok(w.calls.every((c) => c.kind === 'advance'));
  pb.step(-STEP_LARGE);
  assert.deepEqual(w.calls.at(-1), { kind: 'seek', block: 5003 - 1008, from: 5003 });
  await run(0.2);
  assert.equal(w.block, 3995);
  pb.step(-1);
  await run(0.1);
  assert.equal(w.block, 3994);
  assert.equal(w.calls.at(-1).kind, 'advance');
  assert.equal(w.calls.at(-1).target, 3994);
  // Steps pause playback.
  pb.play();
  pb.step(1);
  assert.equal(pb.state.playing, false);
});

test('pause keeps the block where the in-flight advance lands (no backward replay that would clear heat)', async () => {
  const { w, pb, run } = await setup({ start: 840000, tip: 966827, rate: 2000, speed: '1' });
  pb.play();
  await run(0.5);
  pb.pause();
  const callsAtPause = w.calls.length;
  await run(0.3);
  const after = w.calls.slice(callsAtPause);
  assert.ok(after.every((c) => c.kind !== 'seek' && !(c.kind === 'advance' && c.target < c.from)), 'no backward step or seek after pause: ' + JSON.stringify(after));
  const b = w.block;
  await run(0.3);
  assert.equal(w.block, b, 'stays put once the in-flight advance has landed');
  assert.ok(b > 840000);
});

test('scrub seeks snapshots while dragging, exact on release, resumes play', async () => {
  const snapshots = [0, 450, 900, 1350, 1800];
  const { w, pb, run } = await setup({ start: 100, tip: 2000, rate: 5000, seekMs: 30, snapshots, speed: '1' });
  pb.play();
  await run(0.2);
  pb.scrubTo(1000);
  pb.scrubTo(1100);
  await run(0.1);
  pb.scrubTo(1400);
  await run(0.1);
  const seeks = w.calls.filter((c) => c.kind === 'seek').map((c) => c.block);
  assert.deepEqual(seeks, [900, 1350]);
  assert.equal(w.block, 1350);
  assert.equal(pb.state.playing, false);
  pb.scrubEnd(1420);
  await run(0.1);
  assert.equal(w.calls.filter((c) => c.kind === 'seek').at(-1).block, 1420);
  assert.equal(pb.state.playing, true, 'resumes');
  await run(1);
  assert.ok(w.block >= 1470 && w.block <= 1485, 'block ' + w.block);
});

test('user seek while playing continues from the new block', async () => {
  const { w, pb, run } = await setup({ start: 1000, tip: 966827, rate: 5000, speed: '1' });
  pb.play();
  await run(0.5);
  await Promise.all([pb.seek(314000), run(0.2)]);
  assert.ok(w.block >= 314000 && w.block <= 314015, 'block ' + w.block);
  await run(1);
  assert.ok(Math.abs(w.block - 314000 - 72) <= 4, 'block ' + w.block);
  assert.equal(w.busyErrors, 0);
});

test('planPlay and snapshot lookup', () => {
  const snaps = [0, 450, 900];
  assert.equal(snapshotAtOrBelow(snaps, 899), 450);
  assert.equal(snapshotAtOrBelow(snaps, 900), 900);
  assert.equal(snapshotAtOrBelow(snaps, 5000), 900);
  assert.equal(snapshotAtOrBelow(snaps, -1), null);
  assert.equal(snapshotAtOrBelow([], 5), null);
  // Startup without a block in the link: the latest snapshot at least a week before the tip.
  assert.equal(START_BEFORE_TIP, 1008);
  const tipSnaps = [0, 964828, 965267, 965702, 966141, 966578, 966827];
  assert.equal(defaultStartBlock(966827, tipSnaps), 965702);
  assert.equal(defaultStartBlock(966710, tipSnaps), 965702);
  assert.equal(defaultStartBlock(966709, tipSnaps), 965267);
  assert.equal(defaultStartBlock(966827, []), 966827 - 1008);
  assert.equal(defaultStartBlock(500, [0, 450, 500]), 0);
  assert.equal(planPlay({ speed: '1', block: 10, target: 10.9, tip: 100, snapshots: snaps }), null);
  assert.deepEqual(planPlay({ speed: '1', block: 10, target: 11.2, tip: 100, snapshots: snaps, frameMs: 16.7 }), { kind: 'advance', target: 11, budgetMs: 17 });
  assert.deepEqual(planPlay({ speed: '100', block: 0, target: 2000, tip: 5000, snapshots: snaps, exactRate: 300 }), { kind: 'seek', block: 900 });
  assert.equal(planPlay({ speed: '100', block: 0, target: 2000, tip: 5000, snapshots: snaps, exactRate: 50000 }).kind, 'advance');
  assert.deepEqual(planPlay({ speed: 'max', block: 0, target: 0, tip: 5000, snapshots: snaps, frameMs: 100 }), { kind: 'advance', target: 5000, budgetMs: 50 });
  assert.equal(speedById('nope').id, '1');
  assert.deepEqual(SPEEDS.map((s) => s.label), ['1\u00d7', '10\u00d7', '100\u00d7', 'Max']);
});

test('places resolve eras and amount bands on the film rows', () => {
  const minAmt = buildMinAmtTable();
  assert.equal(minAmt.length, 2072);
  const rows = Object.fromEntries(BANDS.map((b) => [b.id, bandRows(minAmt, b)]));
  assert.deepEqual(rows.coinbase50, { rowMin: rowOfAmount(minAmt, 5e9), rowMax: rowOfAmount(minAmt, 5e9) });
  assert.deepEqual(rows.whale, { rowMin: 0, rowMax: rowOfAmount(minAmt, 1e9) });
  assert.equal(rows.sat1to100.rowMax, 2071);
  assert.equal(rows.sat1to100.rowMin, rowOfAmount(minAmt, 100));
  // Larger amounts sit on smaller rows.
  const order = ['coinbase50', 'btc1', 'sat10000', 'dust546'].map((id) => rows[id].rowMin);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // 50 BTC lies inside the white-hot region (>= 10 BTC).
  assert.ok(rows.coinbase50.rowMin <= rows.whale.rowMax);
  const ctx = { tip: 966827, minAmt };
  assert.deepEqual(resolvePlace('b314000', ctx), { kind: 'era', id: 'b314000', block: 314000, title: 'A denser field' });
  assert.equal(resolvePlace('314000', ctx).block, 314000);
  assert.equal(resolvePlace(210000, ctx).block, 210000);
  assert.equal(resolvePlace('tip', ctx).block, 966827);
  assert.equal(resolvePlace('b900000', { tip: 400000, minAmt }).block, 400000);
  assert.equal(resolvePlace(5e6, ctx).block, 966827);
  assert.equal(resolvePlace({ band: 'btc1' }, ctx).kind, 'band');
  assert.equal(resolvePlace({ block: 50000 }, ctx).block, 50000);
  assert.equal(resolvePlace('nowhere', ctx), null);
  assert.equal(ERAS.length, 10);
  assert.equal(eraBlock(ERAS.at(-1), 1234), 1234);
});
