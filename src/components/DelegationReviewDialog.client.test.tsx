import { type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { DelegationReviewDialog } from './DelegationReviewDialog';
import { CompletionReport } from './CompletionReport';
import { clearTaskLandingReview } from '../store/tasks';
import type { Task } from '../store/types';

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));
vi.mock('../store/tasks', () => ({ clearTaskLandingReview: vi.fn() }));

const task: Task = {
  id: 'child',
  name: 'Child',
  projectId: 'project',
  branchName: 'task/child',
  worktreePath: '/repo/child',
  gitIsolation: 'worktree',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
};
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

it('shows a legacy completion without manufacturing a report', () => {
  dispose = render(
    () => <DelegationReviewDialog open task={task} onClose={() => {}} />,
    document.body,
  );
  expect(document.body.textContent).toContain('No structured report provided');
  expect(document.body.textContent).not.toContain('Agent-reported verification');
});

it('shows claims, unresolved issues, and inert artifact paths with honest commit association', () => {
  dispose = render(
    () => (
      <section aria-label="Agent completion report">
        <CompletionReport
          headSha={'b'.repeat(40)}
          task={{
            ...task,
            completion: {
              id: '11111111-1111-4111-8111-111111111111',
              completedAt: '2026-09-26T10:00:00.000Z',
              reviewRevision: 1,
              sourceCommit: 'a'.repeat(40),
              snapshotState: 'dirty',
              result: {
                summary: 'Implemented the result',
                verification: {
                  checks: [{ name: 'Tests', command: 'npm test', result: 'passed' }],
                },
                artifacts: [{ path: 'reports/result.html', label: 'Report' }],
                unresolvedIssues: ['Native smoke check pending'],
              },
            },
          }}
        />
      </section>
    ),
    document.body,
  );
  const section = document.querySelector('section[aria-label="Agent completion report"]');
  expect(section?.textContent).toContain('Implemented the result');
  expect(section?.textContent).toContain('Native smoke check pending');
  expect(section?.textContent).toContain('Agent-reported verification');
  expect(section?.textContent).toContain('The app has not proven they ran at this commit');
  expect(section?.textContent).toContain('Worktree was dirty at completion');
  expect(section?.textContent).toContain('Report is stale for the displayed commit');
  expect(section?.textContent).toContain('reports/result.html');
  expect(section?.querySelector('a')).toBeNull();
  expect(section?.querySelector('button')).toBeNull();
});

it('labels unknown completion identity and snapshot without implying app verification', () => {
  dispose = render(
    () => (
      <DelegationReviewDialog
        open
        task={{
          ...task,
          landingState: 'landed_pending_review',
          reviewRevision: 2,
          completion: {
            id: '11111111-1111-4111-8111-111111111111',
            completedAt: '2026-09-26T10:00:00.000Z',
            reviewRevision: 1,
            snapshotState: 'unknown',
          },
        }}
        onClose={() => {}}
      />
    ),
    document.body,
  );
  expect(document.body.textContent).toContain('Historical report');
  expect(document.body.textContent).toContain('Completion commit association unknown');
  expect(document.body.textContent).toContain('Worktree state at completion unknown');
  expect(document.body.textContent).toContain('No structured report provided');
});

it('marks a self-landed result reviewed without offering a merge', () => {
  const onClose = vi.fn();
  dispose = render(
    () => (
      <DelegationReviewDialog
        open
        task={{ ...task, landingState: 'landed_pending_review' }}
        onClose={onClose}
      />
    ),
    document.body,
  );
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent)).toEqual(['Close', 'Mark reviewed']);
  buttons[1]?.click();
  expect(clearTaskLandingReview).toHaveBeenCalledWith('child');
  expect(onClose).toHaveBeenCalledOnce();
});
