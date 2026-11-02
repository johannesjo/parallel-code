import { Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { closeTaskNow } from './CloseTaskDialog';
import { FinishDialog } from './FinishDialog';
import { invoke } from '../lib/ipc';
import { setStore } from '../store/core';
import { showNotification } from '../store/notification';
import { getPrChecks, getTaskChecks, mergeTask, pushTask, sendPrompt, store } from '../store/store';
import {
  getPullRequestDetails,
  markPullRequestReadyForTask,
  mergePullRequestForTask,
  stageFailedChecksPrompt,
} from '../store/github';
import { IPC } from '../../electron/ipc/channels';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { PullRequestDetails } from '../ipc/types';
import type { Task } from '../store/types';

vi.mock('../store/store', () => ({
  store: { agents: {} },
  backgroundVerifyEnabled: () => false,
  cancelTaskVerification: vi.fn(async () => true),
  getBackgroundVerifyHold: () => undefined,
  runBackgroundVerify: vi.fn(async () => undefined),
  runTaskVerification: vi.fn(async () => undefined),
  stageVerificationFailurePrompt: vi.fn(() => false),
  getProject: () => undefined,
  getProjectPath: () => '/repo',
  getPrChecks: vi.fn(() => undefined),
  getVerifyCommand: () => undefined,
  getTaskChecks: vi.fn(() => []),
  getCheckSuiteUiState: () => ({}),
  isCheckSuiteBusy: () => false,
  mergeTask: vi.fn(async () => {}),
  pushTask: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
  updateTaskBranch: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === IPC.GetBranchLog) return '';
    if (channel === IPC.GetBranchCommits)
      return [
        { hash: 'a1', message: 'feat: add thing', body: 'Co-authored-by: Bot <bot@x>' },
        { hash: 'b2', message: 'fix: tweak thing', body: 'Because reasons.' },
      ];
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
  ChangeTourButton: (props: { children?: JSX.Element; outdated?: boolean }) => (
    <span data-testid="tour" data-outdated={String(!!props.outdated)}>
      tour{props.children}
    </span>
  ),
}));
const refreshCodeFingerprint = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../store/task-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/task-brief')>()),
  refreshCodeFingerprint,
}));
vi.mock('./ChangedFilesList', () => ({ ChangedFilesList: () => null }));
// Covered by its own tests; its store imports reach past this file's mocks.
const reviewProps = vi.hoisted(() => ({
  current: undefined as
    | {
        verifyFailed: boolean;
        onReworkStaged: () => void;
        onOpenFile: (file: string, line?: number) => void;
      }
    | undefined,
}));
vi.mock('./ReviewSection', () => ({
  ReviewSection: (props: NonNullable<typeof reviewProps.current>) => {
    // eslint-disable-next-line solid/reactivity -- keeps the live props proxy for the test to read
    reviewProps.current = props;
    return <button onClick={() => props.onOpenFile('test.ts', 7)}>Open review finding</button>;
  },
}));
vi.mock('./MergeReadinessPanel', () => ({
  MergeReadinessPanel: (props: { children?: JSX.Element }) => <div>{props.children}</div>,
}));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn() }));
vi.mock('./CloseTaskDialog', () => ({ closeTaskNow: vi.fn() }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));
vi.mock('../store/github', () => ({
  getPullRequestDetails: vi.fn(),
  markPullRequestReadyForTask: vi.fn(),
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
            data-testid="finding-diff"
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
  sectionLabelStyle: {},
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

function tour(
  stops = 0,
  basis?: { generatedAt: number; fingerprint: string },
): ChangeTourController {
  return {
    stops: () => Array.from({ length: stops }),
    loading: () => false,
    basis: () => basis,
  } as unknown as ChangeTourController;
}

// Readiness shows once something backs it; an agent's own report is enough.
const reported = () =>
  task({ verification: { checks: [{ name: 'Tests', command: 'npm test', result: 'passed' }] } });

function mount(
  options: { task?: Task; tour?: ChangeTourController; initialCleanup?: boolean } = {},
) {
  const handlers = {
    onClose: vi.fn(),
    onCloseTask: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onPushDone: vi.fn(),
    onRegenerateTour: vi.fn(),
    onConfigureChecks: vi.fn(),
  };
  dispose = render(
    () => (
      <FinishDialog
        open
        task={options.task ?? task()}
        initialCleanup={options.initialCleanup ?? true}
        initialCreatePr={false}
        tour={options.tour ?? tour()}
        onTourClick={() => {}}
        onPushStart={() => {}}
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
    expect(confirmButton()?.textContent).toBe('Merge into local main');
    confirmButton()?.click();
    expect(mergeTask).toHaveBeenCalled();
  });

  it('prefills the squash description once commits load, if ticked before', async () => {
    mount();
    const squash = [...document.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Squash commits'),
    );
    squash?.querySelector('input')?.click();
    await flush();
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit description"]')
        ?.value,
    ).toContain('* feat: add thing');
  });

  it('prefills a GitHub-style squash title and description', async () => {
    mount();
    await flush();
    const squash = [...document.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Squash commits'),
    );
    squash?.querySelector('input')?.click();
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Commit title"]');
    const body = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Commit description"]',
    );
    expect(title?.value).toBe('Parent');
    expect(body?.value).toBe(
      '* feat: add thing\n\n* fix: tweak thing\n\nBecause reasons.\n\nCo-authored-by: Bot <bot@x>',
    );

    if (title) {
      title.value = ' ';
      title.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toBe(
      'Add a commit title.',
    );
    if (title) {
      title.value = 'feat: thing';
      title.dispatchEvent(new Event('input', { bubbles: true }));
    }
    confirmButton()?.click();
    expect(mergeTask).toHaveBeenCalledWith(
      'parent',
      expect.objectContaining({ squash: true, message: `feat: thing\n\n${body?.value}` }),
    );
  });
});

describe('FinishDialog push', () => {
  it('offers Push beside Merge only while origin lacks the branch head', async () => {
    let remote = 'pushed';
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: [], main_ahead_count: 0, remote };
      return { current_branch: 'task/parent', has_committed_changes: true, head_sha: 'local' };
    });
    mount();
    await flush();
    expect(button('Push')).toBeUndefined();
    dispose?.();
    document.body.replaceChildren();
    remote = 'unpushed';
    mount();
    await flush();
    // A local merge needs no push, so Merge stays the main action.
    expect(button('Push')?.className).toContain('btn-secondary');
    expect(confirmButton()?.textContent).toBe('Merge into local main');
  });

  it('keeps Push for conflicts, but not for a worktree on another branch or one still being read', async () => {
    let status: () => unknown = () => ({
      current_branch: 'task/parent',
      has_committed_changes: true,
      head_sha: 'local',
    });
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: ['src/a.ts'], main_ahead_count: 0, remote: 'unpushed' };
      return status();
    });
    mount();
    await flush();
    // Conflicts block the merge only; pushing is how a PR gets them resolved.
    expect(confirmButton()?.disabled).toBe(true);
    expect(button('Push')?.disabled).toBe(false);

    for (const [answer, reason] of [
      [
        () => ({ current_branch: 'other', has_committed_changes: true }),
        "not on this task's branch",
      ],
      [() => new Promise(() => {}), 'Checking the branch'],
    ] as const) {
      dispose?.();
      document.body.replaceChildren();
      status = answer;
      mount();
      await flush();
      expect(button('Push')?.disabled).toBe(true);
      expect(button('Push')?.title).toContain(reason);
    }
  });

  it('pushes the branch and keeps a failure on screen', async () => {
    vi.mocked(pushTask).mockRejectedValueOnce(new Error('rejected: non-fast-forward'));
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: [], main_ahead_count: 0, remote: 'differs' };
      return { current_branch: 'task/parent', has_committed_changes: true, head_sha: 'local' };
    });
    const handlers = mount();
    await flush();
    button('Push')?.click();
    expect(pushTask).toHaveBeenCalledWith('parent', expect.anything());
    await flush();
    expect(handlers.onPushDone).toHaveBeenCalledWith(false, false);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('rejected: non-fast-forward');
  });
});

