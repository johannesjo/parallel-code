/**
 * Reliability benchmark: many agents at once, a normal restart, and a crash,
 * all against the built app with fake agents (no paid services).
 *
 * - load: BENCH_AGENTS tasks (default 12) whose agents print BENCH_FLOOD bytes
 *   per second each (default 32768) for BENCH_SECONDS (default 60). Reports
 *   memory and CPU per Electron process, memory growth, frame gaps and how
 *   long the window and the main process take to answer.
 * - restart: quits normally and starts again; reports which tasks, notes and
 *   panel sizes came back and how many agents run again.
 * - crash: measures how long an edit takes to reach disk, kills the main
 *   process right after another edit, then reports what was lost, the agents
 *   left running, and whether the app starts with every task.
 *
 * Linux only, like the showcase harness: `npm run bench:reliability` builds
 * the app and runs all three (about 2 minutes); add `-- -g load` for one.
 * Results land in `.tmp/bench/reliability-<scenario>.json`. Headless runs use
 * software rendering, so the GPU process's CPU is not what a desktop sees.
 * Prefix `SHOWCASE_WINDOWED=1` for a real window with the GPU, outside a sandbox.
 * Landing integrity is covered by electron/ipc/git-merge-kanban.integration.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import type { DemoTask } from '../showcase/demo-workspace';
import { DEMO_DIR, launchShowcaseApp, type ShowcaseApp } from '../showcase/electron-app';
import {
  percentile,
  pingMs,
  readSession,
  round,
  agentPids,
  runningAgents,
  type ProcessSample,
  sampleProcesses,
  floodBytesWritten,
  startFrameProbe,
  waitForSave,
} from './reliability-probes';

const AGENTS = Number(process.env.BENCH_AGENTS ?? 12);
const FLOOD = Number(process.env.BENCH_FLOOD ?? 32_768);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 60);
const SAMPLE_EVERY_MS = 2000;
const OUT_DIR = path.join(import.meta.dirname, '..', '..', '.tmp', 'bench');
// Where launchShowcaseApp puts the workspace; fake agents' arguments name it.
const WORKSPACE = DEMO_DIR;

const benchTask = (i: number, flood: number): DemoTask => ({
  slug: `bench-${i}`,
  name: `Bench task ${i}`,
  agentName: 'Codex CLI',
  session: { prompt: `Run suite ${i}`, transcript: `› Run suite ${i}\n` },
  flood,
  prepare: () => undefined,
});

const tasks = (count: number, flood: number): DemoTask[] =>
  Array.from({ length: count }, (_, i) => benchTask(i + 1, flood));

const report = (scenario: string, result: Record<string, unknown>): void => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `reliability-${scenario}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`,
  );
  console.warn(`${scenario}: ${JSON.stringify(result)}`);
};

type Sample = { at: number; processes: ProcessSample[] };

/** CPU share and memory of one process type over the run, from the first and last samples. */
const byType = (samples: Sample[], type: string) => {
  const ofType = (sample: Sample) => sample.processes.filter((p) => p.type === type);
  const first = samples[0];
  const last = samples[samples.length - 1];
  // Only processes alive throughout, so a restarted one does not count negative time.
  const pids = new Set(ofType(first).map((p) => p.pid));
  const cpu = (sample: Sample) =>
    ofType(sample)
      .filter((p) => pids.has(p.pid))
      .reduce((sum, p) => sum + p.cpuSeconds, 0);
  const mb = samples.map((sample) => ofType(sample).reduce((sum, p) => sum + p.memoryMB, 0));
  return {
    // Percent of one core, so a busy multi-threaded process can exceed 100.
    cpuPercent: round(((cpu(last) - cpu(first)) / ((last.at - first.at) / 1000)) * 100),
    maxMemoryMB: round(Math.max(...mb)),
    memoryGrowthMB: round(mb[mb.length - 1] - mb[0]),
  };
};

const awaitAllTasks = async (run: ShowcaseApp, count: number): Promise<void> => {
  for (let i = 1; i <= count; i++) {
    await expect(run.page.getByText(`Bench task ${i}`, { exact: true }).first()).toBeAttached();
  }
};

