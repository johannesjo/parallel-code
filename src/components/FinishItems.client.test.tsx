import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { sendPrompt } from '../store/tasks';
import { isAgentIdle } from '../store/taskStatus';
import type { Agent, Task } from '../store/types';
import { FinishItems } from './FinishItems';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('../store/persistence', () => ({ saveState: vi.fn(() => Promise.resolve()) }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn(() => Promise.resolve()) }));
vi.mock('../store/taskStatus', () => ({
  isAgentIdle: vi.fn(() => true),
  isAgentAskingQuestion: () => false,
}));

const task: Task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  branchName: 'task/task-1',
  worktreePath: '/repo/.worktrees/task-1',
  agentIds: ['agent-1'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  finishItems: { items: ['Remove the DEBUG_SYNC flag', 'Update the API docs'], publishedAt: 1 },
};

beforeEach(() => {
  // Cloned: the store writes through to the object it was given.
  setStore('tasks', reconcile({ 'task-1': structuredClone(task) }));
  setStore(
    'agents',
    reconcile({
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        status: 'running',
        def: { name: 'Claude Code' },
      } as Agent,
    }),
  );
});

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  setStore('tasks', reconcile({}));
  setStore('agents', reconcile({}));
  vi.clearAllMocks();
  vi.mocked(isAgentIdle).mockReturnValue(true);
});

function mount(onSent = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <FinishItems task={store.tasks['task-1'] as Task} onSent={onSent} />,
    host,
  );
  return onSent;
}

function button(): HTMLButtonElement {
  const found = document.querySelector('button');
  if (!found) throw new Error('No button');
  return found;
}

function checkbox(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll('label')].find((el) =>
    el.textContent?.includes(label),
  );
  const input = found?.querySelector('input');
  if (!input) throw new Error(`No checkbox "${label}"`);
  return input;
}

const sentText = () => vi.mocked(sendPrompt).mock.calls[0]?.[2] ?? '';

it('shows nothing when the agent recorded no loose ends', () => {
  setStore('tasks', 'task-1', 'finishItems', undefined);
  mount();
  expect(document.body.textContent).toBe('');
});

it('sends every item, ticked by default, to the main agent and steps aside', async () => {
  const onSent = mount();
  expect(checkbox('DEBUG_SYNC').checked).toBe(true);
  expect(button().textContent).toBe('Send to Claude Code');
  button().click();
  await vi.waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', expect.any(String), {
    appPrompt: true,
  });
  expect(sentText()).toContain('- Remove the DEBUG_SYNC flag\n- Update the API docs');
  expect(store.tasks['task-1'].finishItems?.sentAt).toEqual(expect.any(Number));
});

it('leaves out unticked items and disables the send when none are kept', async () => {
  const onSent = mount();
  checkbox('API docs').click();
  button().click();
  await vi.waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(sentText()).toContain('- Remove the DEBUG_SYNC flag');
  expect(sentText()).not.toContain('API docs');
  checkbox('DEBUG_SYNC').click();
  expect(button().disabled).toBe(true);
});

it('holds the send while the agent is working', () => {
  vi.mocked(isAgentIdle).mockReturnValue(false);
  mount();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('The agent is busy');
  expect(button().disabled).toBe(true);
});

it('says the list was sent and offers to send it again', () => {
  setStore('tasks', 'task-1', 'finishItems', 'sentAt', 2);
  mount();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Sent to Claude Code');
  expect(button().textContent).toBe('Send again');
});
