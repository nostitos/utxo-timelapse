// UTXO Timelapse Landscape: settings schema (contract: landscape/SPEC.md section 7).
//
// One declarative list drives the settings panel, the store (validation, presets, URL,
// JSON, localStorage) and every consumer's uniform/node updates. Pure module: no DOM,
// no three.js, safe to import from Node tests and workers.
//
// Entry fields
//   id            'group.name'; consumers use exactly these ids
//   group         'color' | 'amp' | 'geo' | 'light' | 'fx' | 'camera' | 'display'
//   section       sub-heading inside the group (panel layout only)
//   label         short UI label
//   type          'number' | 'int' | 'bool' | 'enum' | 'color' | 'gradient' | 'file'
//   min, max      numeric range; stored values are clamped to it
//   step          UI step hint (the store does not snap to it)
//   scale         'linear' | 'log' slider mapping; logMin is the smallest positive slider
//                 value for log entries whose min is 0 (the far left of the slider is 0)
//   options       allowed values of an 'enum' (strings, or numbers such as [1, 2, 4]);
//                 optionLabels maps value -> UI text
//   default       value used when a preset does not specify the id
//   unit          display unit (tooltips)
//   webgpu        true: needs the WebGPU backend (compute). On WebGL2 the panel disables
//                 the control and the store forces booleans to false. webgpuOptions lists
//                 enum options that need WebGPU; the store replaces them with fallback.
//   rebuild       cost of a change, informative for the UI: 'none' (uniform or texture
//                 update), 'material' (shader recompile), 'terrain' (geometry or buffers),
//                 'post' (RenderPipeline rebuild), 'shadows' (shadow maps or cascades),
//                 'renderer' (canvas or renderer reconfiguration), 'worker' (sent to the
//                 replay worker, which repacks tiles)
//   url           true: written to the share URL when it differs from the preset
//   preset        false: a personal preference that presets never change and that does
//                 not turn the preset into 'Custom' (camera, HUD toggles, LUT file)
//   capMax        capabilities key that can lower max at run time (for example
//                 view.capabilities.maxTileBudget)
//   maxStops      'gradient': maximum number of stops
//   accept        'file': accepted file extensions
//   help          one-line explanation with units and semantics
//
// Value formats: colours are lowercase '#rrggbb' strings; gradients are frozen arrays of
// 2..16 frozen stops {t: 0..1 (4 decimals), color: '#rrggbb'} sorted by t; files are
// null or a frozen {name, text} object (the .cube text, kept in memory and in JSON
// exports, never in the URL).

export const GROUPS = Object.freeze([
  Object.freeze({ id: 'color', label: 'Colour' }),
  Object.freeze({ id: 'amp', label: 'Amplification' }),
  Object.freeze({ id: 'geo', label: 'Geometry' }),
  Object.freeze({ id: 'light', label: 'Lighting' }),
  Object.freeze({ id: 'fx', label: 'Effects' }),
  Object.freeze({ id: 'camera', label: 'Camera' }),
  Object.freeze({ id: 'display', label: 'Display' }),
]);

export const TYPES = Object.freeze(['number', 'int', 'bool', 'enum', 'color', 'gradient', 'file']);

export const REBUILD_CLASSES = Object.freeze({
  none: 'Updates live (uniform or texture)',
  material: 'Recompiles the terrain material (short stall)',
  terrain: 'Rebuilds terrain geometry or buffers',
  post: 'Rebuilds the post-processing pipeline (short stall)',
  shadows: 'Rebuilds shadow maps',
  renderer: 'Reconfigures the canvas or renderer',
  worker: 'Sent to the replay worker, which repacks resident tiles',
});

// Presets, from look to quality tiers. Startup preset: High. On WebGL2 presets above
// High are capped to High.
export const PRESET_NAMES = Object.freeze(['Film', 'Performance', 'Balanced', 'High', 'Ultra', 'Extreme']);
export const QUALITY_ORDER = Object.freeze(['Performance', 'Balanced', 'High', 'Ultra', 'Extreme']);
export const STARTUP_PRESET = 'High';
export const WEBGL2_MAX_PRESET = 'High';

export const PRESET_INFO = Object.freeze({
  Film: 'Unlit film colours: weighted density through the film palette (white-hot whale rows at 10 BTC and above), stepped cells, black background and ground; no grid, lighting, shadows, fog, sky, tone mapping or post effects. Matches the film colour at equal density. Heat glow and flashes still appear during playback, like the activity flashes in the film, and are zero right after a seek.',
  Performance: '75% resolution, FXAA, no shadows or ambient occlusion, bloom with 4 mips, 96 resident tiles and coarser terrain detail (6 px per cell).',
  Balanced: 'Native resolution, SMAA, two 2048 PCF shadow cascades, SSAO with 8 samples, bloom and 160 resident tiles.',
  High: 'Startup preset (schema defaults): native resolution, TRAA, three 2048 PCF shadow cascades, GTAO with 16 samples, bloom, fog, sky, stars and 225 resident tiles.',
  Ultra: 'Targets 60 fps at 4K: High plus three 4096 shadow cascades, volumetric light (32 steps), god rays, and bicubic smoothing (applies once Subdivision is raised).',
  Extreme: 'Deliberately GPU-bound, about 30 fps at 4K: Ultra plus a fourth shadow cascade, 2x supersampling, softer shadows (softness 1.5), GTAO with 32 samples, SSR, 64 volumetric steps, motion blur, subdivision 2, finer detail (2 px per cell, 320 resident tiles) and instanced columns (up to 2M within 1024 cells).',
});

export const DEFAULT_GRADIENT = Object.freeze([
  Object.freeze({ t: 0, color: '#08142b' }),
  Object.freeze({ t: 0.3, color: '#1b6ca8' }),
  Object.freeze({ t: 0.55, color: '#35d0ba' }),
  Object.freeze({ t: 0.8, color: '#f9d64a' }),
  Object.freeze({ t: 1, color: '#ffffff' }),
]);

