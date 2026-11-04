import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskRowShell } from './Sidebar';
import { store, setStore } from '../store/core';
import { bringTaskToFront, isTaskBackgrounded } from '../store/background-tasks';
import { invoke } from '../lib/ipc';
import type { Task } from '../store/types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const task: Task = {
  id: 'one',
  name: 'one',
  projectId: 'project',
  branchName: 'one',
  worktreePath: '/tmp/one',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  baseBranch: 'main',
};

let container: HTMLDivElement;
let dispose: () => void;
const onClick = vi.fn();
const onListKeyDown = vi.fn();

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  onClick.mockClear();
  onListKeyDown.mockClear();
  bringTaskToFront('one');
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      // Stands in for the sidebar's task list, which handles Enter for the focused row.
      <div onKeyDown={onListKeyDown}>
        <TaskRowShell
          taskId="one"
          class="task-item"
          onClick={onClick}
          fontSize="13px"
          cursor="pointer"
          opacity="1"
        >
          one
        </TaskRowShell>
      </div>
    ),
    container,
  );
});

afterEach(() => {
  dispose();
  container.remove();
  setStore('pendingAction', null);
});

const rightClick = () =>
  container
    .querySelector('.task-item')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));

const labels = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );

it('offers the task menu on a sidebar row, without the board-only side switch', () => {
  rightClick();
  expect(labels()).toEqual([
    'Open',
    'Snooze until new activity',
    'Snooze · keep running',
    'Snooze · stop agents',
    'Minimize (stop agents)',
    'Finish and close',
    'Create pull request…',
    'Close',
  ]);
});

it('acts from the menu without also activating the row', () => {
  rightClick();
  menuItem('Snooze until new activity')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  menuItem('Snooze until new activity')?.click();
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(onClick).not.toHaveBeenCalled();
  expect(onListKeyDown).not.toHaveBeenCalled();
});

it('opens the task like a click on its row before requesting Finish', () => {
  rightClick();
  menuItem('Finish and close')?.click();
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(store.pendingAction).toEqual({ type: 'finish', taskId: 'one', closeAfter: true });
});

it('confirms Close without activating the row', () => {
  rightClick();
  menuItem('Close')?.click();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  expect(dialog).not.toBeNull();
  dialog?.click();
  expect(onClick).not.toHaveBeenCalled();
});
