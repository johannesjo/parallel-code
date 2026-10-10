import { Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FinishDialog } from './FinishDialog';
import { invoke } from '../lib/ipc';
import { getPrChecks, mergeTask, pushTask } from '../store/store';
import {
  getPullRequestDetails,
  mergePullRequestForTask,
  stageFailedChecksPrompt,
} from '../store/github';
import { IPC } from '../../electron/ipc/channels';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { PullRequestDetails } from '../ipc/types';
import type { Task } from '../store/types';

vi.mock('../store/store', () => ({
  store: { agents: {} },
  getProject: () => undefined,
  getPrChecks: vi.fn(() => undefined),
  getVerifyCommand: () => undefined,
  getTaskChecks: () => [],
  buildEvidence: vi.fn(async () => {}),
  getEvidenceUiState: () => ({}),
  isEvidenceBusy: () => false,
  mergeTask: vi.fn(async () => {}),
  pushTask: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
  updateTaskBranch: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === IPC.GetBranchLog) return '';
    if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
    return { current_branch: 'task/parent', has_committed_changes: true, head_sha: 'local' };
  }),
  Channel: class {
    onmessage: ((text: string) => void) | null = null;
    cleanup = vi.fn();
  },
}));
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    message: JSX.Element;
    confirmLabel: string;
    confirmDisabled?: boolean;
    extraActions?: JSX.Element;
    footerNote?: string;
    onConfirm: () => void;
  }) => (
    <div>
      {props.message}
      {props.extraActions}
      <span data-testid="footer-note">{props.footerNote}</span>
      <button
        data-testid="confirm"
        disabled={props.confirmDisabled}
        onClick={() => props.onConfirm()}
      >
        {props.confirmLabel}
      </button>
    </div>
  ),
}));
vi.mock('./ChangeTourButton', () => ({
  // Renders its extra segments, where the dialog puts Regenerate.
  ChangeTourButton: (props: { children?: JSX.Element }) => <span>tour{props.children}</span>,
}));
vi.mock('./ChangedFilesList', () => ({ ChangedFilesList: () => null }));
vi.mock('./MergeReadinessPanel', () => ({
  MergeReadinessPanel: (props: { children?: JSX.Element }) => <div>{props.children}</div>,
}));
vi.mock('./EvidencePanel', () => ({
  EvidencePanel: (props: {
    onReviewFile: (file: string, line?: number, side?: 'old' | 'new') => void;
  }) => (
    <button onClick={() => props.onReviewFile('test.ts', 7, 'old')}>Open evidence finding</button>
  ),
}));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn() }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));
vi.mock('../store/github', () => ({
  getPullRequestDetails: vi.fn(),
  mergePullRequestForTask: vi.fn(),
  stageFailedChecksPrompt: vi.fn(),
  stageReviewFeedbackPrompt: vi.fn(),
}));
vi.mock('./DiffViewerDialog', async () => {
  const { ReviewProvider, useReview } = await import('./ReviewProvider');
  function ReviewEditor() {
    const review = useReview();
    return (
      <>
        <button
          onClick={() =>
            review.addAnnotation({
              id: 'comment',
              filePath: 'test.ts',
              startLine: 7,
              endLine: 7,
              selectedText: 'test()',
              comment: 'Keep this review comment',
            })
          }
        >
          Add review comment
        </button>
        <div data-testid="review-comments">
          {review
            .annotations()
            .map((item) => item.comment)
            .join('\n')}
        </div>
      </>
    );
  }
  return {
    DiffViewerDialog: (props: {
      scrollToFile: string | null;
      scrollToLine?: number;
      scrollToSide?: string;
      closeLabel: string;
      onClose: () => void;
    }) => (
      <ReviewProvider open={props.scrollToFile !== null} compilePrompt={() => ''}>
        <Show when={props.scrollToFile !== null}>
          <div
            data-testid="evidence-diff"
            data-file={props.scrollToFile}
            data-line={props.scrollToLine}
            data-side={props.scrollToSide}
          >
            <ReviewEditor />
            <button onClick={() => props.onClose()}>{props.closeLabel}</button>
          </div>
        </Show>
      </ReviewProvider>
    ),
  };
});
vi.mock('./merge-readiness', () => ({ buildMergeReadiness: () => ({ checks: [] }) }));
vi.mock('../lib/theme', () => ({
  theme: {},
  bannerStyle: () => ({}),
  dialogButtonStyle: () => ({}),
  linkButtonStyle: {},
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.mocked(getPrChecks).mockReturnValue(undefined);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-testid="confirm"]');
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === text);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'parent',
    name: 'Parent',
    projectId: 'project',
    branchName: 'task/parent',
    worktreePath: '/repo/.worktrees/parent',
    gitIsolation: 'worktree',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    ...overrides,
  };
}

