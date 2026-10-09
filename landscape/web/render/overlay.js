// Performance overlay and per-pass GPU timing (render_post).
//
// GPU time comes from timestamp queries: three tracks one query pair per render context
// (uid "r:<call>:<contextId>:f<frame>") and per compute dispatch ("c:…"). The backend's
// beginRender is wrapped to remember a label for each render context (its first colour
// attachment's name, or the pass name post.js registered for its render target).
//
// On tile-based GPUs (Apple) a pass's begin timestamp is taken when its vertex work starts,
// which can be long before its fragment work ends, so pass intervals overlap and summing
// durations overcounts. The query pools are therefore patched (on the instance, not the
// vendored file) to keep each pass's absolute [begin, end]; the frame's GPU time is the union
// of those intervals, and each pass is credited with the busy time it adds after the passes
// that finished before it. Chrome quantises timestamps to 100 µs unless WebGPU developer
// features are enabled.

const GROUPS = [
  [/^scene\.output$|^output$|^SSAA/i, 'scene'],
  [/shadow|^depth$/i, 'shadows'],
  [/GTAO|SSAO|AO\b|^AO/i, 'ao'],
  [/SSGI/i, 'ssgi'],
  [/SSR/i, 'ssr'],
  [/volumetric/i, 'volumetric'],
  [/godray|radial/i, 'god rays'],
  [/TRAA|TAA/i, 'traa'],
  [/bloom/i, 'bloom'],
  [/DepthOfField|DoF/i, 'dof'],
  [/SMAA/i, 'smaa'],
  [/FXAA/i, 'fxaa'],
  [/autoExposure/i, 'auto exposure'],
  [/^canvas$/, 'output'],
  [/composite|RTT|rtt/i, 'composite'],
];

export function groupOfPass(label) {
  for (const [re, name] of GROUPS) if (re.test(label)) return name;
  return label || 'other';
}

/**
 * Union length of [start, end] intervals (any units) and each interval's credit: the part of
 * it not covered by intervals that end earlier, so credits sum to the union.
 */
export function intervalUnion(intervals) {
  const items = intervals.map((iv, i) => ({ i, s: iv[0], e: iv[1] })).filter((x) => x.e > x.s);
  const credit = new Array(intervals.length).fill(0);
  if (!items.length) return { total: 0, span: 0, credit };
  const covered = []; // disjoint segments, sorted by start
  for (const x of items.slice().sort((a, b) => (a.e - b.e) || (a.s - b.s))) {
    let len = x.e - x.s;
    for (const [s, e] of covered) len -= Math.max(0, Math.min(e, x.e) - Math.max(s, x.s));
    credit[x.i] = Math.max(0, len);
    let s = x.s;
    let e = x.e;
    const keep = [];
    for (const seg of covered) {
      if (seg[1] < s || seg[0] > e) keep.push(seg);
      else { s = Math.min(s, seg[0]); e = Math.max(e, seg[1]); }
    }
    keep.push([s, e]);
    keep.sort((a, b) => a[0] - b[0]);
    covered.length = 0;
    covered.push(...keep);
  }
  const total = covered.reduce((acc, [s, e]) => acc + (e - s), 0);
  const span = covered[covered.length - 1][1] - covered[0][0];
  return { total, span, credit };
}

function patchPool(pool) {
  if (!pool || pool.__landscapePatched || !pool.querySet || !pool.resultBuffer || !pool.device) return;
  pool.__landscapePatched = true;
  pool.intervals = new Map();
  pool._resolveQueries = async function () {
    if (this.isDisposed) return this.lastValue;
    try {
      if (this.resultBuffer.mapState !== 'unmapped') return this.lastValue;
      const offsets = new Map(this.queryOffsets);
      const queryCount = this.currentQueryIndex;
      const bytesUsed = queryCount * 8;
      this.currentQueryIndex = 0;
      this.queryOffsets.clear();
      const encoder = this.device.createCommandEncoder({ label: 'landscape-timestamps' });
      encoder.resolveQuerySet(this.querySet, 0, queryCount, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, bytesUsed);
      this.device.queue.submit([encoder.finish()]);
      if (this.resultBuffer.mapState !== 'unmapped') return this.lastValue;
      await this.resultBuffer.mapAsync(GPUMapMode.READ, 0, bytesUsed);
      if (this.isDisposed) {
        if (this.resultBuffer.mapState === 'mapped') this.resultBuffer.unmap();
        return this.lastValue;
      }
      const times = new BigUint64Array(this.resultBuffer.getMappedRange(0, bytesUsed).slice(0));
      this.resultBuffer.unmap();
      const perFrame = {};
      const frames = [];
      this.timestamps.clear();
      this.intervals = new Map();
      for (const [uid, base] of offsets) {
        const m = /^(.*):f(\d+)$/.exec(uid);
        if (!m) continue;
        const frame = Number(m[2]);
        if (!frames.includes(frame)) frames.push(frame);
        const s = times[base];
        const e = times[base + 1];
        if (s === 0n || e < s) continue;
        const ms = Number(e - s) / 1e6;
        this.timestamps.set(uid, ms);
        this.intervals.set(uid, [s, e]);
        perFrame[frame] = (perFrame[frame] || 0) + ms;
      }
      const total = perFrame[frames[frames.length - 1]] || 0;
      this.lastValue = total;
      this.frames = frames;
      return total;
    } catch (err) {
      if (this.resultBuffer.mapState === 'mapped') this.resultBuffer.unmap();
      return this.lastValue;
    }
  };
}

