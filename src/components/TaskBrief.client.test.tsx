import { render } from 'solid-js/web';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChange, mockKeep, mockRate, mockRefreshCode } = vi.hoisted(() => ({
  mockRefreshCode: vi.fn(),
  mockChange: vi.fn(),
  mockKeep: vi.fn(),
  mockRate: vi.fn(),
}));

vi.mock('../store/task-brief', () => ({
  changeBriefDecision: mockChange,
  keepBriefDecision: mockKeep,
  reopenBriefDecision: vi.fn(),
  refreshTaskBrief: vi.fn(),
  refreshCodeFingerprint: mockRefreshCode,
  requestConfidenceRating: mockRate,
}));

import { setStore } from '../store/core';
import type { Task } from '../store/types';
import { TaskBriefBar, TaskBriefLine } from './TaskBrief';

let dispose: (() => void) | undefined;
let lastSetState: SetStoreFunction<Task> | undefined;
beforeEach(() => setStore('taskBriefs', true));
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task',
    name: 'Move billing webhooks onto a queue',
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
        goal: 'Stop webhook timeouts.',
        headline: 'Deduplicate by event ID or invoice ID?',
        changed: [{ text: 'Route queues the event.', file: 'src/webhooks.ts' }],
        extra: [],
        open: [{ text: 'Nine event types still synchronous.' }],
        decided: [{ text: 'Used BullMQ.' }],
      },
      generatedAt: 2_000,
      fingerprint: 'new',
      turns: [{ prompt: 'Move it to a queue', outcome: 'Queued two events.', endedAt: 1_000 }],
      decisions: {},
    },
    confidence: {
      scores: [
        { label: 'Correct', score: 70, why: 'Happy path tested.' },
        { label: 'Complete', score: 40, why: 'No dedupe.' },
      ],
      findings: [{ kind: 'extra', text: 'Added Redis to production compose.' }],
      source: 'review skill',
      publishedAt: 1_000,
      fingerprint: 'old',
    },
    ...overrides,
  };
}

function mount(task: Task, onFileClick = vi.fn()) {
  const [state, setState] = createStore(task);
  lastSetState = setState;
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <TaskBriefBar task={state} onFileClick={onFileClick} />, root);
  const bar = root.querySelector<HTMLButtonElement>('.task-brief-bar');
  if (!bar) throw new Error('Missing brief bar');
  return { bar, onFileClick };
}

const card = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Task brief"]');
const button = (label: string) =>
  Array.from(card()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label);

describe('TaskBriefBar', () => {
  it('shows the headline and scores compactly and marks a rating the code moved past', () => {
    const { bar } = mount(baseTask());
    expect(bar.textContent).toContain('Deduplicate by event ID or invoice ID?');
    expect(bar.textContent).toContain('Correct 70%');
    expect(bar.textContent).toContain('Complete 40%');
    expect(bar.textContent).toContain('out of date');
    expect(bar.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the full brief with rating findings merged into the sections', () => {
    const { bar, onFileClick } = mount(baseTask());
    bar.click();
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    const text = card()?.textContent ?? '';
    expect(text).toContain('Stop webhook timeouts.');
    expect(text).toContain('Route queues the event.');
    expect(text).toContain('Added Redis to production compose.');
    expect(text).toContain('from the rating');
    expect(text).toContain('code changed since');
    button('src/webhooks.ts')?.click();
    expect(onFileClick).toHaveBeenCalledWith('src/webhooks.ts');
    expect(card()).toBeNull();
  });

  it('keeps a decision or sends the typed change to the agent', async () => {
    mockChange.mockResolvedValue(undefined);
    const { bar } = mount(baseTask());
    bar.click();
    button('Keep')?.click();
    expect(mockKeep).toHaveBeenCalledWith('task', 'Used BullMQ.');
    button('Change…')?.click();
    const textarea = card()?.querySelector('textarea');
    if (!textarea) throw new Error('Missing correction field');
    expect(textarea.value).toBe('About your decision "Used BullMQ.": ');
    textarea.value = 'Use pg-boss instead.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button('Send to agent')?.click();
    await vi.waitFor(() =>
      expect(mockChange).toHaveBeenCalledWith('task', 'Used BullMQ.', 'Use pg-boss instead.'),
    );
  });

  it('keeps a half-typed correction when the brief is rewritten', () => {
    const { bar } = mount(baseTask());
    bar.click();
    button('Change…')?.click();
    const textarea = card()?.querySelector('textarea');
    if (!textarea) throw new Error('Missing correction field');
    textarea.value = 'Half typed';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    lastSetState?.('brief', 'brief', 'decided', [{ text: 'Used BullMQ.' }, { text: 'New one.' }]);
    expect(card()?.querySelector('textarea')?.value).toBe('Half typed');
  });

  it('keeps each draft and lets only its own send clear it', async () => {
    let finishSend: () => void = () => {};
    mockChange.mockReturnValueOnce(new Promise<void>((resolve) => (finishSend = resolve)));
    const task = baseTask();
    task.brief?.brief.decided.push({ text: 'Retries 5 times.' });
    const { bar } = mount(task);
    bar.click();
    const changeButtons = () =>
      Array.from(card()?.querySelectorAll('button') ?? []).filter(
        (b) => b.textContent === 'Change…',
      );
    changeButtons()[0]?.click();
    button('Send to agent')?.click();
    expect(button('Sending…')).toBeDefined();
    changeButtons()[0]?.click();
    const fields = () => Array.from(card()?.querySelectorAll('textarea') ?? []);
    expect(fields()).toHaveLength(2);
    fields()[1].value = 'Alert on-call instead';
    fields()[1].dispatchEvent(new Event('input', { bubbles: true }));
    finishSend();
    await vi.waitFor(() => expect(fields()).toHaveLength(1));
    expect(fields()[0].value).toBe('Alert on-call instead');
  });

  it('checks a rating against the current code when opened with briefs off', () => {
    setStore('taskBriefs', false);
    const { bar } = mount(baseTask({ brief: undefined }));
    expect(bar.textContent).toContain('Confidence rating');
    bar.click();
    expect(mockRefreshCode).toHaveBeenCalledWith('task');
    expect(card()?.textContent).toContain('Task briefs are off');
  });

  it('marks a rating out of date from a newer code check', () => {
    const { bar } = mount(
      baseTask({ brief: undefined, codeFingerprint: { fingerprint: 'changed', at: 5_000 } }),
    );
    expect(bar.textContent).toContain('out of date');
  });

  it('closes on Escape and asks for a rating from the footer', () => {
    mockRate.mockResolvedValue(undefined);
    const { bar } = mount(baseTask({ confidence: undefined }));
    expect(bar.textContent).not.toContain('%');
    bar.click();
    button('Rate confidence')?.click();
    expect(mockRate).toHaveBeenCalledWith('task');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card()).toBeNull();
  });

  it('explains the empty state before the first brief', () => {
    const { bar } = mount(baseTask({ brief: undefined, confidence: undefined }));
    expect(bar.textContent).toContain('The brief appears after the agent finishes a turn');
  });
});

describe('TaskBriefLine', () => {
  it('shows only the headline and nothing without a brief', () => {
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(
      () => (
        <>
          <TaskBriefLine task={baseTask()} />
          <TaskBriefLine task={baseTask({ brief: undefined })} />
        </>
      ),
      root,
    );
    expect(root.querySelectorAll('.task-brief-line')).toHaveLength(1);
    expect(root.textContent).toBe('Deduplicate by event ID or invoice ID?');
  });
});
