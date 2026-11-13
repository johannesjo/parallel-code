import { produce } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { isAgentAskingQuestion } from '../store/taskStatus';
import type { Agent, Task } from '../store/types';
import { createTaskContextMenu } from './task-context-menu';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})), fireAndForget: vi.fn() }));
vi.mock('../store/taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/taskStatus')>()),
  isAgentAskingQuestion: vi.fn(() => false),
}));

let dispose: (() => void) | undefined;

function setup(agent: Partial<Agent> & { command?: string }, task: Partial<Task> = {}) {
  setStore(
    produce((s) => {
      s.agents['a1'] = {
        id: 'a1',
        taskId: 't1',
        def: { id: 'x', command: agent.command ?? 'claude' },
        status: agent.status ?? 'running',
        generation: 1,
        remoteControlGeneration: agent.remoteControlGeneration,
      } as unknown as Agent;
      s.tasks['t1'] = {
        id: 't1',
        name: 'Fix login',
        branchName: 'fix',
        agentIds: ['a1'],
        shellAgentIds: [],
        gitIsolation: 'direct',
        ...task,
      } as unknown as Task;
    }),
  );
}

function openMenu(): void {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => {
    const menu = createTaskContextMenu({ task: () => store.tasks['t1'], open: vi.fn() });
    return (
      <div class="row" onContextMenu={(e) => menu.onContextMenu(e)}>
        <menu.Menu />
      </div>
    );
  }, host);
  host
    .querySelector('.row')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
}

const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === label,
  );

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.mocked(isAgentAskingQuestion).mockReturnValue(false);
});

it('offers Remote Control and the cloud handoff for a running Claude agent', () => {
  setup({});
  openMenu();
  expect(item('Enable Remote Control')?.disabled).toBe(false);
  expect(item('Continue in cloud…')).toBeDefined();
  expect(item('Continue in cloud…')?.querySelector('svg')).not.toBeNull();
});

it('offers neither for another agent', () => {
  setup({ command: 'codex' });
  openMenu();
  expect(item('Enable Remote Control')).toBeUndefined();
  expect(item('Continue in cloud…')).toBeUndefined();
});

it('keeps the cloud handoff but not Remote Control once the agent exited', () => {
  setup({ status: 'exited' });
  openMenu();
  expect(item('Enable Remote Control')).toBeUndefined();
  expect(item('Continue in cloud…')).toBeDefined();
});

it('hides both for a Docker task, whose terminals have no claude.ai sign-in', () => {
  setup({}, { dockerMode: true });
  openMenu();
  expect(item('Enable Remote Control')).toBeUndefined();
  expect(item('Continue in cloud…')).toBeUndefined();
});

it('disables Remote Control while a draft or a question is in the agent terminal', () => {
  setup({}, { terminalInputPending: true });
  openMenu();
  expect(item('Enable Remote Control')?.disabled).toBe(true);
  dispose?.();
  document.body.replaceChildren();

  setup({});
  vi.mocked(isAgentAskingQuestion).mockReturnValue(true);
  openMenu();
  expect(item('Enable Remote Control')?.disabled).toBe(true);
});

it('offers the status panel once Remote Control was sent in this session', () => {
  setup({ remoteControlGeneration: 1 });
  openMenu();
  expect(item('Remote Control status…')).toBeDefined();
});
