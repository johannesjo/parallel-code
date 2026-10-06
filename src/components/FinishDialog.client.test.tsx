import { Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FinishDialog } from './FinishDialog';
import { invoke } from '../lib/ipc';
import { mergeTask, pushTask } from '../store/store';
import { IPC } from '../../electron/ipc/channels';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { Task } from '../store/types';

vi.mock('../store/store', () => ({
  store: { agents: {} },
  getProject: () => undefined,
  getPrChecks: () => undefined,
  getVerifyCommand: () => undefined,
  getTaskChecks: () => [],
  buildEvidence: vi.fn(async () => {}),
  mergeTask: vi.fn(async () => {}),
  pushTask: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
  updateTaskBranch: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === IPC.GetBranchLog) return '';
    if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
    return { current_branch: 'task/parent', has_committed_changes: true };
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
vi.mock('../lib/theme', () => ({ theme: {}, bannerStyle: () => ({}) }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
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
    onPushDone: vi.fn(),
    onDelegationReview: vi.fn(),
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

  it('hands child tasks under review to the delegation review instead of merging', async () => {
    const handlers = mount({ task: task({ integrationPolicy: 'review' }) });
    await flush();
    expect(confirmButton()?.textContent).toBe('Review and merge…');
    confirmButton()?.click();
    expect(handlers.onDelegationReview).toHaveBeenCalled();
    expect(mergeTask).not.toHaveBeenCalled();
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
