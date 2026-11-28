import { produce } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { createUnderstandingTour } from '../lib/create-understanding-tour';
import { TaskNotesBody } from './TaskNotesBody';

// The mock factory builds its own Solid store; these refs hand it to the tests
// (the real '../store/store' module exports neither name directly).
const mockPanel = vi.hoisted(() => ({
  panelUserSize: null as unknown as Record<string, number>,
  setPanelUserSize: null as unknown as SetStoreFunction<Record<string, number>>,
}));

// The mock mirrors the real accessors over a real Solid store so a toggle
// click round-trips through panelUserSize reactively, exactly like ui.ts does.
vi.mock('../store/store', async () => {
  const { createStore, produce } = await import('solid-js/store');
  const [panelUserSize, setPanelUserSize] = createStore<Record<string, number>>({});
  mockPanel.panelUserSize = panelUserSize;
  mockPanel.setPanelUserSize = setPanelUserSize;
  const keyFor = (taskId: string, section: string) => `task:${taskId}:collapsed:${section}`;
  return {
    store: { showPlans: true, focusMode: false, taskSplitMode: {} as Record<string, boolean> },
    updateTaskNotes: vi.fn(),
    setTaskFocusedPanel: vi.fn(),
    sendPrompt: vi.fn(),
    isAgentAskingQuestion: () => false,
    isPanelFocused: () => false,
    registerFocusFn: vi.fn(),
    unregisterFocusFn: vi.fn(),
    panelUserSize,
    setPanelUserSize,
    isTaskSectionCollapsed: (taskId: string, section: string) =>
      mockPanel.panelUserSize[keyFor(taskId, section)] !== undefined,
    setTaskSectionCollapsed: (taskId: string, section: string, collapsed: boolean) => {
      if (collapsed) setPanelUserSize(keyFor(taskId, section), 1);
      else
        setPanelUserSize(
          produce((sizes: Record<string, number>) => {
            Reflect.deleteProperty(sizes, keyFor(taskId, section));
          }),
        );
    },
  };
});

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  mockPanel.setPanelUserSize(
    produce((sizes: Record<string, number>) => {
      for (const key of Object.keys(sizes)) Reflect.deleteProperty(sizes, key);
    }),
  );
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
  planContent: '# Plan',
  planFileName: 'plan.md',
};

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
  const toggle = container.querySelector<HTMLButtonElement>('[aria-controls="task-1-notes-body"]');
  if (!toggle) throw new Error('collapse toggle not rendered');
  return { container, toggle };
}

describe('TaskNotesBody collapse', () => {
  it('removes the body and parks the state in panelUserSize when collapsed', () => {
    const { container, toggle } = renderNotes(task);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide notes');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('.notes-tour-footer')).not.toBeNull();
    expect(mockPanel.panelUserSize['task:task-1:collapsed:notes']).toBeUndefined();

    toggle.click();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show notes');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.notes-tour-footer')).toBeNull();
    expect(mockPanel.panelUserSize['task:task-1:collapsed:notes']).toBe(1);
    // Only the heading row remains, with its summary.
    expect(container.querySelector('.task-pane-heading')?.textContent).toContain('Notes');
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('');
  });

  it('restores the body in its old position and deletes the key when expanded', () => {
    const { container, toggle } = renderNotes(task);
    toggle.click();
    toggle.click();

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    // The editor sits directly under the heading row again, footer after it.
    expect(textarea?.closest('#task-1-notes-body')).not.toBeNull();
    expect(
      textarea
        ?.closest('#task-1-notes-body')
        ?.previousElementSibling?.classList.contains('task-pane-heading'),
    ).toBe(true);
    expect(container.querySelector('.notes-tour-footer')).not.toBeNull();
    expect(mockPanel.panelUserSize['task:task-1:collapsed:notes']).toBeUndefined();
  });

  it('keeps the pane floor at the heading row while collapsed and the full pane when not', () => {
    const { container, toggle } = renderNotes({ ...task, planContent: undefined });

    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('100px');
    toggle.click();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('');
    toggle.click();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('100px');
  });
});
