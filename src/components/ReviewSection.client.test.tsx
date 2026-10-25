import { render } from 'solid-js/web';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockDismiss, mockKeep, mockRate, mockRefreshCode, mockRestore, mockStage } = vi.hoisted(
  () => ({
    mockDismiss: vi.fn(),
    mockKeep: vi.fn(),
    mockRate: vi.fn(() => Promise.resolve()),
    mockRefreshCode: vi.fn(),
    mockRestore: vi.fn(),
    mockStage: vi.fn(() => true),
  }),
);

vi.mock('../store/task-brief', () => ({
  briefTargetAgentName: () => undefined,
  keepBriefDecision: mockKeep,
  refreshCodeFingerprint: mockRefreshCode,
  refreshTaskBrief: vi.fn(),
  reopenBriefDecision: vi.fn(),
  requestConfidenceRating: mockRate,
}));

vi.mock('../store/review', () => ({
  dismissReviewItem: mockDismiss,
  restoreReviewItem: mockRestore,
  setReviewDismissReason: vi.fn(),
  stageRework: mockStage,
}));

import { reviewItemId } from '../lib/review-summary';
import type { Task } from '../store/types';
import { ReviewSection } from './ReviewSection';

let dispose: (() => void) | undefined;
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
      brief: {
        goal: 'Send people back after sign-in.',
        headline: '',
        unbacked: [],
        changed: [{ text: 'Sign-in lands on the requested page.' }],
        extra: [{ text: 'Renamed parseNext.' }],
        open: [{ text: OPEN }],
        decided: [{ text: 'Cookie lasts 5 minutes.' }],
      },
      generatedAt: 2_000,
      fingerprint: 'same',
      turns: [],
      decisions: {},
    },
    confidence: {
      scores: [
        { label: 'Correctness', score: 88, why: 'Tested.' },
        { label: 'Completeness', score: 50, why: 'Misses remember-me.' },
      ],
      findings: [],
      publishedAt: 3_000,
      fingerprint: 'same',
    },
    ...overrides,
  };
}

function mount(task: Task, verifyFailed = false) {
  const [state, setState] = createStore(task);
  const onReworkStaged = vi.fn();
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => (
      <ReviewSection task={state} verifyFailed={verifyFailed} onReworkStaged={onReworkStaged} />
    ),
    root,
  );
  return { root, setState, onReworkStaged };
}

const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll('button'));
const button = (root: HTMLElement, label: string | RegExp) => {
  const found = buttons(root).find((b) => {
    const text = b.textContent?.replace('✓', '').trim() ?? '';
    return typeof label === 'string' ? text === label : label.test(text);
  });
  if (!found) throw new Error(`Missing button ${String(label)}`);
  return found;
};

function dismiss(setState: SetStoreFunction<Task>, text: string, reason = '') {
  setState('reviewDismissed', { [reviewItemId('risk', text)]: { text, reason } });
}

