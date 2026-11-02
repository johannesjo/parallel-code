import { render } from 'solid-js/web';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCancel,
  mockDismiss,
  mockRate,
  mockRefreshCode,
  mockRestore,
  mockSetChecks,
  mockSetModel,
  mockStage,
  mockTakeUnseen,
} = vi.hoisted(() => ({
  mockTakeUnseen: vi.fn((_taskId: string) => false),
  mockSetModel: vi.fn(),
  mockCancel: vi.fn(),
  mockDismiss: vi.fn(),
  mockRate: vi.fn(),
  mockRefreshCode: vi.fn((_taskId: string) => Promise.resolve()),
  mockRestore: vi.fn(),
  mockSetChecks: vi.fn(),
  mockStage: vi.fn(() => true),
}));

vi.mock('../store/task-brief', () => ({ refreshCodeFingerprint: mockRefreshCode }));

vi.mock('../store/task-review', () => ({
  reviewerName: () => 'opus',
  taskReviewModel: () => ({ provider: 'claude', model: 'opus' }),
  setTaskReviewModel: mockSetModel,
  takeUnseenReview: mockTakeUnseen,
}));

// Stands in for the model call: answers with a fixed setup at once.
vi.mock('./SuggestChecksButton', () => ({
  SuggestChecksButton: (props: {
    label?: string;
    onSuggest: (suggestion: {
      verifyCommand: string;
      checks: { kind: 'static'; command: string; run: 'auto' }[];
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        props.onSuggest({
          verifyCommand: 'npm run check',
          checks: [
            { kind: 'static', command: 'npm run lint', run: 'auto' },
            { kind: 'static', command: 'npm test', run: 'auto' },
          ],
        })
      }
    >
      {props.label}
    </button>
  ),
}));

vi.mock('../store/review-run', () => ({
  cancelReview: mockCancel,
  startReview: mockRate,
  setReviewChecks: mockSetChecks,
}));

vi.mock('../store/review', () => ({
  dismissReviewItem: mockDismiss,
  restoreReviewItem: mockRestore,
  setReviewDismissReason: vi.fn(),
  stageRework: mockStage,
}));

import { reviewItemId } from '../lib/review-summary';
import { setStore, store } from '../store/core';
import type { Project, Task } from '../store/types';
import { ReviewSection } from './ReviewSection';

/** A project whose review checks were picked before, unless a test says otherwise. */
function setProject(overrides: Partial<Project> = {}) {
  setStore('projects', [
    {
      id: 'project',
      name: 'Weather',
      path: '/repo',
      color: '#fff',
      verifyCommand: 'npm run check',
      evidenceChecks: [
        { id: 'unit', name: 'Unit', kind: 'unit', command: 'npm test', run: 'auto' },
        { id: 'e2e', name: 'E2E', kind: 'e2e', command: 'npm run e2e', run: 'on-demand' },
      ],
      reviewChecks: [],
      ...overrides,
    },
  ]);
}

let dispose: (() => void) | undefined;
beforeEach(() => setProject());
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const OPEN = 'Remember-me path not handled.';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task',
    name: 'Fix login redirect',
    projectId: 'project',
    branchName: 'branch',
    worktreePath: '/repo',
    agentIds: ['agent'],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    brief: {
      brief: { goal: 'Send people back after sign-in.', now: '' },
      generatedAt: 2_000,
      fingerprint: 'same',
    },
    confidence: {
      scores: [
        {
          label: 'Correctness',
          score: 88,
          why: 'Tested.',
          verified: ['read both callers', 'unit tests passed'],
        },
        {
          label: 'Completeness',
          score: 50,
          why: 'Misses remember-me.',
          verified: ['read the login form'],
        },
      ],
      findings: [
        { kind: 'gap', text: OPEN },
        { kind: 'extra', text: 'Renamed parseNext.' },
      ],
      publishedAt: 3_000,
      fingerprint: 'same',
    },
    ...overrides,
  };
}

function mount(task: Task, verifyFailed = false) {
  const [state, setState] = createStore(task);
  const onReworkStaged = vi.fn();
  const onOpenFile = vi.fn();
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => (
      <ReviewSection
        task={state}
        verifyFailed={verifyFailed}
        onReworkStaged={onReworkStaged}
        onOpenFile={onOpenFile}
      />
    ),
    root,
  );
  return { root, setState, onReworkStaged, onOpenFile };
}

