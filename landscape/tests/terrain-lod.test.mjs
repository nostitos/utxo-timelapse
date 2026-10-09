// Tests for landscape/web/render/terrain/lod.js and patchmax.js (render_terrain).
// Run: node --test landscape/tests/terrain-lod.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridFromManifest, tileInfo, childTiles, parentTile, tileOfCell, SLOT } from '../web/data/grid.js';
import {
  selectTiles, fullPatchMask, childPatchMask, rootTiles, cellSize, boxVisible, frustumPlanes, PATCH_CELLS,
} from '../web/render/terrain/lod.js';
import { recomputePatchMax, bumpPatchMax, patchesOfCell } from '../web/render/terrain/patchmax.js';
import { heightOfCpu, heightBoundCpu } from '../web/render/terrain/curve.js';

const GRIDS = [gridFromManifest({ numBlocks: 966828 }), gridFromManifest({ numBlocks: 330001 }), gridFromManifest({ numBlocks: 120001 })];
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const popcount = (m) => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };

test('child patch masks partition every parent tile exactly', () => {
  for (const grid of GRIDS) {
    for (let id = 0; id < grid.tiles; id++) {
      const t = tileInfo(grid, id);
      if (t.level === 0) continue;
      const full = fullPatchMask(t);
      let union = 0;
      for (const c of childTiles(grid, id)) {
        const m = childPatchMask(grid, id, c);
        assert.equal(union & m, 0, 'children overlap in tile ' + id);
        assert.ok(m !== 0, 'child ' + c + ' covers nothing of ' + id);
        union |= m;
      }
      assert.equal(union, full, 'children do not cover tile ' + id);
    }
  }
});

test('full patch masks match the cells inside the grid', () => {
  const grid = GRIDS[0];
  const t757 = tileInfo(grid, 757);
  assert.equal(popcount(fullPatchMask(t757)), 4 * 3); // 237 x 130 cells
  const lastL0 = tileInfo(grid, 539); // tile (59, 8): 3 columns x 24 rows
  assert.equal(fullPatchMask(lastL0), 1);
});

// Builds a random residency set closed under parents (as the worker keeps ancestors).
function randomResident(grid, r, pick) {
  const res = new Set(rootTiles(grid));
  for (let id = 0; id < grid.tiles; id++) {
    if (r() < pick) {
      let x = id;
      while (x !== null) {
        res.add(x);
        x = parentTile(grid, x);
      }
    }
  }
  return res;
}

test('draw list covers every grid cell exactly once with the deepest resident level (no culling)', () => {
  const r = rng(3);
  for (const grid of GRIDS) {
    for (let trial = 0; trial < 12; trial++) {
      const res = randomResident(grid, r, 0.3);
      const W = grid.numBlocks / 1000;
      const D = grid.rows / 10;
      const cam = [r() * W, 2 + r() * 80, r() * D * 1.4];
      const sel = selectTiles(grid, { position: cam, planes: null, projScale: 900 + r() * 2000 }, {
        threshold: 1 + r() * 4, budget: 40 + Math.floor(r() * 300), isResident: (id) => res.has(id),
      });
      const drawn = new Map(sel.draw.map((d) => [d.id, d.mask]));
      for (const id of drawn.keys()) assert.ok(res.has(id), 'drawn tile ' + id + ' is resident');
      for (let k = 0; k < 400; k++) {
        const x = r() * W * 0.99999;
        const z = r() * D * 0.99999;
        let covers = 0;
        let finestResidentSplit = -1;
        for (let l = 0; l < grid.levels.length; l++) {
          const { cw, ch } = cellSize(grid, l);
          const col = Math.floor(x / cw);
          const row = Math.floor(z / ch);
          const id = tileOfCell(grid, l, col, row);
          if (id < 0) continue;
          const t = tileInfo(grid, id);
          const bit = (((row - t.row0) / PATCH_CELLS) | 0) * 4 + (((col - t.col0) / PATCH_CELLS) | 0);
          const m = drawn.get(id);
          if (m !== undefined && (m & (1 << bit))) covers++;
          if (finestResidentSplit < 0 && sel.split.has(id)) finestResidentSplit = l;
        }
        assert.equal(covers, 1, 'point ' + x.toFixed(3) + ',' + z.toFixed(3) + ' covered ' + covers + ' times');
      }
      assert.ok(sel.selected <= Math.max(sel.selected, 1));
    }
  }
});

