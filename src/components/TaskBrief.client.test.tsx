import { render } from 'solid-js/web';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChange, mockKeep, mockMarkRead, mockRate, mockRefreshCode, mockTargetName } =
  vi.hoisted(() => ({
    mockTargetName: vi.fn<() => string | undefined>(),
    mockMarkRead: vi.fn(),
    mockRefreshCode: vi.fn(),
    mockChange: vi.fn(),
    mockKeep: vi.fn(),
    mockRate: vi.fn(),
  }));

vi.mock('../store/task-brief', () => ({
  briefTargetAgentName: mockTargetName,
  changeBriefDecision: mockChange,
  keepBriefDecision: mockKeep,
  markBriefRead: mockMarkRead,
  reopenBriefDecision: vi.fn(),
  refreshTaskBrief: vi.fn(),
  refreshCodeFingerprint: mockRefreshCode,
  requestConfidenceRating: mockRate,
}));

import type { Task } from '../store/types';
import { TaskBriefBar, TaskBriefLine } from './TaskBrief';

let dispose: (() => void) | undefined;
let lastSetState: SetStoreFunction<Task> | undefined;
beforeEach(() => {
  mockTargetName.mockReturnValue(undefined);
});
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
        unbacked: [],
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
    expect(bar.querySelector('[aria-label="Correct 70%"]')?.getAttribute('title')).toBe('Correct');
    expect(bar.querySelector('[aria-label="Complete 40%"] svg')).not.toBeNull();
    expect(bar.textContent).toContain('out of date');
    expect(bar.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps unknown score labels as text', () => {
    const task = baseTask();
    const confidence = task.confidence;
    if (!confidence) throw new Error('Missing rating');
    const { bar } = mount({
      ...task,
      confidence: { ...confidence, scores: [{ label: 'toString', score: 50, why: 'Odd.' }] },
    });
    const score = bar.querySelector('[aria-label="toString 50%"]');
    expect(score?.textContent).toBe('toString50%');
    expect(score?.querySelector('svg')).toBeNull();
  });

  it('counts changed, open and decided items on the bar, rating gaps included', () => {
    const task = baseTask();
    const confidence = task.confidence;
    if (!confidence) throw new Error('Missing rating');
    const { bar } = mount({
      ...task,
      confidence: { ...confidence, findings: [{ kind: 'gap', text: 'No dedupe test.' }] },
    });
    const counts = bar.querySelector('[aria-label$="decided"]');
    expect(counts?.getAttribute('aria-label')).toBe('1 changed, 2 open, 1 decided');
    expect(counts?.textContent).toBe('121');
  });

  it('quietens the decided count once every decision is handled', () => {
    const { bar } = mount(baseTask());
    const decidedIcon = () =>
      bar.querySelector<SVGElement>('[aria-label$="decided"] > span:last-child svg');
    expect(decidedIcon()?.style.color).not.toBe('var(--fg-muted)');
    lastSetState?.('brief', 'decisions', { 'Used BullMQ.': 'kept' });
    expect(decidedIcon()?.style.color).toBe('var(--fg-muted)');
  });

  it('leaves empty sections out of the bar counts', () => {
    const task = baseTask();
    const brief = task.brief;
    if (!brief) throw new Error('Missing brief');
    const { bar } = mount({
      ...task,
      brief: { ...brief, brief: { ...brief.brief, open: [], decided: [] } },
    });
    expect(bar.querySelector('[aria-label="1 changed"]')?.textContent).toBe('1');
  });

  it('opens the full brief with rating findings merged into the sections', () => {
    const { bar, onFileClick } = mount(baseTask());
    bar.click();
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    const text = card()?.textContent ?? '';
    expect(text).toContain('Stop webhook timeouts.');
    expect(text).toContain('Added Redis to production compose.');
    expect(card()?.querySelector('title')?.textContent).toBe('From the confidence rating');
    const headings = Array.from(card()?.querySelectorAll('h3') ?? []).map((h) =>
      h.getAttribute('aria-label'),
    );
    expect(headings).toEqual(['Open (1)', 'Decided (1)', 'Extra (1)', 'Changed (1)']);
    expect(text).toContain('code changed since');
    // What changed is collapsed, since the diff and the agent's message say it already.
    expect(text).not.toContain('Route queues the event.');
    const toggle = card()?.querySelector<HTMLButtonElement>('h3[aria-label^="Changed"] button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    expect(card()?.textContent).toContain('Route queues the event.');
    button('src/webhooks.ts')?.click();
    expect(onFileClick).toHaveBeenCalledWith('src/webhooks.ts');
    expect(card()).toBeNull();
  });

  it('marks a new brief on the bar until the card is opened', () => {
    const task = baseTask();
    const brief = task.brief;
    if (!brief) throw new Error('Missing brief');
    const { bar } = mount({ ...task, brief: { ...brief, unread: true } });
    const dot = () => bar.querySelector<HTMLElement>('.task-brief-unread');
    expect(dot()?.style.visibility).toBe('visible');
    bar.click();
    expect(mockMarkRead).toHaveBeenCalledWith('task');
    lastSetState?.('brief', 'unread', undefined);
    // Hidden rather than removed, so the headline does not shift.
    expect(dot()?.style.visibility).toBe('hidden');
  });

  it('flags claims the diff does not back on the bar and leads the card with them', () => {
    const task = baseTask();
    const brief = task.brief;
    if (!brief) throw new Error('Missing brief');
    const { bar } = mount(task);
    expect(bar.getAttribute('style')).not.toContain('var(--warning)');
    lastSetState?.('brief', 'brief', 'unbacked', [{ text: 'Says it added dedupe tests.' }]);
    expect(bar.getAttribute('style')).toContain('var(--warning)');
    expect(bar.querySelector('[aria-label^="1 unbacked"]')).not.toBeNull();
    bar.click();
    expect(card()?.querySelector('h3')?.getAttribute('aria-label')).toBe('Not in diff (1)');
    expect(card()?.textContent).toContain('Says it added dedupe tests.');
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

  it('quietens the Decided icon once every decision is handled', () => {
    const { bar } = mount(baseTask());
    bar.click();
    const decidedIcon = () =>
      card()?.querySelector('h3[aria-label^="Decided"] svg')?.getAttribute('style') ?? '';
    expect(decidedIcon()).toContain('var(--review)');
    lastSetState?.('brief', 'decisions', { 'Used BullMQ.': 'kept' });
    expect(decidedIcon()).toContain('var(--fg-muted)');
    lastSetState?.('brief', 'decisions', { 'Used BullMQ.': 'sent' });
    expect(decidedIcon()).toContain('var(--fg-muted)');
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

  it('checks a rating against the current code when opened', () => {
    const { bar } = mount(baseTask({ brief: undefined }));
    bar.click();
    expect(mockRefreshCode).toHaveBeenCalledWith('task');
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

  it('leaves Escape to the focused element once closed by a click outside', () => {
    const { bar } = mount(baseTask());
    const terminal = document.createElement('textarea');
    document.body.append(terminal);
    bar.click();
    terminal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(card()).toBeNull();

    terminal.focus();
    const reached = vi.fn();
    terminal.addEventListener('keydown', reached);
    terminal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reached).toHaveBeenCalled();
    expect(document.activeElement).toBe(terminal);
    terminal.remove();
  });

  it('names the agent a rating goes to when the task has several', () => {
    mockTargetName.mockReturnValue('Codex');
    const { bar } = mount(baseTask({ confidence: undefined }));
    bar.click();
    expect(button('Rate confidence · Codex')).toBeDefined();
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
