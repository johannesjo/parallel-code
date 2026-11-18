/**
 * Measurements for the reliability benchmark (reliability.spec.ts): process
 * memory and CPU, how quickly the main process and the window respond, frame
 * gaps, the fake agent processes still running, and the saved session.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { ElectronApplication, Page } from '@playwright/test';

export type ProcessSample = { pid: number; type: string; cpuSeconds: number; memoryMB: number };

/** Every Electron process (main, window, GPU, utilities) with its CPU and memory. */
export const sampleProcesses = (app: ElectronApplication): Promise<ProcessSample[]> =>
  app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpuSeconds: metric.cpu.cumulativeCPUUsage ?? 0,
      memoryMB: metric.memory.workingSetSize / 1024,
    })),
  );

/** How long a no-op round trip takes: queued behind whatever the process is busy with. */
export const pingMs = async (target: Page | ElectronApplication): Promise<number> => {
  const started = performance.now();
  await target.evaluate(() => 0);
  return performance.now() - started;
};

/** Records the gaps between rendered frames until `stop` returns them. */
export const startFrameProbe = async (page: Page): Promise<{ stop: () => Promise<number[]> }> => {
  await page.evaluate(() => {
    const probe = window as unknown as { __benchGaps: number[]; __benchStop: boolean };
    probe.__benchGaps = [];
    probe.__benchStop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      probe.__benchGaps.push(now - last);
      last = now;
      if (!probe.__benchStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return {
    stop: () =>
      page.evaluate(() => {
        const probe = window as unknown as { __benchGaps: number[]; __benchStop: boolean };
        probe.__benchStop = true;
        return probe.__benchGaps;
      }),
  };
};

export const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export const round = (value: number): number => Math.round(value * 10) / 10;

/** Process ids of this benchmark workspace's fake agents that are still running. */
export const agentPids = (workspaceDir: string): number[] => {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.includes('fake-agent.mjs') && line.includes(workspaceDir))
    .map((line) => Number.parseInt(line.trim(), 10));
};

export const runningAgents = (workspaceDir: string): number => agentPids(workspaceDir).length;

type SavedSession = {
  taskOrder: string[];
  tasks: Record<string, { name: string; notes?: string; worktreePath: string }>;
};

export const readSession = (statePath: string): SavedSession =>
  JSON.parse(fs.readFileSync(statePath, 'utf8')) as SavedSession;

/** Polls the saved session until `done` holds; the time it took, or null on timeout. */
export const waitForSave = async (
  statePath: string,
  done: (session: SavedSession) => boolean,
  timeoutMs: number,
): Promise<number | null> => {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    // The app saves through a temp file and rename, so a read never sees half a save.
    const session = readSession(statePath);
    if (done(session)) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
};

/** Bytes the flooding fake agents managed to write, summed over the `agents` that report so far. */
export const floodBytesWritten = (workspaceDir: string): { agents: number; bytes: number } => {
  const dir = `${workspaceDir}/transcripts`;
  const counts = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.written'))
    .map((name) => Number(fs.readFileSync(`${dir}/${name}`, 'utf8')));
  return { agents: counts.length, bytes: counts.reduce((sum, n) => sum + n, 0) };
};
