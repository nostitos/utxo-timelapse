// ui/tx-layout.js: ribbons by cell, the cap, the curves and the camera that frames them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTx, txCurves, framedPoints, frameTx, ribbonStyle, nextCoin, MAX_RIBBONS } from '../web/ui/tx-layout.js';
import { buildMinAmtTable, rowOfAmount } from '../web/data/axis.js';

const minAmt = buildMinAmtTable();
const id = (n) => n.toString(16).padStart(64, '0');
const input = (height, satoshi, n = 0) => ({ txid: id(n), vout: 0, satoshi, height });

test('coins in one cell share a ribbon; inputs without a block and zero-value outputs get none', () => {
  const answer = { txid: id(1), height: 6400, coinbase: false,
    inputs: [input(100, 5e8, 1), input(120, 5e8, 2), input(100, 3e3, 3), input(null, 7e5, 4), input(200, 0, 5)],
    outputs: [{ vout: 0, satoshi: 1e9, spent: null }, { vout: 1, satoshi: 0, spent: null }] };
  const g = groupTx(answer, minAmt, 6400);
  // Blocks 100 and 120 share column 1; 5 BTC and 3,000 sat do not share a row.
  assert.equal(g.inputs.length, 2);
  assert.deepEqual(g.inputs[0].rows, [0, 1]);
  assert.equal(g.inputs[0].sat, 1e9);
  assert.deepEqual([g.inputs[0].col, g.inputs[0].row], [1, rowOfAmount(minAmt, 5e8)]);
  assert.deepEqual(g.rest, { count: 1, sat: 7e5, rows: [3] });
  assert.deepEqual(g.inRibbon, [0, 0, 1, -1, -1]);
  assert.deepEqual(g.outRibbon, [0, -1]);
  assert.equal(g.inSat, 1e9 + 3e3 + 7e5);
  assert.equal(g.hub.x, 6.4);
  assert.equal(groupTx(answer, minAmt, 6399), null, 'nothing before the transaction\u2019s block');
});

test('past the cap the largest keep their cell, the rest merge by coarser cells, and value is kept', () => {
  // 1,000 inputs, each in its own cell: columns 0..999 at two amounts.
  const inputs = Array.from({ length: 1000 }, (_, i) => input(i * 64, i % 2 ? 1e5 + i : 1e8 + i, i));
  const g = groupTx({ txid: id(9), height: 64000, inputs, outputs: [{ vout: 0, satoshi: 1e10, spent: null }] }, minAmt, 64000);
  assert.ok(g.inputs.length <= MAX_RIBBONS, g.inputs.length + ' ribbons');
  const exact = g.inputs.filter((r) => r.level === 0);
  assert.equal(exact.length, MAX_RIBBONS / 2);
  const largest = inputs.map((p, i) => [p.satoshi, i]).sort((a, b) => b[0] - a[0]).slice(0, MAX_RIBBONS / 2).map((p) => p[1]).sort((a, b) => a - b);
  assert.deepEqual(exact.flatMap((r) => r.rows).sort((a, b) => a - b), largest, 'the largest coins keep their own cell');
  assert.equal(g.inputs.reduce((s, r) => s + r.sat, 0), inputs.reduce((s, p) => s + p.satoshi, 0));
  assert.ok(g.inRibbon.every((k) => k >= 0), 'every input is drawn by one ribbon');
  assert.ok(g.inputs.every((r) => r.x >= 0 && r.x <= 64 && r.z >= 0 && r.z <= 207.2));
});

test('inputs end at the bridge from the past side, outputs leave it toward the future', () => {
  const answer = { txid: id(2), height: 500000, inputs: [input(100000, 2e8, 1)], outputs: [{ vout: 0, satoshi: 1.9e8, spent: null }] };
  const g = groupTx(answer, minAmt, 500000);
  const { curves, hubY, half } = txCurves(g, () => 3);
  const inc = curves.find((c) => c.kind === 'in');
  const out = curves.find((c) => c.kind === 'out');
  assert.deepEqual(inc.p.slice(0, 3), [g.inputs[0].x, 3, g.inputs[0].z], 'the input starts on its cell');
  assert.deepEqual(inc.p.slice(9), [g.hub.x - half, hubY, g.hub.z], 'and ends at the bridge\u2019s past end');
  assert.ok(inc.p[6] < g.hub.x - half && inc.p[7] === hubY && inc.p[8] === g.hub.z, 'arriving along the bridge');
  assert.deepEqual(out.p.slice(0, 3), [g.hub.x + half, hubY, g.hub.z]);
  assert.ok(out.p[4] === hubY && out.p[5] === g.hub.z, 'outputs leave along it');
  assert.ok(out.p[3] > g.hub.x + half, 'outputs swing out beyond the leading edge');
  assert.ok(hubY > 3 + 2.2 && hubY <= 3 + 45);
  assert.deepEqual(curves.map((c) => c.kind), ['in', 'out', 'bridge', 'mast']);
});

