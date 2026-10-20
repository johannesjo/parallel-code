import { describe, expect, it } from 'vitest';
import type { ResourceGroup } from '../ipc/types';
import { formatBytes, formatCpu, groupLabel, snapshotTotals } from './resources-format';

const group = (over: Partial<ResourceGroup>): ResourceGroup => ({
  kind: 'agent',
  agentId: 'a1',
  taskId: 't1',
  cpuPercent: 0,
  memoryBytes: 0,
  processes: [],
  ...over,
});

const source = {
  tasks: { t1: { name: 'Fix login' } },
  agents: { a1: { def: { name: 'Claude Code' } } },
  terminals: { term: { name: 'Terminal 1', agentId: 's9' } },
};

describe('groupLabel', () => {
  it('names agents and shells after their task', () => {
    expect(groupLabel(group({}), source)).toBe('Fix login · Claude Code');
    expect(groupLabel(group({ kind: 'shell', agentId: 's1' }), source)).toBe('Fix login · shell');
  });

  it('falls back to a standalone terminal name, then to a closed task', () => {
    expect(groupLabel(group({ kind: 'shell', agentId: 's9', taskId: 'x' }), source)).toBe(
      'Terminal 1 · shell',
    );
    expect(groupLabel(group({ agentId: 'zz', taskId: 'gone' }), source)).toBe(
      'Closed task · agent',
    );
  });

  it('names the app groups', () => {
    expect(groupLabel(group({ kind: 'app' }), source)).toBe('Parallel Code');
    expect(groupLabel(group({ kind: 'other' }), source)).toBe('Other subprocesses');
  });
});

describe('formatters', () => {
  it('formats cpu and memory', () => {
    expect(formatCpu(3.456, 1)).toBe('3.5%');
    expect(formatCpu(123.4, 1)).toBe('123%');
    // Shown as a share of the whole machine: four busy cores of 24.
    expect(formatCpu(400, 24)).toBe('17%');
    expect(formatCpu(24, 24)).toBe('1.0%');
    expect(formatBytes(300 * 1024 ** 2)).toBe('300 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('snapshotTotals', () => {
  it('sums cpu and memory over all groups', () => {
    const snapshot = {
      groups: [group({ cpuPercent: 10, memoryBytes: 5 }), group({ cpuPercent: 2, memoryBytes: 1 })],
      cpuCount: 4,
      totalMemoryBytes: 0,
      sampledAt: 0,
    };
    expect(snapshotTotals(snapshot)).toEqual({ cpuPercent: 12, memoryBytes: 6 });
  });
});
