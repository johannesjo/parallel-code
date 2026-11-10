import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { KanbanCardView } from './KanbanCard';
import { store, setStore } from '../store/core';
import {
  extraPrWatchId,
  markPrimaryPrClosed,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from '../store/pr-checks-state';
import type { KanbanCard } from '../lib/kanban';
import type { Task } from '../store/types';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  fireAndForget: vi.fn(),
}));

const task: Task = {
  id: 'one',
  name: 'one',
  projectId: 'project',
  branchName: 'task/one',
  worktreePath: '/tmp/one',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  baseBranch: 'main',
  prUrl: 'https://github.com/o/r/pull/7',
};

const card: KanbanCard = {
  title: 'Card',
  done: false,
  body: '',
  branches: ['task/one'],
  depends: [],
  issue: '',
  before: '',
};

const green: PrChecksState = {
  overall: 'success',
  merged: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  passing: 1,
  pending: 0,
  failing: 0,
  checks: [],
  checkedAt: '2026-10-31T00:00:00Z',
};

const EXTRA = 'https://github.com/o/lib/pull/3';

let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  container = document.createElement('div');
  document.body.append(container);
  const noop = () => undefined;
  dispose = render(
    () => (
      <ul>
        <KanbanCardView
          card={card}
          projectId="project"
          blockedBy={[]}
          draggable={false}
          dropBefore={false}
          dragging={false}
          flash={false}
          dataRef="0:0"
          onSelect={noop}
          onDragStart={noop}
          onDragEnd={noop}
          onDragOver={noop}
          onDrop={noop}
          onEdit={noop}
          onStart={noop}
          onToggleDone={noop}
          onToggleChecklist={noop}
        />
      </ul>
    ),
    container,
  );
});

afterEach(() => {
  dispose();
  container.remove();
  removePrChecks('one');
  removePrChecks(extraPrWatchId('one', EXTRA));
  setTaskExtraPrs('one', []);
  markPrimaryPrClosed('one', undefined);
  setStore('pendingAction', null);
});

const mergeButton = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Merge');

it('offers Merge on a card whose task PR is ready, opening Finish', () => {
  expect(mergeButton()).toBeUndefined();
  setPrChecks('one', green);
  mergeButton()?.click();
  expect(store.pendingAction).toEqual({ type: 'finish', taskId: 'one' });
});

it('offers no Merge while CI is still running', () => {
  setPrChecks('one', { ...green, overall: 'pending', passing: 0, pending: 1 });
  expect(mergeButton()).toBeUndefined();
});

it('offers no Merge for a task the Finish dialog cannot take', () => {
  setStore('tasks', 'one', { gitIsolation: 'direct' });
  setPrChecks('one', green);
  expect(mergeButton()).toBeUndefined();
});

const prLink = () => container.querySelector('.task-board-link')?.getAttribute('title');

it('links the PR its row describes, and its own PR once that closed unmerged', () => {
  setPrChecks('one', { ...green });
  setTaskExtraPrs('one', [{ url: EXTRA, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('one', EXTRA), { ...green, overall: 'failure', failing: 1 });
  expect(prLink()).toBe('Open pull request #3');
  expect(container.querySelector('.task-board-status')?.textContent).toBe('CI failed');
  setTaskExtraPrs('one', []);
  markPrimaryPrClosed('one', task.prUrl);
  expect(prLink()).toBe('Open pull request #7');
});
