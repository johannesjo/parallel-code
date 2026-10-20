import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackage } from '../../electron/shared/evidence';

const { statusHolder, mockBuild, mockNotify } = vi.hoisted(() => ({
  statusHolder: { set: (_status: Record<string, string>): void => undefined },
  mockBuild: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock('./taskStatus', async () => {
  const { createSignal } = await import('solid-js');
  const [status, setStatus] = createSignal<Record<string, string>>({});
  statusHolder.set = setStatus;
  return { getTaskDotStatus: (id: string) => status()[id] ?? 'waiting' };
});
vi.mock('./evidence', () => ({ buildEvidence: mockBuild }));
vi.mock('./notification', () => ({ showNotification: mockNotify, NOTIFICATION_ERROR_MS: 10_000 }));

import { setStore, store } from './core';
import { AUTO_BUILD_SETTLE_MS, startEvidenceAutoBuild } from './evidence-auto';
import type { Project, Task } from './types';

let stop: (() => void) | undefined;
let status: Record<string, string> = {};
const setStatus = (next: Record<string, string>) => {
  status = { ...status, ...next };
  statusHolder.set(status);
};

function task(id: string): Task {
  return {
    id,
    name: `Task ${id}`,
    projectId: 'p1',
    branchName: `task/${id}`,
    worktreePath: `/repo/.worktrees/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function pkg(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    id: 'auto-1',
    createdAt: 'x',
    trigger: 'auto',
    assembling: false,
    scan: {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      dirty: false,
      files: [],
      flags: [],
      tests: [],
      coveringTests: [],
      sourceWithoutTests: [],
    },
    checks: [],
    skipped: [],
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

async function finishTurn(...ids: string[]) {
  setStatus(Object.fromEntries(ids.map((id) => [id, 'busy'])));
  setStatus(Object.fromEntries(ids.map((id) => [id, 'ready'])));
  await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockBuild.mockResolvedValue(undefined);
  status = {};
  statusHolder.set({});
  setStore('projects', [
    { id: 'p1', name: 'Repo', path: '/repo', color: '', evidenceAutoBuild: true } as Project,
  ]);
  setStore('tasks', { t1: task('t1'), t2: task('t2') });
  stop = startEvidenceAutoBuild();
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe('startEvidenceAutoBuild', () => {
  it('builds once a task has stayed idle after a turn', async () => {
    setStatus({ t1: 'busy' });
    setStatus({ t1: 'ready' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS - 1);
    expect(mockBuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockBuild).toHaveBeenCalledWith('t1', { trigger: 'auto' });
  });

  it('waits again when the agent picks work back up', async () => {
    setStatus({ t1: 'busy' });
    setStatus({ t1: 'ready' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS / 2);
    setStatus({ t1: 'busy' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('does nothing unless the project turned it on', async () => {
    setStore('projects', 0, 'evidenceAutoBuild', undefined);
    await finishTurn('t1');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('runs one background build at a time across tasks', async () => {
    let release: (() => void) | undefined;
    mockBuild.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await finishTurn('t1', 't2');
    expect(mockBuild.mock.calls.map(([id]) => id)).toEqual(['t1']);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockBuild.mock.calls.map(([id]) => id)).toEqual(['t1', 't2']);
  });

  it('removes queued work when an agent resumes and waits for a new idle period', async () => {
    let release: (() => void) | undefined;
    mockBuild.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await finishTurn('t1', 't2');
    setStatus({ t2: 'busy' });
    setStatus({ t2: 'ready' });
    release?.();
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS - 1);
    expect(mockBuild.mock.calls.map(([id]) => id)).toEqual(['t1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockBuild.mock.calls.map(([id]) => id)).toEqual(['t1', 't2']);
  });

  it('notifies only when a background build finds a problem', async () => {
    const failed = {
      checkId: 'verify',
      name: 'Verify',
      kind: 'custom' as const,
      command: 'npm run check',
      status: 'failed' as const,
      exitCode: 1,
      headSha: 'a'.repeat(40),
      dirty: false,
      startedAt: 'x',
      finishedAt: 'y',
      outputTail: '',
    };
    mockBuild.mockImplementationOnce(async (id: string) => {
      setStore('tasks', id, 'evidence', pkg());
    });
    mockBuild.mockImplementationOnce(async (id: string) => {
      setStore('tasks', id, 'evidence', pkg({ id: 'auto-2', checks: [failed] }));
    });
    await finishTurn('t1');
    expect(store.tasks.t1.evidence?.id).toBe('auto-1');
    expect(mockNotify).not.toHaveBeenCalled();
    await finishTurn('t1');
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining('Task t1'), expect.anything());
  });
});
