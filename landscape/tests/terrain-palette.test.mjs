// Tests for landscape/web/render/terrain/palette.js (render_terrain).
// Run: node --test landscape/tests/terrain-palette.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../web/render/terrain/palette.js';
import { buildMinAmtTable, rowOfAmount, parseRowsBin } from '../web/data/axis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (u8) => Buffer.from(u8).toString('hex');
const palettesJson = JSON.parse(readFileSync(join(ROOT, 'site/assets/palettes.json'), 'utf8'));

// Deterministic PRNG.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
function nextUp(x) {
  f64[0] = x;
  if (x >= 0) u64[0] += 1n;
  else u64[0] -= 1n;
  return f64[0];
}
function nextDown(x) {
  f64[0] = x;
  if (x > 0) u64[0] -= 1n;
  else u64[0] += 1n;
  return f64[0];
}

test('film and whale tables equal site/assets/palettes.json byte for byte', () => {
  assert.equal(hex(P.paletteRGB('film')), palettesJson.base);
  assert.equal(hex(P.whaleRGB()), palettesJson.whale);
  assert.equal(hex(P.paletteRGB('film', { whiteHot: true })), palettesJson.whale);
});

test('applyWhiteHotTail ports ColorMap::applyWhiteHotTail: film -> whale, entries 0..180 unchanged', () => {
  const film = P.paletteRGB('film');
  const tail = P.applyWhiteHotTail(film);
  assert.equal(hex(tail), palettesJson.whale);
  assert.deepEqual(Array.from(tail.slice(0, 181 * 3)), Array.from(film.slice(0, 181 * 3)));
  assert.deepEqual(Array.from(tail.slice(255 * 3)), [255, 245, 224]);
});