test('selection respects the budget, starts with the roots and keeps ancestors before children', () => {
  const r = rng(5);
  for (const grid of GRIDS) {
    for (let trial = 0; trial < 20; trial++) {
      const budget = 1 + Math.floor(r() * 400);
      const W = grid.numBlocks / 1000;
      const sel = selectTiles(grid, { position: [r() * W, 1 + r() * 40, r() * 250], planes: null, projScale: 2000 }, {
        threshold: 0.5 + r() * 3, budget, isResident: () => false,
      });
      const roots = rootTiles(grid);
      assert.ok(sel.desired.length <= Math.max(budget, roots.length));
      assert.deepEqual(sel.desired.slice(0, roots.length), roots);
      const pos = new Map(sel.desired.map((id, i) => [id, i]));
      assert.equal(pos.size, sel.desired.length, 'unique');
      for (const [id, i] of pos) {
        const p = parentTile(grid, id);
        if (p !== null) assert.ok(pos.has(p) && pos.get(p) < i, 'parent of ' + id + ' listed first');
      }
    }
  }
});

test('refinement follows the threshold and hysteresis keeps a previous split', () => {
  const grid = GRIDS[0];
  const view = { position: [500, 30, 120], planes: null, projScale: 1000 };
  const coarse = selectTiles(grid, view, { threshold: 1e9, budget: 400 });
  assert.deepEqual(coarse.desired, rootTiles(grid));
  const fine = selectTiles(grid, view, { threshold: 1, budget: 400 });
  assert.ok(fine.desired.length > 50);
  // Camera 100 units above the root's footprint with no height data: the root's cell
  // (max(4.096, 1.6) = 4.096 units) projects to 4.096 * 1000 / 100 = 40.96 px.
  const root = rootTiles(grid)[0];
  const { cw, ch } = cellSize(grid, 6);
  const e = (Math.max(cw, ch) * 1000) / 100;
  assert.ok(Math.abs(e - 40.96) < 1e-9);
  const v2 = { position: [500, 100, 120], planes: null, projScale: 1000 };
  const a = selectTiles(grid, v2, { threshold: 45, budget: 400, defaultMaxHeight: 0 });
  assert.ok(!a.split.has(root), 'error 40.96 <= threshold 45: not split');
  const b = selectTiles(grid, v2, { threshold: 45, budget: 400, defaultMaxHeight: 0, previousSplit: new Set([root]), hysteresis: 0.8 });
  assert.ok(b.split.has(root), 'previously split: kept while error > 45 * 0.8');
  const c = selectTiles(grid, v2, { threshold: 40, budget: 400, defaultMaxHeight: 0 });
  assert.ok(c.split.has(root), 'error 40.96 > threshold 40: split');
});

