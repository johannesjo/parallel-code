import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { sendPrompt } from '../store/tasks';
import { isAgentIdle } from '../store/taskStatus';
import type { Agent, Task } from '../store/types';
import { RETRO_PROMPT, RetroButton, closeRetroPrompt } from './RetroButton';

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
};

beforeEach(() => {
  setStore('tasks', reconcile({ 'task-1': task }));
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

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

function statusText(): string {
  return document.querySelector('[role="status"]')?.textContent ?? '';
}

function openRetro(onSent = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <RetroButton task={store.tasks['task-1'] as Task} onSent={onSent} />,
    host,
  );
  button('Retro').click();
  return onSent;
}

it('names the main agent before sending the retro prompt to it', async () => {
  const onSent = openRetro();
  expect(document.body.textContent).toContain("to Claude Code, this task's main agent");
  expect(sendPrompt).not.toHaveBeenCalled();

  button('Send to Claude Code').click();
  await vi.waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', RETRO_PROMPT, { appPrompt: true });
});

it('holds the send while the agent is working', () => {
  vi.mocked(isAgentIdle).mockReturnValue(false);
  openRetro();
  expect(statusText()).toContain('The agent is busy');
  expect(button('Send to Claude Code').disabled).toBe(true);
});

it('holds the send while the task input has an unsent draft', () => {
  setStore('tasks', 'task-1', 'promptDraft', 'half-written message');
  openRetro();
  expect(statusText()).toContain('Your draft in the task prompt is unsent');
  button('Send to Claude Code').click();
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('keeps keyboard focus when the confirmation opens and closes', () => {
  openRetro();
  expect(document.activeElement).toBe(button('Cancel'));
  button('Cancel').click();
  expect(document.activeElement).toBe(button('Retro'));
});

it('warns the close retro about the deleted worktree only when close deletes it', () => {
  expect(closeRetroPrompt(true)).toContain('worktree will be deleted');
  expect(closeRetroPrompt(false)).not.toContain('worktree will be deleted');
  expect(closeRetroPrompt(false)).toContain('before the task is closed');
});
