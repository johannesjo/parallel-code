import { createStore } from 'solid-js/store';
import { store } from '../store/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskNotesBody } from './TaskNotesBody';

vi.mock('../store/store', () => ({
  store: { showPlans: true, focusMode: false },
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

describe('TaskNotesBody plan button', () => {
  function renderPlan(notesTask: Task, onPlanFullscreen = vi.fn()) {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <TaskNotesBody task={notesTask} agentId="agent-1" onPlanFullscreen={onPlanFullscreen} />
        ),
        container,
      ),
    );
    return container;
  }

  it('keeps notes visible and opens the plan viewer from a single button', () => {
    const onPlanFullscreen = vi.fn();
    const container = renderPlan({ ...task, notes: 'Keep this note.' }, onPlanFullscreen);

    expect(container.querySelector('textarea')?.value).toBe('Keep this note.');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Review Plan', '']);
    buttons[0].click();
    expect(onPlanFullscreen).toHaveBeenCalledOnce();
    expect(container.querySelector('.plan-markdown')).toBeNull();
  });

  it('keeps the notes editor mounted when a plan arrives or disappears', () => {
    const [notesTask, setNotesTask] = createStore<Task>({ ...task, planContent: undefined });
    const container = renderPlan(notesTask);
    const textarea = container.querySelector('textarea');
    textarea?.focus();

    setNotesTask('planContent', '# New plan');
    expect(container.querySelector('.review-plan-btn')).not.toBeNull();
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);

    setNotesTask('planContent', undefined);
    expect(container.querySelector('.review-plan-btn')).toBeNull();
    expect(container.querySelector('textarea')).toBe(textarea);
  });

  it('hides the plan button when plans are disabled', () => {
    store.showPlans = false;
    const container = renderPlan(task);
    expect(container.querySelector('.review-plan-btn')).toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('keeps empty notes compact even when a plan is available', () => {
    const container = renderPlan(task);
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
          <TaskNotesBody task={notesTask} agentId="agent-1" onPlanFullscreen={() => undefined} />
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