function tour(stops = 0): ChangeTourController {
  return {
    stops: () => Array.from({ length: stops }),
    loading: () => false,
  } as unknown as ChangeTourController;
}

function mount(options: { task?: Task; tour?: ChangeTourController } = {}) {
  const handlers = {
    onClose: vi.fn(),
    onCloseTask: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onPushDone: vi.fn(),
    onRegenerateTour: vi.fn(),
  };
  dispose = render(
    () => (
      <FinishDialog
        open
        task={options.task ?? task()}
        initialCleanup
        tour={options.tour ?? tour()}
        tourDisabled={false}
        onTourClick={() => {}}
        onPushStart={() => {}}
        onConfigureChecks={() => {}}
        onDiffFileClick={() => {}}
        {...handlers}
      />
    ),
    document.body,
  );
  return handlers;
}

describe('FinishDialog merge', () => {
  it.each([{ delegationParent: true }, { coordinatorMode: true }, {}])(
    'only allows merge cleanup without a parent relationship: %j',
    async (policy) => {
      const handlers = mount({ task: task(policy) });
      await flush();
      const cleanup = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const parent = Object.keys(policy).length > 0;
      expect(cleanup?.disabled).toBe(parent);
      expect(cleanup?.checked).toBe(!parent);
      if (parent) expect(document.body.textContent).toContain('Merge first, then close this task');
      confirmButton()?.click();
      expect(mergeTask).toHaveBeenCalledWith(
        'parent',
        expect.objectContaining({ cleanup: !parent }),
      );
      await flush();
      expect(handlers.onClose).toHaveBeenCalled();
    },
  );

  it('merges a child under review like any task and folds its completion report', async () => {
    mount({
      task: task({
        integrationPolicy: 'review',
        coordinatedBy: 'coordinator',
        completion: {
          id: '11111111-1111-4111-8111-111111111111',
          completedAt: '2026-09-26T10:00:00.000Z',
          reviewRevision: 1,
          snapshotState: 'clean',
          result: { summary: 'Implemented the result' },
        },
      }),
    });
    await flush();
    const report = [...document.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('Agent completion report'),
    );
    expect(report?.open).toBe(false);
    expect(report?.textContent).toContain('Implemented the result');
    expect(confirmButton()?.textContent).toBe('Merge into main');
    confirmButton()?.click();
    expect(mergeTask).toHaveBeenCalled();
  });
});

describe('FinishDialog push', () => {
  it('pushes the branch and keeps a failure on screen', async () => {
    vi.mocked(pushTask).mockRejectedValueOnce(new Error('rejected: non-fast-forward'));
    const handlers = mount();
    button('Push branch')?.click();
    expect(pushTask).toHaveBeenCalledWith('parent', expect.anything());
    await flush();
    expect(handlers.onPushDone).toHaveBeenCalledWith(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('rejected: non-fast-forward');
  });
});

function mockInvoke(answer: (channel: string) => unknown) {
  const original = vi.mocked(invoke).getMockImplementation();
  onTestFinished(() => {
    if (original) vi.mocked(invoke).mockImplementation(original);
  });
  vi.mocked(invoke).mockImplementation(async (channel: string) => answer(channel));
}

describe('FinishDialog base sync', () => {
  it('offers rebase or a merge of the base when it moved on, before anything else', async () => {
    let synced = false;
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: [], main_ahead_count: synced ? 0 : 2 };
      if (channel === IPC.MergeBaseIntoTask) {
        synced = true;
        return undefined;
      }
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    expect(document.body.textContent?.indexOf('main has 2 new commits')).toBeLessThan(
      document.body.textContent?.indexOf('Commits and changed files') ?? 0,
    );
    expect(button('Rebase onto main')).toBeDefined();
    expect(confirmButton()?.textContent).toBe('Merge into main');
    button('Merge main into branch')?.click();
    expect(invoke).toHaveBeenCalledWith(IPC.MergeBaseIntoTask, {
      worktreePath: '/repo/.worktrees/parent',
      baseBranch: 'main',
    });
    await flush();
    await flush();
    // The base is in, so its notice is gone; the outcome must outlive it.
    expect(document.body.textContent).not.toContain('new commits');
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Merged main into this branch.',
    );
  });
});