function mockInvoke(answer: (channel: string) => unknown) {
  const original = vi.mocked(invoke).getMockImplementation();
  onTestFinished(() => {
    if (original) vi.mocked(invoke).mockImplementation(original);
  });
  vi.mocked(invoke).mockImplementation(async (channel: string) => {
    const value = answer(channel);
    // The branch commit list is always an array; answers written for other channels are not.
    return channel === IPC.GetBranchCommits && !Array.isArray(value) ? [] : value;
  });
}

describe('FinishDialog base sync', () => {
  it('offers rebase or a merge of the base when it moved on, before anything else', async () => {
    let synced = false;
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return {
          conflicting_files: [],
          main_ahead_count: synced ? 0 : 2,
          overlapping_files: ['src/a.ts'],
        };
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
    // Where the new base commits meet this branch, checks here never saw them.
    expect(document.body.textContent).toContain(
      "They also change 1 of this branch's files: src/a.ts. Test again afterwards.",
    );
    expect(button('Rebase')).toBeDefined();
    expect(confirmButton()?.textContent).toBe('Merge into local main');
    button('Merge')?.click();
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

  it('says on one line when the new base commits leave this branch alone', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: [], main_ahead_count: 1, overlapping_files: [] };
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    expect(document.body.textContent).toContain(
      "main has 1 new commit. No overlap with this branch's files.",
    );
  });

  it('claims no overlap when the merge check could not tell', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 1 };
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    expect(document.body.textContent).toContain('main has 1 new commit.');
    expect(document.body.textContent).not.toContain('No overlap');
  });

  it('brings the base in over uncommitted changes the base does not touch', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 2 };
      return {
        current_branch: 'task/parent',
        has_committed_changes: true,
        has_uncommitted_changes: true,
      };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    expect(button('Rebase')?.disabled).toBe(false);
    expect(button('Merge')?.disabled).toBe(false);
  });

  it('asks to commit uncommitted changes the base changed too', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return {
          conflicting_files: [],
          main_ahead_count: 2,
          uncommitted_overlap: ['src/a.ts'],
        };
      return {
        current_branch: 'task/parent',
        has_committed_changes: true,
        has_uncommitted_changes: true,
      };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    expect(document.body.textContent).toContain(
      'Commit or stash your changes to src/a.ts first: main changed them too.',
    );
    expect(button('Rebase')?.disabled).toBe(true);
    expect(button('Merge')?.disabled).toBe(true);
  });

  it('asks the agent to resolve the conflicting files', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: ['src/a.ts', 'src/b.ts'], main_ahead_count: 1 };
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    vi.mocked(sendPrompt).mockResolvedValue(undefined);
    store.agents = { agent: { status: 'running' } } as unknown as typeof store.agents;
    onTestFinished(() => {
      store.agents = {};
    });
    const handlers = mount({ task: task({ baseBranch: 'main', agentIds: ['agent'] }) });
    await flush();
    button('Rebase with AI')?.click();
    expect(handlers.onClose).toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith(
      'parent',
      'agent',
      'rebase on main branch and resolve the conflicts in src/a.ts, src/b.ts',
    );
  });

  it('offers a way out when a rebase stops on conflicts the merge check did not predict', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 1 };
      if (channel === IPC.RebaseTask)
        throw new Error(
          "Error invoking remote method 'rebase_task': Error: Rebase stopped on conflicts in src/a.ts and was undone; the branch is unchanged.",
        );
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    vi.mocked(sendPrompt).mockResolvedValue(undefined);
    store.agents = { agent: { status: 'running' } } as unknown as typeof store.agents;
    onTestFinished(() => {
      store.agents = {};
    });
    mount({ task: task({ baseBranch: 'main', agentIds: ['agent'] }) });
    await flush();
    button('Rebase')?.click();
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      'Rebase stopped on conflicts in src/a.ts and was undone; the branch is unchanged.',
    );
    expect(text).not.toContain('Error invoking remote method');
    // Replaying commit by commit can conflict where a single merge does not.
    expect(text).toContain('Merge main into the branch instead, or rebase with AI.');
    button('Rebase with AI')?.click();
    expect(sendPrompt).toHaveBeenCalledWith(
      'parent',
      'agent',
      'rebase on main branch and resolve the conflicts',
    );
  });

  it('offers no merge instead when a rebase fails for another reason', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 1 };
      if (channel === IPC.RebaseTask) throw new Error('Rebase failed: index.lock exists');
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    button('Rebase')?.click();
    await flush();
    expect(document.body.textContent).toContain('Rebase failed: index.lock exists');
    expect(document.body.textContent).not.toContain('instead');
  });
});

