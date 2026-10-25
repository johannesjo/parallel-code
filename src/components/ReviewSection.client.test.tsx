import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockDismiss, mockKeep, mockRate, mockRestore, mockStage } = vi.hoisted(() => ({
  mockDismiss: vi.fn(),
  mockKeep: vi.fn(),
  mockRate: vi.fn(),
  mockRestore: vi.fn(),
  mockStage: vi.fn(() => true),
}));

vi.mock('../store/task-brief', () => ({
  keepBriefDecision: mockKeep,
  refreshTaskBrief: vi.fn(),
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
        open: [{ text: 'Remember-me path not handled.' }],
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
        { label: 'Completeness', score: 64, why: 'Misses remember-me.' },
      ],
      findings: [],
      publishedAt: 3_000,
      fingerprint: 'same',
    },
    ...overrides,
  };
}

function mount(task: Task, failingChecks = 0) {
  const [state] = createStore(task);
  const onReworkStaged = vi.fn();
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => (
      <ReviewSection task={state} failingChecks={failingChecks} onReworkStaged={onReworkStaged} />
    ),
    root,
  );
  return { root, onReworkStaged };
}

const button = (root: HTMLElement, label: string) => {
  const found = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};

describe('ReviewSection', () => {
  it('leads with the verdict, the ask and the low score with its reason', () => {
    const { root } = mount(baseTask(), 1);
    expect(root.querySelector('h3')?.textContent).toBe('1 open risk · 1 check failing');
    expect(root.textContent).toContain('Asked: Send people back after sign-in.');
    expect(root.textContent).toContain('Completeness 64 · Misses remember-me.');
    expect(root.textContent).toContain('Correctness 88 look fine');
    expect(root.textContent).toContain('Sign-in lands on the requested page.');
    // A current rating needs no new one.
    expect(Array.from(root.querySelectorAll('button')).map((b) => b.textContent)).not.toContain(
      'Rate confidence',
    );
  });

  it('collects picks into one staged rework prompt', () => {
    const { root, onReworkStaged } = mount(baseTask());
    const rework = button(root, 'Rework (0)');
    expect(rework.disabled).toBe(true);

    button(root, 'Add to rework').click();
    button(root, 'Ask to revert').click();
    expect(button(root, 'Rework (2)').disabled).toBe(false);
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);

    button(root, 'Rework (2)').click();
    expect(mockStage).toHaveBeenCalledWith(
      'task',
      [
        expect.objectContaining({ text: 'Remember-me path not handled.' }),
        expect.objectContaining({ text: 'Renamed parseNext.' }),
      ],
      '',
    );
    expect(onReworkStaged).toHaveBeenCalled();
  });

  it('dismisses a risk and keeps a decision through the store', () => {
    const { root } = mount(baseTask());
    button(root, 'Not needed').click();
    expect(mockDismiss).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ id: reviewItemId('risk', 'Remember-me path not handled.') }),
    );
    button(root, 'Keep').click();
    expect(mockKeep).toHaveBeenCalledWith('task', 'Cookie lasts 5 minutes.');
  });

  it('lists dismissed risks with their reason and an undo', () => {
    const id = reviewItemId('risk', 'Remember-me path not handled.');
    const { root } = mount(
      baseTask({
        reviewDismissed: { [id]: { text: 'Remember-me path not handled.', reason: 'Gone soon' } },
      }),
    );
    expect(root.querySelector('h3')?.textContent).toBe('No open risks');
    expect(root.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Gone soon');
    button(root, 'Undo').click();
    expect(mockRestore).toHaveBeenCalledWith('task', id);
  });

  it('offers a new rating once the code moved past the old one', () => {
    const task = baseTask();
    const brief = task.brief;
    if (!brief) throw new Error('Missing brief');
    const { root } = mount({
      ...task,
      brief: { ...brief, fingerprint: 'newer', generatedAt: 4_000 },
    });
    expect(root.textContent).toContain('the code changed since this rating');
    button(root, 'Rate confidence again').click();
    expect(mockRate).toHaveBeenCalledWith('task');
  });
});