describe('FinishDialog merge blocker', () => {
  it('says next to the disabled merge button why it is disabled', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
      return { current_branch: 'task/parent', has_committed_changes: false };
    });
    mount();
    await flush();
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toBe(
      'Nothing to merge yet.',
    );
  });
});

describe('FinishDialog tour', () => {
  it('offers to regenerate a ready tour', async () => {
    expect(mount().onRegenerateTour).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Regenerate');
    dispose?.();
    document.body.replaceChildren();
    const handlers = mount({ tour: tour(3) });
    const regenerate = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Regenerate',
    );
    regenerate?.click();
    expect(handlers.onRegenerateTour).toHaveBeenCalled();
  });
});

it('opens the cited side and line above the finish dialog and returns without closing it', () => {
  const handlers = mount();
  button('Open evidence finding')?.click();
  const diff = document.querySelector<HTMLElement>('[data-testid="evidence-diff"]');
  expect(diff?.dataset).toMatchObject({ file: 'test.ts', line: '7', side: 'old' });
  expect(handlers.onClose).not.toHaveBeenCalled();
  button('Back to evidence')?.click();
  expect(document.querySelector('[data-testid="evidence-diff"]')).toBeNull();
  expect(button('Open evidence finding')).toBeDefined();
  expect(handlers.onClose).not.toHaveBeenCalled();
});

it('preserves unsent diff comments when returning to evidence and reopening a finding', () => {
  mount();
  button('Open evidence finding')?.click();
  button('Add review comment')?.click();
  expect(document.querySelector('[data-testid="review-comments"]')?.textContent).toBe(
    'Keep this review comment',
  );
  button('Back to evidence')?.click();
  expect(document.querySelector('[data-testid="evidence-diff"]')).toBeNull();
  button('Open evidence finding')?.click();
  expect(document.querySelector('[data-testid="review-comments"]')?.textContent).toBe(
    'Keep this review comment',
  );
});

describe('FinishDialog GitHub', () => {
  it('shows an empty state without linking an issue as a PR', () => {
    mount({ task: task({ githubUrl: 'https://github.com/o/r/issues/2' }) });
    expect(document.body.textContent).toContain('No pull request detected');
    expect(button('PR #2 details…')).toBeUndefined();
  });

  it.each(['prUrl', 'githubUrl'] as const)(
    'opens a PR from %s with its CI and review status',
    (field) => {
      vi.mocked(getPrChecks).mockReturnValue({
        overall: 'failure',
        passing: 0,
        pending: 0,
        failing: 1,
        checks: [{ name: 'Unit tests', bucket: 'fail' }],
        checkedAt: '',
        isDraft: true,
        reviewDecision: 'CHANGES_REQUESTED',
        mergeable: 'CONFLICTING',
      });
      const url = 'https://github.com/o/r/pull/42';
      const handlers = mount({ task: task({ [field]: url }) });
      expect(document.body.textContent).toContain('Unit tests: fail');
      expect(document.body.textContent).toContain('Draft · Review: changes requested');
      expect(document.body.textContent).toContain('PR has conflicts');
      button('PR #42 details…')?.click();
      expect(handlers.onOpenPullRequest).toHaveBeenCalledWith(url);
    },
  );
});

const PR_URL = 'https://github.com/o/r/pull/42';

function prDetails(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    number: 42,
    title: 'Parent',
    url: PR_URL,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    baseRefName: 'main',
    headRefName: 'task/parent',
    headRefOid: 'local',
    mergeMethods: ['squash', 'merge'],
    ...overrides,
  };
}