describe('ReviewSection', () => {
  it('leads with the verdict, the ask and the low score with its reason', () => {
    const { root } = mount(baseTask(), true);
    expect(root.querySelector('h3')?.textContent).toBe('Verify failed · 1 open risk');
    expect(root.textContent).toContain('Asked: Send people back after sign-in.');
    expect(root.textContent).toContain('Completeness 50 · Misses remember-me.');
    expect(root.textContent).toContain('Correctness 88 looks fine');
    expect(root.textContent).toContain('Sign-in lands on the requested page.');
    // A current rating needs no new one, but is checked against the code as it is now.
    expect(buttons(root).some((b) => /Rate confidence/.test(b.textContent ?? ''))).toBe(false);
    expect(mockRefreshCode).toHaveBeenCalledWith('task');
  });

  it('collects picks into one staged rework prompt', () => {
    const { root, onReworkStaged } = mount(baseTask());
    expect(button(root, 'Rework (0)').disabled).toBe(true);

    button(root, 'Add to rework').click();
    button(root, 'Ask to revert').click();
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    // The label stays put; only the pressed state and the tick change.
    expect(button(root, 'Add to rework').getAttribute('aria-pressed')).toBe('true');

    button(root, 'Rework (2)').click();
    expect(mockStage).toHaveBeenCalledWith('task', [
      expect.objectContaining({ text: OPEN }),
      expect.objectContaining({ text: 'Renamed parseNext.' }),
    ]);
    expect(onReworkStaged).toHaveBeenCalled();
  });

  it('keeps a dismissed risk in place with its reason field, and drops its pick', () => {
    const { root, setState } = mount(baseTask());
    button(root, 'Add to rework').click();
    expect(button(root, 'Rework (1)')).toBeTruthy();

    button(root, 'Not needed').click();
    expect(mockDismiss).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ id: reviewItemId('risk', OPEN) }),
    );
    dismiss(setState, OPEN);
    expect(root.querySelector('h3')?.textContent).toBe('No open risks');
    expect(root.textContent).toContain(OPEN);
    expect(button(root, 'Rework (0)').disabled).toBe(true);
    expect(root.textContent).not.toContain('Dismissed earlier');

    const input = root.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error('Missing reason field');
    input.focus();
    // A store update while typing must not rebuild the field under the cursor.
    dismiss(setState, OPEN, 'Gone soon');
    expect(root.querySelector('input[type="text"]')).toBe(input);
    expect(document.activeElement).toBe(input);

    button(root, 'Undo').click();
    expect(mockRestore).toHaveBeenCalledWith('task', reviewItemId('risk', OPEN));
  });

  it('folds risks dismissed before the dialog opened', () => {
    const task = baseTask({
      reviewDismissed: { [reviewItemId('risk', OPEN)]: { text: OPEN, reason: 'Gone soon' } },
    });
    const { root } = mount(task);
    expect(root.textContent).toContain('Nothing open.');
    expect(root.textContent).not.toContain(OPEN);
    button(root, 'Dismissed earlier (1)').click();
    expect(root.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Gone soon');
  });

  it('keeps a kept decision on screen with an undo', () => {
    const { root, setState } = mount(baseTask());
    button(root, 'Keep').click();
    expect(mockKeep).toHaveBeenCalledWith('task', 'Cookie lasts 5 minutes.');
    setState('brief', 'decisions', { 'Cookie lasts 5 minutes.': 'kept' });
    expect(root.textContent).toContain('Cookie lasts 5 minutes. · kept');
    expect(button(root, 'Undo')).toBeTruthy();
  });

  it('folds long lists behind a show-more button', () => {
    const task = baseTask();
    const brief = task.brief;
    if (!brief) throw new Error('Missing brief');
    const extra = Array.from({ length: 7 }, (_, i) => ({ text: `Extra ${i}.` }));
    const { root } = mount({ ...task, brief: { ...brief, brief: { ...brief.brief, extra } } });
    expect(buttons(root).filter((b) => b.textContent?.includes('Ask to revert'))).toHaveLength(5);
    button(root, 'Show 2 more').click();
    expect(buttons(root).filter((b) => b.textContent?.includes('Ask to revert'))).toHaveLength(7);
  });

  it('offers a new rating once the code moved past the old one, once', async () => {
    const { root } = mount(baseTask({ codeFingerprint: { fingerprint: 'newer', at: 4_000 } }));
    expect(root.textContent).toContain('the code changed since this rating');
    button(root, 'Rate confidence again').click();
    expect(mockRate).toHaveBeenCalledWith('task');
    await vi.waitFor(() =>
      expect(button(root, /^Rating asked for/).hasAttribute('disabled')).toBe(true),
    );
  });

  it('shows no rework footer when there is nothing to pick', () => {
    const { root } = mount(baseTask({ brief: undefined, confidence: undefined }));
    expect(root.querySelector('h3')?.textContent).toBe('Not reviewed yet');
    expect(buttons(root).some((b) => b.textContent?.startsWith('Rework'))).toBe(false);
  });
});
