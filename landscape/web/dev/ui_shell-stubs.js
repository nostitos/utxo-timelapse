// ui_shell dev stubs: a synthetic replay client and a 2D-canvas stand-in view, so the
// app shell (main.js and ui/*) can run before the real data and renderer exist. Shapes
// follow landscape/SPEC.md §5 and §6; values are synthetic and only for layout checks.

import { PerspectiveCamera, Vector3 } from 'three';
import { gridFromManifest, SLOT, worldX } from '../data/grid.js';
import { buildMinAmtTable, FILM_AXIS, rowOfAmount } from '../data/axis.js';
import { paletteRGB } from '../render/terrain/palette.js';

const GENESIS = 1231006505;

function synthetic(lx, ly, block) {
  const created = lx * 4096;
  if (created > block) return 0;
  const age = (block - created) / 105000;
  const era = Math.min(1, lx / 237);
  const band = 420 * Math.exp(-(((ly - 96) / 14) ** 2)) + 260 * Math.exp(-(((ly - 112) / 5) ** 2)) + 60 * Math.exp(-(((ly - 70) / 9) ** 2));
  const stripes = 1 + 0.6 * Math.sin(lx * 0.9) * Math.sin(ly * 0.7);
  const survive = Math.exp(-age * (0.6 - 0.4 * (ly < 60 ? 1 : 0)));
  return Math.max(0, band * (0.15 + era * era * 3) * stripes * survive * 0.02);
}

