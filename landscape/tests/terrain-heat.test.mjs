// Spend flashes (activity heat): brightness transfer and flash sprite sizing (pure helpers
// in render/terrain/curve.js; the shader in shading.js mirrors heatIntensityCpu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { heatIntensityCpu, heatAmountScale, flashLook, HEAT_H0 } from '../web/render/terrain/curve.js';

const P = { gain: 2.5, floor: 0.35, reference: 100, halfLife: 30 };

test('every spend flashes at least at the floor, and brighter for more BTC', () => {
  assert.equal(heatIntensityCpu(0, 0, P), 0);
  assert.equal(heatIntensityCpu(-1, 0, P), 0);
  const oneSat = heatIntensityCpu(1e-8, 0, P);
  assert.ok(Math.abs(oneSat - P.gain * P.floor) < 1e-3, '1 sat reaches the floor: ' + oneSat);
  let prev = 0;
  for (const btc of [1e-8, 1e-6, 1e-4, 0.01, 1, 10, 100]) {
    const v = heatIntensityCpu(btc, 0, P);
    assert.ok(v > prev, btc + ' BTC brighter than smaller spends');
    prev = v;
  }
  assert.ok(Math.abs(heatIntensityCpu(100, 0, P) - P.gain) < 1e-9, 'the reference reaches full brightness');
  assert.equal(heatIntensityCpu(1e6, 0, P), P.gain, 'clamped above the reference');
  // A typical 0.01 BTC spend: the old transfer (log2(1 + h) / 8 * 1.5) gave 0.0027.
  const typical = heatIntensityCpu(0.01, 0, P);
  assert.ok(typical > 1.2 && typical < 1.6, 'typical spend is clearly visible: ' + typical);
});

test('flashes fade with the half-life and vanish after a few half-lives', () => {
  const v0 = heatIntensityCpu(1, 0, P);
  assert.ok(Math.abs(heatIntensityCpu(1, 30, P) - v0 / 2) < 1e-12);
  assert.ok(Math.abs(heatIntensityCpu(1, 60, P) - v0 / 4) < 1e-12);
  assert.ok(heatIntensityCpu(1, 300, P) < 0.003, 'gone after ten half-lives');
  assert.equal(heatIntensityCpu(1, -5, P), v0, 'negative ages clamp to the spend block');
});

test('floor 0 makes brightness depend only on the BTC moved; the reference rescales it', () => {
  const noFloor = { ...P, floor: 0 };
  assert.ok(heatIntensityCpu(HEAT_H0 / 1000, 0, noFloor) < 0.01);
  const low = heatIntensityCpu(1, 0, { ...P, reference: 1 });
  assert.ok(Math.abs(low - P.gain) < 1e-9, '1 BTC is full brightness when the reference is 1 BTC');
});

test('flash sprites grow with the BTC moved, keep a minimum screen size, and are smaller near the edge', () => {
  const dust = flashLook(1e-6, { size: 1, reference: 100 });
  const a = flashLook(1, { size: 1, reference: 100 });
  const b = flashLook(100, { size: 1, reference: 100 });
  assert.ok(b.size > a.size && b.minPx > a.minPx && b.intensity > a.intensity);
  assert.ok(dust.minPx >= 3 && dust.minPx < 3.1, 'small spends still get 3 px: ' + dust.minPx);
  assert.ok(Math.abs(b.minPx - 16) < 1e-9, '16 px at the reference: ' + b.minPx);
  assert.equal(heatAmountScale(1e9, 100), 1);
  const edge = flashLook(100, { size: 1, reference: 100, old: false });
  assert.ok(Math.abs(edge.size - b.size * 0.5) < 1e-12 && Math.abs(edge.minPx - b.minPx * 0.5) < 1e-12);
  assert.ok(edge.intensity < b.intensity / 2, 'creation-edge flashes are dimmer');
  assert.equal(flashLook(100, { old: false, edge: 1 }).intensity, b.intensity, 'edge strength 1 treats young coins like old ones');
  assert.equal(flashLook(100, { size: 0 }).minPx, 0, 'size 0 hides flashes');
});
