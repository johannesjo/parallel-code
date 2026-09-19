import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type MockStore = {
  activeTaskId: string | null;
  activeDocumentProjectId: string | null;
  activeAgentId: string | null;
  tasks: Record<string, { id: string; agentIds: string[]; selectedAgentId?: string }>;
  terminals: Record<string, unknown>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
  projects: Array<{ id: string }>;
  focusedPanel: Record<string, string>;
  sidebarFocused: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  newTaskPanelFocused: boolean;
};

let mockStore: MockStore;
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({} as MockStore);
  return core.harness.moduleMock();
});

vi.mock('./focus', () => ({}));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./projects', () => ({ pickAndAddProject: vi.fn() }));
vi.mock('./tasks', () => ({ reorderTask: vi.fn() }));

import { activateTaskFromPointer, jumpToTask, moveActiveTask, setActiveTask } from './navigation';
import { isPanelFocused } from './focused-panel';
import { reorderTask } from './tasks';

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({
    activeTaskId: null,
    activeDocumentProjectId: null,
    activeAgentId: null,
    tasks: {
      'task-1': { id: 'task-1', agentIds: ['agent-a'] },
      'task-2': { id: 'task-2', agentIds: ['agent-b'] },
      'task-3': { id: 'task-3', agentIds: ['agent-c'] },
    },
    terminals: {},
    taskOrder: ['task-1', 'task-2', 'task-3'],
    collapsedTaskOrder: [],
    projects: [],
    focusedPanel: {},
    sidebarFocused: false,
    sidebarFocusedProjectId: null,
    sidebarFocusedTaskId: null,
    newTaskPanelFocused: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('moveActiveTask', () => {
  it('does not reorder the previous task while the new-task panel is focused', () => {
    mockStore.activeTaskId = 'task-2';
    mockStore.newTaskPanelFocused = true;

    moveActiveTask('right');

    expect(reorderTask).not.toHaveBeenCalled();
  });
});

describe('jumpToTask', () => {
  it('selects the document after coding panels even with no document agent installed', () => {
    mockStore.activeDocumentProjectId = 'docs';
    jumpToTask(3);
    expect(mockStore.activeTaskId).toBe('doc-agent-docs');
    expect(mockStore.activeAgentId).toBeNull();
    jumpToTask(0);
    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.activeDocumentProjectId).toBe('docs');
  });
  it('switches to the task at the given 0-based index', () => {
    jumpToTask(1);
    expect(mockStore.activeTaskId).toBe('task-2');
  });

  it('switches to the first task with index 0', () => {
    jumpToTask(0);
    expect(mockStore.activeTaskId).toBe('task-1');
  });

  it('switches to the last task with index matching last position', () => {
    jumpToTask(2);
    expect(mockStore.activeTaskId).toBe('task-3');
  });

  it('does nothing when index is out of bounds', () => {
    mockStore.activeTaskId = 'task-1';
    jumpToTask(9);
    expect(mockStore.activeTaskId).toBe('task-1');
  });

  it('sets activeAgentId to first agent of the target task', () => {
    jumpToTask(1);
    expect(mockStore.activeAgentId).toBe('agent-b');
  });

  it('preserves activeAgentId when it already belongs to the target task', () => {
    mockStore.tasks['task-2'].agentIds = ['agent-b', 'agent-b2'];
    mockStore.activeAgentId = 'agent-b2';
    jumpToTask(1);
    expect(mockStore.activeAgentId).toBe('agent-b2');
  });

  it('prefers the focused AI pane when switching back to a multi-agent task', () => {
    mockStore.tasks['task-1'].agentIds = ['agent-a', 'agent-a2'];
    mockStore.activeTaskId = 'task-2';
    mockStore.activeAgentId = 'agent-b';
    mockStore.focusedPanel['task-1'] = 'ai-terminal:agent-a2';

    jumpToTask(0);

    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.activeAgentId).toBe('agent-a2');
  });

  it('restores the per-task selected agent when focus is on a non-agent panel', () => {
    mockStore.tasks['task-1'].agentIds = ['agent-a', 'agent-a2'];
    mockStore.tasks['task-1'].selectedAgentId = 'agent-a2';
    mockStore.activeTaskId = 'task-2';
    mockStore.activeAgentId = 'agent-b';
    mockStore.focusedPanel['task-1'] = 'prompt';

    jumpToTask(0);

    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.activeAgentId).toBe('agent-a2');
  });

  it('indexes taskOrder, not collapsed tasks', () => {
    // Collapsed tasks live in collapsedTaskOrder and must not be reachable
    // by index — the user can't see them, so jumping there would surprise.
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.collapsedTaskOrder = ['task-3'];
    jumpToTask(2);
    expect(mockStore.activeTaskId).toBe(null);
  });

  it('moves the sidebar focus outline when jumping while the sidebar is focused', () => {
    mockStore.activeTaskId = 'task-1';
    mockStore.sidebarFocused = true;
    mockStore.sidebarFocusedTaskId = 'task-1';
    mockStore.sidebarFocusedProjectId = 'project-1';

    jumpToTask(2);

    expect(mockStore.activeTaskId).toBe('task-3');
    expect(mockStore.sidebarFocusedTaskId).toBe('task-3');
    expect(mockStore.sidebarFocusedProjectId).toBe(null);
  });
});

// `sidebarFocused` gates every panel: while it is set, `isPanelFocused` is false
// and `scheduleTaskFocus` will not move DOM focus. A click into a column is the
// user leaving the sidebar; a keyboard jump is not.
describe('activateTaskFromPointer', () => {
  const panel = 'ai-terminal:agent-b';

  beforeEach(() => {
    mockStore.activeTaskId = 'task-1';
    mockStore.sidebarFocused = true;
    mockStore.focusedPanel = { 'task-2': panel };
  });

  it('setActiveTask leaves sidebarFocused set (keyboard jumps rely on it)', () => {
    setActiveTask('task-2');
    expect(mockStore.activeTaskId).toBe('task-2');
    expect(isPanelFocused('task-2', panel)).toBe(false);
  });

  it('activates the column and hands it focus', () => {
    activateTaskFromPointer('task-2');
    expect(mockStore.activeTaskId).toBe('task-2');
    expect(mockStore.sidebarFocused).toBe(false);
    expect(isPanelFocused('task-2', panel)).toBe(true);
  });

  it('clears the sidebar gate when the clicked column is already active', () => {
    mockStore.activeTaskId = 'task-2';
    activateTaskFromPointer('task-2');
    expect(isPanelFocused('task-2', panel)).toBe(true);
  });

  it('leaves the sidebar focused when the id is not something setActiveTask accepts', () => {
    activateTaskFromPointer('no-such-task');
    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.sidebarFocused).toBe(true);
  });

  it('keeps keyboard jumps on the sidebar, as they were', () => {
    jumpToTask(1);
    expect(mockStore.sidebarFocused).toBe(true);
  });
});