describe('FinishDialog with an open PR', () => {
  it('merges the PR on GitHub, then offers to close the task', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails({ state: 'MERGED' }));
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Squash and merge PR #42');
    // Local merge options would describe a merge that will not happen.
    expect(document.body.textContent).not.toContain('Squash commits');
    confirmButton()?.click();
    await flush();
    await flush();
    expect(mergePullRequestForTask).toHaveBeenCalledWith('parent', {
      prUrl: PR_URL,
      method: 'squash',
      headSha: 'local',
    });
    expect(mergeTask).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(confirmButton()?.textContent).toBe('Close task');
    confirmButton()?.click();
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onCloseTask).toHaveBeenCalled();
  });

  it('blocks the PR merge while the PR lacks the latest local commit', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ headRefOid: 'older' }));
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toContain(
      'Push the branch first',
    );
  });

  it('can merge locally instead, and switch back', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Merge locally instead')?.click();
    expect(confirmButton()?.textContent).toBe('Merge into main');
    button('Use PR #42 instead')?.click();
    expect(confirmButton()?.textContent).toBe('Squash and merge PR #42');
    button('Merge locally instead')?.click();
    confirmButton()?.click();
    expect(mergeTask).toHaveBeenCalled();
    expect(mergePullRequestForTask).not.toHaveBeenCalled();
  });

  it('falls back to a local merge when the PR cannot be loaded', async () => {
    vi.mocked(getPullRequestDetails).mockRejectedValue(new Error('gh: not logged in'));
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    await flush();
    expect(confirmButton()?.textContent).toBe('Merge into main');
    expect(document.body.textContent).toContain('gh: not logged in');
  });

  it('stages a Fix CI prompt and closes so it can be reviewed', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(stageFailedChecksPrompt).mockResolvedValueOnce(true);
    vi.mocked(getPrChecks).mockReturnValue({
      overall: 'failure',
      passing: 0,
      pending: 0,
      failing: 1,
      checks: [{ name: 'Unit tests', bucket: 'fail' }],
      checkedAt: '',
    });
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Fix CI')?.click();
    await flush();
    expect(stageFailedChecksPrompt).toHaveBeenCalledWith('parent', { number: 42, url: PR_URL });
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('stays on Close task when the refetch after a merge fails', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('rate limited'));
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    await flush();
    expect(confirmButton()?.textContent).toBe('Close task');
    expect(button('Merge locally instead')).toBeUndefined();
    expect(document.body.textContent).not.toContain('merges locally');
  });

  it('closes when GitHub only queued the merge', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(false);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onCloseTask).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error when the PR merge fails', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockRejectedValueOnce(new Error('head moved'));
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('head moved');
  });

  it.each([
    [{ state: 'CLOSED' as const }, 'PR #42 is closed'],
    [{ headRefName: 'someone/else' }, 'PR #42 is on someone/else'],
    [{ headRefName: 'someone/else', state: 'MERGED' as const }, 'PR #42 is on someone/else'],
  ])('merges locally when the PR cannot carry the work: %j', async (overrides, note) => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails(overrides));
    mount({ task: task({ githubUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Merge into main');
    expect(document.body.textContent).toContain(note);
  });

  it('clears the push-first blocker once a push lands on the PR', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails({ headRefOid: 'older' }));
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.disabled).toBe(true);
    button('Push branch')?.click();
    await flush();
    await flush();
    expect(confirmButton()?.disabled).toBe(false);
    expect(confirmButton()?.textContent).toBe('Squash and merge PR #42');
  });

  it('retries loading the PR after a failure', async () => {
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Retry')?.click();
    await flush();
    expect(confirmButton()?.textContent).toBe('Squash and merge PR #42');
  });

  it('offers agent hand-offs only when CI fails or changes are requested', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(button('Fix CI')).toBeUndefined();
    expect(button('Address review')).toBeUndefined();
  });

  it('offers a local merge for commits made after the PR merged', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(
      prDetails({ state: 'MERGED', headRefOid: 'older' }),
    );
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Close task');
    expect(document.body.textContent).toContain('commits that are not in PR #42');
    button('Merge locally instead')?.click();
    expect(confirmButton()?.textContent).toBe('Merge into main');
  });
});
