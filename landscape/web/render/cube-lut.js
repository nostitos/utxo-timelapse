// Adobe/Resolve .cube 3D LUT parser (render_post). Pure module, no three.js.
//
// Format: optional TITLE "…", LUT_3D_SIZE N, optional DOMAIN_MIN/DOMAIN_MAX r g b, then N³
// lines "r g b" with red varying fastest, then green, then blue — the same order as a
// three.js Data3DTexture (x fastest), so the data uploads without reordering.

export const CUBE_MAX_SIZE = 128;

export function parseCubeLUT(text) {
  if (typeof text !== 'string') throw new TypeError('cube LUT: text expected');
  let title = '';
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let data = null;
  let n = 0;
  let expected = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;
    const first = line.charCodeAt(0);
    const isNumber = (first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46;
    if (!isNumber) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*(.*)$/);
      if (!m) throw new Error('cube LUT: unrecognised line ' + (li + 1));
      const key = m[1].toUpperCase();
      const rest = m[2].trim();
      if (key === 'TITLE') title = rest.replace(/^"(.*)"$/, '$1');
      else if (key === 'LUT_3D_SIZE') {
        size = parseInt(rest, 10);
        if (!(size >= 2 && size <= CUBE_MAX_SIZE)) throw new Error('cube LUT: LUT_3D_SIZE out of range: ' + rest);
        expected = size * size * size;
        data = new Float32Array(expected * 4);
      } else if (key === 'LUT_1D_SIZE') throw new Error('cube LUT: 1D LUTs are not supported');
      else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
        const v = rest.split(/\s+/).map(Number);
        if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new Error('cube LUT: bad ' + key);
        if (key === 'DOMAIN_MIN') domainMin = v; else domainMax = v;
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        const v = rest.split(/\s+/).map(Number);
        if (v.length !== 2 || v.some((x) => !Number.isFinite(x))) throw new Error('cube LUT: bad LUT_3D_INPUT_RANGE');
        domainMin = [v[0], v[0], v[0]];
        domainMax = [v[1], v[1], v[1]];
      }
      // Other keywords are ignored, as in other readers.
      continue;
    }
    if (!data) throw new Error('cube LUT: data before LUT_3D_SIZE');
    const parts = line.split(/\s+/);
    if (parts.length < 3) throw new Error('cube LUT: expected three values on line ' + (li + 1));
    if (n >= expected) throw new Error('cube LUT: more than ' + expected + ' entries');
    const o = n * 4;
    for (let c = 0; c < 3; c++) {
      const v = Number(parts[c]);
      if (!Number.isFinite(v)) throw new Error('cube LUT: bad number on line ' + (li + 1));
      data[o + c] = v;
    }
    data[o + 3] = 1;
    n++;
  }
  if (!size) throw new Error('cube LUT: missing LUT_3D_SIZE');
  if (n !== expected) throw new Error('cube LUT: expected ' + expected + ' entries, found ' + n);
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) throw new Error('cube LUT: DOMAIN_MAX must exceed DOMAIN_MIN');
  }
  return { title, size, domainMin, domainMax, data };
}

/** Identity LUT text (tests and a neutral starting point). */
export function identityCubeLUT(size = 17, title = 'identity') {
  const out = ['TITLE "' + title + '"', 'LUT_3D_SIZE ' + size];
  const d = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) out.push((r / d).toFixed(6) + ' ' + (g / d).toFixed(6) + ' ' + (b / d).toFixed(6));
    }
  }
  return out.join('\n') + '\n';
}

/** Trilinear lookup on parsed data (reference for tests; the GPU path samples a 3D texture). */
export function sampleCubeLUT(lut, rgb) {
  const { size, data, domainMin, domainMax } = lut;
  const p = [0, 1, 2].map((c) => {
    const t = (rgb[c] - domainMin[c]) / (domainMax[c] - domainMin[c]);
    return Math.min(1, Math.max(0, t)) * (size - 1);
  });
  const i0 = p.map((x) => Math.min(size - 2, Math.floor(x)));
  const f = p.map((x, c) => x - i0[c]);
  const at = (r, g, b, c) => data[((b * size + g) * size + r) * 4 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const dr = k & 1, dg = (k >> 1) & 1, db = (k >> 2) & 1;
      const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
      v += w * at(i0[0] + dr, i0[1] + dg, i0[2] + db, c);
    }
    out[c] = v;
  }
  return out;
}
