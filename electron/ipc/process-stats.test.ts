import { describe, expect, it } from 'vitest';
import {
  createCpuSampler,
  groupProcesses,
  parseProcStat,
  parsePsOutput,
  type ProcRow,
} from './process-stats.js';

function stat(pid: number, name: string, ppid: number, utime: number, stime: number, rss: number) {
  // Fields 3..24 of /proc/<pid>/stat; only ppid, utime, stime, starttime and rss matter here.
  const rest = ['S', ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, utime, stime, 0, 0, 0, 0, 0, 0, 777, 0, rss];
  return `${pid} (${name}) ${rest.join(' ')} 0 0\n`;
}

describe('parseProcStat', () => {
  it('reads ppid, cpu seconds and resident memory', () => {
    expect(parseProcStat(stat(42, 'node', 7, 150, 50, 1000))).toEqual({
      pid: 42,
      ppid: 7,
      name: 'node',
      cpuSeconds: 2,
      startTicks: 777,
      memoryBytes: 1000 * 4096,
    });
  });

  it('keeps names that contain spaces and parentheses', () => {
    expect(parseProcStat(stat(5, 'Web (Content) x', 1, 0, 0, 1))?.name).toBe('Web (Content) x');
  });

  it('rejects malformed input', () => {
    expect(parseProcStat('garbage')).toBeNull();
  });
});

describe('parsePsOutput', () => {
  it('reads rows and shortens executable paths', () => {
    const out = '  12     1  3.5  2048 /usr/local/bin/my tool\n  13    12  0.0   512 zsh\n\n';
    expect(parsePsOutput(out)).toEqual([
      { pid: 12, ppid: 1, cpuPercent: 3.5, memoryBytes: 2048 * 1024, name: 'my tool' },
      { pid: 13, ppid: 12, cpuPercent: 0, memoryBytes: 512 * 1024, name: 'zsh' },
    ]);
  });
});

describe('createCpuSampler', () => {
  const row = (cpuSeconds: number, startTicks = 1): ProcRow => ({
    pid: 1,
    ppid: 0,
    name: 'a',
    memoryBytes: 0,
    cpuSeconds,
    startTicks,
  });

  it('reports the share of one core used since the previous sample', () => {
    const sample = createCpuSampler();
    expect(sample([row(10)], 0).get(1)).toBe(0);
    expect(sample([row(11)], 2000).get(1)).toBe(50);
  });

  it('treats a reused pid as a new process instead of a spike', () => {
    const sample = createCpuSampler();
    sample([row(1)], 0);
    expect(sample([row(500, 2)], 2000).get(1)).toBe(0);
    expect(sample([row(501, 2)], 4000).get(1)).toBe(50);
  });

  it('passes ready-made percentages through', () => {
    const sample = createCpuSampler();
    const rows = [{ pid: 3, ppid: 0, name: 'b', memoryBytes: 0, cpuPercent: 12 }];
    expect(sample(rows, 0).get(3)).toBe(12);
  });
});

describe('groupProcesses', () => {
  const row = (pid: number, ppid: number, name: string): ProcRow => ({
    pid,
    ppid,
    name,
    memoryBytes: pid * 100,
  });
  // main(10) → gpu(11), zygote(12) → renderer(13); pty(20) → claude(21) → node(22); mcp(30)
  const rows = [
    row(1, 0, 'init'),
    row(10, 1, 'electron'),
    row(11, 10, 'gpu'),
    row(12, 10, 'zygote'),
    row(13, 12, 'renderer'),
    row(20, 10, 'zsh'),
    row(21, 20, 'claude'),
    row(22, 21, 'node'),
    row(30, 10, 'mcp'),
    row(40, 1, 'unrelated'),
  ];
  const cpu = new Map([
    [21, 30],
    [22, 20],
    [10, 5],
  ]);
  const groups = groupProcesses({
    rows,
    cpu,
    ptys: [{ agentId: 'a1', taskId: 't1', isShell: false, pid: 20 }],
    appProcesses: new Map([
      [10, 'Browser'],
      [11, 'GPU'],
      [13, 'Tab'],
    ]),
    mainPid: 10,
  });
  const pids = (kind: string) =>
    groups
      .find((g) => g.kind === kind)
      ?.processes.map((p) => p.pid)
      .sort((a, b) => a - b);

  it('sums an agent PTY with all of its descendants', () => {
    const agent = groups.find((g) => g.kind === 'agent');
    expect(pids('agent')).toEqual([20, 21, 22]);
    expect(agent?.cpuPercent).toBe(50);
    expect(agent?.memoryBytes).toBe((20 + 21 + 22) * 100);
    expect(agent?.processes[0].pid).toBe(21);
  });

  it('labels the app processes and collects the rest of the app tree as other', () => {
    expect(pids('app')).toEqual([10, 11, 13]);
    expect(groups.find((g) => g.kind === 'app')?.processes.map((p) => p.name)).toContain('GPU');
    expect(pids('other')).toEqual([12, 30]);
  });

  it('ignores processes outside the app and PTYs that already exited', () => {
    expect(groups.flatMap((g) => g.processes).some((p) => p.pid === 40)).toBe(false);
    const gone = groupProcesses({
      rows,
      cpu,
      ptys: [{ agentId: 'x', taskId: 't', isShell: true, pid: 999 }],
      appProcesses: new Map(),
      mainPid: 10,
    });
    expect(gone.some((g) => g.kind === 'shell')).toBe(false);
  });

  it('survives a process that is its own parent', () => {
    const looped = groupProcesses({
      rows: [row(0, 0, 'kernel_task'), row(5, 0, 'child')],
      cpu: new Map(),
      ptys: [],
      appProcesses: new Map(),
      mainPid: 0,
    });
    expect(looped.find((g) => g.kind === 'other')?.processes).toHaveLength(2);
  });
});
