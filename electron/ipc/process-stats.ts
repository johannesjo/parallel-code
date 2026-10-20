import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { ResourceGroup, ResourceProcess } from './shared-types.js';

// shortcut: Linux defaults for USER_HZ and page size — read them via getconf if
// an unusual kernel (e.g. 16K pages on Asahi) reports wrong memory.
const CLOCK_TICKS_PER_SECOND = 100;
const PAGE_SIZE_BYTES = 4096;

/** One OS process as read from the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  memoryBytes: number;
  /** Cumulative CPU seconds (Linux), turned into a percentage by the sampler. */
  cpuSeconds?: number;
  /** Start time since boot (Linux) — tells a reused pid apart from the old process. */
  startTicks?: number;
  /** Ready-made CPU percentage (macOS `ps`, a recent decaying average). */
  cpuPercent?: number;
}

/** Parse `/proc/<pid>/stat`. The command name may contain spaces and parens. */
export function parseProcStat(text: string): ProcRow | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  // Fields after the name, starting with field 3 (state):
  // ppid=1, utime=11, stime=12, starttime=19, rss=21.
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const ticks = Number(rest[11]) + Number(rest[12]);
  const startTicks = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (![pid, ppid, ticks, startTicks, rssPages].every(Number.isFinite)) return null;
  return {
    pid,
    ppid,
    name: text.slice(open + 1, close),
    cpuSeconds: ticks / CLOCK_TICKS_PER_SECOND,
    startTicks,
    memoryBytes: rssPages * PAGE_SIZE_BYTES,
  };
}

/** Parse `ps -A -o pid=,ppid=,%cpu=,rss=,comm=` output (macOS). */
export function parsePsOutput(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      memoryBytes: Number(match[4]) * 1024,
      // macOS reports the full executable path; the basename is what users recognise.
      name: path.basename(match[5].trim()),
    });
  }
  return rows;
}

async function readLinuxProcesses(): Promise<ProcRow[]> {
  const entries = await fs.readdir('/proc');
  const reads = entries
    .filter((entry) => /^\d+$/.test(entry))
    // A process can exit between readdir and read; dropping it is the right answer.
    .map((pid) => fs.readFile(`/proc/${pid}/stat`, 'utf8').then(parseProcStat, () => null));
  return (await Promise.all(reads)).filter((row): row is ProcRow => row !== null);
}

function readPsProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,%cpu=,rss=,comm='],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        // `ps -A` lists itself as a child of the app; it is the measurement, not a workload.
        resolve(parsePsOutput(stdout).filter((row) => row.pid !== child.pid));
      },
    );
  });
}

/** Read the whole process table. Linux uses /proc; macOS uses `ps`. */
export function readProcessTable(): Promise<ProcRow[]> {
  return process.platform === 'linux' ? readLinuxProcesses() : readPsProcesses();
}

interface CpuReading {
  cpuSeconds: number;
  startTicks?: number;
}

/**
 * Turns cumulative CPU seconds into a percentage of one core over the interval
 * since the previous sample. The first sample of a process — or of a new
 * process that reused an old pid — reports 0%. `at` is when the table was read.
 */
export function createCpuSampler() {
  let previous = new Map<number, CpuReading>();
  let previousAt = 0;
  return (rows: ProcRow[], at: number): Map<number, number> => {
    const elapsed = (at - previousAt) / 1000;
    const percents = new Map<number, number>();
    const next = new Map<number, CpuReading>();
    for (const row of rows) {
      if (row.cpuPercent !== undefined) {
        percents.set(row.pid, row.cpuPercent);
        continue;
      }
      if (row.cpuSeconds === undefined) continue;
      next.set(row.pid, { cpuSeconds: row.cpuSeconds, startTicks: row.startTicks });
      const before = previous.get(row.pid);
      const same = before !== undefined && before.startTicks === row.startTicks;
      const percent =
        !same || elapsed <= 0 ? 0 : ((row.cpuSeconds - before.cpuSeconds) / elapsed) * 100;
      percents.set(row.pid, Math.max(0, percent));
    }
    previous = next;
    previousAt = at;
    return percents;
  };
}

/** A PTY whose process tree is reported as one group. */
export interface PtyRoot {
  agentId: string;
  taskId: string;
  isShell: boolean;
  pid: number;
}

export interface GroupInput {
  rows: ProcRow[];
  cpu: Map<number, number>;
  ptys: PtyRoot[];
  /** Electron's own processes (main, renderers, GPU, …) keyed by pid with a label. */
  appProcesses: Map<number, string>;
  mainPid: number;
}

function descendants(rootPid: number, children: Map<number, number[]>): number[] {
  // A set, because macOS `ps` reports pid 0 as its own parent.
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return [...seen];
}

function buildGroup(
  base: Omit<ResourceGroup, 'cpuPercent' | 'memoryBytes' | 'processes'>,
  processes: ResourceProcess[],
): ResourceGroup {
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes);
  return {
    ...base,
    cpuPercent: processes.reduce((sum, p) => sum + p.cpuPercent, 0),
    memoryBytes: processes.reduce((sum, p) => sum + p.memoryBytes, 0),
    processes,
  };
}

/**
 * Splits the process table into one group per PTY (agent or shell, with all of
 * its descendants), the app's own Electron processes, and everything else the
 * app spawned (chat agents, MCP servers, git, …).
 */
export function groupProcesses(input: GroupInput): ResourceGroup[] {
  const byPid = new Map(input.rows.map((row) => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of input.rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const claimed = new Set<number>();
  const toProcesses = (pids: number[], label?: (pid: number) => string | undefined) =>
    pids.flatMap((pid): ResourceProcess[] => {
      const row = byPid.get(pid);
      if (!row || claimed.has(pid)) return [];
      claimed.add(pid);
      const name = label?.(pid) ?? row.name;
      return [{ pid, name, cpuPercent: input.cpu.get(pid) ?? 0, memoryBytes: row.memoryBytes }];
    });

  const groups = input.ptys.map((pty) =>
    buildGroup(
      { kind: pty.isShell ? 'shell' : 'agent', agentId: pty.agentId, taskId: pty.taskId },
      toProcesses(descendants(pty.pid, children)),
    ),
  );
  const appPids = [...input.appProcesses.keys()];
  groups.push(
    buildGroup(
      { kind: 'app', agentId: null, taskId: null },
      toProcesses(appPids, (pid) => input.appProcesses.get(pid)),
    ),
  );
  groups.push(
    buildGroup(
      { kind: 'other', agentId: null, taskId: null },
      toProcesses(descendants(input.mainPid, children)),
    ),
  );
  return groups.filter((group) => group.processes.length > 0);
}