describe('FinishDialog merge blocker', () => {
  it('warns about uncommitted changes in the base checkout and merges past them', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return {
          conflicting_files: [],
          main_ahead_count: 0,
          target_uncommitted: { path: '/repo', files: ['notes.txt', 'b.txt'], overlap: [] },
        };
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount();
    await flush();
    expect(document.querySelector('[data-testid="target-uncommitted"]')?.textContent).toBe(
      '/repo has uncommitted changes in 2 files. Merging sets them aside and puts them back afterwards.',
    );
    expect(confirmButton()?.disabled).toBe(false);
    confirmButton()?.click();
    expect(mergeTask).toHaveBeenCalledWith(
      'parent',
      expect.objectContaining({ allowDirtyTarget: true }),
    );
  });

  it('blocks the merge while base checkout changes touch files it merges', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return {
          conflicting_files: [],
          main_ahead_count: 0,
          target_uncommitted: { path: '/repo', files: ['a.ts'], overlap: ['a.ts'] },
        };
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount();
    await flush();
    expect(document.querySelector('[data-testid="target-uncommitted"]')?.textContent).toBe(
      'Uncommitted changes in /repo touch files this merge changes: a.ts. Commit or stash them first.',
    );
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toBe(
      'Commit or stash the changes in main that this merge touches.',
    );
  });

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
      'No commits on this branch yet.',
    );
  });

  it('asks for a commit when the changes are not committed yet', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
      return {
        current_branch: 'task/parent',
        has_committed_changes: false,
        has_uncommitted_changes: true,
      };
    });
    mount();
    await flush();
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toBe(
      'Commit the changes to merge them.',
    );
    // Nothing to merge yet, so no merge options either.
    expect(document.body.textContent).not.toContain('Squash commits');
  });
});