export async function createStubClient({ tip = 966827, rate = 2400 } = {}) {
  const numBlocks = tip + 1;
  const manifest = { format: 'utxo-landscape-1', numBlocks, tip, tipTime: GENESIS + tip * 600, axis: FILM_AXIS, snapshots: [] };
  const grid = gridFromManifest(manifest);
  const rows = buildMinAmtTable();
  const blocktimes = new Uint32Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) blocktimes[b] = GENESIS + b * 600 + ((b * 7919) % 900) - 450;
  const snapshotBlocks = [];
  for (let b = 0; b < 300000; b += 6000) snapshotBlocks.push(b);
  for (let b = 300000; b < tip; b += 450) snapshotBlocks.push(b);
  snapshotBlocks.push(tip);
  const L6 = grid.levels[6];
  const frameFns = new Set();
  const statusFns = new Set();
  let seq = 0;
  let pendingSeek = null;

  function l6(block) {
    const data = new Float32Array(SLOT * SLOT * 4);
    for (let ly = 0; ly < L6.rows; ly++) {
      for (let lx = 0; lx < L6.columns; lx++) {
        const v = synthetic(lx, ly, block);
        const o = ((ly + 1) * SLOT + lx + 1) * 4;
        data[o] = v;
        data[o + 3] = v;
      }
    }
    return data;
  }
  function meta(block) {
    const n = 1500 + ((block * 31) % 900);
    const total = 2e6 + block * 180;
    return {
      block, time: blocktimes[block], nTx: Math.round(n / 2.4), size: n * 300, created: n, spent: Math.round(n * 0.93),
      totals: { countSmall: total, countLarge: Math.round(total / 400), satsSmall: block * 1.2e10, satsLarge: block * 1.9e9 },
    };
  }
  function emit(reason, block) {
    const frame = {
      seq: ++seq, block, reason, partial: false,
      full: [{ id: L6.firstTile, level: 6, tx: 0, ty: 0, empty: false, data: l6(block) }],
      deltas: null, evicted: [],
      stats: { blocksApplied: 0, changesApplied: 0, ms: 1, blocksPerSecond: rate, residentTiles: 1, pendingTiles: 0, chunkCacheBytes: 0 },
      meta: meta(block),
    };
    client.block = block;
    client.meta = frame.meta;
    frameFns.forEach((fn) => fn(frame));
  }
  const status = (s) => statusFns.forEach((fn) => fn({ residentTiles: 1, pendingTiles: 0, memoryBytes: 180e6, ...s }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const client = {
    manifest, grid, rows, blocktimes, snapshotBlocks, block: null, busy: false, meta: null,
    setTiles() {},
    setMeasures() {},
    setHeatHalfLife() {},
    setMaxResidentTiles() {},
    async seek(block) {
      const my = {};
      if (pendingSeek) pendingSeek.cancelled = true;
      pendingSeek = my;
      client.busy = true;
      status({ busy: true, phase: 'seek', target: block, progress: 0.3 });
      await wait(120);
      if (my.cancelled) return { cancelled: true };
      pendingSeek = null;
      emit('seek', block);
      client.busy = false;
      status({ busy: false, phase: 'idle', block });
      return { block };
    },
    async advance(target, { budgetMs = 10 } = {}) {
      const start = performance.now();
      await wait(Math.max(1, budgetMs * 0.6));
      const can = Math.max(1, Math.floor((rate * (performance.now() - start)) / 1000));
      const dir = Math.sign(target - client.block);
      const n = Math.min(Math.abs(target - client.block), can);
      emit('advance', client.block + dir * n);
      return { block: client.block, reached: client.block === target, blocks: n, ms: performance.now() - start };
    },
    async cell(level, col, row) {
      await wait(30);
      const b = client.block;
      if (col * 64 > b) return { countSmall: 0, countLarge: 0, satsSmall: 0, satsLarge: 0, heat: 0, heatBlock: 0, block: b };
      const v = synthetic(col >> 6, row >> 4, b) * 3;
      const count = Math.round(v);
      const amt = rows[row];
      return { countSmall: count, countLarge: 0, satsSmall: Math.round(count * amt), satsLarge: 0, heat: 0, heatBlock: 0, block: b };
    },
    onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    onError() { return () => {}; },
    dispose() {},
  };
  return client;
}

export function createStubView({ canvas, settings, manifest }) {
  const grid = gridFromManifest(manifest);
  const L6 = grid.levels[6];
  const camera = new PerspectiveCamera(50, 1, 0.05, 6000);
  const ctx = canvas.getContext('2d');
  let data = null;
  let block = 0;
  let vmax = 1;
  const v = new Vector3();
  const colW = (64 << 6) / 1000;
  const rowW = 1.6;
  const exaggeration = () => {
    try {
      return settings.get('amp.exaggeration') || 20;
    } catch {
      return 20;
    }
  };
  function cellHeight(lx, ly) {
    if (!data || lx < 0 || ly < 0 || lx >= L6.columns || ly >= L6.rows) return 0;
    const val = data[((ly + 1) * SLOT + lx + 1) * 4];
    return val > 0 ? (exaggeration() * Math.log1p(val)) / Math.log1p(vmax) : 0;
  }
  const view = {
    backend: 'webgpu',
    capabilities: { compute: true, timestamp: false, maxTileBudget: 400, limits: {} },
    camera, renderer: null, scene: null,
    stats: { fps: 60, cpuMs: 1, gpuMs: 0, scale: 1, width: 0, height: 0 },
    setBlock(b) {
      block = b;
    },
    applyFrame(f) {
      let changed = false;
      for (const t of f.full || []) {
        if (t.id === L6.firstTile && t.data) {
          data = Float32Array.from(t.data);
          changed = true;
        }
      }
      const d = f.deltas;
      if (data && d && d.ids) {
        for (let k = 0; k < d.ids.length; k++) {
          if (d.ids[k] !== L6.firstTile) continue;
          for (let j = d.offsets[k]; j < d.offsets[k + 1]; j++) data.set(d.data.subarray(j * 4, j * 4 + 4), d.index[j] * 4);
          changed = true;
        }
      }
      if (changed) {
        vmax = 1;
        for (let i = 0; i < data.length; i += 4) if (data[i] > vmax) vmax = data[i];
      }
    },
    update() {
      return { desiredTiles: null };
    },
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      camera.updateProjectionMatrix();
    },
    render() {
      if (canvas.width !== Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1))) view.resize();
      const W = canvas.width;
      const H = canvas.height;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0b1418');
      g.addColorStop(1, '#020304');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      if (!data) return;
      camera.updateMatrixWorld(true);
      const pal = paletteRGB('film');
      const buckets = Array.from({ length: 64 }, () => []);
      for (let ly = 0; ly < L6.rows; ly++) {
        for (let lx = 0; lx < L6.columns; lx++) {
          const val = data[((ly + 1) * SLOT + lx + 1) * 4 + 3];
          if (!(val > 0)) continue;
          const h = cellHeight(lx, ly);
          v.set((lx + 0.5) * colW, h, (ly + 0.5) * rowW).project(camera);
          if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
          const i = Math.min(63, Math.floor((Math.log1p(val) / Math.log1p(vmax)) * 64));
          buckets[i].push(((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H, 1 / Math.max(0.05, 1 - v.z));
        }
      }
      for (let i = 0; i < 64; i++) {
        const k = Math.min(255, i * 4 + 2);
        ctx.fillStyle = 'rgb(' + pal[k * 3] + ',' + pal[k * 3 + 1] + ',' + pal[k * 3 + 2] + ')';
        const b = buckets[i];
        for (let j = 0; j < b.length; j += 3) {
          const s = Math.max(1.5, Math.min(9, b[j + 2] * 0.06));
          ctx.fillRect(b[j] - s / 2, b[j + 1] - s / 2, s, s);
        }
      }
      ctx.fillStyle = 'rgba(237,191,118,0.5)';
      v.set(worldX(block), 0, 0).project(camera);
      const x0 = ((v.x + 1) / 2) * W;
      const y0 = ((1 - v.y) / 2) * H;
      v.set(worldX(block), 0, 207.2).project(camera);
      ctx.strokeStyle = 'rgba(237,191,118,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H);
      ctx.stroke();
    },
    pick(cx, cy) {
      const r = canvas.getBoundingClientRect();
      const nx = ((cx - r.left) / r.width) * 2 - 1;
      const ny = -(((cy - r.top) / r.height) * 2 - 1);
      camera.updateMatrixWorld(true);
      const o = camera.position.clone();
      const d = new Vector3(nx, ny, 0.5).unproject(camera).sub(o).normalize();
      if (d.y >= 0) return null;
      const t = -o.y / d.y;
      const p = o.addScaledVector(d, t);
      if (p.x < 0 || p.z < 0 || p.x >= worldX(manifest.numBlocks) || p.z >= 207.2) return null;
      const l0Col = Math.floor((p.x * 1000) / 64);
      const l0Row = Math.floor(p.z * 10);
      const lx = l0Col >> 6;
      const ly = l0Row >> 4;
      const val = data ? data[((ly + 1) * SLOT + lx + 1) * 4] : 0;
      return { x: p.x, y: 0, z: p.z, level: 6, col: lx, row: ly, l0Col, l0Row, value: val, colorValue: val, heat: 0 };
    },
    heightAt(x, z) {
      return cellHeight(Math.floor(x / colW), Math.floor(z / rowW));
    },
    focusDistance() {
      return 100;
    },
    dispose() {},
  };
  view.resize();
  return view;
}

export function createStubPanel({ container }) {
  container.innerHTML = '<div style="padding:16px;background:rgba(8,11,14,.85);border:1px solid rgba(237,236,228,.1);border-radius:8px;font:12px IBM Plex Mono,monospace;color:#a1adae">Settings panel (ui/panel.js from ui_settings) mounts here.</div>';
  let open = false;
  container.hidden = true;
  const set = (v) => {
    open = v;
    container.hidden = !v;
  };
  return { open: () => set(true), close: () => set(false), toggle: () => set(!open), isOpen: () => open, dispose() {} };
}
