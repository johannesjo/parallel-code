import { produce } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskShellSection } from './TaskShellSection';
import { store } from '../store/store';

const { terminalProps, invoke } = vi.hoisted(() => ({
  terminalProps: [] as Record<string, unknown>[],
  invoke: vi.fn(),
}));

// The mock factory builds its own Solid store; these refs hand it to the tests
// (the real '../store/store' module exports neither name directly).
const mockPanel = vi.hoisted(() => ({
  panelUserSize: null as unknown as Record<string, number>,
  setPanelUserSize: null as unknown as SetStoreFunction<Record<string, number>>,
}));

// Same mock surface as TaskShellSection.client.test.tsx, plus the section
// collapse accessors mirroring ui.ts over a real Solid store so clicks round-
// trip through panelUserSize reactively.
vi.mock('../store/store', async () => {
  const { createStore, produce } = await import('solid-js/store');
  const [panelUserSize, setPanelUserSize] = createStore<Record<string, number>>({});
  mockPanel.panelUserSize = panelUserSize;
  mockPanel.setPanelUserSize = setPanelUserSize;
  const keyFor = (taskId: string, section: string) => `task:${taskId}:collapsed:${section}`;
  return {
    store: {
      focusMode: false,
      taskSplitMode: {},
      documentWorkspacesEnabled: true,
      shellLayoutOverride: null,
      taskShellAutoLayout: {},
    },
    getProject: () => ({ terminalBookmarks: [] }),
    spawnShellForTask: vi.fn(),
    runBookmarkInTask: vi.fn(),
    updateProject: vi.fn(),
    closeShell: vi.fn(),
    markAgentOutput: vi.fn(),
    clearAgentActivity: vi.fn(),
    refreshTaskStatus: vi.fn(),
    registerFocusFn: vi.fn(),
    unregisterFocusFn: vi.fn(),
    setActiveTask: vi.fn(),
    setTaskFocusedPanel: vi.fn(),
    shellPanelId: (index: number) => `shell:${index}`,
    isPanelFocused: () => false,
    isPanelFocusedPrefix: () => false,
    getTaskShellLayout: () => 'row',
    setTaskShellAutoLayout: vi.fn(),
    panelUserSize,
    setPanelUserSize,
    isTaskSectionCollapsed: (taskId: string, section: string) =>
      mockPanel.panelUserSize[keyFor(taskId, section)] !== undefined,
    setTaskSectionCollapsed: (taskId: string, section: string, collapsed: boolean) => {
      if (collapsed) mockPanel.setPanelUserSize(keyFor(taskId, section), 1);
      else
        mockPanel.setPanelUserSize(
          produce((sizes: Record<string, number>) => {
            Reflect.deleteProperty(sizes, keyFor(taskId, section));
          }),
        );
    },
  };
});
vi.mock('../store/staged-prompt', () => ({ stageTaskPrompt: vi.fn() }));
vi.mock('./TerminalView', () => ({
  TerminalView: (props: Record<string, unknown>) => {
    terminalProps.push(props);
    return null;
  },
}));
vi.mock('../documents/store', () => ({ editAsDocument: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke }));

const disposers: Array<() => void> = [];

afterEach(() => {
  store.taskSplitMode = {};
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  terminalProps.length = 0;
  mockPanel.setPanelUserSize(
    produce((sizes: Record<string, number>) => {
      for (const key of Object.keys(sizes)) Reflect.deleteProperty(sizes, key);
    }),
  );
  vi.clearAllMocks();
});

function makeTask(shellAgentIds: string[] = []): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/shells',
    worktreePath: '/tmp/task',
    agentIds: [],
    shellAgentIds,
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function renderShell(shellAgentIds: string[]) {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(() => <TaskShellSection task={makeTask(shellAgentIds)} isActive />, container),
  );
  const toggle = container.querySelector<HTMLButtonElement>('[aria-controls="task-1-shell-body"]');
  if (!toggle) throw new Error('collapse toggle not rendered');
  return { container, toggle };
}

describe('TaskShellSection collapse', () => {
  it('hides only the terminals row when the user collapses open shells', () => {
    const { container, toggle } = renderShell(['shell-1']);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide shell terminals');
    expect(container.querySelector('.shell-terminals-row')).not.toBeNull();
    expect(container.querySelector('.shell-toolbar-panel')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('140px');

    toggle.click();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show shell terminals');
    expect(container.querySelector('.shell-terminals-row')).toBeNull();
    expect(container.querySelector('.shell-toolbar-panel')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('35px');
    expect(mockPanel.panelUserSize['task:task-1:collapsed:shell-section']).toBe(1);
    expect(terminalProps).toHaveLength(1); // no terminal remounted meanwhile
  });

  it('restores the terminals row and deletes the key when expanded', () => {
    const { container, toggle } = renderShell(['shell-1']);
    toggle.click();
    toggle.click();

    expect(container.querySelector('.shell-terminals-row')).not.toBeNull();
    expect(mockPanel.panelUserSize['task:task-1:collapsed:shell-section']).toBeUndefined();
    expect(terminalProps).toHaveLength(2); // one remount after the round-trip
  });

  it('stays toolbar-only without shells whatever the flag says', () => {
    const { container, toggle } = renderShell([]);

    expect(container.querySelector('.shell-terminals-row')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('35px');

    mockPanel.setPanelUserSize('task:task-1:collapsed:shell-section', 1);

    expect(container.querySelector('.shell-terminals-row')).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('35px');
    expect(container.querySelector('.shell-toolbar-panel')).not.toBeNull();
  });

  it('keeps the toolbar-only state for open shells collapsed by a stored flag', () => {
    mockPanel.setPanelUserSize('task:task-1:collapsed:shell-section', 1);
    const { container, toggle } = renderShell(['shell-1']);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.shell-terminals-row')).toBeNull();
    expect(container.querySelector('.shell-toolbar-panel')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('35px');
  });
});
