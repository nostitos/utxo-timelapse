// Focused browser verification for the raw count plane and count-driven column shader.
const { Scene, OrthographicCamera, RenderTarget, Vector3, NoToneMapping } = await import('three/webgpu');
const { uniform, float, vec3 } = await import('three/tsl');
const { gridFromManifest, tileInfo, SLOT_CELLS } = await import('/data/grid.js');
const { TileAtlas } = await import('/render/terrain/atlas.js');
const { createColumns } = await import('/render/terrain/columns.js');

/** Compare both CPU/GPU count planes and sampled exact replay cells, including empty cells. */
async function countAtlasCheck(L) {
  const atlas = L.view.terrain.atlas;
  const gpu = new Uint32Array(await L.view.renderer.getArrayBufferAsync(atlas.countAttribute));
  let gpuChecked = 0;
  let gpuMismatches = 0;
  const samples = [];
  for (let s = 0; s < atlas.capacity; s++) {
    const id = atlas.slotTile[s];
    if (id < 0) continue;
    const t = tileInfo(L.grid, id);
    const base = s * SLOT_CELLS;
    for (let i = 0; i < SLOT_CELLS; i++) {
      gpuChecked++;
      if (gpu[base + i] !== atlas.countData[base + i]) gpuMismatches++;
    }
    // One occupied and one arbitrary cell per tile, at every resident level.
    const chosen = new Set([Math.floor(t.rows / 2) * 256 + Math.floor(t.cols / 2)]);
    outer: for (let y = 0; y < t.rows; y++) for (let x = 0; x < t.cols; x++) {
      if (atlas.countData[base + (y + 1) * 258 + x + 1] > 0) { chosen.add(y * 256 + x); break outer; }
    }
    for (const li of chosen) {
      const x = li % 256, y = Math.floor(li / 256);
      samples.push({ level: t.level, col: t.col0 + x, row: t.row0 + y,
        count: atlas.countData[base + (y + 1) * 258 + x + 1] });
    }
  }
  let exactChecked = 0, exactMismatches = 0;
  for (const s of samples) {
    const ex = await L.replay.cell(s.level, s.col, s.row, { load: false });
    if (!ex) continue;
    exactChecked++;
    if (s.count !== ex.countSmall + ex.countLarge) exactMismatches++;
  }
  return { gpuChecked, gpuMismatches, exactChecked, exactMismatches };
}

/** Actual column material, isolated fixture: equal heights but 1,2,5,10,1000 UTXOs.
 * Read pixels down each side: N-1 dark boundaries; 1000 subpixel layers must fade out.
 * No screenshot of this synthetic fixture is presented as chain data. */
async function columnLayerPixels(renderer) {
  const grid = gridFromManifest({ numBlocks: 1024 });
  const atlas = new TileAtlas({ renderer, grid, backend: 'webgpu', capacity: 1 });
  const data = new Float32Array(SLOT_CELLS * 4);
  const counts = new Uint32Array(SLOT_CELLS);
  const ns = [1, 2, 5, 10, 1000];
  for (let k = 0; k < ns.length; k++) {
    const i = 2 * 258 + 2 + k * 2;
    data[i * 4] = data[i * 4 + 3] = 1;
    counts[i] = ns[k];
  }
  atlas.applyFrame({ full: [{ id: 0, data, counts }] });
  atlas.flush();
  const shading = {
    uniforms: { albedo: uniform(0), emissive: uniform(1), roughness: uniform(1), metalness: uniform(0),
      columnFocus: uniform(new Vector3()) },
    heightOf: () => float(1), cellColor: () => vec3(0.7), heatEmissive: () => vec3(0),
    edgeGlow: () => float(0), rimTerm: () => vec3(0),
  };
  const columns = createColumns({ renderer, atlas, shading, grid, maxBudget: 10 });
  const scene = new Scene(); scene.add(columns.mesh);
  const camera = new OrthographicCamera(0, 0.704, 1.1, -0.1, 0.01, 10);
  camera.position.set(0, 0, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const target = new RenderTarget(704, 600);
  const results = [];
  try {
    for (const shape of ['oval', 'cylinder', 'box']) for (const farStyle of ['near', 'prism', 'card', 'flat', 'cross']) {
      columns.update({ enabled: true, focus: [0.35, 0.15], radiusCells: 16,
        nearCells: farStyle === 'near' ? Infinity : 0, budget: 10, gap: 0, dataVersion: atlas.version,
        shape, sides: 12, farStyle: farStyle === 'near' ? 'prism' : farStyle });
      // Keep app animation and its render target/MRT out of this synchronous render.
      await new Promise(resolve => requestAnimationFrame(() => {
        const oldTarget = renderer.getRenderTarget(), oldMRT = renderer.getMRT(), oldTone = renderer.toneMapping;
        renderer.setRenderTarget(target); renderer.setMRT(null); renderer.toneMapping = NoToneMapping;
        renderer.render(scene, camera);
        renderer.setRenderTarget(oldTarget); renderer.setMRT(oldMRT); renderer.toneMapping = oldTone;
        resolve();
      }));
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 704, 600);
      const boundaries = ns.map((n, k) => {
        const x = Math.round((1.5 + 2 * k) * 64);
        let runs = 0, dark = false;
        // Side occupies y=50..550; omit its outer silhouette.
        let peak = 0;
        for (let y = 55; y < 545; y++) peak = Math.max(peak, pixels[(y * 704 + x) * 4]);
        for (let y = 55; y < 545; y++) {
          const next = pixels[(y * 704 + x) * 4] < peak * 0.92;
          if (next && !dark) runs++;
          dark = next;
        }
        return { n, runs, peak };
      });
      results.push({ shape, farStyle, boundaries });
    }
  } finally {
    columns.dispose(); atlas.dispose(); target.dispose();
  }
  return results;
}