describe('FinishDialog readiness tip', () => {
  function mountWithTip(options: { task?: Task } = { task: reported() }) {
    vi.useFakeTimers();
    // An earlier test may have dismissed the tip.
    setStore('seenFeatureHints', []);
    // happy-dom lays nothing out; the tip needs its anchor on screen.
    const box = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 400, 40));
    onTestFinished(() => {
      dispose?.();
      dispose = undefined;
      vi.runAllTimers();
      box.mockRestore();
      vi.useRealTimers();
    });
    const handlers = mount(options);
    vi.advanceTimersByTime(650);
    return { handlers, note: document.querySelector('[role="note"]') };
  }
  const tipButton = (note: Element | null, text: string) =>
    [...(note?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text);

  it('points first-time users at readiness and offers to configure checks', () => {
    const { handlers, note } = mountWithTip();
    expect(note?.textContent).toContain('Check what backs this change');
    expect(note?.textContent).toContain('Add a verify command');
    tipButton(note, 'Configure checks')?.click();
    expect(handlers.onConfigureChecks).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="note"]')).toBeNull();
  });

  it('leaves readiness and its tip out when nothing is configured, run or reported', () => {
    const { note } = mountWithTip({});
    expect(note).toBeNull();
    expect(document.querySelector('[aria-label="Readiness and checks"]')).toBeNull();
    expect(document.body.textContent).not.toContain('No verify command');
  });

  it('offers no setup once the project has any check', () => {
    vi.mocked(getTaskChecks).mockReturnValue([
      { id: 'lint', name: 'Lint', kind: 'custom', command: 'npm run lint', run: 'on-demand' },
    ]);
    onTestFinished(() => {
      vi.mocked(getTaskChecks).mockReturnValue([]);
    });
    const { note } = mountWithTip();
    expect(note?.textContent).toContain('Check what backs this change');
    expect(note?.textContent).not.toContain('Add a verify command');
    expect(tipButton(note, 'Configure checks')).toBeUndefined();
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

  it('marks a tour of code that changed since as out of date, after reading the code', async () => {
    const basis = { generatedAt: 100, fingerprint: 'a' };
    refreshCodeFingerprint.mockClear();
    mount({ tour: tour(2, basis), task: task({ codeFingerprint: { fingerprint: 'b', at: 200 } }) });
    expect(document.querySelector<HTMLElement>('[data-testid="tour"]')?.dataset.outdated).toBe(
      'true',
    );
    expect(refreshCodeFingerprint).toHaveBeenCalledWith('parent');
    dispose?.();
    document.body.replaceChildren();
    mount({ tour: tour(2, basis), task: task({ codeFingerprint: { fingerprint: 'a', at: 200 } }) });
    expect(document.querySelector<HTMLElement>('[data-testid="tour"]')?.dataset.outdated).toBe(
      'false',
    );
  });

  it('does not read the code for a dialog without a tour', () => {
    refreshCodeFingerprint.mockClear();
    mount();
    expect(refreshCodeFingerprint).not.toHaveBeenCalled();
  });

  it("offers the tour from the dialog's own status, not the task panel", async () => {
    mount();
    await flush();
    expect(document.body.textContent).toContain('tour');
  });

  it('leaves the tour out when the branch has no changes', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
      return { current_branch: 'task/parent', has_committed_changes: false };
    });
    mount();
    await flush();
    expect(document.body.textContent).not.toContain('tour');
  });
});

