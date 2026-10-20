import type { ResourceGroup, ResourceSnapshot } from '../ipc/types';

/** The store fields needed to name a PTY group. */
export interface GroupNameSource {
  tasks: Record<string, { name: string } | undefined>;
  agents: Record<string, { def: { name: string } } | undefined>;
  terminals: Record<string, { name: string; agentId: string } | undefined>;
}

/** Stable identity of a group across samples. */
export function groupKey(group: ResourceGroup): string {
  return `${group.kind}:${group.agentId ?? ''}`;
}

/** Human label for a group: the task (or terminal) plus what runs in it. */
export function groupLabel(group: ResourceGroup, source: GroupNameSource): string {
  if (group.kind === 'app') return 'Parallel Code';
  if (group.kind === 'other') return 'Other subprocesses';
  const task = group.taskId ? source.tasks[group.taskId] : undefined;
  const terminal = Object.values(source.terminals).find((t) => t?.agentId === group.agentId);
  const owner = task?.name ?? terminal?.name ?? 'Closed task';
  const agentName = group.agentId ? source.agents[group.agentId]?.def.name : undefined;
  const what = group.kind === 'shell' ? 'shell' : (agentName ?? 'agent');
  return `${owner} · ${what}`;
}

/**
 * Share of the whole machine. The backend reports percent of one core (top's
 * convention), which reads as 2400% on a busy 24-core machine.
 */
export function cpuShare(percentOfOneCore: number, cpuCount: number): number {
  return percentOfOneCore / Math.max(1, cpuCount);
}

export function formatCpu(percentOfOneCore: number, cpuCount: number): string {
  const share = cpuShare(percentOfOneCore, cpuCount);
  return `${share < 10 ? share.toFixed(1) : Math.round(share)}%`;
}

/** Everything the app and its agents use, summed over all groups. */
export function snapshotTotals(snapshot: ResourceSnapshot): {
  cpuPercent: number;
  memoryBytes: number;
} {
  return snapshot.groups.reduce(
    (sum, group) => ({
      cpuPercent: sum.cpuPercent + group.cpuPercent,
      memoryBytes: sum.memoryBytes + group.memoryBytes,
    }),
    { cpuPercent: 0, memoryBytes: 0 },
  );
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
