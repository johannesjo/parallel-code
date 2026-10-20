import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { PullRequestDialog } from './PullRequestDialog';
import {
  getPullRequestDetails,
  markPullRequestReadyForTask,
  mergePullRequestForTask,
  stageFailedChecksPrompt,
} from '../store/github';
import { showNotification } from '../store/notification';
import type { PullRequestDetails } from '../ipc/types';
import type { Task } from '../store/types';

vi.mock('../store/github', () => ({
  getPullRequestDetails: vi.fn(),
  markPullRequestReadyForTask: vi.fn(async () => undefined),
  mergePullRequestForTask: vi.fn(async () => true),
  stageFailedChecksPrompt: vi.fn(async () => false),
  stageReviewFeedbackPrompt: vi.fn(async () => false),
}));
vi.mock('../store/store', () => ({ getPrChecks: () => undefined }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));

const task: Task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project',
  branchName: 'feature/x',
  worktreePath: '/repo/.worktrees/feature/x',
  gitIsolation: 'worktree',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
};
const prUrl = 'https://github.com/o/r/pull/5';
const openPr: PullRequestDetails = {
  number: 5,
  title: 'Add x',
  url: prUrl,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  baseRefName: 'main',
  headRefName: 'feature/x',
  headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  mergeMethods: ['rebase', 'squash'],
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function renderDialog(details: PullRequestDetails): Promise<void> {
  vi.mocked(getPullRequestDetails).mockResolvedValue(details);
  dispose = render(
    () => <PullRequestDialog open task={task} prUrl={prUrl} onClose={vi.fn()} />,
    document.body,
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain('#5'));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

it('merges with the repository default method after confirmation', async () => {
  await renderDialog(openPr);
  button('Merge on GitHub…').click();
  expect(mergePullRequestForTask).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Rebase and merge PR #5 into main?');
  button('Confirm merge').click();
  await vi.waitFor(() =>
    expect(mergePullRequestForTask).toHaveBeenCalledWith('task-1', {
      prUrl,
      method: 'rebase',
      headSha: openPr.headRefOid,
    }),
  );
});

it('does not claim a merge GitHub has not confirmed', async () => {
  vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(false);
  await renderDialog(openPr);
  button('Merge on GitHub…').click();
  button('Confirm merge').click();
  await vi.waitFor(() =>
    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('GitHub has not merged it yet'),
    ),
  );
  expect(showNotification).not.toHaveBeenCalledWith('Merged PR #5');
});

it('notes failing optional checks in the merge confirmation', async () => {
  await renderDialog({ ...openPr, mergeStateStatus: 'UNSTABLE' });
  button('Merge on GitHub…').click();
  expect(document.body.textContent).toContain('Some checks are failing.');
});

it('does not merge when the confirmation is cancelled', async () => {
  await renderDialog(openPr);
  button('Merge on GitHub…').click();
  button('Cancel').click();
  expect(mergePullRequestForTask).not.toHaveBeenCalled();
  expect(button('Merge on GitHub…')).toBeTruthy();
});

it('explains when branch protection blocks the merge', async () => {
  await renderDialog({ ...openPr, mergeStateStatus: 'BLOCKED' });
  expect(document.body.textContent).toContain('required reviews or checks');
  expect(document.body.textContent).not.toContain('Merge on GitHub');
});

it('marks a draft PR ready, then offers the merge', async () => {
  await renderDialog({ ...openPr, isDraft: true });
  expect(document.body.textContent).toContain('Draft pull requests cannot be merged');
  vi.mocked(getPullRequestDetails).mockResolvedValue(openPr);
  button('Mark ready for review').click();
  await vi.waitFor(() => expect(button('Merge on GitHub…')).toBeTruthy());
  expect(markPullRequestReadyForTask).toHaveBeenCalledWith('task-1', prUrl);
});

it('offers no mark-ready for a closed draft PR', async () => {
  await renderDialog({ ...openPr, isDraft: true, state: 'CLOSED' });
  expect(document.body.textContent).toContain('The pull request is closed.');
  expect(document.body.textContent).not.toContain('Mark ready for review');
});

it('shows why marking ready failed and keeps the draft blocker', async () => {
  vi.mocked(markPullRequestReadyForTask).mockRejectedValueOnce(new Error('gh: no permission'));
  await renderDialog({ ...openPr, isDraft: true });
  button('Mark ready for review').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('gh: no permission'));
  expect(button('Mark ready for review').disabled).toBe(false);
  expect(document.body.textContent).not.toContain('Merge on GitHub');
});

it('warns when the task branch is not the PR head branch', async () => {
  await renderDialog({ ...openPr, headRefName: 'contributor-branch' });
  expect(document.body.textContent).toContain('does not update the PR');
});

it('explains instead of offering merge when the PR has conflicts', async () => {
  await renderDialog({ ...openPr, mergeable: 'CONFLICTING' });
  expect(document.body.textContent).toContain('conflicts with its base branch');
  expect(document.body.textContent).not.toContain('Merge on GitHub');
});

it('reports when there are no failed checks to hand to the agent', async () => {
  await renderDialog(openPr);
  button('Fix CI').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('No failed checks found.'));
  expect(stageFailedChecksPrompt).toHaveBeenCalledWith('task-1', { number: 5, url: prUrl });
});
