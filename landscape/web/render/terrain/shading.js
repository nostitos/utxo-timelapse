// Shared TSL nodes for the landscape terrain: height curve, exact palette colour transfer,
// heat, creation-edge glow, rim and grid lines (landscape/SPEC.md §3, §6, §7).
import { Color, Vector3, DataTexture, RGBAFormat, FloatType, UnsignedByteType, NearestFilter, NoColorSpace } from 'three/webgpu';
import {
  Fn, uniform, float, int, ivec2, vec3, select, log, pow, exp2, log2, clamp, min, max, abs, floor,
  round, smoothstep, fwidth, textureLoad, sRGBTransferEOTF, dot, saturate, positionViewDirection,
} from 'three/tsl';
import { paletteRGB, transferThresholds, whiteHotRow, parseColor } from './palette.js';
import { rowOfAmount } from '../../data/axis.js';
import { CURVES, heightOfCpu, HEAT_H0, heatIntensityCpu } from './curve.js';

export { CURVES, heightOfCpu, HEAT_H0, heatIntensityCpu };

function srgbHexToLinearColor(hex, fallback = '#000000') {
  const rgb = parseColor(hex) || parseColor(fallback);
  const c = new Color();
  c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 'srgb');
  return c;
}

export function createShading({ rows }) {
  const u = {
    curve: uniform(0, 'int'),
    exposure: uniform(1),
    reference: uniform(500),
    exponent: uniform(0.5),
    invLogRef: uniform(1 / Math.log(501)),
    exaggeration: uniform(10),
    floor: uniform(0.05),
    whale: uniform(1),
    whiteRow: uniform(-1), // last L0 row (graph row) at/above the white-hot threshold, -1 none
    whitePalette: uniform(1), // 1 when color.whiteHot uses the white-hot palette on those rows
    ground: uniform(new Color(0, 0, 0)),
    heatColor: uniform(new Color(1, 0.55, 0.2)),
    heatGain: uniform(2.5),
    heatFloor: uniform(0.35),
    heatInvLogRef: uniform(1 / Math.log1p(100 / HEAT_H0)),
    heatEdge: uniform(0.3),
    heatEdgeBlocks: uniform(4032),
    halfLife: uniform(30),
    block: uniform(0),
    edgeGlow: uniform(1),
    edgeBlocks: uniform(1008),
    albedo: uniform(0.85),
    emissive: uniform(0.4),
    rim: uniform(0.35),
    rimColor: uniform(new Color(0.6, 0.75, 1)),
    roughness: uniform(0.65),
    metalness: uniform(0.05),
    grid: uniform(0),
    gridBlockStep: uniform(100000),
    gridColor: uniform(new Color(1, 1, 1)),
    gridOpacity: uniform(0.35),
    skirt: uniform(1),
    skirtDepth: uniform(0.02),
    columnFocus: uniform(new Vector3(0, 0, 0)), // (x, z, radius) in world units; radius 0 = off
  };

  // Palette LUT: row 0 base palette, row 1 white-hot palette (sRGB bytes).
  const lutData = new Uint8Array(256 * 2 * 4);
  const lut = new DataTexture(lutData, 256, 2, RGBAFormat, UnsignedByteType);
  lut.minFilter = lut.magFilter = NearestFilter;
  lut.generateMipmaps = false;
  lut.colorSpace = NoColorSpace;
  // Thresholds for the exact transfer (float32), see palette.js transferThresholds.
  const thrData = new Float32Array(256 * 4);
  const thresholds = new DataTexture(thrData, 256, 1, RGBAFormat, FloatType);
  thresholds.minFilter = thresholds.magFilter = NearestFilter;
  thresholds.generateMipmaps = false;
  thresholds.colorSpace = NoColorSpace;
  // Amount grid rows: 1 where a grid line sits on the top edge of that graph row.
  const gridRowData = new Uint8Array(2072 * 4);
  const gridRows = new DataTexture(gridRowData, 2072, 1, RGBAFormat, UnsignedByteType);
  gridRows.minFilter = gridRows.magFilter = NearestFilter;
  gridRows.generateMipmaps = false;
  gridRows.colorSpace = NoColorSpace;

  const state = {
    palette: 'film', gradient: null, reverse: false, whiteHot: true, whiteHotBTC: 10,
    offset: 30, upper: 500, gamma: 1,
    curve: 'log', exposure: 1, reference: 500, exponent: 0.5, exaggeration: 10, floor: 0.05, whale: 1,
    whiteRow: -1,
  };

  function updateLut() {
    const base = paletteRGB(state.palette, { gradient: state.gradient, reverse: state.reverse });
    const hot = state.whiteHot ? paletteRGB(state.palette, { gradient: state.gradient, reverse: state.reverse, whiteHot: true }) : base;
    for (let i = 0; i < 256; i++) {
      lutData[i * 4] = base[i * 3];
      lutData[i * 4 + 1] = base[i * 3 + 1];
      lutData[i * 4 + 2] = base[i * 3 + 2];
      lutData[i * 4 + 3] = 255;
      const j = (256 + i) * 4;
      lutData[j] = hot[i * 3];
      lutData[j + 1] = hot[i * 3 + 1];
      lutData[j + 2] = hot[i * 3 + 2];
      lutData[j + 3] = 255;
    }
    lut.needsUpdate = true;
  }

  function updateThresholds() {
    const T = transferThresholds({ offset: state.offset, upper: state.upper, gamma: state.gamma });
    for (let i = 0; i < 256; i++) thrData[i * 4] = T[i];
    thresholds.needsUpdate = true;
    state.T = T;
  }

  function updateWhiteRow() {
    const r = rows && rows.length ? whiteHotRow(rows, state.whiteHotBTC) : -1;
    state.whiteRow = r;
    u.whiteRow.value = r;
  }

  function updateCurve() {
    u.curve.value = CURVES[state.curve] ?? 0;
    u.exposure.value = state.exposure;
    u.reference.value = state.reference;
    u.exponent.value = state.exponent;
    u.invLogRef.value = 1 / Math.log(1 + state.exposure * state.reference);
    u.exaggeration.value = state.exaggeration;
    u.floor.value = state.floor;
    u.whale.value = state.whale;
  }

  /** Amount grid rows (graph rows of the labelled amounts). */
  function setGridRows(list) {
    gridRowData.fill(0);
    for (const r of list || []) if (r >= 0 && r < 2072) gridRowData[r * 4] = 255;
    gridRows.needsUpdate = true;
  }
  if (rows && rows.length) {
    const list = [];
    for (let k = 0; k <= 13; k++) list.push(rowOfAmount(rows, 10 ** k));
    setGridRows(list);
  }

  updateLut();
  updateThresholds();
  updateWhiteRow();
  updateCurve();

  // ---- TSL functions ---------------------------------------------------------------------

  /** Height of a cell from its area-normalised height value and its first L0 row. */
  const heightOf = (v, l0row) => {
    const ev = max(v, 0).mul(u.exposure);
    const eR = u.reference.mul(u.exposure);
    const cLog = log(ev.add(1)).mul(u.invLogRef);
    const cPow = pow(ev.div(eR), u.exponent);
    const cLin = ev.div(eR);
    const c = select(u.curve.equal(0), cLog, select(u.curve.equal(1), cPow, cLin));
    const h = c.mul(u.exaggeration);
    const hw = select(l0row.lessThanEqual(u.whiteRow), h.mul(u.whale), h);
    return select(v.greaterThan(0), hw.add(u.floor), float(0));
  };

  /** Palette index (int) of a colour value by binary search over the float32 thresholds. */
  const paletteIndex = (cv) => {
    let lo = int(0);
    for (const step of [128, 64, 32, 16, 8, 4, 2, 1]) {
      const j = lo.add(int(step));
      const t = textureLoad(thresholds, ivec2(j, int(0))).x;
      lo = select(t.lessThanEqual(cv), j, lo).toVar();
    }
    return lo;
  };

  /** Linear RGB of a cell's colour value (ground colour when v <= 0). */
  const cellColor = (cv, l0row) => {
    const idx = paletteIndex(cv);
    const hot = l0row.lessThanEqual(u.whiteRow).and(u.whitePalette.greaterThan(0.5));
    const srgb = textureLoad(lut, ivec2(idx, select(hot, int(1), int(0)))).xyz;
    const lin = sRGBTransferEOTF(srgb);
    return select(cv.greaterThan(0), lin, u.ground);
  };

  /** Heat (raw BTC sum of the cell) decayed to the current block: heat * 2^(-(B - heatBlock)/H) (SPEC §3). */
  const heatDecayed = (heat, heatBlock) => {
    const age = max(u.block.sub(heatBlock), 0);
    return select(heat.greaterThan(0), heat.mul(exp2(age.negate().div(max(u.halfLife, 0.001)))), float(0));
  };
  /**
   * Spend-flash brightness from (heat, heatBlock), mirroring heatIntensityCpu in curve.js:
   * every spend reaches at least the floor at its block, more BTC moved is brighter
   * (logarithmic up to the reference), and the flash fades with the half-life.
   */
  const heatIntensity = (heat, heatBlock, worldX = null) => {
    const age = max(u.block.sub(heatBlock), 0);
    const fade = exp2(age.negate().div(max(u.halfLife, 0.001)));
    const t = clamp(log(max(heat, 0).div(HEAT_H0).add(1)).mul(u.heatInvLogRef), 0, 1);
    const amp = u.heatFloor.add(float(1).sub(u.heatFloor).mul(t));
    // Coins created near the creation edge are spent constantly; like the film's small edge
    // flashes, their glow is dimmed to amp.heatEdge and ramps to full over amp.heatEdgeBlocks.
    const edge = worldX === null ? float(1)
      : float(1).sub(float(1).sub(u.heatEdge).mul(float(1).sub(smoothstep(0, max(u.heatEdgeBlocks, 1), u.block.sub(worldX.mul(1000))))));
    return select(heat.greaterThan(0), amp.mul(fade).mul(u.heatGain).mul(edge), float(0));
  };
  /** Emissive colour of a heat brightness. */
  const heatEmissiveOf = (intensity) => u.heatColor.mul(intensity);
  /** Emissive heat from (heat, heatBlock). */
  const heatEmissive = (heat, heatBlock, worldX = null) => heatEmissiveOf(heatIntensity(heat, heatBlock, worldX));

  /** Creation-edge glow factor at world x (cells created within edgeBlocks of the block). */
  const edgeGlow = (worldX) => {
    const d = u.block.sub(worldX.mul(1000));
    const g = clamp(float(1).sub(d.div(max(u.edgeBlocks, 1))), 0, 1);
    return select(d.greaterThanEqual(-64), g, float(0)).mul(u.edgeGlow);
  };

  /** Grid line coverage (0..1) at a world position. */
  const gridLines = (worldX, worldZ) => {
    const stepW = u.gridBlockStep.div(1000);
    const dx = abs(worldX.sub(round(worldX.div(stepW)).mul(stepW)));
    const lx = float(1).sub(smoothstep(0, fwidth(worldX).mul(1.25), dx));
    // Amount lines at row centres (z = (row + 0.5) / 10), where the labels sit.
    const r = floor(worldZ.mul(10));
    const isRow = textureLoad(gridRows, ivec2(clamp(int(r), int(0), int(2071)), int(0))).x;
    const dz = abs(worldZ.sub(r.add(0.5).div(10)));
    const lz = float(1).sub(smoothstep(0, fwidth(worldZ).mul(1.25), dz)).mul(isRow);
    return max(lx, lz).mul(u.grid).mul(u.gridOpacity);
  };

  /** Rim term (vec3) from a view-space normal. */
  const rimTerm = (nView) => {
    const f = float(1).sub(saturate(dot(nView, positionViewDirection)));
    return u.rimColor.mul(pow(f, 3).mul(u.rim));
  };

  function set(id, value) {
    switch (id) {
      case 'color.palette': state.palette = value; updateLut(); break;
      case 'color.gradient': state.gradient = value; if (state.palette === 'custom') updateLut(); break;
      case 'color.reverse': state.reverse = !!value; updateLut(); break;
      case 'color.whiteHot': state.whiteHot = !!value; u.whitePalette.value = value ? 1 : 0; updateLut(); break;
      case 'color.whiteHotBTC': state.whiteHotBTC = value; updateWhiteRow(); break;
      case 'color.offset': state.offset = value; updateThresholds(); break;
      case 'color.upper': state.upper = value; updateThresholds(); break;
      case 'color.gamma': state.gamma = value; updateThresholds(); break;
      case 'color.ground': u.ground.value.copy(srgbHexToLinearColor(value)); break;
      case 'color.heat': u.heatColor.value.copy(srgbHexToLinearColor(value, '#ffffff')); break;
      case 'color.heatGain': u.heatGain.value = value; break;
      case 'amp.curve': state.curve = value; updateCurve(); break;
      case 'amp.exponent': state.exponent = value; updateCurve(); break;
      case 'amp.exposure': state.exposure = value; updateCurve(); break;
      case 'amp.reference': state.reference = value; updateCurve(); break;
      case 'amp.exaggeration': state.exaggeration = value; updateCurve(); break;
      case 'amp.floor': state.floor = value; updateCurve(); break;
      case 'amp.whale': state.whale = value; updateCurve(); break;
      case 'amp.heatHalfLife': u.halfLife.value = value; break;
      case 'amp.heatFloor': u.heatFloor.value = Math.min(1, Math.max(0, value)); break;
      case 'amp.heatReference': u.heatInvLogRef.value = 1 / Math.log1p(Math.max(value, HEAT_H0 * 1.001) / HEAT_H0); break;
      case 'amp.heatEdge': u.heatEdge.value = Math.min(1, Math.max(0, value)); break;
      case 'amp.heatEdgeBlocks': u.heatEdgeBlocks.value = Math.max(1, value); break;
      case 'amp.edgeGlow': u.edgeGlow.value = value; break;
      case 'amp.edgeBlocks': u.edgeBlocks.value = value; break;
      case 'light.albedo': u.albedo.value = value; break;
      case 'light.emissive': u.emissive.value = value; break;
      case 'light.rim': u.rim.value = value; break;
      case 'light.rimColor': u.rimColor.value.copy(srgbHexToLinearColor(value, '#99bbff')); break;
      case 'light.roughness': u.roughness.value = value; break;
      case 'light.metalness': u.metalness.value = value; break;
      case 'display.grid': u.grid.value = value ? 1 : 0; break;
      case 'geo.skirts': u.skirt.value = value ? 1 : 0; break;
      default: return false;
    }
    return true;
  }

  /** CPU mirror of the height parameters for picking and bounds. */
  function heightParams() {
    return { curve: state.curve, exposure: state.exposure, reference: state.reference, exponent: state.exponent,
      exaggeration: state.exaggeration, floor: state.floor, whale: state.whale, whiteRow: state.whiteRow };
  }

  return {
    uniforms: u, textures: { lut, thresholds, gridRows }, state,
    heightOf, paletteIndex, cellColor, heatEmissive, heatDecayed, heatIntensity, heatEmissiveOf, edgeGlow, gridLines, rimTerm,
    set, heightParams, setGridRows,
    dispose() { lut.dispose(); thresholds.dispose(); gridRows.dispose(); },
  };
}
