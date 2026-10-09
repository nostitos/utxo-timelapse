// Tests for landscape/web/render/terrain/labels.js (owner: render_terrain).
// Pure Node: no three.js and no browser. Cameras are hand-built column-major matrices laid
// out like three.js (projectionMatrix x matrixWorldInverse); createAxisLabels runs against a
// minimal fake DOM that counts every style and text write.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../web/render/terrain/labels.js';
import { gridFromManifest, worldX, worldZ } from '../web/data/grid.js';
import { buildMinAmtTable, rowOfAmount } from '../web/data/axis.js';

const NUM_BLOCKS = 966828;
const grid = gridFromManifest({ numBlocks: NUM_BLOCKS });
const table = buildMinAmtTable();
const W = worldX(NUM_BLOCKS);
const D = worldZ(grid.rows);
const GENESIS_TIME = 1231006505;
const synthetic = new Uint32Array(NUM_BLOCKS);
for (let i = 0; i < NUM_BLOCKS; i++) synthetic[i] = GENESIS_TIME + 600 * i;
const VW = 1600;
const VH = 900;
const FRONT = [W / 2, 0.35 * W, D + 0.55 * W];
const CENTER = [W / 2, 0, D / 2];
const NEAR_EDGE = D + L.BLOCK_EDGE_OFFSET;
const FAR_EDGE = -L.BLOCK_EDGE_OFFSET;

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Perspective projection as three.js builds it (column-major). depth: 'webgl' (z in
// [-1, 1]), 'webgpu' (z in [0, 1]) or 'reversed' (reversed [0, 1]).
function perspective(fovDeg, aspect, near, far, depth = 'webgl') {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const m = new Array(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  if (depth === 'webgl') {
    m[10] = -(far + near) / (far - near);
    m[14] = (-2 * far * near) / (far - near);
  } else if (depth === 'webgpu') {
    m[10] = -far / (far - near);
    m[14] = (-far * near) / (far - near);
  } else {
    m[10] = near / (far - near);
    m[14] = (far * near) / (far - near);
  }
  return m;
}

// View matrix (matrixWorldInverse) of a camera at eye looking at target, up = +y.
function lookAtView(eye, target) {
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function mulVec(m, v) {
  const r = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i] += m[j * 4 + i] * v[j];
  return r;
}

function cameraAt(eye, target, { fov = 50, w = VW, h = VH, depth = 'webgl' } = {}) {
  const view = lookAtView(eye, target);
  const proj = perspective(fov, w / h, 0.5, 20000, depth);
  return { proj, view, viewProj: L.viewProjection(proj, view), position: { x: eye[0], y: eye[1], z: eye[2] }, w, h };
}

function decade(step) {
  const k = Math.floor(Math.log10(step) + 1e-9);
  return { k, mantissa: Math.round(step / 10 ** k) };
}
function isNice(step) {
  const { k, mantissa } = decade(step);
  return [1, 2, 5].includes(mantissa) && Math.abs(step - mantissa * 10 ** k) < 1e-9 * step;
}
function previousNice(step) {
  const { mantissa } = decade(step);
  return mantissa === 5 ? step * 0.4 : step / 2;
}

const TICK_ROWS = L.amountTicks(table).map((t) => t.row);

// Invariants every layout must satisfy.
function checkLayout(out, cam, blocktimes = synthetic) {
  const margin = L.VIEW_MARGIN_PX;
  assert.ok(out.blockStep >= L.MIN_BLOCK_STEP && isNice(out.blockStep), 'blockStep ' + out.blockStep);
  assert.ok(Object.isFrozen(out.amountRows), 'amountRows frozen');
  for (let i = 1; i < out.amountRows.length; i++) assert.ok(out.amountRows[i] > out.amountRows[i - 1], 'amountRows ascending');
  for (const r of out.amountRows) assert.ok(TICK_ROWS.includes(r), 'row ' + r + ' is a decade row');
  for (const l of out.labels) {
    assert.ok(l.depth > 0, l.text + ' in front of the camera');
    assert.ok(l.x >= -margin && l.x <= cam.w + margin && l.y >= -margin && l.y <= cam.h + margin, l.text + ' on screen');
    assert.ok(l.left >= -1 && l.top >= -1 && l.left + l.w <= cam.w + 1 && l.top + l.h <= cam.h + 1, l.text + ' text box fits on screen');
    assert.ok(Math.abs(Math.max(Math.abs(l.ux), Math.abs(l.uy)) - 1) < 1e-9, l.text + ' outward direction normalised');
    let world;
    if (l.kind === 'block') {
      assert.equal(l.block % out.blockStep, 0, l.text + ' on a multiple of blockStep');
      assert.ok(l.block >= 0 && l.block < NUM_BLOCKS);
      assert.equal(l.text, L.formatBlockLabel(l.block, blocktimes));
      world = [worldX(l.block), 0, out.blockEdgeZ];
    } else {
      assert.equal(l.kind, 'amount');
      assert.equal(l.text, L.formatAmount(l.sats));
      assert.equal(l.row, rowOfAmount(table, l.sats));
      assert.ok(out.amountRows.includes(l.row), 'shown amount row ' + l.row + ' is in amountRows');
      world = [out.amountEdgeX, 0, worldZ(l.row + 0.5)];
    }
    const p = L.projectToScreen(cam.viewProj, world[0], world[1], world[2], cam.w, cam.h);
    assert.ok(p.visible && Math.abs(p.x - l.x) < 1e-6 && Math.abs(p.y - l.y) < 1e-6, l.text + ' anchor is its projected world point');
  }
  for (let i = 0; i < out.labels.length; i++) {
    for (let j = i + 1; j < out.labels.length; j++) {
      const a = out.labels[i];
      const b = out.labels[j];
      const overlap = a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
      assert.ok(!overlap, 'boxes of ' + a.text + ' and ' + b.text + ' overlap');
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (a.kind === 'block' && b.kind === 'block') assert.ok(dist >= L.BLOCK_LABEL_GAP_PX, a.text + ' / ' + b.text + ': ' + dist.toFixed(1) + ' px');
      if (a.kind === 'amount' && b.kind === 'amount') assert.ok(dist >= L.AMOUNT_LABEL_GAP_PX, a.text + ' / ' + b.text + ': ' + dist.toFixed(1) + ' px');
    }
  }
}

// The exact clip interval of the labelled edge agrees with dense sampling of that edge.
function checkRange(out, cam, n = 20000) {
  let lo = -1;
  let hi = -1;
  for (let i = 0; i <= n; i++) {
    if (L.projectToScreen(cam.viewProj, (i / n) * W, 0, out.blockEdgeZ, cam.w, cam.h).visible) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  assert.ok(lo >= 0, 'sampling finds the labelled edge on screen');
  const tol = (NUM_BLOCKS / n) * 1.001;
  const sampled = [(lo / n) * NUM_BLOCKS, (hi / n) * NUM_BLOCKS];
  assert.ok(Math.abs(out.blockRange[0] - sampled[0]) <= tol && Math.abs(out.blockRange[1] - sampled[1]) <= tol,
    JSON.stringify({ clip: out.blockRange, sampled }));
}

test('niceStep: smallest 1-2-5 step at or above span/maxTicks, never below 1,000 blocks', () => {
  const cases = [
    [0, 8, 1000], [8000, 8, 1000], [8000.5, 8, 2000], [16000, 8, 2000], [16001, 8, 5000],
    [40000, 8, 5000], [40001, 8, 10000], [80000, 8, 10000], [966828, 8, 200000],
    [1600000, 8, 200000], [1600001, 8, 500000], [3999999, 8, 500000], [4000001, 8, 1000000],
    [1e9, 8, 2e8], [50000, 1, 50000], [50001, 1, 100000], [NaN, 8, 1000], [-5, 8, 1000],
  ];
  for (const [span, n, want] of cases) assert.equal(L.niceStep(span, n), want, 'niceStep(' + span + ', ' + n + ')');
  assert.equal(L.niceStep(966828), 200000, 'default maxTicks is 8');
  assert.equal(L.niceStep(10000, 0), 10000, 'maxTicks below 1 counts as 1');
  assert.equal(L.niceStep(Infinity, 8), Infinity);
  const r = rng(7);
  for (let i = 0; i < 5000; i++) {
    const span = r() < 0.1 ? r() * 8000 : 10 ** (3 + 7 * r());
    const n = 1 + Math.floor(r() * 20);
    const s = L.niceStep(span, n);
    const msg = 'niceStep(' + span + ', ' + n + ') = ' + s;
    assert.ok(s >= L.MIN_BLOCK_STEP && s >= span / n && isNice(s), msg);
    if (s > L.MIN_BLOCK_STEP) assert.ok(previousNice(s) < span / n, msg + ' is not the smallest');
  }
});

test('blockTicks lists the multiples of step inside [b0, b1]', () => {
  assert.deepEqual(L.blockTicks(0, 10000, 2000), [0, 2000, 4000, 6000, 8000, 10000]);
  assert.deepEqual(L.blockTicks(1500, 9999, 2000), [2000, 4000, 6000, 8000]);
  assert.deepEqual(L.blockTicks(-3000, 3000, 2000), [-2000, 0, 2000]);
  assert.deepEqual(L.blockTicks(-1500, -1, 1000), [-1000]);
  assert.deepEqual(L.blockTicks(0, 966827, 200000), [0, 200000, 400000, 600000, 800000]);
  assert.deepEqual(L.blockTicks(419999.5, 420000.5, 1000), [420000]);
  assert.deepEqual(L.blockTicks(5, 7, 10), []);
  assert.deepEqual(L.blockTicks(9000, 1000, 1000), []);
  assert.deepEqual(L.blockTicks(0, 10, 0), []);
  assert.deepEqual(L.blockTicks(NaN, 10, 1), []);
  assert.deepEqual(L.blockTicks(0, 10, Infinity), []);
  assert.ok(Object.is(L.blockTicks(-0.5, 0.5, 1)[0], 0), 'no negative zero');
  assert.throws(() => L.blockTicks(0, 1e9, 1), RangeError);
});

test('formatAmount writes sat below 100,000 sat and BTC from there on', () => {
  const cases = [
    [1, '1 sat'], [100, '100 sat'], [546, '546 sat'], [10000, '10,000 sat'], [99999, '99,999 sat'],
    [1e5, '0.001 BTC'], [1e6, '0.01 BTC'], [12345678, '0.12345678 BTC'], [1e8, '1 BTC'], [5e9, '50 BTC'],
    [1e13, '100,000 BTC'], [0, '0 sat'], [-0, '0 sat'], [-5e9, '-50 BTC'], [NaN, '\u2014'], [Infinity, '\u2014'],
  ];
  for (const [sats, want] of cases) assert.equal(L.formatAmount(sats), want, String(sats));
});

test('amountTicks: one decade per tick, rows from rowOfAmount on the minAmt table', () => {
  const ticks = L.amountTicks(table);
  assert.deepEqual(ticks.map((t) => t.label), [
    '1 sat', '10 sat', '100 sat', '1,000 sat', '10,000 sat', '0.001 BTC', '0.01 BTC', '0.1 BTC',
    '1 BTC', '10 BTC', '100 BTC', '1,000 BTC', '10,000 BTC', '100,000 BTC',
  ]);
  ticks.forEach((t, k) => {
    assert.equal(t.sats, 10 ** k);
    assert.equal(t.row, rowOfAmount(table, t.sats));
    // Independent check of the row: minAmt[row] <= sats < minAmt[row - 1].
    assert.ok(table[t.row] <= t.sats, t.label + ' row starts at or below the amount');
    if (t.row > 0) assert.ok(t.sats < table[t.row - 1], t.label + ' is below the next row up');
    if (k > 0) assert.ok(t.row < ticks[k - 1].row, 'larger amounts sit on smaller rows');
  });
  assert.equal(ticks.find((t) => t.label === '1 BTC').row, rowOfAmount(table, 1e8));
  assert.equal(ticks[0].row, table.length - 1, '1 sat is the bottom row');
  assert.equal(ticks[0].row, 2071);
  assert.equal(ticks[13].row, 0, '100,000 BTC is the top row');
});

test('formatBlockLabel adds the UTC year-month when blocktimes has the block', () => {
  assert.equal(L.formatBlockLabel(0, synthetic), '0 \u00b7 2009-01');
  for (const b of [1, 52560, 210000, 420000, 840000, 966827]) {
    const iso = new Date((GENESIS_TIME + 600 * b) * 1000).toISOString().slice(0, 7);
    assert.equal(L.formatBlockLabel(b, synthetic), b.toLocaleString('en-US') + ' \u00b7 ' + iso);
  }
  const real = new Uint32Array(420001);
  real[420000] = Date.UTC(2016, 6, 9, 16, 46, 13) / 1000;
  assert.equal(L.formatBlockLabel(420000, real), '420,000 \u00b7 2016-07');
  const edge = Date.UTC(2016, 7, 1) / 1000; // 2016-08-01T00:00:00Z
  const boundary = Uint32Array.of(edge - 1, edge);
  assert.equal(L.formatBlockLabel(0, boundary), '0 \u00b7 2016-07', 'UTC, not local time');
  assert.equal(L.formatBlockLabel(1, boundary), '1 \u00b7 2016-08');
  assert.equal(L.formatBlockLabel(420000), '420,000');
  assert.equal(L.formatBlockLabel(420000, null), '420,000');
  assert.equal(L.formatBlockLabel(966828, synthetic), '966,828', 'past the end of blocktimes');
  assert.equal(L.formatBlockLabel(5, new Uint32Array(10)), '5', 'zero time means unknown');
});

test('projectToScreen matches hand-computed points, including points behind the camera', () => {
  const w = 800;
  const h = 400;
  for (const depth of ['webgl', 'webgpu', 'reversed']) {
    // Camera at (0, 0, 10) looking down -z; fov 90 so f = 1 and x scale = 1 / aspect = 0.5.
    const a = cameraAt([0, 0, 10], [0, 0, 0], { fov: 90, w, h, depth });
    const at = (x, y, z, margin) => L.projectToScreen(a.viewProj, x, y, z, w, h, margin);
    const close = (p, x, y, d) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9 && Math.abs(p.depth - d) < 1e-9;
    let p = at(0, 0, 0);
    assert.ok(close(p, 400, 200, 10) && p.visible, depth + ' centre ' + JSON.stringify(p));
    p = at(4, 2, 0);
    assert.ok(close(p, 480, 160, 10) && p.visible, depth + ' offset ' + JSON.stringify(p));
    p = at(20, 0, 0);
    assert.ok(close(p, 800, 200, 10) && p.visible, 'on the right border');
    p = at(24, 0, 0);
    assert.ok(close(p, 880, 200, 10) && !p.visible, 'beyond the default margin');
    assert.ok(at(24, 0, 0, 100).visible, 'inside a 100 px margin');
    // 16 px at 800 px is 0.04 in NDC, i.e. x = 20.8 at this depth.
    assert.ok(at(20.7, 0, 0).visible && !at(20.9, 0, 0).visible, 'default margin is 16 px');
    p = at(3, 0, 9);
    assert.ok(close(p, 1000, 200, 1) && !p.visible, 'in front but off screen');
    p = at(0, 0, 15);
    assert.ok(!p.visible && Number.isNaN(p.x) && Number.isNaN(p.y) && p.depth === -5, 'behind the camera');
    p = at(1, 1, 10);
    assert.ok(!p.visible && Number.isNaN(p.x), 'on the camera plane');

    // Camera at (0, 10, 10) pitched 45 degrees down at the origin.
    const b = cameraAt([0, 10, 10], [0, 0, 0], { fov: 90, w, h, depth });
    p = L.projectToScreen(b.viewProj, 0, 0, 0, w, h);
    assert.ok(Math.abs(p.x - 400) < 1e-9 && Math.abs(p.y - 200) < 1e-9 && Math.abs(p.depth - Math.SQRT2 * 10) < 1e-9);
    p = L.projectToScreen(b.viewProj, 0, 0, -10, w, h);
    assert.ok(Math.abs(p.x - 400) < 1e-9 && Math.abs(p.y - 400 / 3) < 1e-9 && Math.abs(p.depth - 15 * Math.SQRT2) < 1e-9, JSON.stringify(p));
    p = L.projectToScreen(b.viewProj, 0, 20, 20, w, h);
    assert.ok(!p.visible && p.depth < 0, 'behind the pitched camera');
  }
});

test('viewProjection is projection x view in column-major order', () => {
  const cam = cameraAt([100, 80, 400], [300, 0, 50]);
  const r = rng(3);
  for (let i = 0; i < 50; i++) {
    const v = [r() * 1000 - 200, r() * 50, r() * 400 - 100, 1];
    const a = mulVec(cam.viewProj, v);
    const b = mulVec(cam.proj, mulVec(cam.view, v));
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(a[k] - b[k]) <= 1e-9 * (1 + Math.abs(b[k])), 'component ' + k);
  }
  const swapped = L.viewProjection(cam.view, cam.proj);
  assert.notDeepEqual(Array.from(swapped), Array.from(cam.viewProj), 'order matters');
});

test('front camera: block labels on the near long edge, amounts on the x = 0 edge', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt(FRONT, CENTER);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  checkRange(out, cam);
  assert.equal(out.blockEdgeZ, NEAR_EDGE);
  assert.equal(out.amountEdgeX, -L.AMOUNT_EDGE_OFFSET);
  assert.equal(out.blockStep, L.niceStep(out.blockRange[1] - out.blockRange[0], L.BLOCK_TICK_TARGET));
  const blocks = out.labels.filter((l) => l.kind === 'block');
  const amounts = out.labels.filter((l) => l.kind === 'amount');
  assert.ok(blocks.length >= 3, blocks.length + ' block labels');
  // The x = 0 edge is foreshortened to about 130 px here, so adjacent decades are 9-14 px
  // apart and the 16 px rule keeps every other one; even decades win.
  assert.ok(amounts.length >= 5, amounts.length + ' amount labels');
  for (const l of amounts) assert.equal(Math.round(Math.log10(l.sats)) % 2, 0, l.text + ' is an even decade');
  assert.ok(amounts.some((l) => l.text === '1 BTC'));
  for (const l of blocks) assert.ok(l.uy > 0.5, 'near-edge block labels hang below their anchors');
  for (const l of amounts) assert.ok(l.ux < -0.5, 'left-edge amount labels extend to the left');
  const again = layout.update(cam.viewProj, cam.position, VW, VH);
  assert.equal(again.amountRows, out.amountRows, 'amountRows keeps its identity while unchanged');
});

test('camera behind and to the right: far long edge and the x = W edge', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt([W + 150, 260, -380], CENTER);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  checkRange(out, cam);
  assert.equal(out.blockEdgeZ, FAR_EDGE);
  assert.equal(out.amountEdgeX, W + L.AMOUNT_EDGE_OFFSET);
  assert.ok(out.labels.filter((l) => l.kind === 'block').length >= 2);
  assert.ok(out.labels.filter((l) => l.kind === 'amount').length >= 4);
});

