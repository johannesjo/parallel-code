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
  /**
   * Cumulative CPU seconds of the children this process has reaped, each with
   * everything they reaped in turn (Linux cutime + cstime). Commands that exit
   * between two samples leave their CPU only here.
   */
  childCpuSeconds?: number;
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
  // ppid=1, utime=11, stime=12, cutime=13, cstime=14, starttime=19, rss=21.
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const ticks = Number(rest[11]) + Number(rest[12]);
  const childTicks = Number(rest[13]) + Number(rest[14]);
  const startTicks = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (![pid, ppid, ticks, childTicks, startTicks, rssPages].every(Number.isFinite)) return null;
  return {
    pid,
    ppid,
    name: text.slice(open + 1, close),
    cpuSeconds: ticks / CLOCK_TICKS_PER_SECOND,
    childCpuSeconds: childTicks / CLOCK_TICKS_PER_SECOND,
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
  ppid: number;
  cpuSeconds: number;
  childCpuSeconds: number;
  startTicks?: number;
}

/** One sample's CPU, in percent of one core over the interval since the previous sample. */
export interface CpuSample {
  /** What each live process used itself. */
  cpu: Map<number, number>;
  /**
   * What the children a process reaped during the interval used and had not
   * yet been counted, keyed by the reaping parent. Absent where the process
   * table does not report reaped children's CPU (macOS `ps`).
   */
  exitedCpu?: Map<number, number>;
}

/**
 * Turns cumulative CPU seconds into a percentage of one core over the interval
 * since the previous sample. `at` is when the table was read.
 *
 * The first sample has no baseline and reports 0% everywhere. After that, a pid
 * that was not in the previous sample (or that now belongs to a new process
 * with a reused pid) started during the interval, so all of its CPU counts.
 *
 * Commands that exit between two samples are never seen. Their CPU reaches the
 * parent's reaped-children counter when the parent waits for them, so the
 * counter's growth is credited to the parent. A child that was seen alive had
 * its CPU up to that sample counted already: when it disappears, its last-seen
 * total — its own CPU, what it had reaped, and the same for each seen
 * descendant that disappeared with it — is subtracted from that growth.
 */
export function createCpuSampler() {
  let previous: Map<number, CpuReading> | null = null;
  let previousAt = 0;
  return (rows: ProcRow[], at: number): CpuSample => {
    const before = previous;
    const elapsed = (at - previousAt) / 1000;
    const percent = (seconds: number) =>
      before === null || elapsed <= 0 ? 0 : Math.max(0, (seconds / elapsed) * 100);
    const cpu = new Map<number, number>();
    const exitedCpu = new Map<number, number>();
    let measuresChildren = false;
    const next = new Map<number, CpuReading>();
    for (const row of rows) {
      if (row.cpuPercent !== undefined) cpu.set(row.pid, row.cpuPercent);
      else if (row.cpuSeconds !== undefined) {
        measuresChildren ||= row.childCpuSeconds !== undefined;
        next.set(row.pid, {
          ppid: row.ppid,
          cpuSeconds: row.cpuSeconds,
          childCpuSeconds: row.childCpuSeconds ?? 0,
          startTicks: row.startTicks,
        });
      }
    }

    const previousChildren = new Map<number, number[]>();
    for (const [pid, reading] of before ?? []) {
      const list = previousChildren.get(reading.ppid) ?? [];
      list.push(pid);
      previousChildren.set(reading.ppid, list);
    }
    const isGone = (pid: number, reading: CpuReading) => {
      const now = next.get(pid);
      return now === undefined || now.startTicks !== reading.startTicks;
    };
    // CPU already counted for processes under `parentPid` that have exited
    // since the previous sample, and so may now sit in its reaped counter.
    const countedForGoneChildren = (parentPid: number): number => {
      let total = 0;
      const visited = new Set<number>([parentPid]);
      const stack = [...(previousChildren.get(parentPid) ?? [])];
      while (stack.length > 0) {
        const pid = stack.pop() as number;
        const reading = before?.get(pid);
        if (visited.has(pid) || !reading || !isGone(pid, reading)) continue;
        visited.add(pid);
        total += reading.cpuSeconds + reading.childCpuSeconds;
        stack.push(...(previousChildren.get(pid) ?? []));
      }
      return total;
    };

    for (const [pid, reading] of next) {
      const last = before?.get(pid);
      const same = last !== undefined && last.startTicks === reading.startTicks;
      cpu.set(pid, percent(same ? reading.cpuSeconds - last.cpuSeconds : reading.cpuSeconds));
      if (!measuresChildren) continue;
      const reaped = same
        ? reading.childCpuSeconds - last.childCpuSeconds - countedForGoneChildren(pid)
        : reading.childCpuSeconds;
      exitedCpu.set(pid, percent(reaped));
    }
    previous = next;
    previousAt = at;
    return measuresChildren ? { cpu, exitedCpu } : { cpu };
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
  /** Reaped children's CPU by reaping parent; see `CpuSample.exitedCpu`. */
  exitedCpu?: Map<number, number>;
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

/** What identifies a group; the sums are computed from its processes. */
type GroupBase = Omit<
  ResourceGroup,
  'cpuPercent' | 'memoryBytes' | 'processes' | 'exitedCpuPercent'
>;

function buildGroup(
  base: GroupBase,
  processes: ResourceProcess[],
  exitedCpuPercent: number | undefined,
): ResourceGroup {
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes);
  return {
    ...base,
    cpuPercent: processes.reduce((sum, p) => sum + p.cpuPercent, exitedCpuPercent ?? 0),
    memoryBytes: processes.reduce((sum, p) => sum + p.memoryBytes, 0),
    processes,
    ...(exitedCpuPercent === undefined ? {} : { exitedCpuPercent }),
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

  // Finished commands count where their parent is. The main process reaps
  // what the app spawned (git, gh, …), which belongs with the other subprocesses.
  const exitedOf = (processes: ResourceProcess[], extra = 0): number | undefined => {
    const exited = input.exitedCpu;
    if (exited === undefined) return undefined;
    return processes.reduce(
      (sum, p) => sum + (p.pid === input.mainPid ? 0 : (exited.get(p.pid) ?? 0)),
      extra,
    );
  };
  const group = (base: GroupBase, processes: ResourceProcess[], extra?: number) =>
    buildGroup(base, processes, exitedOf(processes, extra));

  const groups = input.ptys.map((pty) =>
    group(
      { kind: pty.isShell ? 'shell' : 'agent', agentId: pty.agentId, taskId: pty.taskId },
      toProcesses(descendants(pty.pid, children)),
    ),
  );
  const appPids = [...input.appProcesses.keys()];
  groups.push(
    group(
      { kind: 'app', agentId: null, taskId: null },
      toProcesses(appPids, (pid) => input.appProcesses.get(pid)),
    ),
  );
  groups.push(
    group(
      { kind: 'other', agentId: null, taskId: null },
      toProcesses(descendants(input.mainPid, children)),
      input.exitedCpu?.get(input.mainPid),
    ),
  );
  return groups.filter((g) => g.processes.length > 0 || (g.exitedCpuPercent ?? 0) > 0);
}
