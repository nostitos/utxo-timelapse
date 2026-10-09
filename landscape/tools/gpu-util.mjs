#!/usr/bin/env node
// Apple GPU utilisation sampler (render_post). Reads IOAccelerator PerformanceStatistics from
// "ioreg -r -d 1 -w 0 -c IOAccelerator" (no sudo) at an interval, prints one JSON line per
// sample and a JSON summary at the end (duration reached, Ctrl-C or SIGTERM).
//
//   node landscape/tools/gpu-util.mjs [--interval 500] [--duration 30] [--quiet] [--label NAME]
//
// "Device Utilization %" is what Activity Monitor's GPU history shows; renderer and tiler are
// the fragment and vertex/tiling pipes. Memory figures are bytes from the driver statistics.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const KEYS = {
  device: 'Device Utilization %',
  renderer: 'Renderer Utilization %',
  tiler: 'Tiler Utilization %',
  inUseMemory: 'In use system memory',
  allocMemory: 'Alloc system memory',
};

/** Parses every accelerator block in ioreg output. */
export function parseIoreg(text) {
  const out = [];
  const blocks = String(text).split(/\n(?=\+-o )/);
  for (const block of blocks) {
    const stats = /"PerformanceStatistics" = \{([^}]*)\}/.exec(block);
    if (!stats) continue;
    const body = stats[1];
    const rec = {};
    const model = /"model" = "([^"]*)"/.exec(block);
    if (model) rec.model = model[1];
    const cores = /"gpu-core-count" = (\d+)/.exec(block);
    if (cores) rec.cores = Number(cores[1]);
    for (const [k, label] of Object.entries(KEYS)) {
      const re = new RegExp('"' + label.replace(/[%()]/g, (c) => '\\' + c) + '"=(\\d+)');
      const m = re.exec(body);
      if (m) rec[k] = Number(m[1]);
    }
    if (rec.device !== undefined) out.push(rec);
  }
  return out;
}

function stat(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: Number(mean.toFixed(2)), min: v[0], p50: q(0.5), p90: q(0.9), p95: q(0.95), max: v[v.length - 1] };
}

/** Summary of samples ({device, renderer, tiler, ...}). */
export function summarize(samples, extra = {}) {
  return {
    summary: true,
    ...extra,
    samples: samples.length,
    device: stat(samples.map((s) => s.device)),
    renderer: stat(samples.map((s) => s.renderer)),
    tiler: stat(samples.map((s) => s.tiler)),
    inUseMemoryMB: stat(samples.map((s) => (s.inUseMemory ?? NaN) / 1048576)),
  };
}

function readOnce() {
  return new Promise((resolve, reject) => {
    execFile('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) reject(err); else resolve(parseIoreg(stdout));
    });
  });
}

function parseArgs(argv) {
  const o = { interval: 500, duration: 0, quiet: false, label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interval') o.interval = Math.max(50, Number(argv[++i]));
    else if (a === '--duration') o.duration = Math.max(0, Number(argv[++i]));
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--label') o.label = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: node landscape/tools/gpu-util.mjs [--interval ms] [--duration s] [--quiet] [--label name]');
      process.exit(0);
    } else throw new Error('unknown argument ' + a);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const samples = [];
  let model = null;
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    console.log(JSON.stringify(summarize(samples, { label: opts.label, model, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), intervalMs: opts.interval })));
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  while (!stopped) {
    const tick = Date.now();
    try {
      const recs = await readOnce();
      const r = recs[0];
      if (r) {
        model = r.model || model;
        const s = { t: tick - t0, ts: tick, device: r.device, renderer: r.renderer, tiler: r.tiler, inUseMemory: r.inUseMemory, allocMemory: r.allocMemory };
        samples.push(s);
        if (!opts.quiet) console.log(JSON.stringify(s));
      }
    } catch (e) {
      console.error('ioreg failed: ' + (e && e.message || e));
    }
    if (opts.duration && Date.now() - t0 >= opts.duration * 1000) break;
    const wait = opts.interval - (Date.now() - tick);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