test('close-up at block 420,000 uses a fine block step', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const x = worldX(420000);
  const cam = cameraAt([x, 6, D + 14], [x, 0, D - 10]);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  checkRange(out, cam);
  assert.equal(out.blockEdgeZ, NEAR_EDGE);
  assert.ok(out.blockStep >= 1000 && out.blockStep <= 5000, 'blockStep ' + out.blockStep);
  assert.ok(out.labels.some((l) => l.block === 420000), 'labels 420,000');
});

test('flying over the landscape toward row 0 labels the far edge ahead', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt([500, 8, 150], [500, 0, 60]);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  checkRange(out, cam);
  assert.equal(out.blockEdgeZ, FAR_EDGE, 'the near edge is behind the camera');
  assert.ok(out.labels.length >= 3, out.labels.length + ' labels');
  // The 1.5-unit outward offset is foreshortened toward the vanishing point here; the
  // edge normal must still lift each box clear of the edge line instead of straddling it.
  for (const l of out.labels) {
    const q = L.projectToScreen(cam.viewProj, worldX(l.block), 0, 0, cam.w, cam.h);
    assert.ok(l.top + l.h <= q.y + 0.5, l.text + ' box bottom ' + (l.top + l.h).toFixed(2) + ' vs edge ' + q.y.toFixed(2));
  }
});