const MEASURE_LABELS = { density: 'Weighted density', count: 'Output count', value: 'BTC value' };

const ENTRIES = [
  // Colour: palette
  { id: 'color.palette', section: 'Palette', label: 'Palette', type: 'enum',
    options: ['film', 'turbo', 'viridis', 'inferno', 'magma', 'plasma', 'cividis', 'grey', 'custom'],
    optionLabels: { film: 'Film', turbo: 'Turbo', viridis: 'Viridis', inferno: 'Inferno', magma: 'Magma',
      plasma: 'Plasma', cividis: 'Cividis', grey: 'Grey', custom: 'Custom gradient' },
    default: 'film',
    help: 'Colour map. Film is the film palette (site/assets/palettes.json base, with the white-hot variant on whale rows).' },
  { id: 'color.gradient', section: 'Palette', label: 'Custom gradient', type: 'gradient', maxStops: 16,
    default: DEFAULT_GRADIENT,
    help: 'Stops {t 0..1, colour} used when Palette is Custom gradient: 2 to 16 stops, sorted by t, interpolated in sRGB like the panel preview.' },
  { id: 'color.reverse', section: 'Palette', label: 'Reverse palette', type: 'bool', default: false,
    help: 'Flip the palette end to end (applies to the white-hot variant too).' },

  // Colour: transfer
  { id: 'color.measure', section: 'Transfer', label: 'Colour measure', type: 'enum',
    options: ['height', 'density', 'count', 'value'],
    optionLabels: { height: 'Same as height', ...MEASURE_LABELS },
    default: 'height', rebuild: 'worker',
    help: 'Value that drives colour. Same as height follows Amplification > Measure. Values are per L0 cell (coarser levels show the mean).' },
  { id: 'color.offset', section: 'Transfer', label: 'Log offset', type: 'number',
    min: 0.0001, max: 10000, step: 0.0001, scale: 'log', default: 30,
    help: 't = (ln(v + o) - ln(1 + o)) / (ln(U + o) - ln(1 + o)), clamped to 0..1. Larger o compresses the low end. Film: 30.' },
  { id: 'color.upper', section: 'Transfer', label: 'Upper limit', type: 'number',
    min: 1.01, max: 10000000, step: 0.01, scale: 'log', default: 500,
    help: 'Colour value U that reaches the top of the palette. Film: 500.' },
  { id: 'color.gamma', section: 'Transfer', label: 'Transfer gamma', type: 'number',
    min: 0.2, max: 5, step: 0.01, scale: 'log', default: 1,
    help: 'Exponent applied to t before the palette lookup; below 1 brightens low values. Film: 1.' },
  { id: 'color.whiteHot', section: 'Transfer', label: 'White-hot whale rows', type: 'bool', default: true,
    help: 'Use the white-hot palette variant on rows at or above the whale threshold, as the film does.' },
  { id: 'color.whiteHotBTC', section: 'Transfer', label: 'Whale threshold (BTC)', type: 'number',
    min: 0.00000001, max: 100000, step: 0.00000001, scale: 'log', default: 10, unit: 'BTC',
    help: 'Rows whose amounts are at least this many BTC count as whale rows (white-hot palette and the whale height multiplier). Film: 10 BTC.' },

  // Colour: scene colours
  { id: 'color.background', section: 'Scene colours', label: 'Background', type: 'color', default: '#05070c',
    help: 'Clear colour behind the landscape; the sky gradient covers it when Sky is on. Film: black.' },
  { id: 'color.ground', section: 'Scene colours', label: 'Empty cells', type: 'color', default: '#0c0f15',
    help: 'Colour of cells with no outputs (v <= 0). Film: black.' },
  { id: 'color.fog', section: 'Scene colours', label: 'Fog', type: 'color', default: '#141b2b',
    help: 'Fog and volumetric scattering colour.' },
  { id: 'color.heat', section: 'Scene colours', label: 'Heat colour', type: 'color', default: '#ffe9c4',
    help: 'Colour of spend flashes: the glow on cells whose outputs were just spent, and the flash sprites.' },
  { id: 'color.heatGain', section: 'Scene colours', label: 'Heat gain', type: 'number',
    min: 0, max: 20, step: 0.01, default: 2.5,
    help: 'Overall brightness of spend flashes on the terrain; 0 hides them. Above 1 they glow through bloom.' },

  // Colour: grade (post)
  { id: 'color.hueShift', section: 'Grade', label: 'Hue shift', type: 'number',
    min: -180, max: 180, step: 1, default: 0, unit: 'deg', help: 'Rotates every hue by this many degrees.' },
  { id: 'color.saturation', section: 'Grade', label: 'Saturation', type: 'number',
    min: 0, max: 2, step: 0.01, default: 1, help: '0 = greyscale, 1 = unchanged, 2 = double.' },
  { id: 'color.contrast', section: 'Grade', label: 'Contrast', type: 'number',
    min: 0, max: 2, step: 0.01, default: 1, help: 'Contrast around mid grey; 1 = unchanged.' },
  { id: 'color.temperature', section: 'Grade', label: 'Temperature', type: 'number',
    min: -1, max: 1, step: 0.01, default: 0, help: 'White balance: -1 cool (blue) to +1 warm (amber).' },
  { id: 'color.tint', section: 'Grade', label: 'Tint', type: 'number',
    min: -1, max: 1, step: 0.01, default: 0, help: 'White balance: -1 green to +1 magenta.' },
  { id: 'color.lift', section: 'Grade', label: 'Lift', type: 'number',
    min: -0.5, max: 0.5, step: 0.005, default: 0,
    help: 'Shadow offset, tinted by Lift colour: out = (in * gain * gainColour + lift * liftColour * (1 - in)) ^ (1 / gamma).' },
  { id: 'color.liftColor', section: 'Grade', label: 'Lift colour', type: 'color', default: '#ffffff',
    help: 'Tint of the lift (white = neutral).' },
  { id: 'color.gradeGamma', section: 'Grade', label: 'Gamma', type: 'number',
    min: 0.2, max: 5, step: 0.01, scale: 'log', default: 1, help: 'Midtone gamma of the grade; 1 = unchanged.' },
  { id: 'color.gain', section: 'Grade', label: 'Gain', type: 'number',
    min: 0, max: 4, step: 0.01, default: 1, help: 'Highlight multiplier, tinted by Gain colour; 1 = unchanged.' },
  { id: 'color.gainColor', section: 'Grade', label: 'Gain colour', type: 'color', default: '#ffffff',
    help: 'Tint of the gain (white = neutral).' },

  // Colour: tone mapping and exposure (post)
  { id: 'color.toneMapping', section: 'Tone and exposure', label: 'Tone mapping', type: 'enum',
    options: ['none', 'linear', 'reinhard', 'aces', 'agx', 'neutral'],
    optionLabels: { none: 'None', linear: 'Linear', reinhard: 'Reinhard', aces: 'ACES Filmic', agx: 'AgX', neutral: 'Khronos Neutral' },
    default: 'agx', rebuild: 'post', help: 'HDR to display mapping. Film: none.' },
  { id: 'color.exposureMode', section: 'Tone and exposure', label: 'Exposure mode', type: 'enum',
    options: ['manual', 'auto'], optionLabels: { manual: 'Manual', auto: 'Auto (histogram)' },
    webgpuOptions: ['auto'], fallback: 'manual', default: 'manual', rebuild: 'post',
    help: 'Auto measures a luminance histogram with a compute pass (WebGPU only).' },
  { id: 'color.exposure', section: 'Tone and exposure', label: 'Exposure', type: 'number',
    min: 0.01, max: 16, step: 0.01, scale: 'log', default: 1, unit: 'x',
    help: 'Linear exposure multiplier; in auto mode it is the compensation applied on top. Film: 1.' },
  { id: 'color.autoExposureMin', section: 'Tone and exposure', label: 'Auto minimum', type: 'number',
    min: 0.01, max: 16, step: 0.01, scale: 'log', default: 0.25, unit: 'x', webgpu: true,
    help: 'Lowest exposure multiplier auto exposure may choose.' },
  { id: 'color.autoExposureMax', section: 'Tone and exposure', label: 'Auto maximum', type: 'number',
    min: 0.01, max: 16, step: 0.01, scale: 'log', default: 4, unit: 'x', webgpu: true,
    help: 'Highest exposure multiplier auto exposure may choose.' },
  { id: 'color.autoExposureSpeed', section: 'Tone and exposure', label: 'Auto speed', type: 'number',
    min: 0.1, max: 10, step: 0.01, scale: 'log', default: 1.5, unit: '/s', webgpu: true,
    help: 'Adaptation rate per second.' },

  // Colour: LUT and output (post)
  { id: 'color.lut', section: 'LUT and output', label: '3D LUT (.cube)', type: 'file', accept: '.cube',
    default: null, url: false, preset: false, rebuild: 'post',
    help: 'A .cube 3D LUT applied after the grade. Value {name, text}: kept in memory and in JSON exports, never in the URL.' },
  { id: 'color.lutIntensity', section: 'LUT and output', label: 'LUT intensity', type: 'number',
    min: 0, max: 1, step: 0.01, default: 1, help: 'Mix between the graded image (0) and the LUT result (1).' },
  { id: 'color.p3', section: 'LUT and output', label: 'Display P3 output', type: 'bool', default: false,
    rebuild: 'post', help: 'Wide-gamut Display P3 canvas where the browser supports it. Film: off (sRGB).' },

  // Amplification: height
  { id: 'amp.measure', section: 'Height', label: 'Measure', type: 'enum',
    options: ['density', 'count', 'value'], optionLabels: MEASURE_LABELS, default: 'density', rebuild: 'worker',
    help: 'Height value per L0 cell: weighted density = outputs up to 5 BTC + (BTC above 5 BTC outputs) / 5; count = outputs; value = BTC. Coarser levels show the mean per L0 cell.' },
  { id: 'amp.curve', section: 'Height', label: 'Height curve', type: 'enum',
    options: ['log', 'power', 'linear'], optionLabels: { log: 'Logarithmic', power: 'Power', linear: 'Linear' },
    default: 'log',
    help: 'log: ln(1 + e v) / ln(1 + e R); power: (v / R) ^ exponent; linear: v / R (e = exposure, R = reference).' },
  { id: 'amp.exponent', section: 'Height', label: 'Power exponent', type: 'number',
    min: 0.05, max: 4, step: 0.01, scale: 'log', default: 0.5, help: 'Exponent of the power curve.' },
  { id: 'amp.exposure', section: 'Height', label: 'Log exposure', type: 'number',
    min: 0.0001, max: 10000, step: 0.0001, scale: 'log', default: 1,
    help: 'Value normalisation e of the log curve; higher lifts small values. The power and linear curves ignore it.' },
  { id: 'amp.reference', section: 'Height', label: 'Reference value', type: 'number',
    min: 0.001, max: 10000000, step: 0.001, scale: 'log', default: 500,
    help: 'Value R at which the curve reaches 1, i.e. Exaggeration world units of height.' },
  { id: 'amp.exaggeration', section: 'Height', label: 'Exaggeration', type: 'number',
    min: 0, max: 200, step: 0.1, default: 10, unit: 'world units',
    help: 'Height at curve value 1. The landscape is 966.8 units wide (block / 1000) and 207.2 deep (row / 10).' },
  { id: 'amp.floor', section: 'Height', label: 'Floor height', type: 'number',
    min: 0, max: 5, step: 0.005, default: 0.05, unit: 'world units',
    help: 'Minimum height added to every occupied cell so sparse cells stay visible; empty cells stay at 0.' },
  { id: 'amp.whale', section: 'Height', label: 'Whale multiplier', type: 'number',
    min: 0, max: 10, step: 0.01, default: 1, unit: 'x',
    help: 'Height multiplier for rows at or above Colour > Whale threshold.' },

  // Amplification: activity
  { id: 'amp.heatHalfLife', section: 'Activity', label: 'Heat half-life (blocks)', type: 'number',
    min: 0.5, max: 100000, step: 0.5, scale: 'log', default: 30, unit: 'blocks', rebuild: 'worker',
    help: 'A spend flash fades to half every this many blocks (30 blocks = 0.5 s at 1x, about 5 hours of chain time).' },
  { id: 'amp.heatFloor', section: 'Activity', label: 'Flash floor', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.35,
    help: 'Brightness every spend reaches at its block, whatever its amount (as every spent output flashes in the film); 0 makes brightness depend only on the BTC moved.' },
  { id: 'amp.heatReference', section: 'Activity', label: 'Full flash at (BTC)', type: 'number',
    min: 0.001, max: 100000, step: 0.001, scale: 'log', default: 100, unit: 'BTC',
    help: 'BTC moved from one cell (summed with its recent spends) that reaches full flash brightness; smaller spends scale down logarithmically to the floor.' },
  { id: 'amp.heatEdge', section: 'Activity', label: 'Edge flash strength', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.3,
    help: 'Brightness of flashes for coins created within the edge flash window of the current block, ramping to full beyond it. Young coins are spent constantly; the film also keeps those flashes small. 1 treats them like old coins.' },
  { id: 'amp.heatEdgeBlocks', section: 'Activity', label: 'Edge flash window (blocks)', type: 'int',
    min: 1, max: 100000, step: 1, scale: 'log', default: 4032, unit: 'blocks',
    help: 'Coins created within this many blocks of the current block count as creation-edge spends for Edge flash strength (4,032 blocks = about four weeks, close to the film\'s creation-edge flash zone).' },
  { id: 'amp.flashSize', section: 'Activity', label: 'Flash size', type: 'number',
    min: 0, max: 10, step: 0.01, default: 1,
    help: 'Size of the flash sprites over spent cells: at least 3 px on screen, growing to 16 px at the full-flash amount, smaller for coins spent near the creation edge. 0 hides them.' },
  { id: 'amp.flashThreshold', section: 'Activity', label: 'Flash threshold (BTC)', type: 'number',
    min: 0.00000001, max: 100000, step: 0.00000001, scale: 'log', default: 0.0001, unit: 'BTC',
    help: 'Smallest BTC moved from one cell within one block that spawns a flash sprite; the default skips dust. Up to 400 new sprites per frame, old coins and larger amounts first.' },

  // Amplification: markers
  { id: 'amp.edgeGlow', section: 'Markers', label: 'Creation-edge glow', type: 'number',
    min: 0, max: 10, step: 0.01, default: 1,
    help: 'Emissive boost on outputs created in the most recent blocks; 0 = off.' },
  { id: 'amp.edgeBlocks', section: 'Markers', label: 'Edge width (blocks)', type: 'int',
    min: 1, max: 100000, step: 1, scale: 'log', default: 1008, unit: 'blocks',
    help: 'Width of the creation-edge glow, counted back from the current block (1,008 blocks = about one week).' },
  { id: 'amp.nowPlane', section: 'Markers', label: 'Now plane', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.15,
    help: 'Opacity of the translucent vertical plane at the current block; 0 = off.' },

  // Geometry: surface
  { id: 'geo.smoothing', section: 'Surface', label: 'Smoothing', type: 'enum',
    options: ['none', 'bilinear', 'bicubic'], optionLabels: { none: 'None', bilinear: 'Bilinear', bicubic: 'Bicubic' },
    default: 'bilinear', rebuild: 'material',
    help: 'Height interpolation between cell centres. Changes the surface only when Subdivision is 2 or 4 (at 1x every vertex sits on a cell centre); Stepped cells ignore it.' },
  { id: 'geo.stepped', section: 'Surface', label: 'Stepped cells', type: 'bool', default: false, rebuild: 'material',
    help: 'Flat-topped cells with vertical walls; each cell shows exactly one palette colour. Ignores Smoothing and Subdivision.' },
  { id: 'geo.subdivision', section: 'Surface', label: 'Subdivision', type: 'enum', options: [1, 2, 4],
    optionLabels: { 1: '1x', 2: '2x', 4: '4x' }, default: 1, rebuild: 'terrain',
    help: 'Heightfield vertices per cell edge (more = smoother bicubic surfaces, more triangles).' },
  { id: 'geo.skirts', section: 'Surface', label: 'Skirts', type: 'bool', default: true, rebuild: 'terrain',
    help: 'Vertical skirts hide cracks between tiles of different levels.' },
  { id: 'geo.wireframe', section: 'Surface', label: 'Wireframe', type: 'bool', default: false, rebuild: 'material',
    preset: false, help: 'Draw the terrain as wireframe (diagnostic).' },

  // Geometry: columns (WebGPU compute)
  { id: 'geo.columns', section: 'Columns', label: 'Column mode', type: 'bool', default: false,
    webgpu: true, rebuild: 'terrain',
    help: 'One instanced box per occupied L0 cell near the view focus; the heightfield continues beyond the radius. Needs WebGPU compute.' },
  { id: 'geo.columnRadius', section: 'Columns', label: 'Column radius', type: 'int',
    min: 16, max: 8192, step: 1, scale: 'log', default: 512, unit: 'L0 cells', webgpu: true,
    help: 'Columns are drawn within this many L0 cells of the view focus.' },
  { id: 'geo.instanceBudget', section: 'Columns', label: 'Instance budget', type: 'int',
    min: 10000, max: 8000000, step: 1000, scale: 'log', default: 1000000, webgpu: true,
    rebuild: 'terrain', capMax: 'maxInstances',
    help: 'Maximum instanced columns per frame (up to 8,000,000).' },
  { id: 'geo.columnGap', section: 'Columns', label: 'Column gap', type: 'number',
    min: 0, max: 0.9, step: 0.01, default: 0.12, webgpu: true,
    help: 'Fraction of each cell footprint left empty between columns.' },

  // Geometry: level of detail
  { id: 'geo.lodBias', section: 'Level of detail', label: 'LOD bias', type: 'number',
    min: -3, max: 3, step: 0.1, default: 0,
    help: '+1 asks for one level finer detail, -1 one level coarser (refinement threshold = pixels per cell x 2^-bias).' },
  { id: 'geo.pixelsPerCell', section: 'Level of detail', label: 'Pixels per cell', type: 'number',
    min: 0.5, max: 32, step: 0.1, scale: 'log', default: 3, unit: 'px',
    help: 'Refine a tile while its cells cover more than this many screen pixels; lower = finer, more tiles.' },
  { id: 'geo.tileBudget', section: 'Level of detail', label: 'Tile budget', type: 'int',
    min: 32, max: 400, step: 1, default: 225, rebuild: 'terrain', capMax: 'maxTileBudget',
    help: 'Maximum resident tiles in the worker and the GPU atlas (each costs about 1 MB of GPU memory and 2 MB in the worker).' },

  // Lighting: sun
  { id: 'light.sunAzimuth', section: 'Sun', label: 'Sun azimuth', type: 'number',
    min: 0, max: 360, step: 1, default: 225, unit: 'deg',
    help: 'Direction the sunlight comes from, clockwise seen from above: 0 = from -z (large-amount rows), 90 = from +x (tip), 180 = from +z (default camera side), 270 = from -x (genesis).' },
  { id: 'light.sunElevation', section: 'Sun', label: 'Sun elevation', type: 'number',
    min: -5, max: 90, step: 0.5, default: 35, unit: 'deg', help: 'Height of the sun above the horizon.' },
  { id: 'light.sunIntensity', section: 'Sun', label: 'Sun intensity', type: 'number',
    min: 0, max: 20, step: 0.01, default: 3, help: 'Directional light intensity. Film: 0.' },
  { id: 'light.sunColor', section: 'Sun', label: 'Sun colour', type: 'color', default: '#fff1dc',
    help: 'Colour of the directional light.' },

  // Lighting: ambient
  { id: 'light.skyColor', section: 'Ambient', label: 'Sky light', type: 'color', default: '#9bb7ff',
    help: 'Hemisphere light colour from above.' },
  { id: 'light.groundColor', section: 'Ambient', label: 'Ground light', type: 'color', default: '#2a2420',
    help: 'Hemisphere light colour from below.' },
  { id: 'light.ambient', section: 'Ambient', label: 'Ambient intensity', type: 'number',
    min: 0, max: 5, step: 0.01, default: 0.6, help: 'Hemisphere (sky and ground) light intensity. Film: 0.' },
  { id: 'light.rim', section: 'Ambient', label: 'Rim light', type: 'number',
    min: 0, max: 5, step: 0.01, default: 0.35, help: 'Fresnel rim light that outlines peaks against the background. Film: 0.' },
  { id: 'light.rimColor', section: 'Ambient', label: 'Rim colour', type: 'color', default: '#8fb8ff',
    help: 'Colour of the rim light.' },

  // Lighting: material
  { id: 'light.emissive', section: 'Material', label: 'Emissive strength', type: 'number',
    min: 0, max: 10, step: 0.01, default: 0.4,
    help: 'Self-illumination by the palette colour. Emissive 1 with albedo 0 shows the unlit palette colour (Film).' },
  { id: 'light.albedo', section: 'Material', label: 'Albedo', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.85, help: 'Diffuse reflectance as a fraction of the palette colour. Film: 0.' },
  { id: 'light.roughness', section: 'Material', label: 'Roughness', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.65, help: 'Surface roughness of the terrain material.' },
  { id: 'light.metalness', section: 'Material', label: 'Metalness', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.05, help: 'Metalness of the terrain material.' },
  { id: 'light.floorReflection', section: 'Material', label: 'Floor reflection', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0,
    help: 'Makes the ground (empty cells) a mirror through screen-space reflections; needs Effects > SSR. 0 = off.' },

  // Lighting: shadows
  { id: 'light.shadows', section: 'Shadows', label: 'Shadows', type: 'bool', default: true, rebuild: 'shadows',
    help: 'Sun shadows through cascaded shadow maps. Film: off.' },
  { id: 'light.cascades', section: 'Shadows', label: 'Cascades', type: 'int',
    min: 1, max: 4, step: 1, default: 3, rebuild: 'shadows', help: 'Cascaded shadow map splits.' },
  { id: 'light.shadowMapSize', section: 'Shadows', label: 'Shadow map size', type: 'enum', options: [1024, 2048, 4096],
    default: 2048, rebuild: 'shadows', unit: 'px', help: 'Resolution of each cascade.' },
  { id: 'light.shadowFilter', section: 'Shadows', label: 'Shadow filter', type: 'enum',
    options: ['basic', 'pcf', 'vsm', 'pcss'],
    optionLabels: { basic: 'Hard', pcf: 'PCF', vsm: 'VSM', pcss: 'PCSS (contact-hardening)' },
    default: 'pcf', rebuild: 'shadows',
    help: 'Shadow filtering. PCSS softens shadows with distance from the occluder (custom filter node; measured about +10 ms per frame at 4K on the M4 Max).' },
  { id: 'light.shadowSoftness', section: 'Shadows', label: 'Softness', type: 'number',
    min: 0, max: 10, step: 0.05, default: 1, help: 'Filter radius (shadow.radius); light size for PCSS.' },
  { id: 'light.shadowBias', section: 'Shadows', label: 'Bias', type: 'number',
    min: -0.01, max: 0.01, step: 0.00005, default: -0.0005, help: 'Depth bias against shadow acne.' },

  // Lighting: atmosphere
  { id: 'light.fogDensity', section: 'Atmosphere', label: 'Fog density', type: 'number',
    min: 0, max: 0.05, step: 0.00001, scale: 'log', logMin: 0.00005, default: 0.002,
    help: 'Fog density per world unit; 0 = no fog. Film: 0.' },
  { id: 'light.fogHeightFalloff', section: 'Atmosphere', label: 'Fog height falloff', type: 'number',
    min: 0, max: 1, step: 0.001, scale: 'log', logMin: 0.001, default: 0.05,
    help: 'Fog thins with height: density * exp(-falloff * y). 0 = uniform fog.' },
  { id: 'light.volumetric', section: 'Atmosphere', label: 'Volumetric light', type: 'bool', default: false,
    rebuild: 'post',
    help: 'Ray-marched height-fog volume lit by the sun with its own shadow map, so peaks cast shafts through the haze. Density follows Fog density and Fog height falloff.' },
  { id: 'light.volumetricSteps', section: 'Atmosphere', label: 'Volumetric steps', type: 'int',
    min: 8, max: 256, step: 1, scale: 'log', default: 32, help: 'Ray-march steps of the half-resolution volumetric pass.' },
  { id: 'light.volumetricIntensity', section: 'Atmosphere', label: 'Volumetric intensity', type: 'number',
    min: 0, max: 4, step: 0.01, default: 1, help: 'Scales the scattered light.' },
  { id: 'light.godRays', section: 'Atmosphere', label: 'God rays', type: 'bool', default: false, rebuild: 'post',
    help: 'Screen-space light shafts: a half-resolution radial blur of the sky around the sun position on screen, visible when the sun is near or in view. Needs no shadows; shadowed shafts through the haze come from Volumetric light.' },
  { id: 'light.godRaysIntensity', section: 'Atmosphere', label: 'God ray intensity', type: 'number',
    min: 0, max: 4, step: 0.01, default: 1, help: 'Strength of the light shafts.' },

  // Lighting: sky
  { id: 'light.sky', section: 'Sky', label: 'Sky', type: 'bool', default: true,
    help: 'Sky gradient dome, which covers the background colour. Film: off.' },
  { id: 'light.stars', section: 'Sky', label: 'Stars', type: 'bool', default: true, help: 'Star field. Film: off.' },
  { id: 'light.starDensity', section: 'Sky', label: 'Star density', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.5, help: 'Fraction of the star field shown.' },

  // Effects: ambient occlusion
  { id: 'fx.ao', section: 'Ambient occlusion', label: 'Ambient occlusion', type: 'enum',
    options: ['off', 'ssao', 'gtao'], optionLabels: { off: 'Off', ssao: 'SSAO', gtao: 'GTAO' },
    default: 'gtao', rebuild: 'post', help: 'Screen-space ambient occlusion. Film: off.' },
  { id: 'fx.aoRadius', section: 'Ambient occlusion', label: 'AO radius', type: 'number',
    min: 0.05, max: 10, step: 0.01, scale: 'log', default: 1, unit: 'world units', help: 'Occlusion sampling radius.' },
  { id: 'fx.aoIntensity', section: 'Ambient occlusion', label: 'AO intensity', type: 'number',
    min: 0, max: 4, step: 0.01, default: 1, help: 'Darkening strength.' },
  { id: 'fx.aoSamples', section: 'Ambient occlusion', label: 'AO samples', type: 'int',
    min: 4, max: 64, step: 1, default: 16, rebuild: 'post', help: 'Samples per pixel.' },

  // Effects: global illumination (WebGPU)
  { id: 'fx.ssgi', section: 'Global illumination', label: 'SSGI', type: 'bool', default: false,
    webgpu: true, rebuild: 'post', help: 'Screen-space global illumination: indirect light and colour bleeding between peaks.' },
  { id: 'fx.ssgiSamples', section: 'Global illumination', label: 'SSGI steps', type: 'int',
    min: 4, max: 32, step: 1, default: 8, webgpu: true,
    help: 'SSGINode stepCount; slices = ceil(steps / 8); samples per pixel = slices * steps * 2.' },
  { id: 'fx.ssgiIntensity', section: 'Global illumination', label: 'SSGI intensity', type: 'number',
    min: 0, max: 4, step: 0.01, default: 1, webgpu: true, help: 'Strength of the indirect light.' },

  // Effects: reflections
  { id: 'fx.ssr', section: 'Reflections', label: 'SSR', type: 'bool', default: false, rebuild: 'post',
    help: 'Screen-space reflections.' },
  { id: 'fx.ssrIntensity', section: 'Reflections', label: 'SSR intensity', type: 'number',
    min: 0, max: 2, step: 0.01, default: 1, help: 'Reflection strength.' },
  { id: 'fx.ssrSteps', section: 'Reflections', label: 'SSR steps', type: 'int',
    min: 8, max: 64, step: 1, default: 32, help: 'Ray-march steps (SSRNode quality = steps / 64).' },

  // Effects: bloom
  { id: 'fx.bloom', section: 'Bloom', label: 'Bloom', type: 'bool', default: true, rebuild: 'post',
    help: 'Glow around bright pixels. Film: off.' },
  { id: 'fx.bloomThreshold', section: 'Bloom', label: 'Threshold', type: 'number',
    min: 0, max: 4, step: 0.01, default: 0.85, help: 'Luminance above which pixels bloom.' },
  { id: 'fx.bloomStrength', section: 'Bloom', label: 'Strength', type: 'number',
    min: 0, max: 3, step: 0.01, default: 0.6, help: 'Bloom intensity.' },
  { id: 'fx.bloomRadius', section: 'Bloom', label: 'Radius', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0.4, help: 'Bloom spread (0..1).' },
  { id: 'fx.bloomMips', section: 'Bloom', label: 'Mip levels', type: 'int',
    min: 1, max: 5, step: 1, default: 5, rebuild: 'post',
    help: 'Narrows the glow by dropping the widest mips. It does not reduce GPU cost: the stock BloomNode always runs 5 passes.' },

  // Effects: depth of field
  { id: 'fx.dof', section: 'Depth of field', label: 'Depth of field', type: 'bool', default: false, rebuild: 'post',
    help: 'Blur outside the focal plane.' },
  { id: 'fx.dofAutoFocus', section: 'Depth of field', label: 'Auto focus', type: 'bool', default: true,
    help: 'Focus on the terrain at screen centre (the crosshair).' },
  { id: 'fx.dofFocus', section: 'Depth of field', label: 'Focus distance', type: 'number',
    min: 0.5, max: 2000, step: 0.1, scale: 'log', default: 100, unit: 'world units',
    help: 'Focus distance when auto focus is off.' },
  { id: 'fx.dofAperture', section: 'Depth of field', label: 'Aperture', type: 'number',
    min: 0.1, max: 10, step: 0.01, scale: 'log', default: 1, help: 'Bigger = shallower focus.' },
  { id: 'fx.dofMaxBlur', section: 'Depth of field', label: 'Max blur', type: 'number',
    min: 0, max: 20, step: 0.01, default: 4, help: 'Largest bokeh size.' },

  // Effects: motion blur
  { id: 'fx.motionBlur', section: 'Motion blur', label: 'Motion blur', type: 'bool', default: false, rebuild: 'post',
    help: 'Velocity-based blur while the camera or terrain moves.' },
  { id: 'fx.motionBlurAmount', section: 'Motion blur', label: 'Amount', type: 'number',
    min: 0, max: 2, step: 0.01, default: 0.5, help: 'Velocity scale; 1 = one frame of motion.' },

  // Effects: lens
  { id: 'fx.grain', section: 'Lens', label: 'Film grain', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0, help: 'Grain intensity; 0 = off.' },
  { id: 'fx.chromatic', section: 'Lens', label: 'Chromatic aberration', type: 'number',
    min: 0, max: 2, step: 0.01, default: 0, help: 'Colour fringing towards the edges; 0 = off.' },
  { id: 'fx.vignette', section: 'Lens', label: 'Vignette', type: 'number',
    min: 0, max: 1, step: 0.01, default: 0, help: 'Darkening towards the corners; 0 = off.' },

  // Camera (personal preferences; presets never change them)
  { id: 'camera.fov', label: 'Field of view', type: 'number', min: 15, max: 110, step: 1, default: 50,
    unit: 'deg', preset: false, help: 'Vertical field of view.' },
  { id: 'camera.flySpeed', label: 'Flight speed', type: 'number', min: 0.05, max: 50, step: 0.01, scale: 'log',
    default: 1, unit: 'x', url: false, preset: false,
    help: 'Flight speed multiplier; speed also scales with height above the terrain and the wheel changes it in flight.' },
  { id: 'camera.sensitivity', label: 'Mouse sensitivity', type: 'number', min: 0.1, max: 5, step: 0.01, scale: 'log',
    default: 1, unit: 'x', url: false, preset: false, help: 'Mouse look and orbit sensitivity.' },
  { id: 'camera.invertY', label: 'Invert Y', type: 'bool', default: false, url: false, preset: false,
    help: 'Invert vertical mouse look in flight mode.' },
  { id: 'camera.damping', label: 'Damping', type: 'number', min: 0, max: 0.95, step: 0.01, default: 0.2,
    url: false, preset: false, help: 'Smoothing of camera motion: 0 = immediate, higher = smoother.' },
  { id: 'camera.collision', label: 'Terrain collision', type: 'bool', default: true, url: false, preset: false,
    help: 'Keep the camera above the terrain surface.' },

  // Display: resolution
  { id: 'display.scale', section: 'Resolution', label: 'Resolution scale', type: 'number',
    min: 0.25, max: 2, step: 0.05, default: 1, unit: 'x',
    help: 'Render resolution as a multiple of devicePixelRatio (2 = 7680x4320 on a 3840x2160 canvas).' },
  { id: 'display.autoScale', section: 'Resolution', label: 'Auto scale', type: 'bool', default: false, preset: false,
    help: 'Adjust the scale between minimum and maximum to hold the target frame rate. A personal preference: presets leave it alone, so turn it off to let Ultra or Extreme load the GPU fully.' },
  { id: 'display.targetFps', section: 'Resolution', label: 'Target fps', type: 'int',
    min: 24, max: 240, step: 1, default: 60, unit: 'fps', preset: false, help: 'Frame rate auto scale aims for.' },
  { id: 'display.scaleMin', section: 'Resolution', label: 'Auto minimum', type: 'number',
    min: 0.25, max: 2, step: 0.05, default: 0.5, unit: 'x', preset: false, help: 'Lowest scale auto scale may choose.' },
  { id: 'display.scaleMax', section: 'Resolution', label: 'Auto maximum', type: 'number',
    min: 0.25, max: 2, step: 0.05, default: 2, unit: 'x', preset: false, help: 'Highest scale auto scale may choose.' },

  // Display: anti-aliasing
  { id: 'display.aa', section: 'Anti-aliasing', label: 'Anti-aliasing', type: 'enum',
    options: ['none', 'fxaa', 'smaa', 'traa'],
    optionLabels: { none: 'None', fxaa: 'FXAA', smaa: 'SMAA', traa: 'TRAA (temporal)' },
    default: 'traa', rebuild: 'post', help: 'Post-process anti-aliasing. Film: none.' },
  { id: 'display.ssaa', section: 'Anti-aliasing', label: 'Supersampling', type: 'enum', options: [1, 2, 4],
    optionLabels: { 1: 'Off', 2: '2x', 4: '4x' }, default: 1, rebuild: 'post',
    help: 'Supersamples the scene pass only, at sqrt(N) times the resolution per axis (4 = 2x2), resolved by an exact box downsample. Effects run at output resolution; TRAA is skipped while supersampling is on.' },

  // Display: overlays (personal preferences, except Grid, which Film turns off)
  { id: 'display.overlay', section: 'Overlays', label: 'Performance overlay', type: 'bool', default: false,
    url: false, preset: false, help: 'fps, CPU and GPU ms per pass, triangles, instances, tiles and worker rate.' },
  { id: 'display.labels', section: 'Overlays', label: 'Axis labels', type: 'bool', default: true, preset: false,
    help: 'Block, date and amount labels in the scene.' },
  { id: 'display.grid', section: 'Overlays', label: 'Grid', type: 'bool', default: true,
    help: 'Reference grid lines on the ground. Film: off, because grid lines draw over palette colours.' },
  { id: 'display.legend', section: 'Overlays', label: 'Legend', type: 'bool', default: true, url: false, preset: false,
    help: 'Colour and height legend.' },
  { id: 'display.minimap', section: 'Overlays', label: 'Minimap', type: 'bool', default: true, url: false, preset: false,
    help: 'Overview map with the camera footprint.' },
  { id: 'display.hud', section: 'Overlays', label: 'HUD', type: 'bool', default: true, url: false, preset: false,
    help: 'Block, date and playback readout.' },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function finalize(raw) {
  const group = raw.id.slice(0, raw.id.indexOf('.'));
  const entry = {
    group,
    section: null,
    scale: 'linear',
    webgpu: false,
    rebuild: 'none',
    url: true,
    preset: true,
    help: '',
    ...raw,
  };
  if (entry.group !== group) throw new Error('settings schema: group/id mismatch for ' + raw.id);
  return deepFreeze(entry);
}

export const SCHEMA = Object.freeze(ENTRIES.map(finalize));

export const SCHEMA_BY_ID = new Map(SCHEMA.map((entry) => [entry.id, entry]));

// Presets are partial: ids they do not name take the schema default (High is the defaults).
// Personal-preference entries (preset: false) are never set by presets.
// Ultra and Extreme are render_post's measured retune (2026-10-07: headless Chrome, WebGPU,
// M4 Max, 3840x2160 at dpr 1, full dataset at the tip): Ultra 78 fps overview / 66 close;
// Extreme 31 fps overview at 97% GPU utilisation. Root's headed run on the 4K display
// (Chrome 154, 120 Hz) measured Ultra at 59–65 fps in the close view with four cascades, so
// Ultra now uses three 4096 cascades (the fourth cost 1.1 ms; map size and bicubic ~0 ms).
// See docs/landscape.md for the final measurements.
export const PRESETS = deepFreeze({
  Film: {
    'color.palette': 'film',
    'color.reverse': false,
    'color.measure': 'density',
    'color.offset': 30,
    'color.upper': 500,
    'color.gamma': 1,
    'color.whiteHot': true,
    'color.whiteHotBTC': 10,
    'color.background': '#000000',
    'color.ground': '#000000',
    'color.heat': '#ffffff',
    'color.hueShift': 0,
    'color.saturation': 1,
    'color.contrast': 1,
    'color.temperature': 0,
    'color.tint': 0,
    'color.lift': 0,
    'color.liftColor': '#ffffff',
    'color.gradeGamma': 1,
    'color.gain': 1,
    'color.gainColor': '#ffffff',
    'color.toneMapping': 'none',
    'color.exposureMode': 'manual',
    'color.exposure': 1,
    'color.lutIntensity': 0,
    'color.p3': false,
    'amp.edgeGlow': 0,
    'amp.nowPlane': 0,
    'geo.smoothing': 'none',
    'geo.stepped': true,
    'light.albedo': 0,
    'light.emissive': 1,
    'light.sunIntensity': 0,
    'light.ambient': 0,
    'light.rim': 0,
    'light.floorReflection': 0,
    'light.shadows': false,
    'light.fogDensity': 0,
    'light.volumetric': false,
    'light.godRays': false,
    'light.sky': false,
    'light.stars': false,
    'fx.ao': 'off',
    'fx.ssgi': false,
    'fx.ssr': false,
    'fx.bloom': false,
    'fx.dof': false,
    'fx.motionBlur': false,
    'fx.grain': 0,
    'fx.chromatic': 0,
    'fx.vignette': 0,
    'display.aa': 'none',
    'display.ssaa': 1,
    'display.scale': 1,
    'display.grid': false,
  },
  Performance: {
    'display.scale': 0.75,
    'display.aa': 'fxaa',
    'light.shadows': false,
    'light.cascades': 2,
    'light.shadowMapSize': 1024,
    'fx.ao': 'off',
    'fx.aoSamples': 8,
    'fx.bloomMips': 4,
    'geo.tileBudget': 96,
    'geo.pixelsPerCell': 6,
  },
  Balanced: {
    'display.aa': 'smaa',
    'light.cascades': 2,
    'light.shadowMapSize': 2048,
    'fx.ao': 'ssao',
    'fx.aoSamples': 8,
    'geo.tileBudget': 160,
    'geo.pixelsPerCell': 4,
  },
  High: {},
  Ultra: {
    'light.cascades': 3,
    'light.shadowMapSize': 4096,
    'light.volumetric': true,
    'light.volumetricSteps': 32,
    'light.godRays': true,
    'geo.smoothing': 'bicubic',
  },
  Extreme: {
    'display.ssaa': 2,
    'light.cascades': 4,
    'light.shadowMapSize': 4096,
    'light.shadowFilter': 'pcf',
    'light.shadowSoftness': 1.5,
    'fx.ao': 'gtao',
    'fx.aoSamples': 32,
    'fx.ssr': true,
    'fx.ssrSteps': 32,
    'light.volumetric': true,
    'light.volumetricSteps': 64,
    'light.godRays': true,
    'fx.motionBlur': true,
    'geo.smoothing': 'bicubic',
    'geo.subdivision': 2,
    'geo.columns': true,
    'geo.columnRadius': 1024,
    'geo.instanceBudget': 2000000,
    'geo.tileBudget': 320,
    'geo.pixelsPerCell': 2,
  },
});
