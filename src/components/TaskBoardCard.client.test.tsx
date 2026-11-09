import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskBoardCard } from './TaskBoardCard';
import { store, setStore } from '../store/core';
import { bringTaskToFront, isTaskBackgrounded } from '../store/background-tasks';
import { invoke } from '../lib/ipc';
import {
  extraPrWatchId,
  getTaskExtraPrs,
  markPrimaryPrClosed,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from '../store/pr-checks-state';
import { IPC } from '../../electron/ipc/channels';
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

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  bringTaskToFront('one');
  setStore('collapsedTaskOrder', []);
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <TaskBoardCard task={store.tasks.one} lane="working" />, container);
});

afterEach(() => {
  dispose();
  container.remove();
  for (const pr of getTaskExtraPrs('one')) removePrChecks(extraPrWatchId('one', pr.url));
  setTaskExtraPrs('one', []);
  removePrChecks('one');
  markPrimaryPrClosed('one', undefined);
});

const failingChecks: PrChecksState = {
  overall: 'failure',
  passing: 0,
  pending: 0,
  failing: 1,
  checks: [],
  checkedAt: '2026-10-10T00:00:00Z',
};

const rightClick = () =>
  container
    .querySelector('.task-board-card')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));

const labels = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );

it('opens a context menu on right-click that snoozes the task', () => {
  rightClick();
  expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Task one');
  expect(labels()).toEqual([
    'Open',
    'Open on the left',
    'Snooze until new activity',
    'Snooze · keep running',
    'Snooze · stop agents',
    'Minimize (stop agents)',
    'Finish and close',
    'Create pull request…',
    'Close',
  ]);
  menuItem('Snooze until new activity')?.click();
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();

  rightClick();
  menuItem('Restore to front')?.click();
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('offers only restore for a minimized task', () => {
  setStore('tasks', 'one', { collapsed: true });
  setStore('collapsedTaskOrder', ['one']);
  rightClick();
  expect(labels()).toEqual([
    'Open',
    'Open on the left',
    'Restore (start agents)',
    'Finish and close',
    'Create pull request…',
    'Close',
  ]);
  menuItem('Restore (start agents)')?.click();
  expect(store.tasks.one.collapsed).toBe(false);
});

it('offers no set-aside actions while the task closes', () => {
  setStore('tasks', 'one', { closingStatus: 'closing' });
  rightClick();
  expect(labels()).toEqual(['Open', 'Open on the left']);
});

it('asks Finish to close the task after merging from its menu', () => {
  rightClick();
  menuItem('Finish and close')?.click();
  expect(store.pendingAction).toEqual({ type: 'finish', taskId: 'one', closeAfter: true });
  setStore('pendingAction', null);
});

it('offers a plain Finish where the Finish dialog cannot delete the worktree', () => {
  setStore('tasks', 'one', { externalWorktree: true });
  rightClick();
  expect(labels()).not.toContain('Finish and close');
  menuItem('Finish')?.click();
  expect(store.pendingAction).toEqual({ type: 'finish', taskId: 'one', closeAfter: false });
  setStore('pendingAction', null);
});

it('opens the pull request in the browser from its menu', () => {
  setStore('tasks', 'one', { prUrl: 'https://github.com/o/r/pull/7' });
  rightClick();
  expect(labels().slice(0, 3)).toEqual(['Open', 'Open on the left', 'Open PR in browser']);
  menuItem('Open PR in browser')?.click();
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, {
    url: 'https://github.com/o/r/pull/7',
  });
  expect(labels()).not.toContain('Create pull request…');
});

it('shows the PR row of a task whose only PR is in a nested repository', () => {
  const url = 'https://github.com/o/lib/pull/3';
  setTaskExtraPrs('one', [{ url, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('one', url), failingChecks);
  expect(container.querySelector('.task-board-status')?.textContent).toBe('CI failed');
  expect(container.querySelector('.task-pr-babysit')).not.toBeNull();
});

it('links, tints and opens the PR its row describes', () => {
  const url = 'https://github.com/o/lib/pull/3';
  setStore('tasks', 'one', { prUrl: 'https://github.com/o/r/pull/7' });
  setPrChecks('one', { ...failingChecks, overall: 'success', failing: 0 });
  setTaskExtraPrs('one', [{ url, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('one', url), failingChecks);
  const card = container.querySelector('.task-board-card');
  expect(card?.classList).toContain('failed');
  expect(
    container.querySelector('.task-board-link[title*="pull request"]')?.getAttribute('title'),
  ).toContain('3');
  rightClick();
  menuItem('Open PR in browser')?.click();
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, { url });
});

it('still links and opens its own PR once that closed unmerged', () => {
  const url = 'https://github.com/o/r/pull/7';
  setStore('tasks', 'one', { prUrl: url });
  markPrimaryPrClosed('one', url);
  expect(container.querySelector('.task-board-link')?.getAttribute('title')).toBe(
    'Open pull request #7',
  );
  rightClick();
  menuItem('Open PR in browser')?.click();
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, { url });
});

it('opens Finish on Create pull request from its menu', () => {
  rightClick();
  menuItem('Create pull request…')?.click();
  expect(store.pendingAction).toEqual({ type: 'create-pr', taskId: 'one' });
  setStore('pendingAction', null);
});

it('offers no Finish for a task without its own worktree', () => {
  setStore('tasks', 'one', { gitIsolation: 'direct' });
  rightClick();
  expect(labels()).not.toContain('Finish');
  expect(labels()).toContain('Close');
});

it('asks to confirm closing the task from its menu', () => {
  setStore('tasks', 'one', { gitIsolation: 'direct' });
  rightClick();
  menuItem('Close')?.click();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  expect(dialog?.textContent).toContain('Close');
});

it("opens the task on the board's other side from its menu", () => {
  setStore('boardView', true);
  setStore('boardSidePanelLeft', false);
  setStore('boardPeek', false);
  rightClick();
  menuItem('Open on the left')?.click();
  expect(store.boardSidePanelLeft).toBe(true);
  expect(store.boardPeek).toBe(true);
  rightClick();
  expect(labels()).toContain('Open on the right');
  setStore({ boardView: false, boardPeek: false, boardSidePanelLeft: false });
});

it('marks a subtask', () => {
  const card = () => container.querySelector('.task-board-card');
  expect(card()?.classList.contains('subtask')).toBe(false);
  setStore('tasks', 'parent', { ...task, id: 'parent', name: 'Coordinator' });
  setStore('tasks', 'one', 'coordinatedBy', 'parent');
  expect(card()?.classList.contains('subtask')).toBe(true);
});

it('offers Merge, opening Finish, on a ready card without a pull request', () => {
  dispose();
  dispose = render(() => <TaskBoardCard task={store.tasks.one} lane="ready" />, container);
  const row = container.querySelector('.task-board-ask.quiet');
  expect(row?.textContent).toContain('Review passed');
  row?.querySelector<HTMLButtonElement>('.task-board-act')?.click();
  expect(store.pendingAction).toEqual({ type: 'finish', taskId: 'one' });
  setStore('pendingAction', null);
});

it('leaves a ready card with a pull request to its PR row', () => {
  dispose();
  setStore('tasks', 'one', { prUrl: 'https://github.com/acme/app/pull/12' });
  dispose = render(() => <TaskBoardCard task={store.tasks.one} lane="ready" />, container);
  expect(container.querySelector('.task-board-ask.quiet')).toBeNull();
});
