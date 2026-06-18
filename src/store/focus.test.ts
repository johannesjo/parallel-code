import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockStore = {
  activeTaskId: string | null;
  activeAgentId: string | null;
  tasks: Record<string, MockTask>;
  terminals: Record<string, Record<string, unknown>>;
  taskOrder: string[];
  projects: Array<{ id: string; terminalBookmarks?: Array<{ id: string; command: string }> }>;
  focusedPanel: Record<string, string>;
  sidebarFocused: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  placeholderFocused: boolean;
  placeholderFocusedButton: 'add-task' | 'add-terminal';
  showNewTaskDialog: boolean;
  showHelpDialog: boolean;
  showSettingsDialog: boolean;
  showPromptInput: boolean;
  sidebarVisible: boolean;
  taskSplitMode: Record<string, boolean>;
};

type MockTask = {
  id: string;
  name: string;
  projectId: string;
  agentIds: string[];
  shellAgentIds: string[];
  stepsEnabled: boolean;
  stepsContent: Array<{ id: string }>;
  collapsed?: boolean;
  [key: string]: unknown;
};

let mockStore: MockStore;

function setStorePath(...args: unknown[]): void {
  const value = args[args.length - 1];
  let target: Record<string, unknown> = mockStore as unknown as Record<string, unknown>;
  for (let i = 0; i < args.length - 2; i++) {
    const key = args[i] as string;
    const next = target[key] as Record<string, unknown> | undefined;
    if (!next || typeof next !== 'object') {
      target[key] = {};
    }
    target = target[key] as Record<string, unknown>;
  }
  target[args[args.length - 2] as string] = value;
}

vi.mock('solid-js', () => ({
  batch: (fn: () => void) => fn(),
}));

vi.mock('./core', () => ({
  store: new Proxy(
    {},
    {
      get(_target, prop) {
        return mockStore[prop as keyof MockStore];
      },
    },
  ),
  setStore: vi.fn((...args: unknown[]) => setStorePath(...args)),
}));

vi.mock('./navigation', () => ({
  setActiveTask: vi.fn((id: string) => {
    mockStore.activeTaskId = id;
    mockStore.activeAgentId = mockStore.tasks[id]?.agentIds?.[0] ?? null;
  }),
}));

vi.mock('./sidebar-order', () => ({
  computeSidebarTaskOrder: vi.fn(() => mockStore.taskOrder),
}));

vi.mock('./tasks', () => ({
  uncollapseTask: vi.fn((id: string) => {
    if (mockStore.tasks[id]) mockStore.tasks[id].collapsed = false;
  }),
}));

import { navigateColumn, navigateRow, scrollTaskToEdge } from './focus';

function setTask(id: string, overrides: Record<string, unknown> = {}): void {
  mockStore.tasks[id] = {
    id,
    name: id,
    projectId: 'project-1',
    agentIds: ['agent-1'],
    shellAgentIds: [],
    stepsEnabled: false,
    stepsContent: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockStore = {
    activeTaskId: 'task-1',
    activeAgentId: 'agent-1',
    tasks: {},
    terminals: {},
    taskOrder: ['task-1'],
    projects: [{ id: 'project-1', terminalBookmarks: [] }],
    focusedPanel: {},
    sidebarFocused: false,
    sidebarFocusedProjectId: null,
    sidebarFocusedTaskId: null,
    placeholderFocused: false,
    placeholderFocusedButton: 'add-task',
    showNewTaskDialog: false,
    showHelpDialog: false,
    showSettingsDialog: false,
    showPromptInput: true,
    sidebarVisible: true,
    taskSplitMode: {},
  };

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('focus navigation neighbor map', () => {
  it('moves down through stacked layout using explicit neighbors', () => {
    setTask('task-1');
    mockStore.focusedPanel['task-1'] = 'notes';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('shell-toolbar:0');
  });

  it('always enters the top-right panel when moving right from ai-terminal in split mode', () => {
    setTask('task-1', {
      stepsEnabled: true,
      stepsContent: [{ id: 'step-1' }],
    });
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.focusedPanel['task-1'] = 'ai-terminal';

    navigateColumn('right');

    expect(mockStore.focusedPanel['task-1']).toBe('changed-files');
  });

  it('falls into the top-right panel when split-mode ai-terminal has no lower left neighbor', () => {
    setTask('task-1', {
      shellAgentIds: ['shell-1'],
    });
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.showPromptInput = false;
    mockStore.focusedPanel['task-1'] = 'ai-terminal';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('changed-files');
  });

  it('falls back from vanished focused panels before navigating', () => {
    setTask('task-1', {
      stepsEnabled: false,
      stepsContent: [],
    });
    mockStore.focusedPanel['task-1'] = 'steps';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('prompt');
  });

  it('preserves cross-task row alignment when exiting to the right', () => {
    setTask('task-1');
    setTask('task-2');
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.focusedPanel['task-1'] = 'changed-files';

    navigateColumn('right');

    expect(mockStore.activeTaskId).toBe('task-2');
    expect(mockStore.focusedPanel['task-2']).toBe('notes');
  });

  it('enters the leftmost task when moving right from the sidebar, ignoring the highlighted task', () => {
    setTask('task-1');
    setTask('task-2');
    setTask('task-3');
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    mockStore.activeTaskId = 'task-2';
    mockStore.sidebarFocused = true;
    mockStore.sidebarFocusedTaskId = 'task-3';

    navigateColumn('right');

    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.sidebarFocused).toBe(false);
    expect(mockStore.focusedPanel['task-1']).toBe('ai-terminal:agent-1');
  });

  it('clamps split shell-toolbar down-moves to the last available shell', () => {
    setTask('task-1', {
      shellAgentIds: ['shell-1'],
    });
    mockStore.projects[0].terminalBookmarks = [
      { id: 'bookmark-1', command: 'npm test' },
      { id: 'bookmark-2', command: 'npm run lint' },
    ];
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.focusedPanel['task-1'] = 'shell-toolbar:2';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('shell:0');
  });
});

describe('scrollTaskToEdge', () => {
  function createScroller(): HTMLElement {
    return {
      clientWidth: 300,
      scrollWidth: 1_000,
      scrollTo: vi.fn(),
    } as unknown as HTMLElement;
  }

  it('scrolls to absolute start for the first task', () => {
    mockStore.taskOrder = ['task-1', 'task-2'];
    const scroller = createScroller();

    const didScroll = scrollTaskToEdge(scroller, 'task-1');

    expect(didScroll).toBe(true);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'instant' });
  });

  it('scrolls to absolute end for the last task', () => {
    mockStore.taskOrder = ['task-1', 'task-2'];
    const scroller = createScroller();

    const didScroll = scrollTaskToEdge(scroller, 'task-2');

    expect(didScroll).toBe(true);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 700, behavior: 'instant' });
  });

  it('does not edge-scroll a middle task', () => {
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    const scroller = createScroller();

    const didScroll = scrollTaskToEdge(scroller, 'task-2');

    expect(didScroll).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('does not edge-scroll when the task is missing from the order', () => {
    mockStore.taskOrder = ['task-1', 'task-2'];
    const scroller = createScroller();

    const didScroll = scrollTaskToEdge(scroller, 'task-x');

    expect(didScroll).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
