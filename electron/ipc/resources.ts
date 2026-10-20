import { app } from 'electron';
import os from 'os';
import { createCpuSampler, groupProcesses, readProcessTable } from './process-stats.js';
import { getPtyProcessRoots } from './pty.js';
import type { ResourceSnapshot } from './shared-types.js';

// CPU deltas over a few milliseconds are tick-quantisation noise, so callers
// closer together than this (several windows, overlapping polls) share a sample.
const MIN_SAMPLE_GAP_MS = 500;

const sampleCpu = createCpuSampler();
let inFlight: Promise<ResourceSnapshot> | null = null;
let last: ResourceSnapshot | null = null;

async function takeSnapshot(): Promise<ResourceSnapshot> {
  const sampledAt = Date.now();
  const rows = await readProcessTable();
  const appProcesses = new Map(
    app.getAppMetrics().map((metric) => [metric.pid, metric.name ?? metric.type] as const),
  );
  return {
    groups: groupProcesses({
      rows,
      cpu: sampleCpu(rows, sampledAt),
      ptys: getPtyProcessRoots(),
      appProcesses,
      mainPid: process.pid,
    }),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    sampledAt,
  };
}

/** CPU and memory of every agent/shell PTY tree, the app itself, and its other subprocesses. */
export function getResourceSnapshot(): Promise<ResourceSnapshot> {
  if (last && Date.now() - last.sampledAt < MIN_SAMPLE_GAP_MS) return Promise.resolve(last);
  inFlight ??= takeSnapshot()
    .then((snapshot) => (last = snapshot))
    .finally(() => (inFlight = null));
  return inFlight;
}