test('looking at the sky shows nothing but keeps a grid step and every decade row', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt([500, 100, 100], [500, 1000, 90]);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  assert.equal(out.labels.length, 0);
  assert.equal(out.blockEdgeZ, null);
  assert.equal(out.amountEdgeX, null);
  assert.equal(out.blockStep, L.niceStep(NUM_BLOCKS, L.BLOCK_TICK_TARGET));
  assert.deepEqual(Array.from(out.amountRows), [...TICK_ROWS].sort((a, b) => a - b));
});

test('from far away crowded decades are thinned, in labels and in amountRows alike', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt([W / 2, 1500, D + 2500], CENTER);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  const amounts = out.labels.filter((l) => l.kind === 'amount');
  assert.ok(amounts.length >= 2 && amounts.length < 14, amounts.length + ' amount labels');
  assert.ok(out.amountRows.length >= 2 && out.amountRows.length < 14, out.amountRows.length + ' amount rows');
  assert.deepEqual(Array.from(out.amountRows), amounts.map((l) => l.row), 'every kept decade is labelled when the edge is on screen');
});

test('zoomed into the middle: no labels on screen, grid step from the visible ground', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cam = cameraAt([500, 60, 110], [500, 0, 100]);
  const out = layout.update(cam.viewProj, cam.position, VW, VH);
  checkLayout(out, cam);
  assert.equal(out.labels.length, 0);
  assert.equal(out.blockEdgeZ, null);
  assert.ok(out.blockStep >= 1000 && out.blockStep <= 50000, 'blockStep ' + out.blockStep);
  assert.ok(out.amountRows.length >= 1);
});

