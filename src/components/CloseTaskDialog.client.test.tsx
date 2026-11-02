import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { boardSidePanelOpen } from '../store/project-pages';
import { closeTask } from '../store/store';
import { sendPrompt } from '../store/tasks';
import type { Agent, Task } from '../store/types';
import { CloseTaskDialog } from './CloseTaskDialog';
import { closeRetroPrompt } from './RetroButton';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../store/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/store')>()),
  armSpCompletion: vi.fn(),
  closeTask: vi.fn(),
}));
vi.mock('../store/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/tasks')>()),
  sendPrompt: vi.fn(() => Promise.resolve()),
}));
vi.mock('../store/taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/taskStatus')>()),
  isAgentIdle: () => true,
  isAgentAskingQuestion: () => false,
}));

const task: Task = {
  id: 'shown',
  name: 'Shown task',
  projectId: 'web',
  branchName: 'shown',
  worktreePath: '/repo',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'direct',
};

let dispose: (() => void) | undefined;

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
}

function openDialog(shown: Task = task, onDone = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <CloseTaskDialog open task={shown} onDone={onDone} />, host);
  return onDone;
}

function confirmClose(): void {
  openDialog();
  button('Close')?.click();
}

beforeEach(() => {
  setStore('tasks', 'shown', task);
  setStore({ boardView: true, boardPeek: true, showNewTaskPanel: false });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  setStore({ boardView: false, boardPeek: false, activeTaskId: null });
  setStore('agents', {});
  vi.mocked(closeTask).mockClear();
  vi.mocked(sendPrompt).mockClear();
});

it('closes the board side panel at once when its task is closed', () => {
  setStore('activeTaskId', 'shown');
  confirmClose();
  expect(closeTask).toHaveBeenCalledWith('shown');
  expect(boardSidePanelOpen()).toBe(false);
});

it('leaves the side panel open when another task is closed', () => {
  setStore('activeTaskId', 'other');
  confirmClose();
  expect(closeTask).toHaveBeenCalledWith('shown');
  expect(boardSidePanelOpen()).toBe(true);
});

it('offers no retro when the task has no running agent', () => {
  openDialog();
  expect(button('Retro')).toBeUndefined();
});

it('sends the close retro to the running agent and keeps the task open', async () => {
  const withAgent: Task = {
    ...task,
    agentIds: ['agent-1'],
    gitIsolation: 'worktree',
    worktreePath: '/repo/.worktrees/shown',
  };
  setStore('tasks', 'shown', withAgent);
  setStore('agents', 'agent-1', {
    id: 'agent-1',
    taskId: 'shown',
    status: 'running',
    def: { name: 'Claude Code' },
  } as Agent);
  const onDone = openDialog(withAgent);

  button('Retro')?.click();
  button('Send to Claude Code')?.click();

  await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(sendPrompt).toHaveBeenCalledWith('shown', 'agent-1', closeRetroPrompt(true), {
    appPrompt: true,
  });
  expect(closeTask).not.toHaveBeenCalled();
});
