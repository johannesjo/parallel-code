import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';

const { mockStage, mockNotify, mockPrChecks } = vi.hoisted(() => ({
  mockStage: vi.fn(),
  mockNotify: vi.fn(),
  mockPrChecks: vi.fn(),
}));

const failingChecks = {
  overall: 'failure',
  passing: 1,
  pending: 0,
  failing: 1,
  checks: [],
  checkedAt: '2026-08-04T10:00:00.000Z',
};

vi.mock('../store/store', () => ({
  store: { editorCommand: null },
  getProject: vi.fn(() => undefined),
  showNotification: mockNotify,
  getPrChecks: mockPrChecks,
  getBranchDivergence: vi.fn(() => null),
}));
vi.mock('../store/github', () => ({ stageFailedChecksPrompt: mockStage }));

import { TaskBranchInfoBar } from './TaskBranchInfoBar';

const task = {
  id: 'task-1',
  name: 'Fix CI',
  projectId: 'project-1',
  branchName: 'task/fix-ci',
  worktreePath: '/repo/.worktrees/fix-ci',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  prUrl: 'https://github.com/acme/app/pull/12',
} as Task;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === text);
}

function clickFixCi(): void {
  mockPrChecks.mockReturnValue(failingChecks);
  dispose = render(() => <TaskBranchInfoBar task={task} onEditProject={vi.fn()} />, document.body);
  const found = findButton('Fix CI');
  if (!found) throw new Error('no Fix CI button');
  found.click();
}

describe('TaskBranchInfoBar Fix CI', () => {
  it('stages the failed checks prompt for the task PR', async () => {
    mockStage.mockResolvedValue(true);
    clickFixCi();

    expect(mockStage).toHaveBeenCalledWith('task-1', {
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
    });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith(
        'Prompt staged in the task input. Review it, then send.',
      ),
    );
  });

  it('reports when GitHub lists no failed checks', async () => {
    mockStage.mockResolvedValue(false);
    clickFixCi();

    await vi.waitFor(() => expect(mockNotify).toHaveBeenCalledWith('No failed checks found.'));
  });
});

describe('TaskBranchInfoBar Merge', () => {
  const greenChecks = { ...failingChecks, overall: 'success', failing: 0 };

  function renderBar(checks: object, onFinish?: () => void): void {
    mockPrChecks.mockReturnValue(checks);
    dispose = render(
      () => <TaskBranchInfoBar task={task} onEditProject={vi.fn()} onFinish={onFinish} />,
      document.body,
    );
  }

  it('opens the finish flow when CI is green', () => {
    const onFinish = vi.fn();
    renderBar(greenChecks, onFinish);

    expect(findButton('Fix CI')).toBeUndefined();
    findButton('Merge')?.click();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it.each([
    ['CI is failing', failingChecks],
    ['CI is running', { ...greenChecks, overall: 'pending' }],
    ['the PR is a draft', { ...greenChecks, isDraft: true }],
    ['the PR conflicts', { ...greenChecks, mergeable: 'CONFLICTING' }],
    ['changes are requested', { ...greenChecks, reviewDecision: 'CHANGES_REQUESTED' }],
    ['a review is required', { ...greenChecks, reviewDecision: 'REVIEW_REQUIRED' }],
    ['the PR is merged', { ...greenChecks, merged: true }],
  ])('hides Merge when %s', (_, checks) => {
    renderBar(checks, vi.fn());
    expect(findButton('Merge')).toBeUndefined();
  });

  it('hides Merge when the task cannot finish', () => {
    renderBar(greenChecks);
    expect(findButton('Merge')).toBeUndefined();
  });
});
