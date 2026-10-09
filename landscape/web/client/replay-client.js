// Main-thread client for the replay worker (landscape/SPEC.md §5).
//
//   const replay = await createReplayClient({ dataUrl: '/dataset/', maxResidentTiles: 225, chunkCacheMB: 512 });
//   replay.onFrame((frame) => view.applyFrame(frame));
//   replay.setTiles(ids); await replay.seek(314000); await replay.advance(314010, { budgetMs: 10 });
//
// Frames are transferred from the worker; after delivery they belong to the main thread.
// Callbacks may read frame data but must not mutate it (several consumers share it).
import { gridFromManifest } from '../data/grid.js';
import { MEASURES } from '../replay/pack.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.dataUrl='/dataset/'] dataset directory URL (resolved against the page)
 * @param {number} [opts.maxResidentTiles=225]
 * @param {number} [opts.chunkCacheMB=512]
 * @param {boolean} [opts.verifyChunks=true] check each chunk's SHA-256 on load
 * @param {Worker} [opts.worker] injected worker-like object (tests)
 * @param {string|URL} [opts.workerUrl]
 */
export async function createReplayClient(opts = {}) {
  const { dataUrl = '/dataset/', maxResidentTiles = 225, chunkCacheMB = 512, verifyChunks = true } = opts;
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const absData = new URL(dataUrl, base).href;
  const worker = opts.worker || new Worker(opts.workerUrl || new URL('../replay.worker.js', import.meta.url), { type: 'module', name: 'utxo-landscape-replay' });

  const frameCbs = new Set();
  const statusCbs = new Set();
  const errorCbs = new Set();
  const pending = new Map();
  let nextId = 1;
  let disposed = false;
  let advanceInFlight = null;
  let advanceQueued = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  const client = {
    manifest: null,
    grid: null,
    rows: null,
    blocktimes: null,
    snapshotBlocks: null,
    block: null,
    busy: true,
    meta: null,
    status: null,
    stats: null,
    measures: { height: 'density', color: 'density' },

    setTiles(ids) {
      post({ type: 'setTiles', ids: Array.from(ids, Number) });
    },
    setMeasures({ height, color } = {}) {
      for (const m of [height, color]) {
        if (m !== undefined && !MEASURES.includes(m)) throw new Error('setMeasures: unknown measure ' + m + ' (density, count, value)');
      }
      if (height !== undefined) client.measures.height = height;
      if (color !== undefined) client.measures.color = color;
      post({ type: 'setMeasures', height, color });
    },
    setHeatHalfLife(blocks) {
      post({ type: 'setHeatHalfLife', blocks: Number(blocks) });
    },
    setMaxResidentTiles(n) {
      post({ type: 'setMaxResidentTiles', n: Number(n) });
    },
    setChunkCacheMB(mb) {
      post({ type: 'setChunkCacheMB', mb: Number(mb) });
    },
    /** Exact seek. Latest seek wins; superseded promises resolve {cancelled: true}. */
    seek(block) {
      if (advanceQueued) { advanceQueued.resolve({ cancelled: true }); advanceQueued = null; }
      return request({ type: 'seek', block: Number(block) });
    },
    /**
     * Exact replay toward target (either direction) within budgetMs (at least one block).
     * One call is in flight at a time; a call made meanwhile is queued (the latest wins,
     * replaced calls resolve {cancelled: true}).
     */
    advance(target, { budgetMs = 10 } = {}) {
      if (advanceInFlight) {
        if (advanceQueued) advanceQueued.resolve({ cancelled: true });
        return new Promise((resolve, reject) => { advanceQueued = { target, budgetMs, resolve, reject }; });
      }
      return sendAdvance(target, budgetMs);
    },
    /** Exact cell state {countSmall, countLarge, satsSmall, satsLarge, heat, heatBlock, block, ...} or null. */
    cell(level, col, row, { load = true } = {}) {
      return request({ type: 'cell', level, col, row, load });
    },
    onFrame(cb) { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb); },
    onError(cb) { errorCbs.add(cb); return () => errorCbs.delete(cb); },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { worker.postMessage({ type: 'dispose' }); } catch {}
      if (worker.terminate) worker.terminate();
      for (const p of pending.values()) p.resolve({ cancelled: true });
      pending.clear();
      if (advanceQueued) { advanceQueued.resolve({ cancelled: true }); advanceQueued = null; }
      frameCbs.clear();
      statusCbs.clear();
      errorCbs.clear();
    },
  };

  function post(msg) {
    if (disposed) return;
    worker.postMessage(msg);
  }

  function request(msg) {
    if (disposed) return Promise.resolve({ cancelled: true });
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, type: msg.type });
      worker.postMessage({ ...msg, id });
    });
  }

  function sendAdvance(target, budgetMs) {
    const p = request({ type: 'advance', target: Number(target), budgetMs: Number(budgetMs) });
    advanceInFlight = p;
    const next = () => {
      advanceInFlight = null;
      if (advanceQueued) {
        const q = advanceQueued;
        advanceQueued = null;
        sendAdvance(q.target, q.budgetMs).then(q.resolve, q.reject);
      }
    };
    p.then(next, next);
    return p;
  }

  function emitError(err) {
    if (!errorCbs.size) console.error('[replay]', err.message || err);
    for (const cb of errorCbs) {
      try { cb(err); } catch (e) { console.error(e); }
    }
  }

  function settle(m, value) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(value);
  }

  function onMessage(e) {
    const m = e.data;
    switch (m.type) {
      case 'frame': {
        const f = m.frame;
        client.block = f.block;
        if (f.meta) client.meta = f.meta;
        client.stats = f.stats;
        for (const cb of frameCbs) {
          try { cb(f); } catch (err) { emitError(err); }
        }
        break;
      }
      case 'status':
        client.status = m.status;
        client.busy = m.status.busy;
        for (const cb of statusCbs) {
          try { cb(m.status); } catch (err) { emitError(err); }
        }
        break;
      case 'seekDone':
        if (!m.cancelled && !m.error && m.block !== undefined) client.block = m.block;
        settle(m, m.cancelled ? { cancelled: true } : { block: m.block, ms: m.ms, plan: m.plan });
        break;
      case 'advanceDone':
        settle(m, m.cancelled ? { cancelled: true } : { block: m.block, reached: m.reached, blocks: m.blocks, ms: m.ms });
        break;
      case 'cellResult':
        settle(m, m.cell);
        break;
      case 'error':
        emitError(Object.assign(new Error(m.message), { workerStack: m.stack }));
        break;
      case 'ready':
        client.manifest = m.manifest;
        client.grid = gridFromManifest(m.manifest);
        client.rows = m.rows;
        client.blocktimes = m.blocktimes;
        client.snapshotBlocks = m.snapshotBlocks;
        client.busy = false;
        readyResolve();
        break;
      case 'initError':
        readyReject(new Error('replay worker init failed: ' + m.message));
        break;
      default:
        break;
    }
  }

  if (worker.addEventListener) {
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (e) => {
      const err = new Error('replay worker error: ' + (e.message || 'unknown'));
      readyReject(err);
      emitError(err);
    });
    worker.addEventListener('messageerror', () => emitError(new Error('replay worker message could not be deserialised')));
  } else {
    worker.onmessage = onMessage;
  }
  worker.postMessage({ type: 'init', dataUrl: absData, maxResidentTiles, chunkCacheMB, verifyChunks });
  try {
    await ready;
  } catch (err) {
    if (worker.terminate) worker.terminate();
    throw err;
  }
  return client;
}