it('opens the cited side and line above the finish dialog and returns without closing it', () => {
  const handlers = mount({ task: reported() });
  button('Open review finding')?.click();
  const diff = document.querySelector<HTMLElement>('[data-testid="finding-diff"]');
  expect(diff?.dataset).toMatchObject({ file: 'test.ts', line: '7', side: 'new' });
  expect(handlers.onClose).not.toHaveBeenCalled();
  button('Back to Finish')?.click();
  expect(document.querySelector('[data-testid="finding-diff"]')).toBeNull();
  expect(button('Open review finding')).toBeDefined();
  expect(handlers.onClose).not.toHaveBeenCalled();
});

it('preserves unsent diff comments when returning to Finish and reopening a finding', () => {
  mount({ task: reported() });
  button('Open review finding')?.click();
  button('Add review comment')?.click();
  expect(document.querySelector('[data-testid="review-comments"]')?.textContent).toBe(
    'Keep this review comment',
  );
  button('Back to Finish')?.click();
  expect(document.querySelector('[data-testid="finding-diff"]')).toBeNull();
  button('Open review finding')?.click();
  expect(document.querySelector('[data-testid="review-comments"]')?.textContent).toBe(
    'Keep this review comment',
  );
});

describe('FinishDialog GitHub', () => {
  it('leaves the PR section out without a PR, not taking an issue for one', () => {
    mount({ task: task({ githubUrl: 'https://github.com/o/r/issues/2' }) });
    expect(document.querySelector('section[aria-label="Pull request"]')).toBeNull();
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
      expect(document.body.textContent).toContain('Draft · changes requested');
      expect(document.body.textContent).toContain('PR has conflicts');
      button('Details…')?.click();
      expect(handlers.onOpenPullRequest).toHaveBeenCalledWith(url);
    },
  );

  it.each([
    [0, '✓ 2 checks passed', false],
    [1, '✗ 1 of 2 checks failed', true],
  ])('folds the CI list unless a check failed (%i failing)', (failing, summary, open) => {
    vi.mocked(getPrChecks).mockReturnValue({
      overall: failing ? 'failure' : 'success',
      passing: 2 - failing,
      pending: 0,
      failing,
      checks: [
        { name: 'lint', bucket: 'pass' },
        { name: 'unit', bucket: failing ? 'fail' : 'pass' },
      ],
      checkedAt: '',
    });
    mount({ task: task({ prUrl: 'https://github.com/o/r/pull/42' }) });
    const list = document.querySelector('[aria-label="GitHub CI checks"]')?.closest('details');
    expect(list?.querySelector('summary')?.textContent).toBe(summary);
    expect(list?.open).toBe(open);
  });
});

const PR_URL = 'https://github.com/o/r/pull/42';
const bypassCheckbox = () =>
  document.querySelector<HTMLInputElement>('[data-testid="bypass-protection"]');
const closeAfterMergeCheckbox = () =>
  [...document.querySelectorAll('label')]
    .find((label) => label.textContent === 'Close task after merge')
    ?.querySelector('input');
// Keeps the task open after the PR merges, so the footer offers Close task.
const optOutOfClose = () => closeAfterMergeCheckbox()?.click();

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
    authoredByViewer: true,
    ...overrides,
  };
}

describe('FinishDialog base sync with an open PR', () => {
  const baseMovedOn = (conflicting_files: string[] = []) =>
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files, main_ahead_count: 3, overlapping_files: [] };
      return { current_branch: 'task/parent', has_committed_changes: true, head_sha: 'local' };
    });

  it('leaves a moved base alone while GitHub can still merge the PR', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    baseMovedOn();
    mount({ task: task({ baseBranch: 'main', prUrl: PR_URL }) });
    await flush();
    expect(document.body.textContent).not.toContain('new commits');
    expect(button('Rebase')).toBeUndefined();
  });

  it.each([
    ['GitHub wants the branch updated', { mergeStateStatus: 'BEHIND' }],
    ['GitHub sees conflicts', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }],
  ] as const)('offers to bring the base in when %s', async (_, overrides) => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails(overrides));
    baseMovedOn();
    mount({ task: task({ baseBranch: 'main', prUrl: PR_URL }) });
    await flush();
    expect(document.body.textContent).toContain('main has 3 new commits');
    expect(button('Merge')).toBeDefined();
  });

  it('leaves a moved base alone once the PR merged', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ state: 'MERGED' }));
    baseMovedOn();
    mount({ task: task({ baseBranch: 'main', prUrl: PR_URL }) });
    await flush();
    expect(document.body.textContent).not.toContain('new commits');
  });

  it('offers to bring the base in when a closed PR leaves the merge local', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ state: 'CLOSED' }));
    baseMovedOn();
    mount({ task: task({ baseBranch: 'main', prUrl: PR_URL }) });
    await flush();
    expect(document.body.textContent).toContain('main has 3 new commits');
  });

  it('shows local conflicts with the base even while GitHub can merge', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    baseMovedOn(['src/a.ts']);
    mount({ task: task({ baseBranch: 'main', prUrl: PR_URL }) });
    await flush();
    expect(document.body.textContent).toContain('Conflicts with main in 1 file');
  });
});