const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll('button'));
const button = (root: HTMLElement, label: string | RegExp) => {
  const found = buttons(root).find((b) => {
    const text = b.textContent?.trim() ?? '';
    return typeof label === 'string' ? text === label : label.test(text);
  });
  if (!found) throw new Error(`Missing button ${String(label)}`);
  return found;
};

function dismiss(setState: SetStoreFunction<Task>, text: string, reason = '') {
  setState('reviewDismissed', { [reviewItemId('risk', text)]: { text, reason } });
}

/** The review's box in the follow-ups row: one action that runs or opens the review. */
const toggle = (root: HTMLElement) => {
  const found = root.querySelector<HTMLButtonElement>('.finish-followup .change-tour-action');
  if (!found) throw new Error('Missing review action');
  return found;
};
/** The segment split off the review's box: the reviewer chevron, or × while it runs. */
const chevron = (root: HTMLElement) => {
  const found = root.querySelector<HTMLButtonElement>('.finish-followup .change-tour-model');
  if (!found) throw new Error('Missing reviewer chevron');
  return found;
};
const heading = (root: HTMLElement) =>
  toggle(root).querySelector('.change-tour-action-label')?.firstChild?.textContent;
/** Opens the review unless it opened on its own. */
const expand = (root: HTMLElement) => {
  if (toggle(root).getAttribute('aria-expanded') !== 'true') toggle(root).click();
};
const settings = (root: HTMLElement) => button(root, 'Change settings');

