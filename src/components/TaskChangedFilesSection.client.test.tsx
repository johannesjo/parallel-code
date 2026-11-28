import { produce } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { UNCOMMITTED_SELECTION } from './CommitNavBar';
import { createChangeTour } from '../lib/create-change-tour';
import { TaskChangedFilesSection } from './TaskChangedFilesSection';

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
    store: {},
    getProject: () => undefined,
    setActiveTask: vi.fn(),
    setTaskFocusedPanel: vi.fn(),
    isPanelFocused: () => false,
    openCanvasDocument: vi.fn(),
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
vi.mock('../store/taskStatus', () => ({ isTaskWorking: () => false }));
vi.mock('./ChangedFilesList', () => ({ ChangedFilesList: () => null }));
vi.mock('./CommitTreeOverlay', () => ({ CommitTreeOverlay: () => null }));
vi.mock('./ChangeTourButton', () => ({ ChangeTourButton: () => <div class="test-tour" /> }));
vi.mock('./FeatureHint', () => ({ FeatureHint: () => null }));
vi.mock('./understanding/ask-code-label', () => ({ askCodeModelLabel: () => 'model' }));

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

function makeTask(): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/changes',
    worktreePath: '/tmp/task',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function renderFiles(selectedCommit: string | null = null, withTour = false) {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <TaskChangedFilesSection
          task={makeTask()}
          isActive
          commitList={[]}
          selectedCommit={selectedCommit}
          onCommitNavigate={() => undefined}
          onDiffFileClick={() => undefined}
          tour={withTour ? createChangeTour() : undefined}
        />
      ),
      container,
    ),
  );
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-controls="task-1-changed-files-body"]',
  );
  if (!toggle) throw new Error('collapse toggle not rendered');
  return { container, toggle };
}

describe('TaskChangedFilesSection collapse', () => {
  it('keeps the heading summary and removes banners, list, and tour footer when collapsed', () => {
    const { container, toggle } = renderFiles(UNCOMMITTED_SELECTION, true);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide changed files');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(container.querySelector('#task-1-changed-files-body')).not.toBeNull();
    expect(container.textContent).toContain('Uncommitted changes only');
    expect(container.querySelector('.test-tour')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('100px');

    toggle.click();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show changed files');
    expect(container.querySelector('#task-1-changed-files-body')).toBeNull();
    expect(container.textContent).not.toContain('Uncommitted changes only');
    expect(container.querySelector('.test-tour')).toBeNull();
    // The heading row keeps its summary and its toggle.
    expect(container.textContent).toContain('No changes yet');
    expect(toggle.isConnected).toBe(true);
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('');
    expect(mockPanel.panelUserSize['task:task-1:collapsed:changed-files']).toBe(1);
  });

  it('restores the body in its old position and deletes the key when expanded', () => {
    const { container, toggle } = renderFiles(UNCOMMITTED_SELECTION, true);
    toggle.click();
    toggle.click();

    const body = container.querySelector('#task-1-changed-files-body');
    if (!body) throw new Error('changed-files body not restored');
    // The heading row (with the toggle) sits before the body again; the banner
    // and the tour footer stay between them as before.
    expect(body.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(container.textContent).toContain('Uncommitted changes only');
    expect(container.querySelector('.test-tour')).not.toBeNull();
    expect(mockPanel.panelUserSize['task:task-1:collapsed:changed-files']).toBeUndefined();
  });
});