test('frustum culling drops tiles outside the view', () => {
  const grid = GRIDS[0];
  // A simple perspective camera at (100, 20, 300) looking toward -z (column-major matrices).
  const fov = (50 * Math.PI) / 180;
  const f = 1 / Math.tan(fov / 2);
  const aspect = 16 / 9;
  const near = 0.1;
  const far = 5000;
  const P = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0];
  const V = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -100, -20, -300, 1];
  const VP = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) for (let k = 0; k < 4; k++) VP[c * 4 + r2] += P[k * 4 + r2] * V[c * 4 + k];
  const planes = frustumPlanes(VP, true);
  assert.ok(boxVisible(planes, [90, 0, 100, 110, 5, 120]), 'in front');
  assert.ok(!boxVisible(planes, [90, 0, 320, 110, 5, 340]), 'behind');
  assert.ok(!boxVisible(planes, [600, 0, 100, 620, 5, 120]), 'far right');
  const sel = selectTiles(grid, { position: [100, 20, 300], planes, projScale: 1000 }, { threshold: 2, budget: 400 });
  for (const id of sel.desired.slice(1)) {
    const t = tileInfo(grid, id);
    const { cw } = cellSize(grid, t.level);
    assert.ok(t.col0 * cw < 600, 'tile ' + id + ' far to the right is not requested');
  }
});

test('patch maxima: recompute equals brute force and incremental bumps', () => {
  const r = rng(9);
  for (let trial = 0; trial < 6; trial++) {
    const data = new Float32Array(SLOT * SLOT * 4);
    for (let i = 0; i < SLOT * SLOT; i++) if (r() < 0.05) data[i * 4] = r() * 100;
    const m = new Float32Array(16);
    const tmax = recomputePatchMax(data, 0, m);
    const brute = new Float32Array(16);
    let bmax = 0;
    for (let py = 0; py < 4; py++) {
      for (let px = 0; px < 4; px++) {
        let v = 0;
        for (let ly = py * 64; ly <= py * 64 + 64; ly++) {
          for (let lx = px * 64; lx <= px * 64 + 64; lx++) {
            const x = data[((ly + 1) * SLOT + lx + 1) * 4];
            if (x > v) v = x;
          }
        }
        brute[py * 4 + px] = v;
      }
    }
    for (let ly = 0; ly <= 256; ly++) for (let lx = 0; lx <= 256; lx++) bmax = Math.max(bmax, data[((ly + 1) * SLOT + lx + 1) * 4]);
    assert.deepEqual(Array.from(m), Array.from(brute));
    assert.equal(tmax, bmax);
    const inc = new Float32Array(16);
    for (let ly = -1; ly <= 256; ly++) for (let lx = -1; lx <= 256; lx++) bumpPatchMax(inc, 0, lx, ly, data[((ly + 1) * SLOT + lx + 1) * 4]);
    assert.deepEqual(Array.from(inc), Array.from(brute));
  }
  assert.deepEqual(patchesOfCell(64, 0).sort(), [0, 1]);
  assert.deepEqual(patchesOfCell(256, 256), [15]);
  assert.deepEqual(patchesOfCell(-1, 5), []);
});

test('height curve: log, power, linear, whale rows, floor and empty cells', () => {
  const p = { curve: 'log', exposure: 1, reference: 500, exponent: 0.5, exaggeration: 10, floor: 0.05, whale: 2, whiteRow: 600 };
  assert.equal(heightOfCpu(0, 700, p), 0);
  assert.equal(heightOfCpu(-3, 700, p), 0);
  assert.ok(Math.abs(heightOfCpu(500, 700, p) - 10.05) < 1e-12);
  assert.ok(Math.abs(heightOfCpu(500, 600, p) - 20.05) < 1e-12, 'whale multiplier on rows at/above the white-hot row');
  assert.ok(Math.abs(heightOfCpu(500, 601, p) - 10.05) < 1e-12);
  assert.ok(Math.abs(heightOfCpu(125, 700, { ...p, curve: 'power' }) - (10 * Math.sqrt(0.25) + 0.05)) < 1e-12);
  assert.ok(Math.abs(heightOfCpu(250, 700, { ...p, curve: 'linear', exposure: 7 }) - 5.05) < 1e-12);
  assert.ok(heightBoundCpu(300, p) >= heightOfCpu(300, 0, p));
  assert.ok(heightBoundCpu(300, { ...p, whale: 0.5 }) >= heightOfCpu(300, 900, { ...p, whale: 0.5 }));
});
