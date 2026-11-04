import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { removePrChecks, setPrChecks, type PrChecksState } from '../../store/pr-checks-state';
import { TaskLine, TaskPr } from './TaskStatus';

vi.mock('../../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

// A fresh object each time: the store merges later writes into the one it was given.
const green = (): PrChecksState => ({
  overall: 'success',
  merged: false,
  isDraft: false,
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  passing: 2,
  pending: 0,
  failing: 0,
  checks: [],
  checkedAt: '2026-01-01T00:00:00Z',
});

let dispose: () => void = () => undefined;
afterEach(() => {
  dispose();
  removePrChecks('t');
  document.body.innerHTML = '';
});

const status = () => document.querySelector('.task-board-status');
const render7 = () =>
  render(() => <TaskPr taskId="t" url="https://github.com/o/r/pull/7" />, document.body);

it('shows a green, mergeable PR as ready to merge, then as merged', () => {
  setPrChecks('t', green());
  dispose = render7();
  expect(status()?.textContent).toBe('Ready to merge');
  expect(status()?.classList).toContain('strong');
  expect(status()?.querySelector('.task-board-ok')).not.toBeNull();

  setPrChecks('t', { ...green(), overall: 'none', merged: true });
  expect(status()?.textContent).toBe('Merged');
  // Done, not urgent: the label recedes and the success check goes.
  expect(status()?.classList).toContain('subtle');
  expect(status()?.querySelector('.task-board-ok')).toBeNull();
});

it('says failed CI once, in the label', () => {
  setPrChecks('t', { ...green(), overall: 'failure', failing: 1 });
  dispose = render7();
  expect(status()?.textContent).toBe('CI failed');
  expect(status()?.classList).toContain('error');
});

it('warns about conflicts but not about a routine wait for review', () => {
  setPrChecks('t', { ...green(), mergeable: 'CONFLICTING' });
  dispose = render7();
  expect(status()?.textContent).toBe('CI passed · Conflicts');
  expect(status()?.classList).toContain('warning');

  setPrChecks('t', { ...green(), reviewDecision: 'REVIEW_REQUIRED' });
  expect(status()?.textContent).toBe('CI passed · Review needed');
  expect(status()?.classList).toContain('muted');
});

it('names an open PR whose checks are not known yet', () => {
  dispose = render7();
  expect(status()?.textContent).toBe('Pull request open');
  expect(document.body.textContent).not.toContain('Babysit');
});

const badges = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.task-board-link')].map((b) => b.title);

it('links the source issue, then the PR, at the end of the task line, without colour', () => {
  dispose = render(
    () => (
      <TaskLine
        text="task/fix"
        classList={{}}
        prUrl="https://github.com/o/r/pull/7"
        issueUrl="https://github.com/o/r/issues/3"
      />
    ),
    document.body,
  );
  expect(badges()).toEqual(['Open issue #3', 'Open pull request #7']);
  expect(document.querySelector('.task-board-link')?.className).toBe(
    'task-board-chip task-board-link',
  );
});

it('shows no issue badge when the task came from a PR', () => {
  dispose = render(
    () => <TaskLine text="" classList={{}} issueUrl="https://github.com/o/r/pull/7" />,
    document.body,
  );
  expect(badges()).toEqual([]);
  expect(document.querySelector('.task-board-links')).toBeNull();
});
