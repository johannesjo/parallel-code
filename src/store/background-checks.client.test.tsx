import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { statusHolder, mockNotify, verify } = vi.hoisted(() => ({
  statusHolder: { set: (_status: Record<string, string>): void => undefined },
  mockNotify: vi.fn(),
  verify: { enabled: vi.fn(), run: vi.fn(), cancel: vi.fn() },
}));

vi.mock('./taskStatus', async () => {
  const { createSignal } = await import('solid-js');
  const [status, setStatus] = createSignal<Record<string, string>>({});
  statusHolder.set = setStatus;
  return { getTaskDotStatus: (id: string) => status()[id] ?? 'waiting' };
});
vi.mock('./verification', () => ({
  backgroundVerifyEnabled: verify.enabled,
  runBackgroundVerify: verify.run,
  cancelBackgroundVerify: verify.cancel,
}));
vi.mock('./notification', () => ({ showNotification: mockNotify, NOTIFICATION_ERROR_MS: 10_000 }));

import { setStore } from './core';
import { AUTO_BUILD_SETTLE_MS, startBackgroundChecks } from './background-checks';
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

async function finishTurn(...ids: string[]) {
  setStatus(Object.fromEntries(ids.map((id) => [id, 'busy'])));
  setStatus(Object.fromEntries(ids.map((id) => [id, 'ready'])));
  await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  verify.enabled.mockReturnValue(true);
  verify.run.mockResolvedValue(undefined);
  status = {};
  statusHolder.set({});
  setStore('projects', [{ id: 'p1', name: 'Repo', path: '/repo', color: '' } as Project]);
  setStore('tasks', { t1: task('t1'), t2: task('t2') });
  stop = startBackgroundChecks();
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe('startBackgroundChecks', () => {
  it('verifies once a task has stayed idle after a turn', async () => {
    setStatus({ t1: 'busy' });
    setStatus({ t1: 'ready' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS - 1);
    expect(verify.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(verify.run).toHaveBeenCalledWith('t1', expect.any(Function));
    // The run asks again once its scan is back; a busy agent stops it.
    const stillIdle = verify.run.mock.calls[0]?.[1] as () => boolean;
    expect(stillIdle()).toBe(true);
    setStatus({ t1: 'busy' });
    expect(stillIdle()).toBe(false);
  });

  it('waits again when the agent picks work back up', async () => {
    setStatus({ t1: 'busy' });
    setStatus({ t1: 'ready' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS / 2);
    setStatus({ t1: 'busy' });
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS);
    expect(verify.run).not.toHaveBeenCalled();
  });

  it('does nothing unless the project turned it on', async () => {
    verify.enabled.mockReturnValue(false);
    await finishTurn('t1');
    expect(verify.run).not.toHaveBeenCalled();
  });

  it('runs one background verify at a time across tasks', async () => {
    let release: (() => void) | undefined;
    verify.run.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await finishTurn('t1', 't2');
    expect(verify.run.mock.calls.map(([id]) => id)).toEqual(['t1']);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(verify.run.mock.calls.map(([id]) => id)).toEqual(['t1', 't2']);
  });

  it('removes queued work when an agent resumes and waits for a new idle period', async () => {
    let release: (() => void) | undefined;
    verify.run.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await finishTurn('t1', 't2');
    setStatus({ t2: 'busy' });
    setStatus({ t2: 'ready' });
    release?.();
    await vi.advanceTimersByTimeAsync(AUTO_BUILD_SETTLE_MS - 1);
    expect(verify.run.mock.calls.map(([id]) => id)).toEqual(['t1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(verify.run.mock.calls.map(([id]) => id)).toEqual(['t1', 't2']);
  });

  it('stops a background verify when the agent starts working again', async () => {
    setStatus({ t1: 'busy' });
    expect(verify.cancel).toHaveBeenCalledWith('t1');
  });

  it('notifies when a background verify fails', async () => {
    verify.run.mockResolvedValueOnce({ status: 'passed' });
    await finishTurn('t1');
    expect(mockNotify).not.toHaveBeenCalled();
    verify.run.mockResolvedValueOnce({ status: 'failed' });
    await finishTurn('t1');
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Task t1: verify failed'),
      expect.anything(),
    );
  });
});
