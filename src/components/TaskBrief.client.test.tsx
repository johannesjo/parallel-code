import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/task-brief', () => ({ refreshTaskBrief: vi.fn() }));
const [working, setWorking] = createSignal(false);
vi.mock('../store/taskStatus', () => ({ isTaskWorking: () => working() }));

import type { Task } from '../store/types';
import type { BriefBarFields } from '../lib/task-brief';
import { TaskBriefBar, TaskBriefLine } from './TaskBrief';

let dispose: (() => void) | undefined;
let lastSetState: SetStoreFunction<Task> | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setWorking(false);
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
        now: 'Two events queued; moving the other nine next.',
      },
      generatedAt: 2_000,
      fingerprint: 'new',
    },
    confidence: {
      scores: [
        { label: 'Correct', score: 70, why: 'Happy path tested.', verified: ['read the worker'] },
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

const QUESTION = 'Deduplicate by event ID or invoice ID?';
const DEFAULT_FIELDS: BriefBarFields = { goal: true, now: false, needsYou: true };

function mount(
  task: Task,
  { fields = DEFAULT_FIELDS, questionInPrompt = false } = {} as {
    fields?: BriefBarFields;
    questionInPrompt?: boolean;
  },
) {
  const [state, setState] = createStore(task);
  lastSetState = setState;
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => <TaskBriefBar task={state} fields={fields} questionInPrompt={questionInPrompt} />,
    root,
  );
  const bar = root.querySelector<HTMLButtonElement>('.task-brief-bar');
  if (!bar) throw new Error('Missing brief bar');
  return { bar };
}

const card = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Task brief"]');
const button = (label: string) =>
  Array.from(card()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label);
const cardTerms = () =>
  Array.from(card()?.querySelectorAll('dt') ?? []).map((dt) => dt.textContent);

describe('TaskBriefBar', () => {
  it('shows the goal by default, leaving the current step to the card', () => {
    const { bar } = mount(baseTask());
    expect(bar.textContent).toContain('Goal');
    expect(bar.textContent).toContain('Stop webhook timeouts.');
    expect(bar.textContent).not.toContain('Now');
    expect(bar.textContent).not.toContain('Two events queued');
    expect(bar.hasAttribute('data-urgent')).toBe(false);
    expect(bar.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a labelled line for each chosen field', () => {
    const { bar } = mount(baseTask(), { fields: { goal: true, now: true, needsYou: true } });
    expect(bar.textContent).toContain('Goal');
    expect(bar.textContent).toContain('Stop webhook timeouts.');
    expect(bar.textContent).toContain('Now');
    expect(bar.textContent).toContain('Two events queued; moving the other nine next.');
  });

  it('skips a chosen field the brief leaves empty', () => {
    const task = baseTask();
    const { bar } = mount(
      {
        ...task,
        brief: { generatedAt: 2_000, fingerprint: 'new', brief: { goal: '', now: 'Step' } },
      },
      { fields: { goal: true, now: true, needsYou: true } },
    );
    expect(bar.textContent).not.toContain('Goal');
    expect(bar.textContent).toContain('Step');
  });

  it('keeps a quiet label that opens the card when every field is off', () => {
    const { bar } = mount(baseTask(), { fields: { goal: false, now: false, needsYou: false } });
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    expect(bar.textContent).toContain('Brief');
    expect(bar.textContent).not.toContain('Stop webhook timeouts.');
    expect(bar.textContent).not.toContain('Deduplicate');
    expect(bar.hasAttribute('data-urgent')).toBe(false);
    bar.click();
    expect(cardTerms()).toEqual(['Goal', 'Now', 'Needs you']);
  });

  it('opens the goal and the current step, and leaves ratings to the Finish review', () => {
    const { bar } = mount(baseTask());
    // The fixture carries a rating, which belongs to finishing rather than to the brief.
    expect(bar.textContent).not.toContain('%');
    expect(bar.textContent).not.toContain('out of date');
    bar.click();
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    expect(cardTerms()).toEqual(['Goal', 'Now']);
    const text = card()?.textContent ?? '';
    expect(text).toContain('Stop webhook timeouts.');
    expect(text).toContain('Two events queued; moving the other nine next.');
    expect(text).not.toContain('Happy path tested.');
    expect(button('Run review')).toBeUndefined();
    expect(button('Review again')).toBeUndefined();
  });

  it('puts what the agent needs on the top line and flags the bar', () => {
    const { bar } = mount(baseTask(), { fields: { goal: true, now: true, needsYou: true } });
    expect(bar.textContent).not.toContain('Needs you');
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    expect(bar.hasAttribute('data-urgent')).toBe(true);
    expect(bar.textContent).toContain('Needs you');
    expect(bar.textContent).toContain(QUESTION);
    // Replaces the top line rather than adding one, so the header keeps its height.
    expect(bar.textContent).not.toContain('Stop webhook timeouts.');
    expect(bar.textContent).toContain('Two events queued');
    bar.click();
    expect(cardTerms()).toEqual(['Goal', 'Now', 'Needs you']);
  });

  it('puts the question in place of the current step when it is the only line', () => {
    const { bar } = mount(baseTask(), { fields: { goal: false, now: true, needsYou: true } });
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    expect(bar.textContent).toContain(QUESTION);
    expect(bar.textContent).not.toContain('Two events queued');
    expect(bar.textContent).not.toContain('Stop webhook timeouts.');
  });

  it('leaves the question to the card when Needs you is off', () => {
    const { bar } = mount(baseTask(), { fields: { goal: true, now: false, needsYou: false } });
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    expect(bar.hasAttribute('data-urgent')).toBe(false);
    expect(bar.textContent).not.toContain('Deduplicate');
    expect(bar.textContent).toContain('Stop webhook timeouts.');
  });

  it('keeps to the other fields when the prompt box shows the question', () => {
    const { bar } = mount(baseTask(), { questionInPrompt: true });
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    expect(bar.hasAttribute('data-urgent')).toBe(false);
    expect(bar.textContent).not.toContain('Deduplicate');
    expect(bar.textContent).toContain('Stop webhook timeouts.');
    bar.click();
    expect(cardTerms()).toEqual(['Goal', 'Now', 'Needs you']);
  });

  it('drops a question the agent has moved past while it works on the answer', () => {
    const { bar } = mount(baseTask());
    lastSetState?.('brief', 'brief', 'needsYou', QUESTION);
    setWorking(true);
    expect(bar.hasAttribute('data-urgent')).toBe(false);
    expect(bar.textContent).not.toContain('Needs you');
    expect(bar.textContent).not.toContain('Deduplicate');
    expect(bar.textContent).toContain('Stop webhook timeouts.');
    bar.click();
    expect(cardTerms()).toEqual(['Goal', 'Now']);
  });

  it('closes on Escape', () => {
    const { bar } = mount(baseTask());
    bar.click();
    expect(card()).not.toBeNull();
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

  it('explains the empty state before the first brief', () => {
    const { bar } = mount(baseTask({ brief: undefined }));
    expect(bar.textContent).toContain('The brief appears after the agent finishes a turn');
  });
});

describe('TaskBriefLine', () => {
  it('shows what the agent needs, else the current step, and nothing without a brief', () => {
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(
      () => (
        <>
          <TaskBriefLine task={baseTask()} />
          <TaskBriefLine task={baseTask({ brief: undefined })} />
          <TaskBriefLine
            task={baseTask({
              brief: {
                brief: { goal: 'g', now: 'n', needsYou: 'Which queue?' },
                generatedAt: 0,
                fingerprint: '',
              },
            })}
          />
        </>
      ),
      root,
    );
    const lines = Array.from(root.querySelectorAll('.task-brief-line'), (el) => el.textContent);
    expect(lines).toEqual(['Two events queued; moving the other nine next.', 'Which queue?']);
  });
});