test('every named palette has 256 RGB entries; reverse, grey and custom behave', () => {
  for (const name of P.PALETTE_NAMES) {
    const rgb = P.paletteRGB(name);
    assert.equal(rgb.length, 768, name);
    const rev = P.paletteRGB(name, { reverse: true });
    for (let i = 0; i < 256; i++) {
      for (let c = 0; c < 3; c++) assert.equal(rev[i * 3 + c], rgb[(255 - i) * 3 + c], name + ' reverse ' + i);
    }
    const hot = P.paletteRGB(name, { whiteHot: true });
    assert.deepEqual(Array.from(hot.slice(765)), [255, 245, 224], name + ' white-hot end');
  }
  const grey = P.paletteRGB('grey');
  for (let i = 0; i < 256; i++) assert.deepEqual(Array.from(grey.slice(i * 3, i * 3 + 3)), [i, i, i]);
  // turbo (round(255x)) stays within one level of the film table (uint8(256x)).
  const film = P.paletteRGB('film');
  const turbo = P.paletteRGB('turbo');
  for (let i = 0; i < 768; i++) assert.ok(Math.abs(film[i] - turbo[i]) <= 1, 'turbo vs film ' + i);
  const g = P.gradientRGB([{ t: 1, color: '#ffffff' }, { t: 0, color: '#000000' }, { t: 0.5, color: '#ff0000' }]);
  assert.deepEqual(Array.from(g.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(g.slice(765)), [255, 255, 255]);
  assert.equal(g[127 * 3], Math.round((127 / 255 / 0.5) * 255));
  assert.equal(P.normalizeGradient([]).length, P.DEFAULT_GRADIENT.length);
  assert.equal(P.normalizeGradient(Array.from({ length: 30 }, (_, i) => ({ t: i / 29, color: '#123456' }))).length, 16);
  assert.deepEqual(P.parseColor('#abc'), [170, 187, 204]);
  assert.deepEqual(P.parseColor(0x102030), [16, 32, 48]);
  assert.equal(P.parseColor('nope'), null);
});

// Densities: random log-uniform, integers, and the exact double boundaries of every index.
function densitySamples() {
  const r = rng(7);
  const out = [0, -1, -0.5, 1e-300, 0.25, 0.5, 1, 1.5, 2, 30, 100, 499.99, 500, 500.0000001, 1e6, 1e15];
  for (let i = 0; i < 40000; i++) out.push(Math.exp(-14 + 23 * r()));
  for (let i = 0; i <= 600; i++) out.push(i, i + 0.5);
  // Boundaries of both the table (C++ semantics) and the plain JS formula, where fused
  // multiply-add and log rounding differences live, with 4 neighbouring doubles each side.
  for (const f of [(v) => P.transferIndex(v), (v) => P.transferIndexFormula(v)]) {
    for (let i = 1; i < 256; i++) {
      let a = 0;
      let b = 500;
      for (let k = 0; k < 200; k++) {
        const m = (a + b) / 2;
        if (m === a || m === b) break;
        if (f(m) >= i) b = m;
        else a = m;
      }
      let x = b;
      for (let k = 0; k < 4; k++) x = nextDown(x);
      for (let k = 0; k < 9; k++) {
        out.push(x);
        x = nextUp(x);
      }
    }
  }
  const n = out.length;
  for (let i = 0; i < n; i++) out.push(Math.fround(out[i])); // float32 values as the GPU sees them
  return out;
}

test('transferIndex equals buv::DensityToImage (compiled from src/cpp) for every sampled density', (t) => {
  const cxx = spawnSync('c++', ['--version']);
  const fmtInc = join(ROOT, 'src/third_party/fmt/include');
  if (cxx.status !== 0 || !existsSync(fmtInc)) {
    t.skip('no C++ compiler or fmt headers; cannot build the DensityToImage reference');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'terrain-palette-'));
  try {
    const lits = [];
    for (let i = 0; i < 256; i++) lits.push((i + 0.5) / 256, (255 - i + 0.5) / 256, 128.5 / 256);
    const src = '#include <fmt/format.h>\n#include <buv/DensityToImage.h>\n#include <cstdio>\n#include <cstdint>\n' +
      'int main(int argc, char** argv) {\n' +
      '  buv::ColorMap cm{' + lits.join(',') + '};\n' +
      '  buv::DensityToImage img(1, 1, 500, cm, std::array<uint8_t, 3>{1, 1, 1});\n' +
      '  FILE* in = std::fopen(argv[1], "rb"); FILE* out = std::fopen(argv[2], "wb");\n' +
      '  double d;\n' +
      '  while (std::fread(&d, sizeof d, 1, in) == 1) {\n' +
      '    img.update(0, d); const uint8_t* p = img.rgb(0);\n' +
      '    int32_t idx = (p[0] == 1 && p[1] == 1 && p[2] == 1) ? -1 : p[0];\n' +
      '    std::fwrite(&idx, sizeof idx, 1, out);\n' +
      '  }\n' +
      '  std::fclose(in); std::fclose(out); return 0;\n}\n';
    writeFileSync(join(dir, 'ref.cpp'), src);
    const exe = join(dir, 'ref');
    // Same compiler defaults as the renderer's Release build (-O3, default FP contraction).
    const cc = spawnSync('c++', ['-std=c++17', '-O3', '-DFMT_HEADER_ONLY', '-I', join(ROOT, 'src/cpp'), '-I', fmtInc,
      join(dir, 'ref.cpp'), '-o', exe], { encoding: 'utf8' });
    assert.equal(cc.status, 0, 'compile failed: ' + cc.stderr);
    const ds = densitySamples();
    writeFileSync(join(dir, 'in.bin'), Buffer.from(new Float64Array(ds).buffer));
    const run = spawnSync(exe, [join(dir, 'in.bin'), join(dir, 'out.bin')], { encoding: 'utf8' });
    assert.equal(run.status, 0, 'reference run failed: ' + run.stderr);
    const buf = readFileSync(join(dir, 'out.bin'));
    const ref = new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    assert.equal(ref.length, ds.length);
    let mismatches = 0;
    const first = [];
    const seen = new Set();
    for (let i = 0; i < ds.length; i++) {
      const js = P.transferIndex(ds[i], P.FILM_TRANSFER);
      seen.add(ref[i]);
      if (js !== ref[i]) {
        mismatches++;
        if (first.length < 5) first.push({ d: ds[i], js, cpp: ref[i] });
      }
    }
    assert.equal(mismatches, 0, 'mismatches: ' + JSON.stringify(first));
    assert.equal(seen.size, 257, 'every index 0..255 and the background were exercised');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('float32 thresholds reproduce transferIndex exactly (GPU path) for several settings', () => {
  const settings = [
    P.FILM_TRANSFER,
    { offset: 1, upper: 100, gamma: 1 },
    { offset: 30, upper: 500, gamma: 0.5 },
    { offset: 10, upper: 5000, gamma: 2.2 },
    { offset: 0.01, upper: 1e7, gamma: 1.3 },
  ];
  const r = rng(11);
  for (const s of settings) {
    const T = P.transferThresholds(s);
    assert.equal(T.length, 256);
    for (let i = 2; i < 256; i++) assert.ok(T[i] >= T[i - 1], 'thresholds non-decreasing');
    const vals = [];
    for (let i = 0; i < 20000; i++) vals.push(Math.fround(Math.exp(-16 + 30 * r())));
    for (let i = 1; i < 256; i++) {
      vals.push(T[i]);
      const f = new Float32Array([T[i]]);
      const u = new Uint32Array(f.buffer);
      u[0] -= 1;
      vals.push(f[0]);
    }
    vals.push(0, -1, Math.fround(s.upper), 3.4e38);
    for (const v of vals) assert.equal(P.thresholdIndex(T, v), P.transferIndex(v, s), JSON.stringify({ s, v }));
  }
});

test('whiteHotRow is the last row at/above the threshold amount (rows.bin semantics)', () => {
  const tables = [buildMinAmtTable()];
  const devRows = '/tmp/landscape_dev/rows.bin';
  if (existsSync(devRows)) {
    const b = readFileSync(devRows);
    tables.push(parseRowsBin(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  }
  for (const rows of tables) {
    const r10 = P.whiteHotRow(rows, 10);
    assert.equal(r10, rowOfAmount(rows, 1e9));
    assert.ok(rowOfAmount(rows, 11e8) <= r10 && rowOfAmount(rows, 9e8) >= r10);
    assert.equal(P.whiteHotRow(rows, 0), -1);
    assert.equal(P.whiteHotRow(rows, 200000), -1); // above the 100,000 BTC axis maximum
    assert.equal(P.whiteHotRow(rows, 1e-8), rowOfAmount(rows, 1));
  }
});

test('cellRGB combines transfer, palettes and the white-hot rows', () => {
  const base = P.paletteRGB('film');
  const whale = P.whaleRGB();
  const ctx = { base, whale, whiteRow: 100, ground: [9, 8, 7], transfer: P.FILM_TRANSFER };
  assert.deepEqual(P.cellRGB(0, 50, ctx), [9, 8, 7]);
  assert.deepEqual(P.cellRGB(1000, 50, ctx), [255, 245, 224]);
  assert.deepEqual(P.cellRGB(1000, 101, ctx), Array.from(base.slice(765)));
  const i = P.transferIndex(42, P.FILM_TRANSFER);
  assert.deepEqual(P.cellRGB(42, 500, ctx), Array.from(base.slice(i * 3, i * 3 + 3)));
});
