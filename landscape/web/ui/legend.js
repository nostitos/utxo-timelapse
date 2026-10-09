// Legend (landscape/SPEC.md §8): palette strips and the transfer scale for the current
// settings, the height measure and curve, heat, and the equal-width note. Colours come
// from render/terrain/palette.js, the module the terrain LUTs use.

import { paletteRGB, parseColor } from '../render/terrain/palette.js';
import { fmtCompact } from './format.js';

const MEASURE_LABELS = {
  density: 'weighted density',
  count: 'unspent outputs',
  value: 'BTC',
};
const MEASURE_NOTES = {
  density: 'outputs; above 5 BTC each counts amount \u00f7 5 BTC',
  count: 'outputs per cell',
  value: 'bitcoin per cell',
};
const CURVES = { log: 'log curve', power: 'power curve', linear: 'linear' };
const NICE = [1, 2, 5];

/** Palette position (0..1) of a value under the colour transfer (inverse of the legend ticks). */
export function transferPosition(v, { offset = 30, upper = 500, gamma = 1 }) {
  if (!(v > 0)) return 0;
  const x1 = Math.log(1 + offset);
  const x2 = Math.log(upper + offset);
  const s = Math.min(1, Math.max(0, (Math.log(v + offset) - x1) / (x2 - x1)));
  return gamma === 1 ? s : Math.pow(s, gamma);
}

/** Round tick values between 1 and upper, at least minGap apart on the strip. */
export function legendTicks(transfer, minGap = 0.14) {
  const upper = transfer.upper ?? 500;
  const values = [];
  for (let e = 0; e <= 12; e++) {
    for (const n of NICE) {
      const v = n * Math.pow(10, e);
      if (v > 1 && v < upper) values.push(v);
    }
  }
  const ticks = [{ v: 1, t: 0, label: '1' }];
  const last = { v: upper, t: 1, label: fmtCompact(upper) + '+' };
  for (const v of values) {
    const t = transferPosition(v, transfer);
    if (t - ticks[ticks.length - 1].t >= minGap && 1 - t >= minGap) ticks.push({ v, t, label: fmtCompact(v) });
  }
  ticks.push(last);
  return ticks;
}

function stripCanvas(rgb) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    img.data[i * 4] = rgb[i * 3];
    img.data[i * 4 + 1] = rgb[i * 3 + 1];
    img.data[i * 4 + 2] = rgb[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function createLegend({ container, settings }) {
  const get = (id, fb) => {
    try {
      const v = settings.get(id);
      return v === undefined || v === null ? fb : v;
    } catch {
      return fb;
    }
  };
  let pending = false;

  function render() {
    pending = false;
    const palette = get('color.palette', 'film');
    const opts = { gradient: get('color.gradient', null), reverse: !!get('color.reverse', false) };
    const transfer = { offset: get('color.offset', 30), upper: get('color.upper', 500), gamma: get('color.gamma', 1) };
    const heightMeasure = get('amp.measure', 'density');
    const colourMeasureSetting = get('color.measure', 'height');
    const colourMeasure = colourMeasureSetting === 'height' ? heightMeasure : colourMeasureSetting;
    const whiteHot = !!get('color.whiteHot', true);
    const whiteBtc = get('color.whiteHotBTC', 10);
    const ticks = legendTicks(transfer);
    const heat = parseColor(get('color.heat', '#ffffff')) || [255, 255, 255];
    const halfLife = get('amp.heatHalfLife', 144);

    container.innerHTML =
      '<div class="lg-head"><span class="eyebrow">Colour</span><span class="lg-measure">' + MEASURE_LABELS[colourMeasure] + ' per cell</span></div>' +
      '<div class="lg-strips"></div>' +
      '<div class="lg-ticks">' + ticks.map((t) => '<span style="left:' + (t.t * 100).toFixed(2) + '%">' + t.label + '</span>').join('') + '</div>' +
      '<p class="lg-note">' + MEASURE_NOTES[colourMeasure] + '; log scale from 1 to ' + fmtCompact(transfer.upper) + (transfer.gamma !== 1 ? ', gamma ' + transfer.gamma : '') + '. Empty cells use the ground colour.</p>' +
      '<div class="lg-row"><span class="eyebrow">Height</span><span>' + MEASURE_LABELS[heightMeasure] + ' \u00b7 ' + (CURVES[get('amp.curve', 'log')] || '') + ' \u00b7 \u00d7' + fmtCompact(get('amp.exaggeration', 1)) + '</span></div>' +
      '<div class="lg-row"><span class="eyebrow">Heat</span><span><i class="lg-swatch" style="background:rgb(' + heat.join(',') + ')"></i>Spent outputs flash, brighter for more BTC \u00b7 half-life ' + fmtCompact(halfLife) + ' blocks</span></div>' +
      '<p class="lg-foot">Each cell holds 64 blocks \u00d7 1 amount row. Every block has the same width, so early eras look sparse next to the film.</p>';
    const strips = container.querySelector('.lg-strips');
    const rows = [[whiteHot ? 'Below ' + fmtCompact(whiteBtc) + ' BTC' : 'All rows', paletteRGB(palette, opts)]];
    if (whiteHot) rows.push([fmtCompact(whiteBtc) + ' BTC and up', paletteRGB(palette, { ...opts, whiteHot: true })]);
    for (const [label, rgb] of rows) {
      const row = document.createElement('div');
      row.className = 'lg-strip';
      const span = document.createElement('span');
      span.textContent = label;
      const canvas = stripCanvas(rgb);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', label + ' colour scale');
      row.append(span, canvas);
      strips.appendChild(row);
    }
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(render);
  }

  render();
  const unsubscribe = settings.subscribe ? settings.subscribe('*', schedule) : null;
  return {
    element: container,
    render,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}
