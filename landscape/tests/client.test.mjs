// End-to-end tests of client/replay-client.js driving the replay engine (in-process
// worker) over a synthetic dataset in the SPEC §4 format (owner: js_replay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayClient } from '../web/client/replay-client.js';
import { SLOT_CELLS, tileOfCell } from '../web/data/grid.js';
import { packFull } from '../web/replay/pack.js';
import { writeDataset, fileSource, inProcessWorker, ReferenceState, rng } from './replay-fixtures.mjs';

const dir = mkdtempSync(join(tmpdir(), 'landscape-client-test-'));
const ds = await writeDataset(dir, { numBlocks: 20000, seed: 11, chunkBytes: 48 * 1024, snapshotIntervalBytes: 160 * 1024 });
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ref = new ReferenceState(ds.grid, ds.rows);
let refBlock = -1;
function moveReference(target) {
  while (refBlock < target) ref.applyBlock(ds.blocks[++refBlock].changes, 1);
  while (refBlock > target) ref.applyBlock(ds.blocks[refBlock--].changes, -1);
}

function applyFrameToMirror(mirror, frame) {
  for (const id of frame.evicted) mirror.delete(id);
  for (const f of frame.full) mirror.set(f.id, f.empty ? new Float32Array(SLOT_CELLS * 4) : new Float32Array(f.data));
  const d = frame.deltas;
  for (let k = 0; k < d.ids.length; k++) {
    const m = mirror.get(d.ids[k]);
    if (!m) throw new Error('delta for tile ' + d.ids[k] + ' not held by the main thread');
    for (let i = d.offsets[k]; i < d.offsets[k + 1]; i++) m.set(d.data.subarray(i * 4, i * 4 + 4), d.index[i] * 4);
  }
}

function checkExact(engine, block, where) {
  moveReference(block);
  const st = engine.state;
  assert.equal(st.block, block, where + ': state block');
  const want = ref.tiles();
  for (let id = 0; id < st.slotOf.length; id++) {
    const s = st.slotOf[id];
    if (s === null) continue;
    const w = want.get(id);
    const c = s.cells;
    for (let i = 0; i < c.length; i++) {
      const e = w ? w[i] : 0;
      if (c[i] !== e) assert.fail(where + ': tile ' + id + ' cell ' + (i >> 2) + ' field ' + (i & 3) + ' ' + c[i] + ' != ' + e);
    }
  }
  const t = st.totals;
  assert.deepEqual([t[0], t[1], t[2], t[3]], [ref.totals.countSmall, ref.totals.satsSmall, ref.totals.countLarge, ref.totals.satsLarge], where + ': totals');
}

function checkMirror(engine, mirror, where) {
  const st = engine.state;
  for (const [id, m] of mirror) {
    assert.ok(st.slotOf[id] !== null && st.delivered[id], where + ': mirror holds undelivered tile ' + id);
    const want = packFull(st.slotOf, st.slotOf[id], engine.hm, engine.cm) || new Float32Array(SLOT_CELLS * 4);
    for (let i = 0; i < want.length; i++) {
      if (m[i] !== want[i]) assert.fail(where + ': tile ' + id + ' slot cell ' + (i >> 2) + ' field ' + (i & 3) + ' mirror ' + m[i] + ' fresh ' + want[i]);
    }
  }
  for (let id = 0; id < st.slotOf.length; id++) if (st.delivered[id]) assert.ok(mirror.has(id), where + ': delivered tile ' + id + ' missing');
}

