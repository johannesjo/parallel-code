import { createStore } from 'solid-js/store';
import { store } from '../store/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import {
  createUnderstandingTour,
  type UnderstandingTourController,
} from '../lib/create-understanding-tour';
import { TaskNotesBody } from './TaskNotesBody';

const { setAskCodeProvider, setAskCodeModel } = vi.hoisted(() => ({
  setAskCodeProvider: vi.fn(),
  setAskCodeModel: vi.fn(),
}));

vi.mock('../store/store', () => ({
  store: { showPlans: true, focusMode: false },
  setAskCodeProvider,
  setAskCodeModel,
  updateTaskNotes: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
  sendPrompt: vi.fn(),
  isAgentAskingQuestion: () => false,
  isPanelFocused: () => false,
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  store.showPlans = true;
  vi.clearAllMocks();
});

const task: Task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  branchName: 'task/plan',
  worktreePath: '/tmp/task',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  planContent: '# Plan\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n',
  planFileName: 'plan.md',
};

/** Every footer button carries the same class, so they are told apart by label. */
function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`No button labelled ${label}`);
  return button;
}

/** Focus opens the hint at once; hover waits for the pointer to settle. */
function showHint(button: HTMLElement): HTMLElement {
  button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const hint = document.querySelector<HTMLElement>('[role="tooltip"]');
  if (!hint) throw new Error('No tour hint shown');
  return hint;
}