test('the labelled long edge switches with hysteresis around the midline', () => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const edgeAt = (z) => {
    const c = cameraAt([W / 2, 420, z], [W / 2, 0, z - 10]);
    return layout.update(c.viewProj, c.position, VW, VH).blockEdgeZ;
  };
  assert.equal(edgeAt(D / 2 + 5), NEAR_EDGE);
  assert.equal(edgeAt(D / 2 + 0.5), NEAR_EDGE);
  assert.equal(edgeAt(D / 2 - 0.5), NEAR_EDGE);
  assert.equal(edgeAt(D / 2 - 5), FAR_EDGE);
  assert.equal(edgeAt(D / 2 + 0.5), FAR_EDGE);
  assert.equal(edgeAt(D / 2 + 5), NEAR_EDGE);
});

test('random cameras: labels stay on screen, in front, uncrowded and anchored to their world points', () => {
  const r = rng(11);
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  let shown = 0;
  let ranges = 0;
  for (let i = 0; i < 300; i++) {
    const target = [r() * W, 0, r() * D];
    const dist = 5 + r() ** 2 * 1500;
    const yaw = r() * 2 * Math.PI;
    const pitch = 0.05 + r() * 1.4;
    const eye = [target[0] + dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), target[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
    const w = 320 + Math.floor(r() * 3500);
    const h = 240 + Math.floor(r() * 2000);
    const cam = cameraAt(eye, target, { w, h, fov: 30 + r() * 60 });
    const out = layout.update(cam.viewProj, cam.position, w, h);
    checkLayout(out, cam);
    if (out.blockRange && out.blockRange[1] - out.blockRange[0] > (2 * NUM_BLOCKS) / 4000) {
      checkRange(out, cam, 4000);
      ranges++;
    }
    shown += out.labels.length;
  }
  assert.ok(shown > 600 && ranges > 50, shown + ' labels, ' + ranges + ' ranges checked');
});

test('layout update costs well under 0.5 ms', (t) => {
  const layout = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic });
  const cams = [];
  for (let i = 0; i < 64; i++) {
    const x = W / 2 + 300 * Math.sin(i / 7);
    cams.push(cameraAt([x, 250 + 50 * Math.cos(i / 5), D + 400 - 3 * i], [x, 0, D / 2]));
  }
  for (const c of cams) layout.update(c.viewProj, c.position, VW, VH);
  const n = 4000;
  let labels = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const c = cams[i % cams.length];
    labels += layout.update(c.viewProj, c.position, VW, VH).labels.length;
  }
  const ms = (performance.now() - t0) / n;
  t.diagnostic('layout.update: ' + (ms * 1000).toFixed(1) + ' us per call, ' + (labels / n).toFixed(1) + ' labels on average');
  assert.ok(ms < 0.25, ms + ' ms per update');
});

