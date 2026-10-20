import { afterEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { initMCPListeners } from './tasks';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('./delegation', () => ({
  delegationRequest: vi.fn(),
  registerTaskAuthority: vi.fn(),
  applyDelegationChange: vi.fn(),
  startDelegationStateHydration: () => () => {},
  startPeerMessageDelivery: () => () => {},
  delegationStates: {},
}));

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  setStore('tasks', reconcile({}));
  vi.unstubAllGlobals();
});

it('replaces completion packets using the real browser Solid store without retaining optional data', () => {
  const handlers = new Map<string, (data: unknown) => void>();
  vi.stubGlobal('electron', {
    ipcRenderer: {
      on: (channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  });
  setStore(
    'tasks',
    reconcile({
      child: {
        id: 'child',
        name: 'Child',
        projectId: 'project',
        branchName: 'task/child',
        worktreePath: '/repo/child',
        gitIsolation: 'worktree',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    }),
  );
  cleanup = initMCPListeners();
  const sync = handlers.get(IPC.MCP_TaskStateSync);
  if (!sync) throw new Error('Task state sync handler not registered');
  const completion = {
    id: '11111111-1111-4111-8111-111111111111',
    completedAt: '2026-09-26T10:00:00.000Z',
    reviewRevision: 1,
    snapshotState: 'unknown',
  };
  sync({
    taskId: 'child',
    completion: {
      ...completion,
      sourceCommit: 'a'.repeat(40),
      result: {
        summary: 'Old report',
        artifacts: [{ path: 'old.txt' }],
        unresolvedIssues: ['Old issue'],
      },
    },
  });
  expect(store.tasks.child.completion?.result?.artifacts).toHaveLength(1);
  sync({ taskId: 'child', completion: { ...completion, result: { summary: 'New report' } } });
  expect(store.tasks.child.completion?.sourceCommit).toBeUndefined();
  expect(store.tasks.child.completion?.result).toEqual({ summary: 'New report' });
  sync({ taskId: 'child', completion });
  expect(store.tasks.child.completion).toEqual(completion);
  sync({ taskId: 'child', completion: null });
  sync({ taskId: 'child', needsReview: false });
  expect(store.tasks.child.completion).toBeUndefined();
});
