// Module worker that owns the exact replay state (landscape/SPEC.md §5).
// The main thread talks to it only through client/replay-client.js.
import { ReplayEngine } from './replay/engine.js';
import { httpSource } from './data/source.js';

let engine = null;
const early = [];

self.onmessage = (e) => {
  const m = e.data;
  if (m && m.type === 'init') {
    init(m);
    return;
  }
  if (!engine || !engine.state) {
    early.push(m);
    return;
  }
  engine.command(m);
};

async function init(m) {
  try {
    engine = new ReplayEngine({
      source: httpSource(m.dataUrl),
      post: (msg, transfer) => self.postMessage(msg, transfer || []),
    });
    const ready = await engine.init({
      maxResidentTiles: m.maxResidentTiles,
      chunkCacheMB: m.chunkCacheMB,
      verifyChunks: m.verifyChunks !== false,
    });
    self.postMessage({
      type: 'ready',
      manifest: ready.manifest,
      rows: ready.rows,
      blocktimes: ready.blocktimes,
      snapshotBlocks: ready.snapshotBlocks,
    });
    for (const q of early.splice(0)) engine.command(q);
  } catch (err) {
    self.postMessage({ type: 'initError', message: String((err && err.message) || err), stack: err && err.stack });
  }
}
