// Height curve on the CPU (pure; no three.js). Mirrors the shader in shading.js exactly
// (landscape/SPEC.md §6): log: log(1 + e v) / log(1 + e R); power: (e v / (e R))^exponent;
// linear: e v / (e R). Height = exaggeration * curve, times the whale factor (whaleFactorCpu),
// plus floor for occupied cells; empty cells have height 0.

export const CURVES = Object.freeze({ log: 0, power: 1, linear: 2 });

/**
 * Decades of amounts below the whale threshold over which the whale multiplier eases in:
 * with the default 10 BTC threshold it is 1 at 1 BTC and reaches amp.whale at 10 BTC.
 */
export const WHALE_RAMP_DECADES = 1;

/**
 * Height multiplier of L0 row l0row (row 0 = largest amounts): p.whale on rows at/above the
 * white-hot row p.whiteRow, easing back to 1 with a smoothstep across the rows down to
 * p.whaleRampRow, so the taller whale rows do not end in a cliff at the threshold. Without
 * whaleRampRow (or with it at whiteRow) the multiplier stops at the threshold.
 */
export function whaleFactorCpu(l0row, p) {
  if (l0row <= p.whiteRow) return p.whale;
  const end = p.whaleRampRow ?? p.whiteRow;
  if (!(end > p.whiteRow) || l0row >= end) return 1;
  const t = (end - l0row) / (end - p.whiteRow);
  return 1 + (p.whale - 1) * t * t * (3 - 2 * t);
}

/** Height of a cell with area-normalised value v whose first L0 row is l0row. */
export function heightOfCpu(v, l0row, p) {
  if (!(v > 0)) return 0;
  const e = p.exposure;
  const R = p.reference;
  let c;
  if (p.curve === 'power') c = Math.pow((e * v) / (e * R), p.exponent);
  else if (p.curve === 'linear') c = (e * v) / (e * R);
  else c = Math.log(1 + e * v) / Math.log(1 + e * R);
  return c * p.exaggeration * whaleFactorCpu(l0row, p) + p.floor;
}

/** Upper bound of the height of any cell whose value is at most maxV (any row). */
export function heightBoundCpu(maxV, p) {
  if (!(maxV > 0)) return 0;
  return heightOfCpu(maxV, -Infinity, { ...p, whale: Math.max(1, p.whale), whiteRow: Infinity });
}

// Spend flashes (activity heat). The worker stores, per cell, the BTC moved by spends as a
// raw sum decayed to the block of the latest spend (heat, heatBlock; SPEC §3). Brightness:
//   gain * (floor + (1 - floor) * clamp(ln(1 + heat / H0) / ln(1 + reference / H0), 0, 1))
//        * 2^(-(block - heatBlock) / halfLife)
// so every spend reaches at least 'floor' at its own block, as every spent output flashes in
// the film, and more BTC moved brightens it logarithmically up to 'reference' BTC.
export const HEAT_H0 = 1e-4; // BTC (10,000 sat): knee of the logarithmic amount scale

/** Heat brightness (multiplies color.heat) of a cell 'age' blocks after its latest spend. */
export function heatIntensityCpu(heat, age, { gain = 2.5, floor = 0.35, reference = 100, halfLife = 30 } = {}) {
  if (!(heat > 0)) return 0;
  const ref = Math.max(reference, HEAT_H0 * 1.001);
  const t = Math.min(1, Math.max(0, Math.log1p(heat / HEAT_H0) / Math.log1p(ref / HEAT_H0)));
  const amp = floor + (1 - floor) * t;
  return gain * amp * Math.pow(2, -Math.max(0, age) / Math.max(halfLife, 1e-3));
}

/** Amount scale shared by the heat glow and the flash sprites: 0 for dust, 1 at the reference. */
export function heatAmountScale(btc, reference = 100) {
  if (!(btc > 0)) return 0;
  const ref = Math.max(reference, HEAT_H0 * 1.001);
  return Math.min(1, Math.max(0, Math.log1p(btc / HEAT_H0) / Math.log1p(ref / HEAT_H0)));
}

/**
 * Flash sprite for a spend of 'btc' BTC (amp.flashSize = size, amp.heatReference =
 * reference): world size, minimum on-screen size in pixels and HDR brightness. Like the
 * film's 1 to 9 pixel flashes, every sprite stays visible from far away (3 px for small
 * spends up to 16 px at the reference); coins spent near the creation edge (old = false)
 * get smaller, dimmer flashes, as in the film, so the busy edge does not wash out.
 */
export function flashLook(btc, { size = 1, reference = 100, old = true, edge = 0.3 } = {}) {
  const t = heatAmountScale(btc, reference);
  const s = old ? 1 : 0.5;
  return { t, size: size * (0.15 + 0.8 * t) * s, minPx: size * (3 + 13 * t) * s, intensity: (1 + 2.5 * t) * (old ? 1 : edge) };
}
