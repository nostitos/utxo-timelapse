// browser-check --script body (render_post): Film preset colour exactness through the full
// createLandscapeView pipeline. Load render_post-view.html?terrain=real&preset=Film&overlay=0
// first. Looks straight down, renders one frame, copies the canvas in the same task and
// compares interior pixels of picked cells with palettes.json bytes (film / whale tables)
// selected by render_terrain's exact film transfer.
const q = new URLSearchParams(location.search);
const dev = window.__dev;
const view = dev.view;
const pal = await import('/render/terrain/palette.js');
const base = pal.paletteRGB('film');
const whale = pal.whaleRGB();
const whiteRow = pal.whiteHotRow(dev.replay.rows, pal.FILM_WHITE_HOT_BTC);
const cam = view.camera;
const X = Number(q.get('fx') || 700);
const Z = Number(q.get('fz') || 110);
const H = Number(q.get('fh') || 40);
cam.up.set(0, 0, -1);
cam.position.set(X, H, Z);
cam.lookAt(X, 0, Z);
cam.updateMatrixWorld();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await dev.settle();
await wait(3000);
await dev.settle();
view.update(1 / 60);
view.render();
const canvas = view.renderer.domElement;
const W = canvas.width;
const Hh = canvas.height;
const oc = new OffscreenCanvas(W, Hh);
const ctx = oc.getContext('2d');
ctx.drawImage(canvas, 0, 0);
const px = ctx.getImageData(0, 0, W, Hh).data;
const rect = canvas.getBoundingClientRect();
const sx = rect.width / W;
const sy = rect.height / Hh;
const pickAt = (x, y) => view.pick(rect.left + (x + 0.5) * sx, rect.top + (y + 0.5) * sy);
let n = 0, exact = 0, near1 = 0, groundCells = 0, whaleCells = 0;
const levels = {};
const mismatches = [];
const step = Number(q.get('step') || 17);
for (let y = 12; y < Hh - 12; y += step) {
  for (let x = 12; x < W - 12; x += step) {
    const hit = pickAt(x, y);
    if (!hit) continue;
    const same = [[3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dy]) => {
      const h2 = pickAt(x + dx, y + dy);
      return h2 && h2.col === hit.col && h2.row === hit.row && h2.level === hit.level;
    });
    if (!same) continue;
    const idx = pal.transferIndex(hit.colorValue, pal.FILM_TRANSFER);
    let exp;
    const row0 = hit.l0Row ?? hit.row;
    if (idx < 0) { exp = [0, 0, 0]; groundCells++; } else {
      const isWhale = row0 <= whiteRow;
      if (isWhale) whaleCells++;
      const t = isWhale ? whale : base;
      exp = [t[idx * 3], t[idx * 3 + 1], t[idx * 3 + 2]];
    }
    const o = (y * W + x) * 4;
    const got = [px[o], px[o + 1], px[o + 2]];
    const d = Math.max(Math.abs(got[0] - exp[0]), Math.abs(got[1] - exp[1]), Math.abs(got[2] - exp[2]));
    n++;
    levels[hit.level] = (levels[hit.level] || 0) + 1;
    if (d === 0) exact++;
    if (d <= 1) near1++;
    else if (mismatches.length < 10) mismatches.push({ x, y, got, exp, idx, v: hit.colorValue, row: row0, level: hit.level });
  }
}
return { samples: n, exact, withinOne: near1, groundCells, whaleCells, levels, whiteRow, mismatches,
  stages: view.describe().stages, size: [W, Hh], block: dev.replay.block };
