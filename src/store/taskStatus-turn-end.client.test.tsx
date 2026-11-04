import { afterEach, expect, it, vi } from 'vitest';

// Client suite: the turn-end watcher is a Solid effect, which only re-runs
// under the browser build.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/ipc', () => ({ invoke: invokeMock }));

import { IPC } from '../../electron/ipc/channels';
import { applyAgentHookEvent } from './agentHookStatus';
import { setStore } from './core';
import { clearAgentActivity, startTaskStatusPolling, stopTaskStatusPolling } from './taskStatus';
import type { AgentDef } from '../ipc/types';
import type { Agent, Task } from './types';

const flush = () => new Promise((resolve) => setTimeout(resolve, 2));

function hookEvent(state: 'working' | 'done', event: string): void {
  applyAgentHookEvent({ agentId: 'agent', taskId: 'task', state, event, at: Date.now() });
}

function worktreeStatusCalls(): unknown[] {
  return invokeMock.mock.calls.filter(([channel]) => channel === IPC.GetWorktreeStatus);
}

afterEach(() => {
  stopTaskStatusPolling();
  clearAgentActivity('agent');
  invokeMock.mockReset();
  setStore('taskOrder', []);
  setStore('agents', 'agent', undefined as unknown as Agent);
  setStore('tasks', 'task', undefined as unknown as Task);
});

it('refreshes git status as soon as the agent finishes a turn', async () => {
  setStore('tasks', 'task', {
    id: 'task',
    name: 'task',
    projectId: 'project',
    branchName: 'task/task',
    worktreePath: '/tmp/worktrees/task',
    agentIds: ['agent'],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    baseBranch: 'main',
  });
  setStore('agents', 'agent', {
    id: 'agent',
    taskId: 'task',
    def: { name: 'Claude' } as AgentDef,
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  });
  setStore('taskOrder', ['task']);
  invokeMock.mockResolvedValue({
    has_committed_changes: true,
    has_uncommitted_changes: false,
    current_branch: 'task/task',
    base_branch: 'main',
  });
  hookEvent('working', 'UserPromptSubmit');
  startTaskStatusPolling();
  await flush();
  // The working task is skipped by the initial sweep.
  expect(worktreeStatusCalls()).toHaveLength(0);

  hookEvent('done', 'Stop');
  await flush();

  expect(worktreeStatusCalls()).toHaveLength(1);
});