describe('ReviewSection', () => {
  it('asks what to run on the first review in a project and saves the pick', () => {
    setProject({ reviewChecks: undefined });
    const { root } = mount(baseTask({ confidence: undefined }));
    toggle(root).click();
    expect(mockRate).not.toHaveBeenCalled();
    const boxes = [...root.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    const labels = boxes.map((box) => box.closest('label')?.textContent);
    expect(labels).toEqual([
      expect.stringContaining('What changed, risks and scores'),
      expect.stringContaining('npm run check'),
      expect.stringContaining('npm test'),
      expect.stringContaining('npm run e2e'),
    ]);
    // The reviewer always runs; on-demand checks start unpicked.
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [true, false],
      [true, false],
      [false, false],
    ]);
    expect(root.querySelector('fieldset [aria-label^="Reviewer model"]')?.textContent).toBe('opus');
    boxes[2].click();
    button(root, /Start review/).click();
    expect(mockSetChecks).toHaveBeenCalledWith('task', {
      ids: ['verify'],
      verifyCommand: undefined,
      newChecks: [],
    });
    // The reviewer was left as it was, so the task keeps following Settings › Review.
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(mockRate).toHaveBeenCalledWith('task');
    expect(root.querySelector('fieldset')).toBeNull();
  });

  it('sets up missing checks with AI, saving only the suggestions picked', () => {
    setProject({ reviewChecks: undefined, verifyCommand: undefined });
    const { root } = mount(baseTask({ confidence: undefined }));
    toggle(root).click();
    button(root, 'Set up checks with AI').click();
    const labels = [...root.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    const suggested = labels.filter((box) =>
      box.closest('label')?.textContent?.includes('suggested'),
    );
    // npm test is already the unit check, so only verify and lint are new; neither is picked yet.
    expect(suggested.map((box) => [box.closest('label')?.textContent, box.checked])).toEqual([
      [expect.stringContaining('npm run check'), false],
      [expect.stringContaining('npm run lint'), false],
    ]);
    expect(root.textContent).not.toContain('Set up checks with AI');
    suggested[1].click();
    button(root, /Start review/).click();
    expect(mockSetChecks).toHaveBeenCalledWith('task', {
      ids: ['unit', 'static-checks'],
      verifyCommand: undefined,
      newChecks: [
        {
          id: 'static-checks',
          name: 'Static checks',
          kind: 'static',
          command: 'npm run lint',
          run: 'auto',
        },
      ],
    });
  });

  it('says when there is no verify command, and Cancel runs nothing', () => {
    setProject({ reviewChecks: undefined, verifyCommand: undefined });
    const { root } = mount(baseTask({ confidence: undefined }));
    toggle(root).click();
    expect(root.querySelector('fieldset')?.textContent).toContain('No verify command set');
    button(root, 'Cancel').click();
    expect(root.querySelector('fieldset')).toBeNull();
    expect(mockSetChecks).not.toHaveBeenCalled();
    expect(mockRate).not.toHaveBeenCalled();
  });

  it('leaves check results to the readiness rows, and runs again with other settings', () => {
    setProject({ reviewChecks: ['verify', 'unit'] });
    const run = (checkId: string, status: 'passed' | 'failed') => ({
      checkId,
      name: checkId,
      kind: 'unit' as const,
      command: 'x',
      status,
      exitCode: status === 'passed' ? 0 : 1,
      headSha: 'h',
      dirty: false,
      startedAt: 'a',
      finishedAt: 'b',
      outputTail: '',
    });
    const { root } = mount(
      baseTask({
        evidence: {
          checks: [run('verify', 'passed'), run('unit', 'failed')],
          skipped: [],
        } as unknown as Task['evidence'],
      }),
    );
    expand(root);
    // Results sit in the readiness rows above; the review does not say them twice.
    expect(root.querySelector('[aria-label="Confidence"]')?.textContent).not.toContain('Unit');
    settings(root).click();
    const boxes = [...root.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    // It starts from the saved pick.
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true, false]);
    boxes[3].click();
    button(root, /Start review/).click();
    expect(mockSetChecks).toHaveBeenCalledWith('task', {
      ids: ['verify', 'unit', 'e2e'],
      verifyCommand: undefined,
      newChecks: [],
    });
    expect(mockRate).toHaveBeenCalledWith('task');
  });

  it('shows what changed and the key line from the reviewer alone, the ask on hover', () => {
    const task = baseTask({ brief: undefined });
    const { root, onOpenFile } = mount({
      ...task,
      confidence: task.confidence && {
        ...task.confidence,
        asked: 'Keep ?next= through sign-in.',
        changes: [
          { now: 'You land where you were going', before: 'instead of /.', tested: 'unit' },
          { now: 'Lost return URLs are remembered' },
        ],
        keyLine: { file: 'src/auth.ts', line: 72, why: 'The only redirect guard.' },
      },
    });
    expand(root);
    const text = root.textContent ?? '';
    expect(text).not.toContain('Keep ?next=');
    expect(root.querySelector('[title^="Rated against"]')?.getAttribute('title')).toBe(
      'Rated against: Keep ?next= through sign-in.',
    );
    // Changes show unfolded; only a gap in testing is said, the covering tests are on hover.
    const items = [...root.querySelectorAll('ol li')];
    expect(items.map((li) => li.textContent)).toEqual([
      'You land where you were going instead of /.',
      'Lost return URLs are remembereduntested',
    ]);
    expect(items[0].getAttribute('title')).toBe('Tested: unit');
    expect(text).not.toContain('brief');
    button(root, 'src/auth.ts:72').click();
    expect(onOpenFile).toHaveBeenCalledWith('src/auth.ts', 72);
  });

  it('stays one follow-up until asked, and Run review runs the saved pick at once', () => {
    const { root } = mount(baseTask({ confidence: undefined }));
    expect(heading(root)).toBe('Run review');
    expect(toggle(root).title).toContain('Checks the work against what you asked');
    // Nothing to open yet, so the action is no disclosure.
    expect(toggle(root).hasAttribute('aria-expanded')).toBe(false);
    // Opening the dialog sends nothing.
    expect(mockRate).not.toHaveBeenCalled();
    toggle(root).click();
    // The project's checks were picked before, so a task's first review asks nothing.
    expect(root.querySelector('fieldset')).toBeNull();
    expect(mockRate).toHaveBeenCalledWith('task');
  });

  it('closes the first review settings from the review button', () => {
    setProject({ reviewChecks: undefined });
    const { root } = mount(baseTask({ confidence: undefined }));
    toggle(root).click();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(root).title).toBe('Close the review settings');
    toggle(root).click();
    expect(root.querySelector('fieldset')).toBeNull();
    expect(mockRate).not.toHaveBeenCalled();
  });

  it("picks the reviewer for this task in the review's settings", () => {
    setProject({ reviewChecks: undefined });
    setStore('reviewModel', { provider: 'claude', model: 'opus' });
    const { root } = mount(baseTask({ confidence: undefined }));
    toggle(root).click();
    // The open settings carry the pick; the chevron beside the button waits.
    expect(chevron(root).disabled).toBe(true);
    const menu = root.querySelector<HTMLButtonElement>('fieldset [aria-label^="Reviewer model"]');
    if (!menu) throw new Error('Missing reviewer menu');
    expect(menu.textContent).toBe('opus');
    menu.click();
    const sonnet = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (row) => row.textContent?.trim() === 'sonnet',
    );
    if (!sonnet) throw new Error('Missing sonnet row');
    sonnet.click();
    expect(mockSetModel).not.toHaveBeenCalled();
    button(root, /Start review/).click();
    expect(mockSetModel).toHaveBeenCalledWith('task', { provider: 'claude', model: 'sonnet' });
    // Settings › Review stays the default for other tasks.
    expect(store.reviewModel).toEqual({ provider: 'claude', model: 'opus' });
    expect(mockRate).toHaveBeenCalledWith('task');
  });

  it('shows the review running on the reviewer model, and can be cancelled', () => {
    const { root, setState } = mount(
      baseTask({ confidence: undefined, reviewStatus: { state: 'running', startedAt: 5_000 } }),
    );
    expect(heading(root)).toBe('Reviewing with opus');
    expect(toggle(root).querySelector('.inline-spinner')).not.toBeNull();
    expect(buttons(root).some((b) => /Run review/.test(b.textContent ?? ''))).toBe(false);
    // The action shows the run; only the × beside it stops it.
    toggle(root).click();
    expect(mockCancel).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('button[aria-label="Cancel the review"]')?.click();
    expect(mockCancel).toHaveBeenCalledWith('task');
    // The × goes away with the run; focus stays on the review instead of falling to the page.
    expect(document.activeElement).toBe(toggle(root));
    const rated = baseTask().confidence;
    if (!rated) throw new Error('Missing rating');
    setState({ confidence: { ...rated, publishedAt: 6_000 }, reviewStatus: undefined });
    expect(heading(root)).toBe('Review · 50% · 1 open');
  });

  it('opens a review that finished while the dialog was closed', () => {
    mockTakeUnseen.mockReturnValueOnce(true);
    const { root } = mount(baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 } }));
    expect(mockTakeUnseen).toHaveBeenCalledWith('task');
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps an already seen review folded', () => {
    const { root } = mount(baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 } }));
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
  });

  it('says why a review failed and offers it again, with another reviewer', () => {
    const { root } = mount(
      baseTask({ confidence: undefined, reviewStatus: { state: 'failed', message: 'No CLI' } }),
    );
    expect(heading(root)).toBe('Retry review');
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('The review failed: No CLI');
    expect(chevron(root).disabled).toBe(false);
    toggle(root).click();
    expect(mockRate).toHaveBeenCalledWith('task');
  });

  it('switches the reviewer from beside the button without running a review', () => {
    const { root, setState } = mount(baseTask());
    expect(chevron(root).title).toMatch(/^Reviewer: opus/);
    chevron(root).click();
    const sonnet = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (row) => row.textContent?.trim() === 'sonnet',
    );
    if (!sonnet) throw new Error('Missing sonnet row');
    sonnet.click();
    expect(mockSetModel).toHaveBeenCalledWith('task', { provider: 'claude', model: 'sonnet' });
    expect(mockRate).not.toHaveBeenCalled();
    // A running review keeps the reviewer it started with: the × to cancel takes the chevron's place.
    setState({ reviewStatus: { state: 'running', startedAt: 5_000 } });
    expect(root.querySelector('[title^="Reviewer:"]')).toBeNull();
    expect(chevron(root).getAttribute('aria-label')).toBe('Cancel the review');
  });

  it('keeps older scores after a failed review and says they are older', () => {
    const { root } = mount(baseTask({ reviewStatus: { state: 'failed', message: 'Timed out' } }));
    expect(heading(root)).toBe('Review · 50% · 1 open');
    expand(root);
    expect(root.textContent).toContain(
      'The last review failed, so these scores are older: Timed out',
    );
    button(root, 'Run review again').click();
    expect(mockRate).toHaveBeenCalledWith('task');
  });

  it('folds a review of older code into the verdict, and shows it on request', () => {
    const { root } = mount(baseTask({ codeFingerprint: { fingerprint: 'newer', at: 4_000 } }));
    expect(heading(root)).toBe('Review · 50% · 1 open');
    expect(root.querySelector('[aria-label="Confidence"]')).toBeNull();
    expand(root);
    expect(root.querySelector('[aria-label="Confidence"]')).not.toBeNull();
  });

  it('folds a review of the code as it is now until asked, then folds it on request', () => {
    const { root } = mount(baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 } }), true);
    // The readiness row above says verify failed, so the review's line does not repeat it.
    expect(heading(root)).toBe('Review · 50% · 1 open');
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
    toggle(root).click();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
    // The weakest score stands for the whole and says why; a score above the bar keeps its reason on hover.
    // Each reason carries what backs it.
    const card = root.querySelector('[aria-label="Confidence"]');
    expect(card?.textContent).toContain('50%confident · held back by Completeness');
    expect(card?.textContent).toContain('Misses remember-me. Checked: read the login form');
    const others = [...(card?.querySelectorAll('[aria-label="Other scores"] li') ?? [])];
    expect(others.map((li) => [li.textContent, li.getAttribute('title')])).toEqual([
      ['Correctness 88%', 'Tested. Checked: read both callers; unit tests passed'],
    ]);
    expect(card?.textContent).not.toContain('Tested.');
    expect(root.textContent).not.toContain('Cookie lasts 5 minutes.');
    // A current rating can still be run again, say on another model; it is checked against the code as it is now.
    expect(button(root, 'Run review again').disabled).toBe(false);
    expect(mockRefreshCode).toHaveBeenCalledWith('task');
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
    toggle(root).click();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[aria-label="Confidence"]')).toBeNull();
  });

  it('keeps every low score with its reason', () => {
    const task = baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 } });
    const rated = task.confidence;
    if (!rated) throw new Error('Missing rating');
    const scores = [...rated.scores, { label: 'Tested', score: 55, why: 'No e2e.' }];
    const { root } = mount({ ...task, confidence: { ...rated, scores } });
    expand(root);
    const card = root.querySelector('[aria-label="Confidence"]');
    expect(card?.textContent).toContain('Tested 55% · No e2e.');
    expect(card?.querySelectorAll('[aria-label="Other scores"] li')).toHaveLength(1);
  });

  /** A rating of the current code that finds nothing to act on. */
  function cleanTask(overrides: Partial<Task> = {}): Task {
    const task = baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 }, ...overrides });
    return {
      ...task,
      confidence: {
        scores: [{ label: 'Correctness', score: 88, why: 'Tested.' }],
        findings: [],
        publishedAt: 3_000,
        fingerprint: 'same',
      },
    };
  }

  it('leaves a clean review folded, its verdict on the button', async () => {
    const { root } = mount(cleanTask());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heading(root)).toBe('Review · 88% · nothing open');
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a clean review the user watched finish', () => {
    const { root, setState } = mount(
      cleanTask({ reviewStatus: { state: 'running', startedAt: 5_000 } }),
    );
    setState('reviewStatus', undefined);
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
  });

  /** Makes the next code read wait until the test settles it, as a real diff read does. */
  function pendingCodeRead() {
    let finish: () => void = () => {};
    mockRefreshCode.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    return async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
  }

  it('stays folded when the code read confirms the rating is current', async () => {
    const settle = pendingCodeRead();
    const { root, setState } = mount(baseTask());
    setState('codeFingerprint', { fingerprint: 'same', at: 4_000 });
    await settle();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves a review the user folded while the code was read', async () => {
    const settle = pendingCodeRead();
    const { root, setState } = mount(baseTask());
    expand(root);
    toggle(root).click();
    setState('codeFingerprint', { fingerprint: 'same', at: 4_000 });
    await settle();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a review that finishes while the dialog is open', () => {
    const { root, setState } = mount(
      baseTask({
        confidence: undefined,
        reviewStatus: { state: 'running', startedAt: 1 },
      }),
    );
    setState('confidence', baseTask().confidence);
    setState('codeFingerprint', { fingerprint: 'same', at: 4_000 });
    setState('reviewStatus', undefined);
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
  });

  it('collects picks into one staged rework prompt', () => {
    const { root, onReworkStaged } = mount(baseTask());
    expand(root);
    expect(button(root, 'Rework (0)').disabled).toBe(true);
    const icon = () => button(root, 'Fix').querySelector('svg path')?.getAttribute('d');
    const plus = icon();
    expect(plus).toBeTruthy();

    button(root, 'Fix').click();
    expect(icon()).toBeTruthy();
    expect(icon()).not.toBe(plus);
    button(root, 'Revert').click();
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    // The label stays put; only the pressed state and the icon change.
    expect(button(root, 'Fix').getAttribute('aria-pressed')).toBe('true');

    button(root, 'Rework (2)').click();
    expect(mockStage).toHaveBeenCalledWith('task', [
      expect.objectContaining({ text: OPEN }),
      expect.objectContaining({ text: 'Renamed parseNext.' }),
    ]);
    expect(onReworkStaged).toHaveBeenCalled();
  });

  it('keeps a dismissed risk in place with its reason field, and drops its pick', () => {
    const { root, setState } = mount(baseTask());
    expand(root);
    button(root, 'Fix').click();
    expect(button(root, 'Rework (1)')).toBeTruthy();

    button(root, 'Accept').click();
    expect(mockDismiss).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ id: reviewItemId('risk', OPEN) }),
    );
    dismiss(setState, OPEN);
    expect(heading(root)).toBe('Review · 50% · nothing open');
    expect(root.textContent).toContain(OPEN);
    expect(button(root, 'Rework (0)').disabled).toBe(true);
    expect(root.textContent).not.toContain('Accepted earlier');

    const input = root.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error('Missing reason field');
    input.focus();
    // A store update while typing must not rebuild the field under the cursor.
    dismiss(setState, OPEN, 'Gone soon');
    expect(root.querySelector('input[type="text"]')).toBe(input);
    expect(document.activeElement).toBe(input);

    button(root, 'Undo').click();
    expect(mockRestore).toHaveBeenCalledWith('task', reviewItemId('risk', OPEN));
    setState('reviewDismissed', undefined);
    // Undo brings the risk back as it was, pick included.
    expect(button(root, 'Rework (1)').disabled).toBe(false);
  });

  it('names where a risk came from and the score it lowers on hover only', () => {
    const task = baseTask({ codeFingerprint: { fingerprint: 'same', at: 4_000 } });
    const rated = task.confidence;
    if (!rated) throw new Error('Missing rating');
    const findings = [
      { kind: 'risk' as const, text: 'Races on logout.', file: 'src/auth.ts', axis: 'Correctness' },
    ];
    const { root } = mount({ ...task, confidence: { ...rated, findings } });
    expand(root);
    const row = [...root.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Races on logout.'),
    );
    expect(row?.textContent).toContain('src/auth.ts');
    expect(row?.textContent).not.toContain('Lowers');
    expect(row?.querySelector('[title]')?.getAttribute('title')).toBe(
      'From the confidence check · Lowers Correctness',
    );
  });

  it('folds risks dismissed before the dialog opened', () => {
    const task = baseTask({
      reviewDismissed: { [reviewItemId('risk', OPEN)]: { text: OPEN, reason: 'Gone soon' } },
    });
    const { root } = mount(task);
    expand(root);
    expect(root.textContent).toContain('Unsure · none open');
    expect(root.textContent).not.toContain(OPEN);
    button(root, 'Accepted earlier (1)').click();
    expect(root.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Gone soon');
  });

  it('folds long lists behind a show-more button', () => {
    const task = baseTask();
    const confidence = task.confidence;
    if (!confidence) throw new Error('Missing confidence');
    const findings = Array.from({ length: 7 }, (_, i) => ({
      kind: 'extra' as const,
      text: `Extra ${i}.`,
    }));
    const { root } = mount({ ...task, confidence: { ...confidence, findings } });
    expand(root);
    expect(buttons(root).filter((b) => b.textContent?.includes('Revert'))).toHaveLength(5);
    button(root, 'Show 2 more').click();
    expect(buttons(root).filter((b) => b.textContent?.includes('Revert'))).toHaveLength(7);
  });

  it('offers a new rating once the code moved past the old one', () => {
    const { root, setState } = mount(
      baseTask({ codeFingerprint: { fingerprint: 'newer', at: 4_000 } }),
    );
    expand(root);
    expect(root.textContent).toContain('the code changed since');
    button(root, 'Run review again').click();
    expect(mockRate).toHaveBeenCalledWith('task');
    setState('reviewStatus', { state: 'running', startedAt: 5_000 });
    expect(heading(root)).toBe('Reviewing with opus');
    // The old review is not shown while it is being redone.
    expect(root.textContent).not.toContain('the code changed since');
    expect(buttons(root).some((b) => b.textContent === 'Run review again')).toBe(false);
    setState('reviewStatus', undefined);
    expect(root.textContent).toContain('the code changed since');
  });

  it('shows no rework footer when there is nothing to pick', () => {
    const task = baseTask();
    const { root } = mount({
      ...task,
      confidence: { ...task.confidence, scores: [], findings: [], publishedAt: 3_000 },
    });
    expand(root);
    expect(heading(root)).toBe('Review · No open risks');
    expect(buttons(root).some((b) => b.textContent?.startsWith('Rework'))).toBe(false);
  });
});
