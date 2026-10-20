// Runs over the real store in the client config; only IPC and saving are mocked.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore } from './core';
import { addAgentToTask } from './agents';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from './ui';
import type { AgentDef } from '../ipc/types';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  saveState: vi.fn(async () => undefined),
}));

const codex: AgentDef = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
};

const task: Task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  branchName: 'task/panes',
  worktreePath: '/tmp/task',
  agentIds: ['agent-1'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};

const columnWidth = () => getPanelUserSize('tiling:task-1');

beforeEach(() => {
  setStore('tasks', 'task-1', {
    ...task,
    // A fresh agent list per test: the store pushes into the array it is given.
    agentIds: [...task.agentIds],
    // Setting a task merges, so the keys the tests add have to be cleared here.
    aiTerminalLayout: undefined,
    canvasOpen: undefined,
  });
});

afterEach(() => {
  deletePanelUserSize(['tiling:task-1', 'task:task-1:canvas-cols:canvas']);
});

it('widens the column so a second terminal and its neighbour each stay workable', async () => {
  await addAgentToTask('task-1', codex);
  expect(columnWidth()).toBe(2 * 420);

  await addAgentToTask('task-1', codex);
  expect(columnWidth()).toBe(3 * 420);
});

it('leaves a column the user already made wide enough alone', async () => {
  setPanelUserSize('tiling:task-1', 1000);
  await addAgentToTask('task-1', codex);
  expect(columnWidth()).toBe(1000);
});

it('pays for the open canvas on top of the terminal panes', async () => {
  setStore('tasks', 'task-1', 'canvasOpen', true);
  setPanelUserSize('tiling:task-1', 520 + 400);
  await addAgentToTask('task-1', codex);
  expect(columnWidth()).toBe(2 * 420 + 400);
});

it('leaves the column alone when the panes are stacked as tabs', async () => {
  setStore('tasks', 'task-1', 'aiTerminalLayout', 'tabs');
  await addAgentToTask('task-1', codex);
  expect(columnWidth()).toBeUndefined();
});