// ---- minimal fake DOM ----
class FakeDocument {
  constructor() {
    this.created = 0;
    this.writes = 0;
    this.defaultView = { devicePixelRatio: 2 };
  }
  createElement(tag) {
    this.created++;
    return new FakeElement(this, tag);
  }
}
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.text = '';
    this.style = new Proxy({}, { set(o, k, v) { doc.writes++; o[k] = v; return true; } });
  }
  get textContent() { return this.text; }
  set textContent(v) {
    this.ownerDocument.writes++;
    this.text = String(v);
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
}

function fakeCamera(eye, target) {
  const c = cameraAt(eye, target);
  return { projectionMatrix: { elements: c.proj }, matrixWorldInverse: { elements: c.view }, position: c.position };
}

test('createAxisLabels mirrors the layout in pooled nodes and rewrites nothing for a still camera', () => {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const labels = L.createAxisLabels({ element: root, grid, rows: table, blocktimes: synthetic });
  assert.equal(root.children.length, 1);
  const layer = root.children[0];
  assert.equal(layer.className, 'lbl-layer');
  assert.equal(layer.style.font, '11px "IBM Plex Mono", monospace');
  assert.equal(layer.style.color, 'rgba(235,240,255,.78)');
  assert.equal(layer.style.textShadow, '0 1px 2px rgba(0,0,0,.8)');
  assert.equal(layer.style.pointerEvents, 'none');
  const shownNodes = () => layer.children.filter((n) => n.style.display !== 'none' && !n.className.includes('lbl-probe'));

  const front = fakeCamera(FRONT, CENTER);
  const r = labels.update(front, VW, VH);
  const refCam = cameraAt(FRONT, CENTER);
  const ref = L.createAxisLayout({ grid, rows: table, blocktimes: synthetic }).update(refCam.viewProj, refCam.position, VW, VH);
  assert.deepEqual(Object.keys(r).sort(), ['amountRows', 'blockStep']);
  assert.equal(r.blockStep, ref.blockStep);
  assert.deepEqual(r.amountRows, ref.amountRows);
  let shown = shownNodes();
  assert.equal(shown.length, ref.labels.length);
  assert.equal(labels.stats.labels, ref.labels.length);
  for (const l of ref.labels) {
    const node = shown.find((n) => n.textContent === l.text);
    assert.ok(node, 'node for ' + l.text);
    assert.equal(node.className, 'lbl lbl-' + l.kind);
    assert.equal(node.style.position, 'absolute');
    assert.equal(node.style.left, '0');
    assert.equal(node.style.top, '0');
    assert.equal(node.style.whiteSpace, 'nowrap');
    const m = /^translate\((-?[\d.]+)px,(-?[\d.]+)px\) translate\((-?\d+)%,(-?\d+)%\)$/.exec(node.style.transform);
    assert.ok(m, node.style.transform);
    assert.ok(Math.abs(Number(m[1]) - l.x) <= 0.25 && Math.abs(Number(m[2]) - l.y) <= 0.25, 'snapped to device pixels');
    assert.equal(Number(m[3]), Math.round(50 * (l.ux - 1)));
    assert.equal(Number(m[4]), Math.round(50 * (l.uy - 1)));
  }

  const writes = doc.writes;
  const r2 = labels.update(front, VW, VH);
  assert.equal(doc.writes, writes, 'a still camera writes nothing');
  assert.equal(r2.amountRows, r.amountRows, 'same amountRows instance while unchanged');

  let maxShown = 0;
  for (let i = 0; i < 400; i++) {
    const x = W / 2 + 350 * Math.sin(i / 25);
    const z = D + 0.55 * W - 300 * (0.5 + 0.5 * Math.sin(i / 40));
    const y = 0.35 * W * (0.4 + 0.3 * (1 + Math.cos(i / 30)));
    labels.update(fakeCamera([x, y, z], [x, 0, D / 2]), VW, VH);
    shown = shownNodes();
    assert.equal(shown.length, labels.stats.labels);
    maxShown = Math.max(maxShown, shown.length);
  }
  assert.equal(labels.stats.nodes, layer.children.length);
  assert.ok(layer.children.length <= 14 + 12, layer.children.length + ' pooled nodes for at most ' + maxShown + ' labels at once');

  labels.setVisible(false);
  assert.equal(layer.style.display, 'none');
  const w0 = doc.writes;
  const hidden = labels.update(front, VW, VH);
  assert.equal(doc.writes, w0, 'no node writes while hidden');
  assert.equal(labels.stats.labels, 0);
  assert.equal(hidden.blockStep, ref.blockStep, 'grid positions still computed while hidden');
  assert.deepEqual(hidden.amountRows, ref.amountRows);
  labels.setVisible(true);
  assert.equal(layer.style.display, '');
  labels.update(front, VW, VH);
  assert.equal(shownNodes().length, ref.labels.length);

  labels.dispose();
  assert.equal(root.children.length, 0);
  assert.equal(labels.stats.labels, 0);
  assert.equal(labels.update(front, VW, VH).blockStep, ref.blockStep, 'update after dispose is a no-op');
});

test('createAxisLayout and createAxisLabels reject missing inputs', () => {
  assert.throws(() => L.createAxisLayout({ rows: table }), TypeError);
  assert.throws(() => L.createAxisLayout({ grid }), TypeError);
  assert.throws(() => L.createAxisLabels({ grid, rows: table }), TypeError);
});
