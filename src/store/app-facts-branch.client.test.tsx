import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: '+a\n', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));

import { appFactCard } from '../lib/app-facts';
import { cardTaskState, refreshBranchFacts } from './app-facts';
import { setStore, store } from './core';
import { refreshCodeFingerprint } from './task-diff';
import type { Task } from './types';

const MERGE = { behind: 0, conflicts: [], base: 'main', at: 5 };

beforeEach(() => {
  mockInvoke.mockReset();
  setStore('cardDefinitions', [appFactCard('branch-health', true), appFactCard('commits', true)]);
  setStore('tasks', {
    t1: {
      id: 't1',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: [],
      shellAgentIds: [],
      facts: { merge: MERGE, commits: { count: 2, at: 5 } },
    } as unknown as Task,
  });
});
afterEach(() => setStore('cardDefinitions', []));

const cardAt = (id: string) => cardTaskState(store.tasks.t1, 100).cards?.[id]?.at;

describe('refreshBranchFacts', () => {
  it('keeps the old facts and their time when neither read worked', async () => {
    mockInvoke.mockRejectedValue(new Error('index.lock exists'));
    await refreshBranchFacts('t1');
    expect(store.tasks.t1.facts).toEqual({ merge: MERGE, commits: { count: 2, at: 5 } });
  });

  it('reads where origin stands when only the remote-branch card is on', async () => {
    setStore('cardDefinitions', [appFactCard('remote-branch', true)]);
    mockInvoke.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
      remote: 'unpushed',
    });
    await refreshBranchFacts('t1');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe('check_merge_status');
    expect(store.tasks.t1.facts?.merge?.remote).toBe('unpushed');
    expect(store.tasks.t1.facts?.merge).not.toHaveProperty('remoteDivergence');
    const status = cardTaskState(store.tasks.t1, 100).cards?.['remote-branch']?.values.status;
    expect(status).toEqual({
      type: 'status',
      rows: [{ state: 'unknown', text: 'Not on origin yet' }],
    });
  });

  it('keeps how far the branch and origin are apart', async () => {
    setStore('cardDefinitions', [appFactCard('remote-branch', true)]);
    mockInvoke.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
      remote: 'differs',
      remote_divergence: { ahead: 3, behind: 0 },
    });
    await refreshBranchFacts('t1');
    const status = cardTaskState(store.tasks.t1, 100).cards?.['remote-branch']?.values.status;
    expect(status).toEqual({
      type: 'status',
      rows: [{ state: 'unknown', text: '3 commits not pushed' }],
    });
  });

  it('dates each fact by its own read, so a newer diff or commit count does not freshen old merge facts', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'check_merge_status'
        ? Promise.reject(new Error('index.lock exists'))
        : Promise.resolve([{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }]),
    );
    await refreshBranchFacts('t1');
    await refreshCodeFingerprint('t1');
    expect(cardAt('branch-health')).toBe(5);
    expect(cardAt('commits')).toBeGreaterThan(5);
    expect(store.tasks.t1.facts?.commits?.count).toBe(3);
  });
});
