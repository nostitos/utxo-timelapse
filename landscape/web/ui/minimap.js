// Minimap (landscape/SPEC.md §8) from the always-resident L6 tile: one pixel per L6 cell
// (4,096 blocks x 16 rows), the creation edge, and the camera footprint. Click or drag
// to move the view. Colours use the current palette with an automatic log scale (L6
// cells are means over up to 1,024 L0 cells, far below the terrain's transfer range).

import { paletteRGB, whiteHotRow } from '../render/terrain/palette.js';
import { SLOT, worldX } from '../data/grid.js';
import { fmtInt } from './format.js';

export function createMinimap({ container, grid, rows, settings, onNavigate }) {
  const level = grid.levels[grid.levels.length - 1];
  const tileId = level.firstTile;
  const cols = level.columns;
  const lrows = level.rows;
  const colWorld = (grid.blocksPerColumn << level.columnShift) / 1000; // world x per L6 column
  const rowWorld = (1 << level.rowShift) / 10; // world z per L6 row
  const worldW = cols * colWorld;
  const worldH = lrows * rowWorld;
  const data = new Float32Array(SLOT * SLOT * 4);
  let hasData = false;
  let dirty = true;
  let lastRebuild = -Infinity;
  let lastKey = '';

  container.innerHTML = '<div class="mm-head"><span class="eyebrow">Overview</span><span class="mm-meta"></span></div><canvas class="mm-canvas" aria-label="Overview map: click to move the view"></canvas>';
  const canvas = container.querySelector('canvas');
  const meta = container.querySelector('.mm-meta');
  const base = document.createElement('canvas');
  base.width = cols;
  base.height = lrows;
  const baseCtx = base.getContext('2d');

  const get = (id, fb) => {
    try {
      const v = settings.get(id);
      return v === undefined || v === null ? fb : v;
    } catch {
      return fb;
    }
  };

  function size() {
    const w = Math.max(120, Math.round(canvas.clientWidth || 300));
    const h = Math.round((w * worldH) / worldW);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = h + 'px';
    }
    return { w: canvas.width, h: canvas.height, dpr };
  }

  function rebuildBase() {
    const palette = get('color.palette', 'film');
    const opts = { gradient: get('color.gradient', null), reverse: !!get('color.reverse', false) };
    const baseRgb = paletteRGB(palette, opts);
    const whaleRgb = get('color.whiteHot', true) ? paletteRGB(palette, { ...opts, whiteHot: true }) : null;
    const whiteRow = whaleRgb && rows ? whiteHotRow(rows, get('color.whiteHotBTC', 10)) : -1;
    const values = new Float32Array(cols * lrows);
    let n = 0;
    for (let ly = 0; ly < lrows; ly++) {
      for (let lx = 0; lx < cols; lx++) {
        const v = data[((ly + 1) * SLOT + lx + 1) * 4 + 3];
        if (v > 0) values[n++] = v;
      }
    }
    const sorted = values.subarray(0, n).sort();
    const hi = n ? sorted[Math.min(n - 1, Math.floor(n * 0.995))] : 1;
    const lo = n ? sorted[Math.floor(n * 0.05)] : 1;
    const s = Math.max(lo, hi / 1000, 1e-12);
    const denom = Math.log1p(hi / s);
    const img = baseCtx.createImageData(cols, lrows);
    for (let ly = 0; ly < lrows; ly++) {
      const rgb = whaleRgb && ly * (1 << level.rowShift) <= whiteRow ? whaleRgb : baseRgb;
      for (let lx = 0; lx < cols; lx++) {
        const v = data[((ly + 1) * SLOT + lx + 1) * 4 + 3];
        const o = (ly * cols + lx) * 4;
        if (!(v > 0)) {
          img.data[o] = 6;
          img.data[o + 1] = 9;
          img.data[o + 2] = 12;
          img.data[o + 3] = 255;
          continue;
        }
        const t = Math.min(1, Math.log1p(v / s) / denom);
        const i = Math.max(0, Math.min(255, Math.floor(t * 255)));
        img.data[o] = rgb[i * 3];
        img.data[o + 1] = rgb[i * 3 + 1];
        img.data[o + 2] = rgb[i * 3 + 2];
        img.data[o + 3] = 255;
      }
    }
    baseCtx.putImageData(img, 0, 0);
  }

  function toPx(x, z, w, h) {
    return [(x / worldW) * w, (z / worldH) * h];
  }

  function draw({ block, pose, footprint }) {
    const now = performance.now();
    const key = block + '|' + (pose ? [pose.x, pose.z, pose.yaw].map((n) => n.toFixed(2)).join(',') : '');
    // Rebuild the colour image at most 4 times a second; the overlay redraws on change.
    const rebuild = dirty && hasData && now - lastRebuild >= 250;
    if (!rebuild && key === lastKey) return;
    lastKey = key;
    const { w, h, dpr } = size();
    const ctx = canvas.getContext('2d');
    if (rebuild) {
      rebuildBase();
      lastRebuild = now;
      dirty = false;
    }
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    if (hasData) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(base, 0, 0, w, h);
    }
    if (Number.isFinite(block)) {
      const [nx] = toPx(worldX(block + 1), 0, w, h);
      ctx.fillStyle = 'rgba(237,191,118,0.95)';
      ctx.fillRect(Math.min(w - dpr, nx), 0, Math.max(1, dpr), h);
    }
    if (footprint && footprint.length === 4) {
      ctx.beginPath();
      footprint.forEach(([x, z], i) => {
        const [px, py] = toPx(x, z, w, h);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(168,214,179,0.14)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(168,214,179,0.85)';
      ctx.stroke();
    }
    if (pose) {
      // Outside the map (e.g. the default overview) the camera is drawn on the nearest edge.
      const [rx, ry] = toPx(pose.x, pose.z, w, h);
      const inset = 4 * dpr;
      const px = Math.min(w - inset, Math.max(inset, rx));
      const py = Math.min(h - inset, Math.max(inset, ry));
      const outside = px !== rx || py !== ry;
      const yaw = (pose.yaw * Math.PI) / 180;
      const len = 14 * dpr;
      ctx.strokeStyle = '#edece4';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.sin(yaw) * len, py - Math.cos(yaw) * len);
      ctx.stroke();
      ctx.fillStyle = outside ? '#edbf76' : '#edece4';
      ctx.beginPath();
      ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    meta.textContent = Number.isFinite(block) ? 'edge ' + fmtInt(block) : '';
  }

  let dragging = false;
  function navigate(e) {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * worldW;
    const z = ((e.clientY - r.top) / r.height) * worldH;
    if (onNavigate) onNavigate(x, z, { dragging });
  }
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    navigate(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) navigate(e);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  if (settings.subscribe) {
    settings.subscribe('*', (changes) => {
      if (changes.some((c) => c.id.startsWith('color.'))) dirty = true;
    });
  }

  return {
    element: container,
    tileId,
    get hasData() {
      return hasData;
    },
    /** Keep a private copy of the L6 tile from worker frames (full tiles and deltas). */
    applyFrame(frame) {
      if (!frame) return;
      for (const t of frame.full || []) {
        if (t.id !== tileId) continue;
        if (t.empty || !t.data) data.fill(0);
        else data.set(t.data);
        hasData = true;
        dirty = true;
      }
      const d = frame.deltas;
      if (d && d.ids) {
        for (let k = 0; k < d.ids.length; k++) {
          if (d.ids[k] !== tileId) continue;
          for (let j = d.offsets[k]; j < d.offsets[k + 1]; j++) {
            const o = d.index[j] * 4;
            data[o] = d.data[j * 4];
            data[o + 1] = d.data[j * 4 + 1];
            data[o + 2] = d.data[j * 4 + 2];
            data[o + 3] = d.data[j * 4 + 3];
          }
          dirty = true;
        }
      }
    },
    draw,
  };
}
