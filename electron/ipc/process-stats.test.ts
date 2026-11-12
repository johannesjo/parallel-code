import { describe, expect, it } from 'vitest';
import {
  createCpuSampler,
  groupProcesses,
  parseProcStat,
  parsePsOutput,
  type ProcRow,
} from './process-stats.js';

function stat(
  pid: number,
  name: string,
  ppid: number,
  utime: number,
  stime: number,
  rss: number,
  cutime = 0,
  cstime = 0,
) {
  // Fields 3..24 of /proc/<pid>/stat; only ppid, utime, stime, cutime, cstime,
  // starttime and rss matter here.
  const rest = [
    ...['S', ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, utime, stime, cutime, cstime],
    ...[0, 0, 0, 0, 777, 0, rss],
  ];
  return `${pid} (${name}) ${rest.join(' ')} 0 0\n`;
}

describe('parseProcStat', () => {
  it('reads ppid, cpu seconds and resident memory', () => {
    expect(parseProcStat(stat(42, 'node', 7, 150, 50, 1000))).toEqual({
      pid: 42,
      ppid: 7,
      name: 'node',
      cpuSeconds: 2,
      childCpuSeconds: 0,
      startTicks: 777,
      memoryBytes: 1000 * 4096,
    });
  });

  it('reads the CPU of the children it has reaped (cutime + cstime)', () => {
    expect(parseProcStat(stat(42, 'bash', 7, 0, 0, 1, 230, 70))?.childCpuSeconds).toBe(3);
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
    const sampler = createCpuSampler();
    const sample = (rows: ProcRow[], at: number) => sampler(rows, at).cpu;
    expect(sample([row(10)], 0).get(1)).toBe(0);
    expect(sample([row(11)], 2000).get(1)).toBe(50);
  });

  it('counts a reused pid as the new process, not as a difference from the old one', () => {
    const sampler = createCpuSampler();
    const sample = (rows: ProcRow[], at: number) => sampler(rows, at).cpu;
    sample([row(100)], 0);
    expect(sample([row(1, 2)], 2000).get(1)).toBe(50);
    expect(sample([row(2, 2)], 4000).get(1)).toBe(50);
  });

  it('counts all the CPU of a process that started since the previous sample', () => {
    const sampler = createCpuSampler();
    const sample = (rows: ProcRow[], at: number) => sampler(rows, at).cpu;
    sample([], 0);
    expect(sample([row(0.5)], 2000).get(1)).toBe(25);
  });

  it('passes ready-made percentages through', () => {
    const sampler = createCpuSampler();
    const sample = (rows: ProcRow[], at: number) => sampler(rows, at).cpu;
    const rows = [{ pid: 3, ppid: 0, name: 'b', memoryBytes: 0, cpuPercent: 12 }];
    expect(sample(rows, 0).get(3)).toBe(12);
  });
});

