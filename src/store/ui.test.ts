import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type MockStore = {
  activeTaskId: string | null;
  focusMode: boolean;
  tasks: Record<string, { id: string; projectId: string }>;
  focusedPanel: Record<string, string>;
  panelUserSize: Record<string, number>;
  projects: Array<{ id: string; tasksCollapsed?: boolean }>;
  projectsCollapsed: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  terminalScreenReaderMode: boolean;
};

let mockStore: MockStore;
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));
const mocks = vi.hoisted(() => ({
  setActiveTask: vi.fn((id: string) => {
    mockStore.activeTaskId = id;
  }),
  setTaskFocusedPanel: vi.fn((taskId: string, panel: string) => {
    mockStore.focusedPanel[taskId] = panel;
  }),
}));

vi.mock('solid-js', () => ({
  batch: (fn: () => void) => fn(),
}));

// Real Solid produce uses Proxy mutation tracking; for the mock, a thin
// pass-through is enough because our store slices are plain objects.
vi.mock('solid-js/store', async () => {
  const { mockSolidStoreProduce } = await import('./test-helpers');
  return mockSolidStoreProduce();
});

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({} as MockStore);
  return core.harness.moduleMock();
});

vi.mock('./navigation', () => ({
  setActiveTask: mocks.setActiveTask,
}));

vi.mock('./focused-panel', () => ({
  setTaskFocusedPanel: mocks.setTaskFocusedPanel,
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../electron/ipc/channels', () => ({
  IPC: {},
}));

import {
  toggleTaskFocusMode,
  getPanelUserSize,
  setPanelUserSize,
  deletePanelUserSize,
  setProjectTasksCollapsed,
  setProjectsCollapsed,
  setTerminalScreenReaderMode,
} from './ui';

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({
    activeTaskId: 'task-1',
    focusMode: false,
    tasks: {
      'task-1': { id: 'task-1', projectId: 'project-1' },
      'task-2': { id: 'task-2', projectId: 'project-2' },
    },
    focusedPanel: {},
    panelUserSize: {},
    projects: [{ id: 'project-1' }, { id: 'project-2' }],
    projectsCollapsed: false,
    sidebarFocusedProjectId: null,
    sidebarFocusedTaskId: null,
    terminalScreenReaderMode: false,
  });

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('toggleTaskFocusMode', () => {
  it('refocuses the last focused task panel when entering focus mode', () => {
    mockStore.focusedPanel['task-1'] = 'notes';

    toggleTaskFocusMode('task-1');

    expect(mockStore.focusMode).toBe(true);
    expect(mocks.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'notes');
  });

  it('falls back to the default task panel when there is no remembered focus', () => {
    toggleTaskFocusMode('task-1');

    expect(mocks.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal');
    expect(mockStore.focusedPanel['task-1']).toBe('ai-terminal');
  });

  it('does not refocus again when leaving focus mode', () => {
    mockStore.focusMode = true;

    toggleTaskFocusMode('task-1');

    expect(mockStore.focusMode).toBe(false);
    expect(mocks.setTaskFocusedPanel).not.toHaveBeenCalled();
  });

  it('activates the requested task before entering focus mode', () => {
    mockStore.activeTaskId = 'task-1';
    mockStore.focusedPanel['task-2'] = 'changed-files';

    toggleTaskFocusMode('task-2');

    expect(mocks.setActiveTask).toHaveBeenCalledWith('task-2');
    expect(mockStore.activeTaskId).toBe('task-2');
    expect(mocks.setTaskFocusedPanel).toHaveBeenCalledWith('task-2', 'changed-files');
  });
});

describe('panelUserSize', () => {
  it('round-trips set and get', () => {
    setPanelUserSize('task:abc:prompt', 150);
    expect(getPanelUserSize('task:abc:prompt')).toBe(150);
  });

  it('returns undefined for unset keys', () => {
    expect(getPanelUserSize('never-set')).toBeUndefined();
  });

  it('overwrites an existing entry', () => {
    setPanelUserSize('k', 100);
    setPanelUserSize('k', 220);
    expect(getPanelUserSize('k')).toBe(220);
  });

  it('deletes multiple keys in one call and leaves others intact', () => {
    setPanelUserSize('a', 100);
    setPanelUserSize('b', 200);
    setPanelUserSize('c', 300);

    deletePanelUserSize(['a', 'c']);

    expect(getPanelUserSize('a')).toBeUndefined();
    expect(getPanelUserSize('b')).toBe(200);
    expect(getPanelUserSize('c')).toBeUndefined();
  });

  it('is a no-op when called with an empty key list', () => {
    setPanelUserSize('keep', 42);
    expect(() => deletePanelUserSize([])).not.toThrow();
    expect(getPanelUserSize('keep')).toBe(42);
  });
});

describe('setProjectsCollapsed', () => {
  it('clears sidebarFocusedProjectId when collapsing', () => {
    mockStore.projectsCollapsed = false;
    mockStore.sidebarFocusedProjectId = 'project-1';

    setProjectsCollapsed(true);

    expect(mockStore.projectsCollapsed).toBe(true);
    expect(mockStore.sidebarFocusedProjectId).toBeNull();
  });

  it('leaves sidebarFocusedProjectId untouched when expanding', () => {
    mockStore.projectsCollapsed = true;
    mockStore.sidebarFocusedProjectId = null;

    setProjectsCollapsed(false);

    expect(mockStore.projectsCollapsed).toBe(false);
    expect(mockStore.sidebarFocusedProjectId).toBeNull();
  });

  it('is a no-op for focus when collapsing with no project highlighted', () => {
    mockStore.projectsCollapsed = false;
    mockStore.sidebarFocusedProjectId = null;

    setProjectsCollapsed(true);

    expect(mockStore.projectsCollapsed).toBe(true);
    expect(mockStore.sidebarFocusedProjectId).toBeNull();
  });
});

describe('setProjectTasksCollapsed', () => {
  it('collapses only the requested project task group and clears hidden task focus', () => {
    mockStore.sidebarFocusedTaskId = 'task-1';

    setProjectTasksCollapsed('project-1', true);

    expect(mockStore.projects).toEqual([
      { id: 'project-1', tasksCollapsed: true },
      { id: 'project-2' },
    ]);
    expect(mockStore.sidebarFocusedTaskId).toBeNull();
  });

  it('preserves focus when expanding a project task group', () => {
    mockStore.projects[0].tasksCollapsed = true;
    mockStore.sidebarFocusedTaskId = 'task-1';

    setProjectTasksCollapsed('project-1', false);

    expect(mockStore.projects[0].tasksCollapsed).toBe(false);
    expect(mockStore.sidebarFocusedTaskId).toBe('task-1');
  });
});

describe('setTerminalScreenReaderMode', () => {
  it('updates the global terminal accessibility option', () => {
    setTerminalScreenReaderMode(true);

    expect(mockStore.terminalScreenReaderMode).toBe(true);
  });
});