// Label for one render call. three renames the scene "Shadow Map [ … ]" while it renders a
// shadow map; render contexts are shared between targets with equal formats, so labels are
// taken per call (per timestamp uid) from the render target.
function labelForRender(scene, renderTarget, resolveLabel) {
  if (scene && typeof scene.name === 'string' && scene.name.startsWith('Shadow Map')) return 'shadow';
  if (!renderTarget) return 'canvas';
  if (resolveLabel) {
    const named = resolveLabel(renderTarget);
    if (named) return named;
  }
  const tex = renderTarget.texture;
  return (tex && tex.name) || 'rt';
}

function labelForCompute(nodes) {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  return list.map((n) => (n && n.name) || 'compute').join('+');
}

export function createGpuTimer(renderer, { resolveLabel = null } = {}) {
  const backend = renderer.backend;
  const inspector = renderer.inspector;
  if (!backend || !backend.trackTimestamp || !inspector) return null;
  // uid → label, filled by hooks on the renderer's inspector (called with the timestamp uid of
  // every render and compute call).
  const labels = new Map();
  const beginRender = inspector.beginRender;
  const beginCompute = inspector.beginCompute;
  inspector.beginRender = function (uid, scene, camera, renderTarget) {
    try { labels.set(uid, labelForRender(scene, renderTarget, resolveLabel)); } catch { /* best effort */ }
    return beginRender.call(this, uid, scene, camera, renderTarget);
  };
  inspector.beginCompute = function (uid, computeNodes) {
    try { labels.set(uid, labelForCompute(computeNodes)); } catch { /* best effort */ }
    return beginCompute.call(this, uid, computeNodes);
  };
  let pending = false;
  let last = { total: NaN, span: NaN, sum: NaN, passes: {}, inclusive: {}, frame: -1, contexts: 0 };
  let lastDetail = [];
  const history = [];

  function collect() {
    const pools = backend.timestampQueryPool || {};
    const entries = [];
    let latest = -1;
    for (const type of ['render', 'compute']) {
      const pool = pools[type];
      if (!pool || !pool.timestamps) continue;
      for (const [uid, ms] of pool.timestamps) {
        const m = /^([rc]):(\d+):(.+):f(\d+)$/.exec(uid);
        if (!m) continue;
        const frame = Number(m[4]);
        const iv = pool.intervals ? pool.intervals.get(uid) : null;
        entries.push({ type, uid, frame, ms, iv });
        if (frame > latest) latest = frame;
      }
    }
    if (latest < 0) return;
    const frameEntries = entries.filter((e) => e.frame === latest);
    const inclusive = {};
    let sum = 0;
    for (const e of frameEntries) {
      e.label = labels.get(e.uid) || (e.type === 'compute' ? 'compute' : 'unlabelled');
      e.group = groupOfPass(e.label);
      inclusive[e.group] = (inclusive[e.group] || 0) + e.ms;
      sum += e.ms;
    }
    let total = sum;
    let span = NaN;
    let passes = inclusive;
    const withIv = frameEntries.filter((e) => e.iv);
    if (withIv.length === frameEntries.length && withIv.length) {
      let base = withIv[0].iv[0];
      for (const e of withIv) if (e.iv[0] < base) base = e.iv[0];
      const ivs = withIv.map((e) => [Number(e.iv[0] - base) / 1e6, Number(e.iv[1] - base) / 1e6]);
      const u = intervalUnion(ivs);
      total = u.total;
      span = u.span;
      passes = {};
      withIv.forEach((e, i) => { passes[e.group] = (passes[e.group] || 0) + u.credit[i]; });
    }
    last = { total, span, sum, passes, inclusive, frame: latest, contexts: frameEntries.length };
    lastDetail = frameEntries.map((e) => ({ label: e.label, ms: Number(e.ms.toFixed(3)) }));
    history.push(total);
    if (history.length > 120) history.shift();
    // Forget labels of frames that can no longer be resolved.
    if (labels.size > 4096) {
      for (const uid of labels.keys()) {
        const m = /:f(\d+)$/.exec(uid);
        if (m && Number(m[1]) < latest - 8) labels.delete(uid);
      }
    }
  }

  return {
    labels,
    get detail() { return lastDetail; },
    poll() {
      if (pending) return;
      pending = true;
      const pools = backend.timestampQueryPool || {};
      patchPool(pools.render);
      patchPool(pools.compute);
      Promise.all([
        renderer.resolveTimestampsAsync('render'),
        renderer.resolveTimestampsAsync('compute'),
      ]).then(collect, () => {}).finally(() => { pending = false; });
    },
    get last() { return last; },
    /** Median of the recent frame totals (ms). */
    median() {
      if (!history.length) return NaN;
      const a = history.slice().sort((x, y) => x - y);
      return a[a.length >> 1];
    },
    dispose() {
      inspector.beginRender = beginRender;
      inspector.beginCompute = beginCompute;
    },
  };
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const big = (v) => {
  if (!Number.isFinite(v)) return '–';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
};

/** Text overlay inside element (pointer-events off, monospace). */
export function createOverlay(element, { capabilities } = {}) {
  if (!element || typeof document === 'undefined') return { update() {}, setVisible() {}, text: '' };
  const pre = document.createElement('pre');
  pre.className = 'landscape-perf';
  pre.setAttribute('aria-live', 'off');
  Object.assign(pre.style, {
    margin: '0', padding: '6px 8px', font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#d8e6f0', background: 'rgba(8, 10, 14, 0.72)', borderRadius: '4px', pointerEvents: 'none',
    whiteSpace: 'pre', maxWidth: '46em', overflow: 'hidden',
  });
  element.appendChild(pre);
  let visible = true;
  let lastUpdate = 0;
  const adapter = capabilities && capabilities.adapter;
  const head = (capabilities ? (capabilities.backend === 'webgpu' ? 'WebGPU' : 'WebGL2') : '') +
    (adapter ? ' · ' + [adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(' ') : '') +
    (capabilities && !capabilities.timestamp ? ' · no GPU timestamps' : '');
  const api = {
    text: '',
    setVisible(v) {
      visible = !!v;
      element.style.display = visible ? '' : 'none';
    },
    update(stats, now = performance.now()) {
      if (!visible || now - lastUpdate < 250) return;
      lastUpdate = now;
      const lines = [head];
      lines.push(stats.width + '×' + stats.height + '  scale ' + fmt(stats.scale, 2) + (stats.autoScale ? ' (auto → ' + stats.targetFps + ' fps)' : '') + '  dpr ' + fmt(stats.dpr, 2) +
        (stats.ssaa > 1 ? '  SSAA ' + stats.ssaa + '× (scene ' + Math.round(stats.width * Math.sqrt(stats.ssaa)) + '×' + Math.round(stats.height * Math.sqrt(stats.ssaa)) + ')' : ''));
      lines.push('fps ' + fmt(stats.fps) + '  frame ' + fmt(stats.frameMs, 2) + ' ms  cpu ' + fmt(stats.cpuMs, 2) + ' ms  gpu ' + fmt(stats.gpuMs, 2) + ' ms' +
        (Number.isFinite(stats.gpuSpanMs) ? ' (span ' + fmt(stats.gpuSpanMs, 1) + ')' : ''));
      const passes = Object.entries(stats.gpuPasses || {}).sort((a, b) => b[1] - a[1]);
      if (passes.length) {
        let row = 'gpu:';
        for (const [name, ms] of passes) {
          const part = ' ' + name + ' ' + fmt(ms, 2);
          if (row.length + part.length > 72) { lines.push(row); row = '    '; }
          row += part;
        }
        lines.push(row);
      }
      lines.push('tris ' + big(stats.triangles) + (Number.isFinite(stats.terrainTriangles) ? ' (terrain ' + big(stats.terrainTriangles) + ')' : '') +
        '  draws ' + big(stats.drawCalls) + '  inst ' + big(stats.instances) +
        '  tiles ' + (stats.tiles ?? '–') + (stats.resident !== undefined ? '/' + stats.resident : '') +
        (stats.maxTiles ? ' (max ' + stats.maxTiles + ')' : ''));
      if (stats.worker) {
        lines.push('worker ' + fmt(stats.worker.blocksPerSecond, 0) + ' blk/s  resident ' + (stats.worker.residentTiles ?? '–') +
          '  chunks ' + fmt((stats.worker.chunkCacheBytes || 0) / 1048576, 0) + ' MB');
      }
      if (stats.memory) lines.push('js heap ' + fmt(stats.memory / 1048576, 0) + ' MB  textures ' + (stats.textures ?? '–') + '  geometries ' + (stats.geometries ?? '–'));
      if (stats.stages && stats.stages.length) lines.push('chain: ' + stats.stages.join(' → '));
      if (stats.error) lines.push('pipeline error: ' + String(stats.error).split('\n')[0].slice(0, 90));
      api.text = lines.join('\n');
      pre.textContent = api.text;
    },
  };
  return api;
}