describe('createCpuSampler: commands that exit between samples', () => {
  // 1 → shell(20) → its commands. Seconds: own CPU, then reaped children's CPU.
  const proc = (pid: number, ppid: number, cpu: number, child = 0, start = pid): ProcRow => ({
    pid,
    ppid,
    name: `p${pid}`,
    memoryBytes: 0,
    cpuSeconds: cpu,
    childCpuSeconds: child,
    startTicks: start,
  });
  const init = proc(1, 0, 0);

  it('credits a child that started and exited within one interval to its parent', () => {
    const sample = createCpuSampler();
    sample([init, proc(20, 1, 0)], 0);
    const { cpu, exitedCpu } = sample([init, proc(20, 1, 0, 1)], 2000);
    expect(cpu.get(20)).toBe(0);
    expect(exitedCpu?.get(20)).toBe(50);
  });

  it('counts a child seen alive once: its last interval when it exits, not its whole life', () => {
    const sample = createCpuSampler();
    sample([init, proc(20, 1, 0), proc(30, 20, 1)], 0);
    const alive = sample([init, proc(20, 1, 0), proc(30, 20, 2)], 2000);
    expect(alive.cpu.get(30)).toBe(50);
    expect(alive.exitedCpu?.get(20)).toBe(0);
    // It used 0.5 s more before exiting; the shell reaped all 2.5 s.
    const gone = sample([init, proc(20, 1, 0, 2.5)], 4000);
    expect(gone.exitedCpu?.get(20)).toBeCloseTo(25);
  });

  it('subtracts a seen grandchild that exited and was reaped along with its parent', () => {
    const sample = createCpuSampler();
    // shell(20) → make(30) → cc(31); make had already reaped 1 s of other jobs.
    sample([init, proc(20, 1, 0), proc(30, 20, 1, 1), proc(31, 30, 2)], 0);
    // make used 0.2 s more, cc 0.4 s more; make reaped cc and the shell reaped make.
    const { exitedCpu } = sample([init, proc(20, 1, 0, 1.2 + 1 + 2.4)], 2000);
    expect(exitedCpu?.get(20)).toBeCloseTo(30);
  });

  it('tells a child apart from a new one that reused its pid', () => {
    const sample = createCpuSampler();
    sample([init, proc(20, 1, 0), proc(30, 20, 1, 0, 100)], 0);
    // The old 30 used 0.2 s more and was reaped; a new 30 has used 0.4 s so far.
    const { cpu, exitedCpu } = sample([init, proc(20, 1, 0, 1.2), proc(30, 20, 0.4, 0, 200)], 2000);
    expect(exitedCpu?.get(20)).toBeCloseTo(10);
    expect(cpu.get(30)).toBeCloseTo(20);
  });

  it('counts nothing twice while the parent has not reaped an exited child yet', () => {
    const sample = createCpuSampler();
    sample([init, proc(20, 1, 0), proc(30, 20, 1)], 0);
    // 30 exited after 0.5 s more and waits as a zombie: still listed, not reaped.
    const zombie = sample([init, proc(20, 1, 0), proc(30, 20, 1.5)], 2000);
    expect(zombie.cpu.get(30)).toBe(25);
    expect(zombie.exitedCpu?.get(20)).toBe(0);
    const reaped = sample([init, proc(20, 1, 0, 1.5)], 4000);
    expect(reaped.exitedCpu?.get(20)).toBe(0);
  });

  it('never goes negative when an exited child was reaped elsewhere', () => {
    const sample = createCpuSampler();
    sample([init, proc(20, 1, 0), proc(30, 20, 1)], 0);
    expect(sample([init, proc(20, 1, 0)], 2000).exitedCpu?.get(20)).toBe(0);
  });

  it('counts the reaped CPU of a process that started since the previous sample', () => {
    const sample = createCpuSampler();
    sample([init], 0);
    expect(sample([init, proc(20, 1, 0, 0.6)], 2000).exitedCpu?.get(20)).toBeCloseTo(30);
  });

  it('reports nothing where the table carries no reaped-children CPU', () => {
    const sample = createCpuSampler();
    const rows = [{ pid: 3, ppid: 0, name: 'b', memoryBytes: 0, cpuPercent: 12 }];
    expect(sample(rows, 0).exitedCpu).toBeUndefined();
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

  it('adds finished commands to the group of the parent that reaped them', () => {
    const withExited = groupProcesses({
      rows,
      cpu,
      // claude(21) reaped hooks; main(10) reaped git; the GPU process reaped nothing.
      exitedCpu: new Map([
        [21, 15],
        [10, 7],
        [11, 0],
      ]),
      ptys: [{ agentId: 'a1', taskId: 't1', isShell: false, pid: 20 }],
      appProcesses: new Map([[10, 'Browser']]),
      mainPid: 10,
    });
    const find = (kind: string) => withExited.find((g) => g.kind === kind);
    expect(find('agent')?.exitedCpuPercent).toBe(15);
    expect(find('agent')?.cpuPercent).toBe(65);
    expect(find('app')?.exitedCpuPercent).toBe(0);
    expect(find('other')?.exitedCpuPercent).toBe(7);
    expect(groups.some((g) => 'exitedCpuPercent' in g)).toBe(false);
  });

  it('keeps a group whose only CPU came from finished commands', () => {
    const onlyExited = groupProcesses({
      rows: [row(10, 1, 'electron')],
      cpu: new Map(),
      exitedCpu: new Map([[10, 3]]),
      ptys: [],
      appProcesses: new Map([[10, 'Browser']]),
      mainPid: 10,
    });
    expect(onlyExited.find((g) => g.kind === 'other')).toMatchObject({
      cpuPercent: 3,
      processes: [],
    });
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