test('the frame keeps the bridge and the ribbons carrying most of the value in view', () => {
  const cases = [
    { txid: id(3), height: 974300, inputs: [input(974206, 1.78e8, 1)], outputs: [{ vout: 0, satoshi: 2.9e7 }, { vout: 1, satoshi: 1.49e8 }] },
    { txid: id(4), height: 974290, inputs: Array.from({ length: 400 }, (_, i) => input(700000 + i * 600, 1e4 + i * 37, i)), outputs: [{ vout: 0, satoshi: 5.8e7 }] },
    { txid: id(5), height: 57043, inputs: Array.from({ length: 30 }, (_, i) => input(1000 + i * 1700, 5e9, i)), outputs: [{ vout: 0, satoshi: 1e12 }] },
  ];
  for (const answer of cases) {
    const g = groupTx(answer, minAmt, answer.height);
    const pts = framedPoints(g, txCurves(g, (x) => x % 7).curves);
    for (const [aspect, yawDeg, pitchDeg] of [[16 / 9, 0, -32], [0.5, 0, -32], [16 / 9, 30, -50]]) {
      const margin = 0.85;
      const { target, distance } = frameTx(pts, { fovDeg: 50, aspect, yawDeg, pitchDeg, margin });
      // The camera of ui/controls.js: forwardOf(yaw, pitch), placed distance behind the target.
      const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
      const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
      const eye = [target.x - f[0] * distance, target.y - f[1] * distance, target.z - f[2] * distance];
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
      const tanV = Math.tan((50 * Math.PI) / 360);
      for (const p of pts) {
        const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const dot = (a) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
        const depth = dot(f);
        assert.ok(depth > 0, 'in front of the camera');
        assert.ok(Math.abs(dot(right)) / (depth * tanV * aspect) <= margin + 1e-9, 'horizontally inside');
        assert.ok(Math.abs(dot(up)) / (depth * tanV) <= margin + 1e-9, 'vertically inside');
      }
      const high = frameTx(pts, { fovDeg: 50, aspect, yawDeg, pitchDeg, margin, minEye: 120 });
      assert.ok(high.target.y - Math.sin(pitch) * high.distance >= 120 - 1e-9, 'the camera stays above minEye');
      assert.ok(high.distance >= distance, 'by backing away');
    }
  }
});

test('ribbons widen and brighten with their share of the value and fade as they multiply', () => {
  const all = ribbonStyle(10, 10, 1);
  const tenth = ribbonStyle(1, 10, 1);
  assert.ok(all.px > tenth.px && all.alpha > tenth.alpha);
  assert.equal(all.px, 1.6 + 9);
  assert.ok(ribbonStyle(1, 10, 900).alpha < tenth.alpha);
  assert.ok(ribbonStyle(1, 10, 900).alpha >= 0.45 * 0.4);
});

test('Follow a coin takes the largest output forward and the largest input back, and stops where the coin does', () => {
  const t = { txid: id(7), height: 100, coinbase: false,
    inputs: [input(90, 5e7, 1), { ...input(95, 9e7, 2), vout: 3 }, input(80, 9e7, 4)],
    outputs: [{ vout: 0, satoshi: 1e8, spent: { txid: id(8), height: 120 } }, { vout: 1, satoshi: 3e7, spent: null }] };
  assert.deepEqual(nextCoin(t, 'forward'), { txid: id(8), mark: id(7) + ':0', sat: 1e8 });
  assert.deepEqual(nextCoin(t, 'back'), { txid: id(2), mark: id(2) + ':3', sat: 9e7 }, 'the first of equal amounts');
  const unspent = { ...t, outputs: [{ vout: 0, satoshi: 1e8, spent: null }, { vout: 1, satoshi: 3e7, spent: { txid: id(9), height: 130 } }] };
  assert.deepEqual(nextCoin(unspent, 'forward'), { stop: 'unspent', sat: 1e8 }, 'the largest output decides, even when a smaller one was spent');
  assert.deepEqual(nextCoin({ ...t, coinbase: true, inputs: [] }, 'back'), { stop: 'mined', sat: 0 });
});
