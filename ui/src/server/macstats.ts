import path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';
import { MONITOR_TICK_MS } from '@/utils/monitorSample';

/**
 * macstats is a native, macOS-only optional dependency.
 *
 * Its readers block the calling thread: getPowerDataSync() sleeps ~500ms inside the native
 * module to measure power over an interval (its "async" variant blocks just the same), and
 * getGpuDataSync() takes ~90ms. Called on the Next.js main thread at monitor cadence, that
 * froze the event loop almost continuously and stalled every request in the UI. So every
 * macstats call runs in a resident worker thread that samples back to back and posts each
 * reading here; callers read the latest snapshot synchronously and never touch macstats.
 *
 * It must not be bundled. Webpack special-cases `createRequire(...)` in ways that leave
 * macstats unreachable at runtime, so the worker is an eval'd source string the bundler never
 * sees, and it resolves macstats against process.cwd() (the ui/ directory the Next server runs
 * in) so it loads from ui/node_modules at runtime.
 */

// Each field is the raw macstats result, or null when that call threw, so callers
// apply the same per-reading fallbacks they used when calling macstats directly.
export interface MacstatsSnapshot {
  gpuData: { temperature?: number; usage?: number } | null;
  fanData: Record<string, { rpm?: number }> | null;
  powerData: { gpu?: number } | null;
  ramData: { total: number; free: number; used: number } | null;
  cpuData: { temperature?: number } | null;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const read = fn => {
  try {
    return fn();
  } catch {
    return null;
  }
};
let ms = null;
try {
  ms = require('module').createRequire(path.join(workerData.cwd, 'package.json'))('macstats');
} catch (error) {
  parentPort.postMessage({ unavailable: String((error && error.message) || error) });
}
const loop = () => {
  const startedAt = Date.now();
  parentPort.postMessage({
    snapshot: {
      gpuData: read(() => ms.getGpuDataSync()),
      fanData: read(() => ms.getFanDataSync()),
      powerData: read(() => ms.getPowerDataSync()),
      ramData: read(() => ms.getRAMUsageSync()),
      cpuData: read(() => ms.getCpuDataSync()),
    },
  });
  setTimeout(loop, Math.max(0, workerData.intervalMs - (Date.now() - startedAt)));
};
if (ms) loop();
`;

const RESTART_DELAY_MS = 5000;

class MacstatsSampler {
  latest: MacstatsSnapshot | null = null;
  private unavailable = false;

  start(): void {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { cwd: process.cwd(), intervalMs: MONITOR_TICK_MS },
      });
    } catch (error) {
      console.warn('macstats not available:', error);
      this.unavailable = true;
      return;
    }
    // Sampling must never keep the server process alive on its own.
    worker.unref();
    worker.on('message', (msg: { snapshot?: MacstatsSnapshot; unavailable?: string }) => {
      if (msg.unavailable) {
        console.warn('macstats not available:', msg.unavailable);
        this.unavailable = true;
        return;
      }
      if (msg.snapshot) this.latest = msg.snapshot;
    });
    worker.on('error', error => console.error('macstats sampler failed:', error));
    worker.on('exit', () => {
      this.latest = null;
      if (this.unavailable) return;
      setTimeout(() => this.start(), RESTART_DELAY_MS).unref();
    });
  }
}

/**
 * Latest macstats readings, or null when macstats is unavailable on this machine
 * or its first reading hasn't arrived yet. Starts the sampler on first use.
 * Guarded on globalThis so every route bundle and dev-mode reload shares one worker.
 */
export function getMacstatsSnapshot(): MacstatsSnapshot | null {
  if (os.platform() !== 'darwin') return null;
  const g = globalThis as unknown as { __aiToolkitMacstatsSampler?: MacstatsSampler };
  if (!g.__aiToolkitMacstatsSampler) {
    g.__aiToolkitMacstatsSampler = new MacstatsSampler();
    g.__aiToolkitMacstatsSampler.start();
  }
  return g.__aiToolkitMacstatsSampler.latest;
}