describe('FinishDialog with an open PR', () => {
  it('merges the PR on GitHub and closes the task', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(closeAfterMergeCheckbox()?.checked).toBe(true);
    confirmButton()?.click();
    await flush();
    expect(handlers.onClose).toHaveBeenCalled();
    expect(closeTaskNow).toHaveBeenCalledWith('parent', 'merged');
    expect(handlers.onCloseTask).not.toHaveBeenCalled();
  });

  it('closes after the merge even where branches are kept on close', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    mount({ task: task({ prUrl: PR_URL }), initialCleanup: false });
    await flush();
    expect(closeAfterMergeCheckbox()?.checked).toBe(true);
    confirmButton()?.click();
    await flush();
    expect(closeTaskNow).toHaveBeenCalledWith('parent', 'merged');
  });

  it('asks before closing when the worktree status cannot be read', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
      if (
        channel === IPC.GetWorktreeStatus &&
        vi.mocked(mergePullRequestForTask).mock.calls.length > 0
      )
        throw new Error('worktree gone');
      return { current_branch: 'task/parent', has_committed_changes: true, head_sha: 'local' };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    expect(closeTaskNow).not.toHaveBeenCalled();
    expect(handlers.onCloseTask).toHaveBeenCalled();
  });

  it('asks before closing a merged task with uncommitted changes', async () => {
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
      return {
        current_branch: 'task/parent',
        has_committed_changes: true,
        has_uncommitted_changes: true,
        head_sha: 'local',
      };
    });
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    expect(closeTaskNow).not.toHaveBeenCalled();
    expect(handlers.onCloseTask).toHaveBeenCalled();
  });

  it('offers no close opt-out for a parent, which closes separately', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    mount({ task: task({ prUrl: PR_URL, coordinatorMode: true }) });
    await flush();
    expect(closeAfterMergeCheckbox()).toBeUndefined();
    confirmButton()?.click();
    await flush();
    expect(closeTaskNow).not.toHaveBeenCalled();
  });

  it('merges the PR on GitHub, then offers to close the task when opted out', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails({ state: 'MERGED' }));
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Squash and merge on GitHub');
    // Local merge options would describe a merge that will not happen.
    expect(document.body.textContent).not.toContain('Squash commits');
    optOutOfClose();
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

  it('makes Push the main action while the PR lacks the latest local commit', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ headRefOid: 'older' }));
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Push');
    expect(confirmButton()?.disabled).toBe(false);
    expect(button('Merge as is')?.disabled).toBe(false);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toBe(
      'The PR is missing your latest commits.',
    );
  });

  it('holds the push to the PR while the worktree is on another branch', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ headRefOid: 'older' }));
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return { conflicting_files: [], main_ahead_count: 0, remote: 'differs' };
      return { current_branch: 'other', has_committed_changes: true, head_sha: 'local' };
    });
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Push');
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toContain(
      "not on this task's branch",
    );
  });

  it('merges the PR as is without closing the task, which still has unpushed work', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ headRefOid: 'older' }));
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(true);
    const handlers = mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Merge as is')?.click();
    await flush();
    expect(mergePullRequestForTask).toHaveBeenCalled();
    expect(handlers.onCloseTask).not.toHaveBeenCalled();
  });

  it('offers no bypass when GitHub does not block the merge', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(bypassCheckbox()).toBeNull();
  });

  it('keeps a conflict blocking when bypassing', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ mergeStateStatus: 'BLOCKED', mergeable: 'CONFLICTING' }),
    );
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    bypassCheckbox()?.click();
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toContain(
      'conflicts',
    );
  });

  it('marks a draft PR ready for review without merging it', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    vi.mocked(markPullRequestReadyForTask).mockResolvedValueOnce(undefined);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Mark ready for review')?.click();
    await flush();
    await flush();
    expect(markPullRequestReadyForTask).toHaveBeenCalledWith('parent', PR_URL);
    expect(button('Mark ready for review')).toBeUndefined();
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent ?? '').not.toContain(
      'Marks the draft ready',
    );
    expect(mergePullRequestForTask).not.toHaveBeenCalled();
  });

  it('marks a draft PR ready for review when merging it', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    vi.mocked(markPullRequestReadyForTask).mockResolvedValueOnce(undefined);
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(false);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toContain(
      'Marks the draft ready for review first',
    );
    confirmButton()?.click();
    await flush();
    await flush();
    expect(markPullRequestReadyForTask).toHaveBeenCalledWith('parent', PR_URL);
    expect(mergePullRequestForTask).toHaveBeenCalledWith('parent', {
      prUrl: PR_URL,
      method: 'squash',
      headSha: 'local',
    });
  });

  it('stops after marking a draft ready when GitHub then blocks the merge', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    // Once after marking ready, once more after the merge is refused.
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ mergeStateStatus: 'BLOCKED' }),
    );
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ mergeStateStatus: 'BLOCKED' }),
    );
    vi.mocked(markPullRequestReadyForTask).mockResolvedValueOnce(undefined);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    await flush();
    expect(markPullRequestReadyForTask).toHaveBeenCalled();
    expect(mergePullRequestForTask).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Marked ready for review, but not merged');
    expect(bypassCheckbox()).not.toBeNull();
  });

  it('refetches a draft marked ready whose merge GitHub then rejects', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    // GitHub computes the merge state lazily, so right after `gh pr ready` it may be unknown.
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ mergeStateStatus: 'UNKNOWN' }),
    );
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ mergeStateStatus: 'BLOCKED' }),
    );
    vi.mocked(markPullRequestReadyForTask).mockResolvedValueOnce(undefined);
    vi.mocked(mergePullRequestForTask).mockRejectedValueOnce(new Error('protected branch'));
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain(
      'Marked ready for review, but not merged: protected branch',
    );
    expect(bypassCheckbox()).not.toBeNull();
  });

  it('says a draft was marked ready when reloading it then fails', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(markPullRequestReadyForTask).mockResolvedValueOnce(undefined);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    await flush();
    expect(mergePullRequestForTask).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Marked ready for review, but not merged');
  });

  it('does not merge a draft that could not be marked ready', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(
      prDetails({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    );
    vi.mocked(markPullRequestReadyForTask).mockRejectedValueOnce(new Error('gh failed'));
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    confirmButton()?.click();
    await flush();
    expect(mergePullRequestForTask).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('gh failed');
    expect(document.body.textContent).not.toContain('Marked ready for review');
  });

  it('merges a protection-blocked PR only after opting into the admin bypass', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails({ mergeStateStatus: 'BLOCKED' }));
    vi.mocked(mergePullRequestForTask).mockResolvedValueOnce(false);
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="footer-note"]')?.textContent).toContain(
      'GitHub blocks merging',
    );
    bypassCheckbox()?.click();
    expect(confirmButton()?.disabled).toBe(false);
    expect(confirmButton()?.textContent).toBe('Squash and merge on GitHub as admin');
    confirmButton()?.click();
    await flush();
    expect(mergePullRequestForTask).toHaveBeenCalledWith('parent', {
      prUrl: PR_URL,
      method: 'squash',
      headSha: 'local',
      admin: true,
    });
  });

  it('can merge locally instead, and switch back', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValue(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Merge locally instead')?.click();
    expect(confirmButton()?.textContent).toBe('Merge into local main');
    button('Use PR #42 instead')?.click();
    expect(confirmButton()?.textContent).toBe('Squash and merge on GitHub');
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
    expect(confirmButton()?.textContent).toBe('Merge into local main');
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
    optOutOfClose();
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
    expect(confirmButton()?.textContent).toBe('Merge into local main');
    expect(document.body.textContent).toContain(note);
  });

  it('clears the push-first blocker once a push lands on the PR', async () => {
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails({ headRefOid: 'older' }));
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Push');
    confirmButton()?.click();
    await flush();
    await flush();
    expect(confirmButton()?.disabled).toBe(false);
    expect(confirmButton()?.textContent).toBe('Squash and merge on GitHub');
  });

  it('retries loading the PR after a failure', async () => {
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getPullRequestDetails).mockResolvedValueOnce(prDetails());
    mount({ task: task({ prUrl: PR_URL }) });
    await flush();
    button('Retry')?.click();
    await flush();
    expect(confirmButton()?.textContent).toBe('Squash and merge on GitHub');
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
    expect(confirmButton()?.textContent).toBe('Merge into local main');
  });
});

