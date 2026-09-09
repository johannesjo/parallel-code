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

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: async (id: string) => ({ svg: `<svg id="${id}"></svg>` }),
  },
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

async function waitFor<T>(probe: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition never became true');
}

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

describe('TaskNotesBody plan tab', () => {
  it('renders mermaid fences as diagrams', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => <TaskNotesBody task={task} agentId="agent-1" onPlanFullscreen={() => undefined} />,
        container,
      ),
    );

    const block = await waitFor(() => container.querySelector<HTMLElement>('.mermaid-block'));
    expect(block.getAttribute('data-mermaid')).toContain('graph TD');

    await waitFor(() => container.querySelector('.mermaid-block.mermaid-rendered'));
    expect(block.innerHTML).toContain('<svg');
  });

  it('re-renders the diagram after switching away from the plan tab and back', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => <TaskNotesBody task={task} agentId="agent-1" onPlanFullscreen={() => undefined} />,
        container,
      ),
    );

    const first = await waitFor(() => container.querySelector('.mermaid-block.mermaid-rendered'));
    const [notesTab, planTab] = Array.from(container.querySelectorAll('button'));
    notesTab.click();
    planTab.click();

    const second = await waitFor(() => container.querySelector('.mermaid-block.mermaid-rendered'));
    expect(second).not.toBe(first);
  });
});

describe('TaskNotesBody notes tab', () => {
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