test('load: many agents streaming at once', async () => {
  const run = await launchShowcaseApp({ tasks: tasks(AGENTS, FLOOD) });
  try {
    await awaitAllTasks(run, AGENTS);
    await expect.poll(() => runningAgents(WORKSPACE)).toBe(AGENTS);
    // Every agent has reported once, so none counts its early output as new.
    await expect.poll(() => floodBytesWritten(WORKSPACE).agents).toBe(AGENTS);
    const frames = await startFrameProbe(run.page);
    const samples: Sample[] = [];
    const writtenFrom = { at: Date.now(), bytes: floodBytesWritten(WORKSPACE).bytes };
    const windowPings: number[] = [];
    const mainPings: number[] = [];
    const end = Date.now() + SECONDS * 1000;
    while (Date.now() < end) {
      samples.push({ at: Date.now(), processes: await sampleProcesses(run.app) });
      windowPings.push(await pingMs(run.page));
      mainPings.push(await pingMs(run.app));
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS));
    }
    const writtenTo = { at: Date.now(), bytes: floodBytesWritten(WORKSPACE).bytes };
    const gaps = await frames.stop();
    expect(gaps.length, 'the window drew no frames').toBeGreaterThan(0);
    expect(samples.length, 'BENCH_SECONDS is too short to sample twice').toBeGreaterThan(1);
    const taken = (writtenTo.bytes - writtenFrom.bytes) / ((writtenTo.at - writtenFrom.at) / 1000);
    report('load', {
      agents: AGENTS,
      floodBytesPerSecondEach: FLOOD,
      seconds: SECONDS,
      // Counts flush once a second, so read it to a few percent. Well below 100%, the app's flow control slowed agents down to what the terminals could draw.
      outputTakenPercent: round((taken / (AGENTS * FLOOD)) * 100),
      processes: Object.fromEntries(
        [...new Set(samples.flatMap((s) => s.processes.map((p) => p.type)))].map((type) => [
          type,
          byType(samples, type),
        ]),
      ),
      frameGapMs: { p95: round(percentile(gaps, 95)), max: round(Math.max(...gaps)) },
      framesOver50ms: gaps.filter((gap) => gap > 50).length,
      windowPingMs: {
        p95: round(percentile(windowPings, 95)),
        max: round(Math.max(...windowPings)),
      },
      mainPingMs: { p95: round(percentile(mainPings, 95)), max: round(Math.max(...mainPings)) },
      agentsStillRunning: runningAgents(WORKSPACE),
    });
  } finally {
    await run.close();
  }
});

const NOTE = 'Reliability benchmark note';

const editNotes = async (run: ShowcaseApp, text: string): Promise<void> => {
  const notes = run.page.getByLabel('Task notes').first();
  await notes.fill(text);
};

test('restart: state comes back after a normal quit', async () => {
  const count = 4;
  let run = await launchShowcaseApp({ tasks: tasks(count, 0) });
  try {
    await awaitAllTasks(run, count);
    await editNotes(run, NOTE);
    const savedMs = await waitForSave(
      run.statePath,
      (s) => Object.values(s.tasks).some((t) => t.notes === NOTE),
      10_000,
    );
    const before = readSession(run.statePath);
    run = await run.restart('quit');
    await awaitAllTasks(run, count);
    await expect.poll(() => runningAgents(WORKSPACE)).toBe(count);
    const after = readSession(run.statePath);
    const result = {
      noteSavedAfterMs: savedMs === null ? null : round(savedMs),
      tasksBefore: before.taskOrder.length,
      tasksAfter: after.taskOrder.length,
      sameTaskOrder: JSON.stringify(before.taskOrder) === JSON.stringify(after.taskOrder),
      noteKept: Object.values(after.tasks).some((t) => t.notes === NOTE),
      agentsRunningAfter: runningAgents(WORKSPACE),
    };
    report('restart', result);
    expect.soft(result.noteKept, 'note lost across a quit').toBe(true);
    expect.soft(result.tasksAfter, 'tasks lost across a quit').toBe(count);
  } finally {
    await run.close();
  }
});

/** SIGKILLs `pid`; one that exited since `ps` listed it is fine (the crash's SIGHUP got there first). */
const killIfAlive = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

test('crash: what survives killing the main process', async () => {
  const count = 4;
  let run = await launchShowcaseApp({ tasks: tasks(count, 0) });
  try {
    await awaitAllTasks(run, count);
    await editNotes(run, `${NOTE} 1`);
    const savedMs = await waitForSave(
      run.statePath,
      (s) => Object.values(s.tasks).some((t) => t.notes === `${NOTE} 1`),
      10_000,
    );
    // The second edit is killed before autosave's debounce can write it.
    await editNotes(run, `${NOTE} 2`);
    const worktrees = Object.values(readSession(run.statePath).tasks).map((t) => t.worktreePath);
    let leftBehind = 0;
    run = await run.restart('kill', () => {
      const orphans = agentPids(WORKSPACE);
      leftBehind = orphans.length;
      // So they cannot be mistaken for respawned agents, or outlive the run.
      for (const pid of orphans) killIfAlive(pid);
    });
    const notes = Object.values(readSession(run.statePath).tasks).map((t) => t.notes);
    await awaitAllTasks(run, count);
    await expect.poll(() => runningAgents(WORKSPACE)).toBe(count);
    const result = {
      editSavedAfterMs: savedMs === null ? null : round(savedMs),
      savedEditKept: notes.includes(`${NOTE} 1`),
      unsavedEditKept: notes.includes(`${NOTE} 2`),
      // Agents a crash leaves running keep editing worktrees nobody watches.
      agentsLeftRunningByCrash: leftBehind,
      worktreesKept: worktrees.filter((dir) => fs.existsSync(dir)).length,
      tasks: count,
      agentsRunningAfterRestart: runningAgents(WORKSPACE),
    };
    report('crash', result);
    expect.soft(result.savedEditKept, 'a saved edit was lost in a crash').toBe(true);
    expect.soft(result.worktreesKept, 'worktrees lost in a crash').toBe(count);
    expect.soft(result.agentsLeftRunningByCrash, 'a crash left agents running').toBe(0);
  } finally {
    await run.close();
  }
});