const settle = () => new Promise((r) => setImmediate(r));
async function waitFor(cond, ms = 20000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('client + engine: exact seeks, advances, residency, cells, measures', { timeout: 300000 }, async () => {
  const worker = inProcessWorker(fileSource(dir));
  const replay = await createReplayClient({ worker, dataUrl: '/dataset/', maxResidentTiles: 40, chunkCacheMB: 2 });
  const engine = worker.engine();
  const grid = replay.grid;
  // Synthetic grid (20000 blocks): L0 ids 0-17 (2 x 9), L1 18-22, L2 23-25, L3 26-27, L4 28, L5 29, L6 30.
  const TOP = grid.tiles - 1;
  assert.equal(TOP, 30);
  assert.equal(grid.numBlocks, 20000);
  assert.equal(replay.rows.length, 2072);
  assert.equal(replay.rows[49], 779521282186);
  assert.equal(replay.blocktimes.length, 20000);
  assert.equal(replay.blocktimes[123], ds.blocks[123].time);
  assert.deepEqual(replay.snapshotBlocks, ds.snapshots.map((s) => s.block));
  assert.ok(replay.snapshotBlocks.length >= 10, replay.snapshotBlocks.length + ' snapshots');
  assert.equal(replay.block, null);

  const mirror = new Map();
  const frames = [];
  const errors = [];
  const statuses = [];
  replay.onFrame((f) => {
    frames.push({ seq: f.seq, block: f.block, reason: f.reason, partial: f.partial, full: f.full.length, evicted: f.evicted.length,
      deltas: f.deltas.index.length, blocksApplied: f.stats.blocksApplied, residentTiles: f.stats.residentTiles });
    assert.equal(f.meta.block, f.block);
    if (frames.length > 1) assert.ok(f.seq > frames[frames.length - 2].seq, 'frame seq increases');
    applyFrameToMirror(mirror, f);
  });
  replay.onError((e) => errors.push(e));
  replay.onStatus((s) => statuses.push(s));

  // Before the first seek: advance and cell answer without state.
  assert.deepEqual(await replay.advance(10), { block: null, reached: false, blocks: 0, ms: 0 });
  assert.equal(await replay.cell(0, 0, 0), null);

  const all = Array.from({ length: grid.tiles }, (_, i) => i);
  replay.setTiles(all);
  replay.setMeasures({ height: 'density', color: 'value' });
  replay.setHeatHalfLife(25);

  const targets = [0, 19999, 5000, 5003, 4990, 12345, 12000, ...replay.snapshotBlocks.slice(3, 6), replay.snapshotBlocks[7] + 1, replay.snapshotBlocks[8] - 1, 1, 19998];
  const r = rng(4);
  for (let i = 0; i < 8; i++) targets.push(Math.floor(r() * 20000));
  const kinds = new Set();
  for (const T of targets) {
    const res = await replay.seek(T);
    assert.equal(res.block, T, 'seek ' + T);
    kinds.add(res.plan.kind);
    assert.equal(replay.block, T);
    assert.equal(replay.meta.block, T);
    assert.equal(replay.meta.time, ds.blocks[T].time);
    checkExact(engine, T, 'seek ' + T);
    checkMirror(engine, mirror, 'seek ' + T);
  }
  assert.ok(kinds.has('current') && (kinds.has('below') || kinds.has('above')), 'plans used: ' + [...kinds]);
  assert.ok(frames.some((f) => f.partial), 'a snapshot seek emits a partial coarse frame first');

  // Advance forward in small budgets, then backward, exactly.
  await replay.seek(9000);
  const statsFrom = frames.length;
  let block = 9000;
  while (block < 9400) {
    const a = await replay.advance(9400, { budgetMs: 0 });
    assert.ok(a.blocks >= 1 && a.block > block, 'advance makes progress');
    block = a.block;
  }
  // Frame accounting: blocks reported by advance frames add up to the blocks advanced.
  await settle();
  const advFrames = frames.slice(statsFrom).filter((f) => f.reason === 'advance');
  assert.equal(advFrames.reduce((s, f) => s + f.blocksApplied, 0), 400);
  assert.equal(advFrames[advFrames.length - 1].block, 9400);
  checkExact(engine, 9400, 'advance forward');
  checkMirror(engine, mirror, 'advance forward');
  assert.ok(engine.state.slotOf[TOP].heatActive, 'forward playback accumulates heat');
  const back = await replay.advance(9350, { budgetMs: 1000 });
  assert.deepEqual([back.block, back.reached, back.blocks], [9350, true, 50]);
  assert.equal(engine.state.slotOf[TOP].heatActive, false, 'backward steps clear heat');
  checkExact(engine, 9350, 'advance backward');
  checkMirror(engine, mirror, 'advance backward');

  // Queued advances: one in flight, the latest queued call wins.
  const p1 = replay.advance(9360, { budgetMs: 1000 });
  const p2 = replay.advance(9370, { budgetMs: 1000 });
  const p3 = replay.advance(9380, { budgetMs: 1000 });
  const [a1, a2, a3] = await Promise.all([p1, p2, p3]);
  assert.equal(a1.block, 9360);
  assert.deepEqual(a2, { cancelled: true });
  assert.equal(a3.block, 9380);
  checkExact(engine, 9380, 'queued advances');

  // Cells equal the reference at every level.
  moveReference(9380);
  for (let i = 0; i < 60; i++) {
    const level = Math.floor(r() * 7);
    const L = grid.levels[level];
    const col = Math.floor(r() * L.columns);
    const row = Math.floor(r() * L.rows);
    const c = await replay.cell(level, col, row);
    const w = ref.cellAt(level, col, row);
    assert.deepEqual([c.countSmall, c.satsSmall, c.countLarge, c.satsLarge, c.block], [...w, 9380], 'cell ' + [level, col, row]);
  }
  assert.equal(await replay.cell(0, grid.l0Columns, 0), null);

  // Residency: a small set; non-desired tiles are evicted from the main thread.
  const small = [TOP, 29, 28, 26, 23, 18, 0, 1, 2];
  replay.setTiles(small);
  await waitFor(() => [...mirror.keys()].sort((a, b) => a - b).join() === [...new Set(small)].sort((a, b) => a - b).join());
  checkMirror(engine, mirror, 'small residency');
  // Pinned cell load: tile 17 (bottom-right L0) is not desired; cell() loads it exactly.
  moveReference(9380);
  const L0 = grid.levels[0];
  const c17 = await replay.cell(0, L0.columns - 1, L0.rows - 1);
  assert.deepEqual([c17.countSmall, c17.satsSmall, c17.countLarge, c17.satsLarge], ref.cellAt(0, L0.columns - 1, L0.rows - 1));
  assert.equal(tileOfCell(grid, 0, L0.columns - 1, L0.rows - 1), 17);
  assert.equal(await replay.cell(0, 300, 3, { load: false }) !== undefined, true);

  // Residency change during playback: new tiles load from a snapshot and catch up while the
  // state keeps moving; every step stays exact.
  const moving = [TOP, 3, 4, 5, 6, 7, 8, 9, 10, 19, 20, 24];
  replay.setTiles(moving);
  block = 9380;
  for (let i = 0; i < 120; i++) {
    const a = await replay.advance(block + 3, { budgetMs: 2 });
    block = a.block;
    await settle();
  }
  await waitFor(() => moving.every((id) => mirror.has(id)));
  checkExact(engine, block, 'catch-up during playback');
  checkMirror(engine, mirror, 'catch-up during playback');

  // Measures: a 'measure' frame resends delivered tiles with the new values.
  const before = frames.length;
  replay.setMeasures({ height: 'count', color: 'density' });
  await waitFor(() => frames.slice(before).some((f) => f.reason === 'measure'));
  checkMirror(engine, mirror, 'measure change');

  // Latest seek wins.
  const s1 = replay.seek(100);
  const s2 = replay.seek(15000);
  const s3 = replay.seek(7000);
  const [x1, x2, x3] = await Promise.all([s1, s2, s3]);
  assert.deepEqual(x2, { cancelled: true });
  assert.ok(x1.cancelled || x1.block === 100);
  assert.equal(x3.block, 7000);
  assert.equal(replay.block, 7000);
  checkExact(engine, 7000, 'latest seek wins');
  await waitFor(() => !engine.group && engine.pendingTileCount() === 0);
  checkMirror(engine, mirror, 'latest seek wins');

  assert.ok(statuses.some((s) => s.phase === 'seek' && s.busy));
  await waitFor(() => statuses[statuses.length - 1].busy === false);
  assert.equal(replay.busy, false);
  assert.deepEqual(errors.map((e) => e.message), []);
  const last = frames[frames.length - 1];
  assert.ok(last.seq > 0);
  replay.dispose();
  assert.deepEqual(await replay.seek(5), { cancelled: true });
});

test('client rejects unknown measures and reports init errors', async () => {
  const worker = inProcessWorker(fileSource(dir));
  const replay = await createReplayClient({ worker });
  assert.throws(() => replay.setMeasures({ height: 'height' }), /unknown measure/);
  replay.dispose();
  const bad = inProcessWorker(fileSource(join(dir, 'missing')));
  await assert.rejects(createReplayClient({ worker: bad }), /init failed/);
});