describe('TaskNotesBody plan button', () => {
  function renderPlan(options: {
    task: Task;
    onPlanFullscreen?: () => void;
    onPlanTour?: () => void;
    onAgentTour?: () => void;
    /** Overrides on the real controller, to render a state without generating. */
    understanding?: Partial<UnderstandingTourController>;
  }) {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <TaskNotesBody
            task={options.task}
            agentId="agent-1"
            onPlanFullscreen={options.onPlanFullscreen ?? (() => undefined)}
            understanding={{ ...createUnderstandingTour(), ...options.understanding }}
            onPlanTour={options.onPlanTour ?? (() => undefined)}
            onAgentTour={options.onAgentTour ?? (() => undefined)}
          />
        ),
        container,
      ),
    );
    return container;
  }

  it('keeps notes visible and opens the plan viewer from a single button', () => {
    const onPlanFullscreen = vi.fn();
    const container = renderPlan({ task: { ...task, notes: 'Keep this note.' }, onPlanFullscreen });

    expect(container.querySelector('textarea')?.value).toBe('Keep this note.');
    // Left to right: send arrow, plan button, tour button, its model chevron.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '',
      'Review Plan',
      'Take Tour',
      '',
    ]);
    buttonLabelled(container, 'Review Plan').click();
    expect(onPlanFullscreen).toHaveBeenCalledOnce();
    expect(container.querySelector('.plan-markdown')).toBeNull();
  });

  it('keeps the plan actions out of the note, in a footer below the editor', () => {
    const container = renderPlan({ task: { ...task, notes: 'Keep this note.' } });

    const footer = container.querySelector('.notes-tour-footer');
    const textarea = container.querySelector('textarea');
    expect(footer).not.toBeNull();
    // The send arrow still floats in the corner; the plan actions no longer do.
    expect(footer?.contains(buttonLabelled(container, 'Review Plan'))).toBe(true);
    expect(footer?.contains(buttonLabelled(container, 'Take Tour'))).toBe(true);
    expect(footer?.querySelector('.send-notes-btn')).toBeNull();
    expect(textarea?.compareDocumentPosition(footer as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('reserves height for the footer so it never sits on the editor', () => {
    const withFooter = renderPlan({ task });
    const withoutFooter = renderPlan({ task: { ...task, planContent: undefined } });

    const height = (container: HTMLElement) =>
      container.querySelector<HTMLElement>('.task-notes-body')?.style.minHeight;
    expect(height(withoutFooter)).toBe('56px');
    expect(height(withFooter)).toBe('87px');
  });

  it('keeps the notes editor mounted when a plan arrives or disappears', () => {
    const [notesTask, setNotesTask] = createStore<Task>({ ...task, planContent: undefined });
    const container = renderPlan({ task: notesTask });
    const textarea = container.querySelector('textarea');
    textarea?.focus();

    setNotesTask('planContent', '# New plan');
    // Review Plan, Take Tour and the model chevron glued to it.
    expect(container.querySelectorAll('.notes-tour-footer button')).toHaveLength(3);
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);

    setNotesTask('planContent', undefined);
    expect(container.querySelector('.notes-tour-footer')).toBeNull();
    expect(container.querySelector('textarea')).toBe(textarea);
  });

  it('hides the plan button when plans are disabled', () => {
    store.showPlans = false;
    const container = renderPlan({ task });
    expect(container.querySelector('.notes-tour-footer')).toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('names the detected plan file in a popover on Review Plan', () => {
    const container = renderPlan({ task: { ...task, planPath: '.claude/plans/theme-plan.md' } });

    const review = buttonLabelled(container, 'Review Plan');
    // A popover, not a native tooltip: the two together would double up.
    expect(review.title).toBe('');
    const hint = showHint(review);
    expect(hint.textContent).toContain('Plan for this task');
    expect(hint.textContent).toContain('.claude/plans/theme-plan.md');
    expect(hint.textContent).toContain('most recently changed plan file');
    expect(review.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('falls back to the plan file name when no path was recorded', () => {
    const container = renderPlan({ task });

    const hint = showHint(buttonLabelled(container, 'Review Plan'));
    // Heading too, so the tour button's own hint cannot satisfy this.
    expect(hint.textContent).toContain('Plan for this task');
    expect(hint.textContent).toContain('plan.md');
  });

  it('starts a plan tour from the tour button', () => {
    const onPlanTour = vi.fn();
    const onPlanFullscreen = vi.fn();
    const container = renderPlan({ task, onPlanFullscreen, onPlanTour });

    const tourButton = buttonLabelled(container, 'Take Tour');
    expect(tourButton.title).toBe('');
    const hint = showHint(tourButton);
    expect(hint.textContent).toContain('plan.md');
    expect(hint.textContent).toContain('Generates in the background');
    expect(tourButton.getAttribute('aria-describedby')).toBe(hint.id);
    tourButton.click();
    expect(onPlanTour).toHaveBeenCalledOnce();
    expect(onPlanFullscreen).not.toHaveBeenCalled();
  });

  it('gives Take Tour the footer chrome Review Plan uses, and its chevron the divider', () => {
    const container = renderPlan({ task });

    const review = buttonLabelled(container, 'Review Plan');
    const tourButton = buttonLabelled(container, 'Take Tour');
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Tour model"]');
    expect(review.className).toBe('change-tour-action');
    expect(tourButton.className).toBe('change-tour-action understanding-action');
    expect(trigger?.className).toBe('change-tour-model');
    // The pair sits in one wrapper, so they share a segment of the bar.
    expect(tourButton.closest('.tour-split')).toBe(trigger?.closest('.tour-split'));
    expect(trigger?.closest('.tour-split')).not.toBeNull();
    // The bar carries its own chrome, so no button brings inline styles of its own.
    expect(tourButton.getAttribute('style')).toBeNull();
    expect(review.getAttribute('style')).toBeNull();
  });

  it('picks the tour model from the chevron beside Take Tour', () => {
    const container = renderPlan({ task });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Tour model"]');
    expect(trigger?.title).toBe('Model: Claude Code \u00b7 sonnet');
    trigger?.click();
    // No backend answers the Codex model list here, so that group stays empty.
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('No Codex models found');
    const opus = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === 'opus',
    );
    opus?.click();

    expect(setAskCodeProvider).toHaveBeenCalledExactlyOnceWith('claude');
    expect(setAskCodeModel).toHaveBeenCalledExactlyOnceWith('opus');
  });

  it('keeps the generating button on one line and cancels on click', () => {
    const cancel = vi.fn();
    const container = renderPlan({
      task,
      understanding: { isLoading: () => true, elapsedSeconds: () => 7, cancel },
    });

    const tourButton = buttonLabelled(container, 'Take Tour');
    expect(tourButton.getAttribute('aria-busy')).toBe('true');
    expect(tourButton.querySelector('.inline-spinner')).not.toBeNull();
    // Only the spinner and the label: the phase and elapsed time stay in the tooltip.
    expect(tourButton.textContent?.trim()).toBe('Take Tour');
    expect(tourButton.querySelectorAll('span')).toHaveLength(2);
    const hint = showHint(tourButton);
    expect(hint.textContent).toContain('Waiting for provider');
    expect(hint.textContent).toContain('7s');
    expect(hint.textContent).toContain('Click to cancel.');

    tourButton.click();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('marks a finished tour as ready to open', () => {
    const container = renderPlan({ task, understanding: { isReady: () => true } });

    const tourButton = buttonLabelled(container, 'Take Tour');
    expect(tourButton.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
    expect(showHint(tourButton).textContent).toContain('Click to open it.');
  });

  it('offers a retry after a failed tour', () => {
    const container = renderPlan({
      task,
      understanding: { errorFor: () => 'Provider unavailable' },
    });

    const retry = buttonLabelled(container, 'Retry');
    const hint = showHint(retry);
    expect(hint.textContent).toContain('Provider unavailable');
    expect(hint.textContent).toContain('Click to retry.');
  });

  it('offers the agent-published tour only while the task carries one', () => {
    const onAgentTour = vi.fn();
    const [agentTask, setAgentTask] = createStore<Task>({ ...task });
    const container = renderPlan({ task: agentTask, onAgentTour });

    expect(() => buttonLabelled(container, 'Agent Tour')).toThrow();
    setAgentTask('agentTour', {
      revision: 1,
      payload: { subject: 'the retry bug', gist: {}, cards: [{}] },
    });
    const agentButton = buttonLabelled(container, 'Agent Tour');
    const hint = showHint(agentButton);
    expect(hint.textContent).toContain('the retry bug');
    expect(hint.textContent).toContain('Cards the agent wrote');
    // No model menu: the agent wrote the cards, so no provider is picked here.
    expect(agentButton.closest('.tour-split')).toBeNull();
    agentButton.click();
    expect(onAgentTour).toHaveBeenCalledOnce();

    setAgentTask('agentTour', undefined);
    expect(() => buttonLabelled(container, 'Agent Tour')).toThrow();
  });

  it('keeps empty notes compact even when a plan is available', () => {
    const container = renderPlan({ task });
    expect(container.querySelector('.task-notes-body')?.getAttribute('data-empty')).toBe('true');
  });
});

describe('TaskNotesBody notes', () => {
  const plainTask: Task = { ...task, planContent: undefined, planFileName: undefined };

  function renderNotes(notesTask: Task) {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <TaskNotesBody
            task={notesTask}
            agentId="agent-1"
            onPlanFullscreen={() => undefined}
            understanding={createUnderstandingTour()}
            onPlanTour={() => undefined}
          />
        ),
        container,
      ),
    );
    return container;
  }

  it('labels the notes textarea and marks a task without notes or plan as empty', () => {
    const container = renderNotes(plainTask);

    const body = container.querySelector('.task-notes-body');
    expect(body?.getAttribute('data-empty')).toBe('true');
    const textarea = container.querySelector('textarea');
    expect(textarea?.getAttribute('aria-label')).toBe('Task notes');
    expect(textarea?.getAttribute('placeholder')).toBe('Add a note\u2026');
  });

  it('drops the empty marker once the task has notes', () => {
    const container = renderNotes({ ...plainTask, notes: 'Keep the wording consistent.' });

    expect(container.querySelector('.task-notes-body')?.getAttribute('data-empty')).toBe('false');
  });
});