describe('FinishDialog review', () => {
  it('passes a failed verify to the review, and closes once rework is staged', async () => {
    const handlers = mount({
      task: task({
        verificationRun: {
          command: 'npm run check',
          status: 'failed',
          exitCode: 1,
          headSha: 'local',
          dirty: false,
          startedAt: '2026-10-25T00:00:00Z',
          finishedAt: '2026-10-25T00:01:00Z',
          outputTail: '',
        },
      }),
    });
    await flush();
    expect(reviewProps.current?.verifyFailed).toBe(true);
    reviewProps.current?.onReworkStaged();
    expect(showNotification).toHaveBeenCalledWith(
      'Rework prompt staged in the task input. Review it, then send.',
    );
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('does not count a verify failure from an older commit', async () => {
    mount({
      task: task({
        verificationRun: {
          command: 'npm run check',
          status: 'failed',
          exitCode: 1,
          headSha: 'older',
          dirty: false,
          startedAt: '2026-10-25T00:00:00Z',
          finishedAt: '2026-10-25T00:01:00Z',
          outputTail: '',
        },
      }),
    });
    await flush();
    expect(reviewProps.current?.verifyFailed).toBe(false);
  });

  it('leaves the review out when it is turned off in Settings', async () => {
    reviewProps.current = undefined;
    setStore('finishReview', false);
    try {
      mount({ task: task() });
      await flush();
      expect(reviewProps.current).toBeUndefined();
      // The tour keeps its place in the follow-ups without the review.
      expect(document.body.textContent).toContain('Before you merge');
    } finally {
      setStore('finishReview', true);
    }
  });

  it('leads "Before you merge" with the verify result, with or without the review', async () => {
    vi.mocked(getTaskChecks).mockReturnValue([
      { id: 'lint', name: 'Lint', kind: 'custom', command: 'npm run lint', run: 'on-demand' },
    ]);
    onTestFinished(() => {
      vi.mocked(getTaskChecks).mockReturnValue([]);
      setStore('finishReview', true);
    });
    const readinessInSection = () =>
      document
        .querySelector('[aria-label="Readiness and checks"]')
        ?.closest('section[aria-labelledby]')
        ?.querySelector('h3')?.textContent;
    mount({ task: task() });
    await flush();
    expect(readinessInSection()).toBe('Before you merge');
    dispose?.();
    setStore('finishReview', false);
    mount({ task: task() });
    await flush();
    expect(readinessInSection()).toBe('Before you merge');
  });

  it('lists the review before the tour, each step with its own result below it', async () => {
    mount({ task: task() });
    await flush();
    const steps = document.querySelector('.finish-followups')?.textContent ?? '';
    expect(steps.indexOf('Open review finding')).toBeGreaterThan(-1);
    expect(steps.indexOf('Open review finding')).toBeLessThan(steps.indexOf('tour'));
  });
});

describe('FinishDialog base upstream', () => {
  it('explains a base that diverged from origin and resets it on confirm', async () => {
    let diverged = true;
    const head = 'b'.repeat(40);
    mockInvoke((channel) => {
      if (channel === IPC.GetBranchLog) return '';
      if (channel === IPC.CheckMergeStatus)
        return {
          conflicting_files: diverged ? ['guide.md'] : [],
          main_ahead_count: diverged ? 1 : 0,
          ...(diverged && {
            base_upstream: {
              upstream: 'origin/main',
              head,
              behind: 3,
              local_count: 1,
              local_commits: [{ hash: 'e1ff6d7', subject: 'docs: add guide' }],
              differing_files: ['guide.md'],
            },
          }),
        };
      if (channel === IPC.ResetBaseToUpstream) {
        diverged = false;
        return head;
      }
      return { current_branch: 'task/parent', has_committed_changes: true };
    });
    mount({ task: task({ baseBranch: 'main' }) });
    await flush();
    const text = () => document.body.textContent ?? '';
    expect(text()).toContain(
      'Local main has 1 commit not on origin/main and is 3 behind it. ' +
        'That is the likely cause of the conflicts in guide.md.',
    );
    expect(text()).toContain('e1ff6d7 docs: add guide');

    button('Reset main to origin/main…')?.click();
    await flush();
    // The confirm names what the reset loses before it runs.
    expect(text()).toContain("guide.md will take origin/main's version");
    expect(invoke).not.toHaveBeenCalledWith(IPC.ResetBaseToUpstream, expect.anything());
    button('Drop 1 commit')?.click();
    await flush();
    await flush();
    expect(invoke).toHaveBeenCalledWith(IPC.ResetBaseToUpstream, {
      projectRoot: '/repo',
      baseBranch: 'main',
      expectedHead: head,
    });
    expect(document.querySelector('[data-testid="base-upstream"]')).toBeNull();
    expect(text()).toContain('Reset main to its upstream. It was at bbbbbbbbbb.');
  });
});
