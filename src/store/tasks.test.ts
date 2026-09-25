import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { expectDefined, type MockStoreHarness } from './test-helpers';

// Hoisted so these refs are available both in vi.mock() factories and in test bodies.
const { mockInvoke, mockIsAgentBracketedPasteEnabled, mockSaveState } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsAgentBracketedPasteEnabled: vi.fn(),
  mockSaveState: vi.fn(),
}));
const core = vi.hoisted(() => ({
  harness: undefined as
    | MockStoreHarness<{
        tasks: Record<string, MockTask>;
        agents: Record<string, unknown>;
        taskOrder: string[];
        collapsedTaskOrder: string[];
        projects: { id: string; path: string; tasksCollapsed?: boolean }[];
        availableAgents: unknown[];
        defaultStepsEnabled: boolean;
      }>
    | undefined,
}));

// ─── Coordinator test infrastructure ─────────────────────────────────────────

type MockTask = {
  controlledBy?: 'coordinator' | 'human';
  coordinatedBy?: string;
  agentIds: string[];
  shellAgentIds: string[];
  agentSessionIds?: Record<string, string>;
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
let mockAgents: Record<string, unknown> = {};
let mockTaskOrder: string[] = [];
let mockCollapsedTaskOrder: string[] = [];
let mockProjects: { id: string; path: string; tasksCollapsed?: boolean }[] = [];
let mockAgentEnvFiles: Record<string, string> = {};
const ipcHandlers = new Map<string, (data: unknown) => void>();

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../lib/ipc', () => ({ Channel: vi.fn(), invoke: mockInvoke }));

let mockDefaultStepsEnabled = false;

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get tasks() {
      return mockTasks;
    },
    set tasks(next) {
      mockTasks = next;
    },
    get agents() {
      return mockAgents;
    },
    set agents(next) {
      mockAgents = next;
    },
    get taskOrder() {
      return mockTaskOrder;
    },
    set taskOrder(next) {
      mockTaskOrder = next;
    },
    get collapsedTaskOrder() {
      return mockCollapsedTaskOrder;
    },
    set collapsedTaskOrder(next) {
      mockCollapsedTaskOrder = next;
    },
    get projects() {
      return mockProjects;
    },
    set projects(next) {
      mockProjects = next;
    },
    availableAgents: [],
    get agentEnvFiles() {
      return mockAgentEnvFiles;
    },
    set agentEnvFiles(next) {
      mockAgentEnvFiles = next;
    },
    get defaultStepsEnabled() {
      return mockDefaultStepsEnabled;
    },
    set defaultStepsEnabled(next) {
      mockDefaultStepsEnabled = next;
    },
  });
  return core.harness.moduleMock({ cleanupPanelEntries: vi.fn() });
});

vi.mock('./persistence', () => ({ saveState: mockSaveState }));
vi.mock('./focus', () => ({ setTaskFocusedPanel: vi.fn() }));
vi.mock('./projects', () => ({
  getProject: vi.fn(),
  getProjectPath: vi.fn(),
  getProjectBranchPrefix: vi.fn(),
  isProjectMissing: vi.fn(),
}));
vi.mock('../lib/bookmarks', () => ({ setPendingShellCommand: vi.fn() }));
vi.mock('./taskStatus', () => ({
  markAgentSpawned: vi.fn(),
  markAgentBusy: vi.fn(),
  clearAgentActivity: vi.fn(),
  clearTaskGitStatusTracking: vi.fn(),
  isAgentBracketedPasteEnabled: mockIsAgentBracketedPasteEnabled,
  isAgentIdle: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));
vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskMerged: vi.fn(),
}));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));
vi.mock('../lib/clean-task-name', () => ({ cleanTaskName: vi.fn() }));
vi.mock('./sidebar-order', () => ({
  getCoordinatorChildren: vi.fn(),
  computeSidebarDraggableTaskOrder: vi.fn(() =>
    mockTaskOrder.filter((taskId) => {
      const projectId = mockTasks[taskId]?.projectId;
      return !mockProjects.some(
        (project) => project.id === projectId && project.tasksCollapsed === true,
      );
    }),
  ),
}));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
}));
vi.mock('./superProductivity', () => ({
  armSpCompletion: vi.fn(),
  fireSpCompletion: vi.fn(),
  onTaskRenamed: vi.fn(),
}));

vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        ipcHandlers.set(_channel, handler);
        return () => ipcHandlers.delete(_channel);
      },
    },
  },
});

import {
  createTask,
  initMCPListeners,
  setTaskControl,
  collapseTask,
  uncollapseTask,
  closeTask,
  mergeTask,
  pushTask,
  sendPrompt,
  setLastPrompt,
  pasteDelayMs,
  markTaskUserActivity,
  setTaskPromptDraftActive,
  setTaskTerminalInputPending,
  setTaskTerminalInputPendingFromQuestion,
  clearTerminalInputPendingFromQuestion,
  markTaskMcpPending,
  markTaskMcpReady,
  markTaskMcpError,
  retryTaskMcpStartup,
  clearTaskLandingReview,
  toggleAITerminalLayout,
  reorderTaskVisually,
  createAgentRecord,
  selectActiveNeighborAfterRemoval,
  updateTaskName,
} from './tasks';
import { armSpCompletion, fireSpCompletion, onTaskRenamed } from './superProductivity';
import { updateTaskBranch } from './task-branch';
import { getCoordinatorChildren } from './sidebar-order';
import { recordMergedLines, recordTaskMerged } from './completion';
import { markAgentSpawned, rescheduleTaskStatusPolling } from './taskStatus';
import { saveState } from './persistence';
import { MAX_PROMPT_HISTORY } from '../lib/prompt-history';
import { getProjectBranchPrefix, getProjectPath, isProjectMissing } from './projects';
const mockSetStore = expectDefined(core.harness, 'mock store harness').setStore;

// ─── Coordinator listener setup ───────────────────────────────────────────────

initMCPListeners();
const taskCreatedHandler = ipcHandlers.get('mcp_task_created');
if (!taskCreatedHandler) throw new Error('mcp_task_created handler not registered');
const taskStateSyncHandler = ipcHandlers.get('mcp_task_state_sync');
if (!taskStateSyncHandler) throw new Error('mcp_task_state_sync handler not registered');

describe('task record helpers', () => {
  const agentDef = {
    id: 'agent-def',
    name: 'Claude',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Claude',
  };

  it('creates running agent records with default state', () => {
    expect(createAgentRecord({ id: 'agent-1', taskId: 'task-1', def: agentDef })).toEqual({
      id: 'agent-1',
      taskId: 'task-1',
      def: agentDef,
      resumed: false,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      generation: 0,
      attachExisting: undefined,
      spawnDelayMs: undefined,
    });
  });

  it('preserves resume and attachment metadata on agent records', () => {
    expect(
      createAgentRecord({
        id: 'agent-1',
        taskId: 'task-1',
        def: agentDef,
        resumed: true,
        attachExisting: true,
        spawnDelayMs: 250,
      }),
    ).toMatchObject({
      resumed: true,
      attachExisting: true,
      spawnDelayMs: 250,
    });
  });

  it.each([
    { order: ['task-1', 'task-2', 'task-3'], removedTaskId: 'task-1', expected: 'task-2' },
    { order: ['task-1', 'task-2', 'task-3'], removedTaskId: 'task-2', expected: 'task-1' },
    { order: ['task-1', 'task-2', 'task-3'], removedTaskId: 'task-3', expected: 'task-2' },
    { order: ['task-1'], removedTaskId: 'task-1', expected: null },
  ])(
    'selects $expected after removing $removedTaskId from $order',
    ({ order, removedTaskId, expected }) => {
      expect(selectActiveNeighborAfterRemoval(order, removedTaskId)).toBe(expected);
    },
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
  mockCollapsedTaskOrder = [];
  mockProjects = [];
  mockAgentEnvFiles = {};
  mockDefaultStepsEnabled = false;
  mockInvoke.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue(undefined);
});

describe('updateTaskBranch', () => {
  it('clears an inferred PR URL when the branch changes', () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      branchName: 'task/old',
      prUrl: 'https://github.com/acme/app/pull/12',
    };

    updateTaskBranch('task-1', 'task/new');

    expect(mockTasks['task-1'].branchName).toBe('task/new');
    expect(mockTasks['task-1'].prUrl).toBeUndefined();
  });

  it('keeps the inferred PR URL when the branch name is unchanged', () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      branchName: 'task/same',
      prUrl: 'https://github.com/acme/app/pull/12',
    };

    updateTaskBranch('task-1', 'task/same');

    expect(mockTasks['task-1'].prUrl).toBe('https://github.com/acme/app/pull/12');
  });
});

describe('reorderTaskVisually', () => {
  it('uses only expanded project tasks when resolving a visible drop index', () => {
    mockProjects = [
      { id: 'project-hidden', path: '/hidden', tasksCollapsed: true },
      { id: 'project-visible', path: '/visible' },
    ];
    mockTasks = {
      hidden: { projectId: 'project-hidden', agentIds: [], shellAgentIds: [] },
      first: { projectId: 'project-visible', agentIds: [], shellAgentIds: [] },
      second: { projectId: 'project-visible', agentIds: [], shellAgentIds: [] },
    };
    mockTaskOrder = ['hidden', 'first', 'second'];
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: [], collapsed: [] });

    reorderTaskVisually('first', 1);

    expect(mockTaskOrder).toEqual(['hidden', 'second', 'first']);
  });
});

describe('toggleAITerminalLayout', () => {
  it('flips an unset (split) layout to tabs and back', () => {
    mockTasks['task-1'] = { agentIds: ['a', 'b'], shellAgentIds: [] };

    toggleAITerminalLayout('task-1');
    expect(mockTasks['task-1'].aiTerminalLayout).toBe('tabs');

    toggleAITerminalLayout('task-1');
    expect(mockTasks['task-1'].aiTerminalLayout).toBe('split');
  });

  it('is a no-op for an unknown task', () => {
    toggleAITerminalLayout('missing');
    expect(mockTasks['missing']).toBeUndefined();
  });
});

// ─── Coordinator tests ────────────────────────────────────────────────────────

const baseEvent = {
  taskId: 'sub-task-1',
  name: 'Sub Task',
  projectId: 'proj-1',
  branchName: 'task/sub-task-1',
  worktreePath: '/repo/.worktrees/sub-task-1',
  agentId: 'agent-sub-1',
  coordinatorTaskId: 'coordinator-1',
  mcpLaunchArgs: ['--config', 'mcp_servers.parallel-code={ command = "node" }'],
};

describe('coordinator controlledBy state machine (item 9: UI disabled-state regression tests)', () => {
  it('9a: sub-task created via MCP starts with controlledBy: coordinator (not undefined)', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('9b: manually added task without coordinatorMode starts with controlledBy undefined', () => {
    mockTasks['plain-task'] = {
      agentIds: ['agent-plain'],
      shellAgentIds: [],
    };
    expect(mockTasks['plain-task'].controlledBy).toBeUndefined();
  });

  it('9c: setTaskControl transitions controlledBy to human', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
    setTaskControl('sub-task-1', 'human');
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');
  });

  it('9c: setTaskControl transitions controlledBy back to coordinator', () => {
    taskCreatedHandler(baseEvent);
    setTaskControl('sub-task-1', 'human');
    setTaskControl('sub-task-1', 'coordinator');
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('9d: setTaskControl is a no-op for unknown taskId (no crash)', () => {
    expect(() => setTaskControl('nonexistent-task', 'human')).not.toThrow();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.MCP_ControlChanged, expect.anything());
  });

  it('rolls back sub-task control when backend acknowledgement fails', async () => {
    taskCreatedHandler(baseEvent);
    mockInvoke.mockRejectedValueOnce(new Error('coordinator missing'));

    setTaskControl('sub-task-1', 'human');
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');

    await Promise.resolve();
    await Promise.resolve();

    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
  });

  it('persists sub-task control only after backend acknowledgement succeeds', async () => {
    taskCreatedHandler(baseEvent);

    setTaskControl('sub-task-1', 'human');
    expect(mockSaveState).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');
    expect(mockInvoke).toHaveBeenCalledWith(IPC.MCP_ControlChanged, {
      taskId: 'sub-task-1',
      controlledBy: 'human',
    });
    expect(mockSaveState).toHaveBeenCalledTimes(1);
  });

  it('9e: removing a coordinator task leaves no entry in mockTasks', () => {
    mockTasks['coordinator-task'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      controlledBy: 'coordinator',
    };
    mockTaskOrder.push('coordinator-task');
    expect(mockTasks['coordinator-task'].controlledBy).toBe('coordinator');

    delete mockTasks['coordinator-task'];
    const idx = mockTaskOrder.indexOf('coordinator-task');
    if (idx !== -1) mockTaskOrder.splice(idx, 1);

    const hasActiveCoordinator = Object.values(mockTasks).some(
      (t) => (t as MockTask & { coordinatorMode?: boolean }).coordinatorMode,
    );
    expect(hasActiveCoordinator).toBe(false);
    expect(mockTasks['coordinator-task']).toBeUndefined();
  });
});

describe('MCP_TaskCreated IPC handler', () => {
  it('ignores duplicate task-created events without resetting spawn state', () => {
    taskCreatedHandler(baseEvent);
    taskCreatedHandler(baseEvent);

    expect(mockTaskOrder).toEqual(['sub-task-1']);
    expect(markAgentSpawned).toHaveBeenCalledTimes(1);
    expect(rescheduleTaskStatusPolling).toHaveBeenCalledTimes(1);
  });

  it('sets controlledBy to coordinator on the new sub-task', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('sets coordinatedBy to the coordinator task ID', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].coordinatedBy).toBe('coordinator-1');
  });

  it('stores MCP launch args so coordinated subtasks respawn with MCP configured', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].mcpLaunchArgs).toEqual(baseEvent.mcpLaunchArgs);
  });

  it('stores the backend-owned initial prompt for display and restart hydration', () => {
    taskCreatedHandler({ ...baseEvent, prompt: 'do the work' });
    expect(mockTasks['sub-task-1'].initialPrompt).toBe('do the work');
  });

  it('regression: sub-tasks must not be created without controlledBy defined', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBeDefined();
  });

  // This def is synthesised when availableAgents has no entry for the
  // coordinator's command, and it is persisted under `id: cmd` — an id
  // enrichAgentDef will never match on restore — so an empty list here is
  // stored permanently and read by every later consumer of the def.
  it("synthesises a fallback def carrying the command's skip-permissions flags", () => {
    taskCreatedHandler({ ...baseEvent, agentCommand: 'claude' });
    const agent = mockAgents['agent-sub-1'] as { def: { skip_permissions_args: string[] } };
    expect(agent.def.skip_permissions_args).toEqual(['--dangerously-skip-permissions']);
  });

  it('leaves the fallback def empty for a command that takes no such flag', () => {
    taskCreatedHandler({ ...baseEvent, agentCommand: 'opencode' });
    const agent = mockAgents['agent-sub-1'] as { def: { skip_permissions_args: string[] } };
    expect(agent.def.skip_permissions_args).toEqual([]);
  });
});

describe('task automation activity lease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockTasks['sub-task-1'] = {
      agentIds: ['agent-sub-1'],
      shellAgentIds: [],
      coordinatedBy: 'coordinator-1',
      controlledBy: 'coordinator',
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('temporarily holds automation after user activity, then releases automatically', () => {
    markTaskUserActivity('sub-task-1');

    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');
    expect(mockTasks['sub-task-1'].userActivityHoldUntil).toBe(5_000);

    vi.advanceTimersByTime(4_999);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');

    vi.advanceTimersByTime(1);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('does not optimistically switch to human while a coordinated initial prompt is pending', () => {
    mockTasks['sub-task-1'].initialPrompt = 'do the work';

    markTaskUserActivity('sub-task-1');

    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.MCP_ControlChanged, {
      taskId: 'sub-task-1',
      controlledBy: 'human',
    });
  });

  it('extends the activity hold when more user activity arrives', () => {
    markTaskUserActivity('sub-task-1');
    vi.advanceTimersByTime(3_000);

    markTaskUserActivity('sub-task-1');

    expect(mockTasks['sub-task-1'].userActivityHoldUntil).toBe(8_000);
    vi.advanceTimersByTime(4_999);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');

    vi.advanceTimersByTime(1);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('does not release while a prompt draft remains active', () => {
    setTaskPromptDraftActive('sub-task-1', true);

    vi.advanceTimersByTime(10_000);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');

    setTaskPromptDraftActive('sub-task-1', false);
    vi.runOnlyPendingTimers();
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('does not release while terminal input remains pending', () => {
    setTaskTerminalInputPending('sub-task-1', true);

    vi.advanceTimersByTime(10_000);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');

    setTaskTerminalInputPending('sub-task-1', false);
    vi.runOnlyPendingTimers();
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });
});

describe('terminalInputPendingFromQuestion — real typing survives self-resolving question', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks['sub-task-1'] = {
      agentIds: ['agent-sub-1'],
      shellAgentIds: [],
      coordinatedBy: 'coordinator-1',
      controlledBy: 'coordinator' as const,
    };
    mockTaskOrder.push('sub-task-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    mockTaskOrder.length = 0;
  });

  it('clearing the question flag does not clear terminalInputPending', () => {
    // Question appears: mark pending as question-originated.
    setTaskTerminalInputPendingFromQuestion('sub-task-1');
    setTaskTerminalInputPending('sub-task-1', true);
    expect(mockTasks['sub-task-1'].terminalInputPendingFromQuestion).toBe(true);
    expect(mockTasks['sub-task-1'].terminalInputPending).toBe(true);

    // User types in the terminal before question self-dismisses: clears the flag, not pending.
    clearTerminalInputPendingFromQuestion('sub-task-1');
    expect(mockTasks['sub-task-1'].terminalInputPendingFromQuestion).toBeUndefined();
    expect(mockTasks['sub-task-1'].terminalInputPending).toBe(true);
  });

  it('setTaskTerminalInputPending(false) also clears the question flag when pending is cleared', () => {
    setTaskTerminalInputPendingFromQuestion('sub-task-1');
    setTaskTerminalInputPending('sub-task-1', true);
    // Question resolves with flag still set (no real typing happened).
    setTaskTerminalInputPending('sub-task-1', false);
    expect(mockTasks['sub-task-1'].terminalInputPending).toBeUndefined();
    expect(mockTasks['sub-task-1'].terminalInputPendingFromQuestion).toBeUndefined();
  });
});

describe('collapseTask — coordinated child guard (TODO #23)', () => {
  it('keeps each pane on its own session across repeated collapse and reopen', async () => {
    const def = {
      id: 'claude',
      name: 'Claude',
      command: 'claude',
      args: [],
      resume_args: ['--continue'],
      skip_permissions_args: [],
      description: '',
    };
    const sessions = [
      'fb4f2bc6-62d9-4b29-a795-240caf2fc459',
      null,
      'fb4f2bc6-62d9-4b29-a795-240caf2fc460',
    ] as const;
    mockTasks.task = {
      id: 'task',
      agentIds: ['a', 'b', 'c'],
      shellAgentIds: [],
      agentSessionIds: { a: sessions[0], c: sessions[2] },
    };
    for (const id of ['a', 'b', 'c']) {
      mockAgents[id] = createAgentRecord({ id, taskId: 'task', def });
    }
    mockTaskOrder.push('task');
    for (let round = 0; round < 2; round++) {
      await collapseTask('task');
      expect(mockTasks.task.savedAgentSessionIds).toEqual(sessions);
      expect(mockTasks.task.agentSessionIds).toBeUndefined();
      uncollapseTask('task');
      const task = mockTasks.task;
      expect(task.agentIds.map((id) => task.agentSessionIds?.[id] ?? null)).toEqual(sessions);
      expect(task.savedAgentSessionIds).toBeUndefined();
      for (const id of task.agentIds) expect(mockAgents[id]).toMatchObject({ resumed: true });
    }
  });

  it('is a no-op when task has coordinatedBy set', async () => {
    mockTasks['sub-task-1'] = {
      agentIds: ['agent-1'],
      shellAgentIds: [],
      coordinatedBy: 'coordinator-1',
      collapsed: false,
    };
    mockTaskOrder.push('sub-task-1');

    await collapseTask('sub-task-1');

    expect(mockTasks['sub-task-1'].agentIds).toEqual(['agent-1']);
    expect(mockTasks['sub-task-1'].collapsed).toBeFalsy();
    expect(mockTaskOrder).toContain('sub-task-1');
  });

  it('proceeds normally for tasks without coordinatedBy', async () => {
    mockTasks['plain-task'] = {
      agentIds: ['agent-2'],
      shellAgentIds: [],
      collapsed: false,
    };
    mockTaskOrder.push('plain-task');

    await collapseTask('plain-task');

    expect(mockTasks['plain-task'].agentIds).toEqual([]);
    expect(mockTasks['plain-task'].collapsed).toBe(true);
  });
});

describe('hasActiveCoordinator condition — coordinator task removal', () => {
  it('condition is false when the store has no tasks', () => {
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });

  it('condition is true when a coordinator task exists in the store', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: undefined,
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(true);
  });

  it('condition is false after the coordinator task is removed from the store', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: undefined,
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    delete mockTasks['coord-1'];
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });

  it('condition is false when the coordinator task has closingStatus set (is being closed)', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: 'closing',
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });
});

// ─── MCP startup failure handling (TODO #43) ─────────────────────────────────

describe('MCP startup status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockInvoke.mockResolvedValue(undefined);
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
  });

  it('markTaskMcpPending sets status to pending', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [] };
    markTaskMcpPending('task-1');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('pending');
  });

  it('markTaskMcpReady sets status to ready', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [], mcpStartupStatus: 'pending' };
    markTaskMcpReady('task-1');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('ready');
  });

  it('markTaskMcpError sets status to error with control chars stripped', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [], mcpStartupStatus: 'pending' };
    // \x1b (ESC, 0x1b) is a control char and gets stripped; printable chars like '[31m' remain
    markTaskMcpError('task-1', 'Connection refused\x1b[31m injected\x1b[0m');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('error');
    expect(mockTasks['task-1'].mcpStartupError).toBe('Connection refused[31m injected[0m');
  });

  it('failed StartMCPServer marks coordinator task with error instead of staying pending', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
    };
    mockAgents['agent-coord'] = { def: { command: 'claude', args: [] } };
    mockInvoke.mockRejectedValueOnce(new Error('port in use'));

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('error');
    expect(String(mockTasks['coord-1'].mcpStartupError)).toContain('port in use');
  });

  it('successful StartMCPServer marks coordinator task as ready', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
    };
    mockAgents['agent-coord'] = { def: { command: 'claude', args: [] } };
    mockInvoke.mockResolvedValueOnce({ mcpLaunchArgs: ['--mcp-config', '/tmp/coord.json'] });

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('ready');
    expect(mockTasks['coord-1'].mcpLaunchArgs).toEqual(['--mcp-config', '/tmp/coord.json']);
  });

  it('allows Claude Docker coordinator MCP startup with no launch args', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
      dockerMode: true,
    };
    mockAgents['agent-coord'] = { def: { command: 'claude', args: [] } };
    mockInvoke.mockResolvedValueOnce({ mcpLaunchArgs: [] });

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('ready');
    expect(mockTasks['coord-1'].mcpStartupError).toBeUndefined();
  });

  it('allows Antigravity coordinator MCP startup with persisted config path and no launch args', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
      mcpConfigPath: '/tmp/coord.json',
    };
    mockAgents['agent-coord'] = { def: { command: 'agy', args: [] } };
    mockInvoke.mockResolvedValueOnce({ mcpLaunchArgs: [] });

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('ready');
    expect(mockTasks['coord-1'].mcpStartupError).toBeUndefined();
  });

  it('missing MCP launch args leaves a Codex coordinated task in error', async () => {
    mockTasks['coord-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      mcpStartupStatus: 'ready',
    };
    mockTasks['child-1'] = {
      agentIds: ['agent-child'],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-1',
      branchName: 'task/child-1',
    };
    mockAgents['agent-child'] = { def: { command: 'codex', args: [] } };
    mockInvoke.mockResolvedValueOnce({ mcpLaunchArgs: [] });

    markTaskMcpPending('child-1');
    await retryTaskMcpStartup('child-1');

    expect(mockTasks['child-1'].mcpStartupStatus).toBe('error');
    expect(String(mockTasks['child-1'].mcpStartupError)).toContain('no launch args');
  });

  it('child hydration failure marks only that child as error, leaving sibling spawnable', async () => {
    mockTasks['coord-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      mcpStartupStatus: 'ready',
    };
    mockTasks['child-a'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-a',
      branchName: 'task/child-a',
    };
    mockTasks['child-b'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-b',
      branchName: 'task/child-b',
    };

    // child-a fails, child-b succeeds
    mockInvoke
      .mockRejectedValueOnce(new Error('hydrate failed'))
      .mockResolvedValueOnce({ mcpLaunchArgs: ['--mcp-config', '/tmp/child-b.json'] });

    markTaskMcpPending('child-a');
    await retryTaskMcpStartup('child-a');
    markTaskMcpPending('child-b');
    await retryTaskMcpStartup('child-b');

    expect(mockTasks['child-a'].mcpStartupStatus).toBe('error');
    expect(mockTasks['child-b'].mcpStartupStatus).toBe('ready');
    expect(mockTasks['child-b'].mcpLaunchArgs).toEqual(['--mcp-config', '/tmp/child-b.json']);
  });

  it('retry of child when coordinator is in error surfaces dependency message', async () => {
    mockTasks['coord-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      mcpStartupStatus: 'error',
    };
    mockTasks['child-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-1',
      branchName: 'task/child-1',
      mcpStartupStatus: 'error',
    };

    await retryTaskMcpStartup('child-1');

    expect(mockTasks['child-1'].mcpStartupStatus).toBe('error');
    expect(String(mockTasks['child-1'].mcpStartupError)).toContain('coordinator');
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.MCP_HydrateCoordinatedTask, expect.anything());
  });
});

describe('createTask delegation options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks = {};
    mockAgents = {};
    mockTaskOrder = [];
    mockDefaultStepsEnabled = false;
    mockAgentEnvFiles = { 'agent-def': '~/.config/parallel-code/claude.env' };
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
    vi.mocked(getProjectBranchPrefix).mockReturnValue('task');
    vi.mocked(isProjectMissing).mockReturnValue(false);
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.CreateTask) {
        return Promise.resolve({
          id: 'parent-1',
          branch_name: 'task/parent-work',
          worktree_path: '/repo/.worktrees/parent-work',
        });
      }
      return Promise.resolve(undefined);
    });
  });

  async function createParent(options = {}) {
    return createTask({
      name: 'Parent',
      agentDef: {
        id: 'agent-def',
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: 'Claude',
      },
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      initialPrompt: 'Work through this backlog',
      ...options,
    });
  }

  it('keeps backlog instructions as the prompt and prepares authority without eager MCP', async () => {
    await createParent({
      autoMergeChildren: true,
      autoSendChildUpdates: true,
      propagateSkipPermissions: true,
      maxConcurrentTasks: 5,
    });

    expect(mockTasks['parent-1']).toMatchObject({
      initialPrompt: 'Work through this backlog',
      savedInitialPrompt: 'Work through this backlog',
      autoMergeChildren: true,
      autoSendChildUpdates: true,
      propagateSkipPermissions: true,
      maxConcurrentTasks: 5,
    });
    expect(mockTasks['parent-1'].coordinatorMode).toBeUndefined();
    expect(mockTasks['parent-1'].controlledBy).toBeUndefined();
    expect(mockTasks['parent-1'].mcpStartupStatus).toBeUndefined();
    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.StartMCPServer)).toBe(false);
    expect(
      mockInvoke.mock.calls.some(([channel]) => channel === IPC.MCP_CoordinatorRegistered),
    ).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
      action: 'register',
      task: expect.objectContaining({
        taskId: 'parent-1',
        autoMergeChildren: true,
        autoSendChildUpdates: true,
        propagateSkipPermissions: true,
        maxConcurrentTasks: 5,
        agentEnvFile: '~/.config/parallel-code/claude.env',
      }),
    });
  });

  it('defaults worktree permissions and concurrency safely and retains explicit false options', async () => {
    await createParent({ autoMergeChildren: false, autoSendChildUpdates: false });
    expect(mockTasks['parent-1']).toMatchObject({
      autoMergeChildren: false,
      autoSendChildUpdates: false,
      propagateSkipPermissions: false,
      maxConcurrentTasks: 3,
    });
  });
});

// ─── createTask stepsEnabled default regression ────────────────────────────────

describe('createTask does not mutate defaultStepsEnabled', () => {
  const agentDef = {
    id: 'agent-def',
    name: 'Claude',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Claude',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks = {};
    mockAgents = {};
    mockTaskOrder = [];
    mockDefaultStepsEnabled = false;
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
    vi.mocked(getProjectBranchPrefix).mockReturnValue('task');
    vi.mocked(isProjectMissing).mockReturnValue(false);
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.CreateTask) {
        return Promise.resolve({
          id: 'task-1',
          branch_name: 'task/my-task',
          worktree_path: '/repo/.worktrees/my-task',
        });
      }
      return Promise.resolve(undefined);
    });
  });

  it('does not write back defaultStepsEnabled when stepsEnabled differs from the default', async () => {
    mockDefaultStepsEnabled = false;
    await createTask({
      name: 'My Task',
      agentDef,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      stepsEnabled: true,
    });
    const defaultsMutated = mockSetStore.mock.calls.some(
      (args) => args[0] === 'defaultStepsEnabled',
    );
    expect(defaultsMutated).toBe(false);
  });
});

// A task's own first pane is created by a different path from the panes added
// to it later, and only the latter used to get a session id. Without one the
// pane launches on the positional default, which means "the newest session in
// this worktree" — so as soon as a second pane exists, pane one resumes pane
// two's conversation. That silent swap is the whole reason ids exist.
describe('createTask assigns the first pane a session id', () => {
  function agentDef(command: string) {
    return {
      id: 'agent-def',
      name: command,
      command,
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: command,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks = {};
    mockAgents = {};
    mockTaskOrder = [];
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
    vi.mocked(getProjectBranchPrefix).mockReturnValue('task');
    vi.mocked(isProjectMissing).mockReturnValue(false);
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.CreateTask) {
        return Promise.resolve({
          id: 'task-1',
          branch_name: 'task/my-task',
          worktree_path: '/repo/.worktrees/my-task',
        });
      }
      return Promise.resolve(undefined);
    });
  });

  async function createWith(command: string) {
    await createTask({
      name: 'My Task',
      agentDef: agentDef(command),
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      baseBranch: 'main',
    });
    return mockTasks['task-1'];
  }

  it('waits for authority acknowledgment before inserting a task that can spawn', async () => {
    const original = mockInvoke.getMockImplementation();
    let release: (() => void) | undefined;
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockInvoke.mockImplementation((channel: string, args: unknown) => {
      if (channel === IPC.DelegationRequest) return registered;
      return original?.(channel, args);
    });
    const creating = createWith('claude');
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.DelegationRequest,
        expect.objectContaining({ action: 'register' }),
      ),
    );
    expect(mockTasks['task-1']).toBeUndefined();
    release?.();
    await creating;
    expect(mockTasks['task-1']).toBeDefined();
  });

  it('gives the first Claude pane an id of its own', async () => {
    const task = await createWith('claude');
    const agentId = expectDefined(task?.agentIds[0], 'first pane id');
    expect(task?.agentSessionIds?.[agentId]).toEqual(expect.any(String));
  });

  // Claude rejects `--session-id` for a session that already exists, so the id
  // has to be new rather than reused from anywhere.
  it('gives two tasks different ids', async () => {
    const first = (await createWith('claude'))?.agentSessionIds;
    mockTasks = {};
    mockAgents = {};
    const second = (await createWith('claude'))?.agentSessionIds;
    expect(Object.values(first ?? {})[0]).not.toBe(Object.values(second ?? {})[0]);
  });

  // Codex assigns its own ids, so one invented here would name a session that
  // never existed and break the resume it was meant to fix.
  it('leaves a Codex pane without one', async () => {
    const task = await createWith('codex');
    expect(task?.agentSessionIds ?? {}).toEqual({});
  });
});

// ─── sendPrompt tests ─────────────────────────────────────────────────────────

function writePayloads(): string[] {
  return mockInvoke.mock.calls
    .filter(([channel]) => channel === IPC.WriteToAgent)
    .map(([, payload]) => (payload as { data: string }).data);
}

describe('sendPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockInvoke.mockResolvedValue(undefined);
    mockIsAgentBracketedPasteEnabled.mockReturnValue(false);
    mockAgents = { 'agent-1': { status: 'running' } };
    mockTasks = { 'task-1': { agentIds: [], shellAgentIds: [], lastPrompt: '' } };
  });

  it('cancels an automated prompt during readiness retries', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mockInvoke.mockRejectedValue(new Error('agent not found'));
    const sending = sendPrompt('task-1', 'agent-1', 'Child complete', {
      signal: controller.signal,
    });
    const result = expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(writePayloads()).toEqual(['\x1b[I']);
    expect(mockTasks['task-1'].lastPrompt).toBe('');
    vi.useRealTimers();
  });

  it('does not write the automated body if policy changes while focus delivery is pending', async () => {
    const controller = new AbortController();
    mockInvoke.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      sendPrompt('task-1', 'agent-1', 'Child complete', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(writePayloads()).toEqual(['\x1b[I']);
    expect(mockTasks['task-1'].lastPrompt).toBe('');
  });

  it('cancels automatic Enter during the paste delay without changing manual delivery', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sending = sendPrompt('task-1', 'agent-1', 'Child complete', {
      signal: controller.signal,
    });
    const result = expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(writePayloads()).toEqual(['\x1b[I', 'Child complete']);
    expect(mockInvoke).toHaveBeenLastCalledWith(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'Child complete',
      automation: true,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(writePayloads()).not.toContain('\r');
    expect(mockTasks['task-1'].lastPrompt).toBe('');
    mockInvoke.mockClear();
    const manual = sendPrompt('task-1', 'agent-1', 'Manual prompt');
    await vi.advanceTimersByTimeAsync(500);
    await manual;
    expect(writePayloads()).toEqual(['\x1b[I', 'Manual prompt', '\r']);
    vi.useRealTimers();
  });

  it('wraps prompt text in bracketed paste when the agent enabled it', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~hello Codex\x1b[201~', '\r']);
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'lastPrompt', 'hello Codex');
  });

  it('sends raw prompt text when bracketed paste is not enabled', async () => {
    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', 'hello Codex', '\r']);
  });

  it('clears stale terminal input after the app submits a prompt', async () => {
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].terminalInputPending = true;
    await sendPrompt('task-1', 'agent-1', 'Continue');
    expect(mockTasks['task-1'].terminalInputPending).toBeUndefined();
  });

  it('keeps terminal input pending if submitting Enter fails', async () => {
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].terminalInputPending = true;
    mockInvoke.mockImplementation(async (_channel, payload) => {
      if (payload?.data === '\r') throw new Error('PTY closed');
    });
    await expect(sendPrompt('task-1', 'agent-1', 'Continue')).rejects.toThrow('PTY closed');
    expect(mockTasks['task-1'].terminalInputPending).toBe(true);
  });

  it('does not clear the main terminal draft when sending to another agent', async () => {
    mockTasks['task-1'].agentIds = ['main-agent', 'agent-1'];
    mockTasks['task-1'].terminalInputPending = true;
    await sendPrompt('task-1', 'agent-1', 'Continue');
    expect(mockTasks['task-1'].terminalInputPending).toBe(true);
  });

  it.each([
    'please explain our architecture in reasoning graph',
    'show the Reasoning Graph',
    'update the mindmap',
    'create a mind map',
    'show a live map',
  ])('includes canvas tool guidance with the chat request: %s', async (prompt) => {
    mockAgents['agent-1'] = { status: 'running', canvasTools: true };
    mockTasks['task-1'].promptedAgentIds = ['agent-1'];
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', prompt);

    const writes = writePayloads();
    expect(writes).toHaveLength(3);
    expect(writes[1].startsWith('\x1b[200~')).toBe(true);
    expect(writes[1]).toContain(prompt);
    expect(writes[1]).toContain('canvas_open with view "reasoning"');
    expect(writes[1]).toContain('reasoning_read and reasoning_update');
    expect(writes[1]).toContain('mindmap_read and mindmap_update');
    expect(writes[1]).toContain('A Mermaid diagram or text graph in chat does not populate');
    expect(writes[1].endsWith('\x1b[201~')).toBe(true);
    expect(writes[2]).toBe('\r');
    expect(mockTasks['task-1'].lastPrompt).toBe(prompt);
  });

  it('sends the canvas guidance once per agent session and never with app prompts', async () => {
    mockAgents['agent-1'] = { status: 'running', canvasTools: true, generation: 3 };
    mockTasks['task-1'].promptedAgentIds = ['agent-1'];
    const prompt = 'update the mind map';

    await sendPrompt('task-1', 'agent-1', prompt, { appPrompt: true });
    expect(writePayloads()[1]).toBe(prompt);

    await sendPrompt('task-1', 'agent-1', prompt);
    expect(writePayloads()[4]).toContain('mindmap_read and mindmap_update');

    await sendPrompt('task-1', 'agent-1', 'and the reasoning graph too');
    expect(writePayloads()[7]).toBe('and the reasoning graph too');

    mockAgents['agent-1'] = { status: 'running', canvasTools: true, generation: 4 };
    await sendPrompt('task-1', 'agent-1', prompt);
    expect(writePayloads()[10]).toContain('mindmap_read and mindmap_update');
  });

  it('sends the canvas guidance again when the delivery failed', async () => {
    mockAgents['agent-1'] = { status: 'running', canvasTools: true, generation: 5 };
    mockTasks['task-1'].promptedAgentIds = ['agent-1'];
    const prompt = 'update the mind map';
    mockInvoke.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('gone'));

    await expect(sendPrompt('task-1', 'agent-1', prompt)).rejects.toThrow('gone');
    await sendPrompt('task-1', 'agent-1', prompt);
    expect(writePayloads().at(-2)).toContain('mindmap_read and mindmap_update');
  });

  it('does not mark a session restarted mid-send as guided', async () => {
    mockAgents['agent-1'] = { status: 'running', canvasTools: true, generation: 6 };
    mockTasks['task-1'].promptedAgentIds = ['agent-1'];
    const prompt = 'update the mind map';
    mockInvoke.mockImplementation(async (channel: string, payload: unknown) => {
      // The agent restarts while the prompt text is on its way to the old session.
      if (channel === IPC.WriteToAgent && (payload as { data: string }).data.includes(prompt))
        mockAgents['agent-1'] = { status: 'running', canvasTools: true, generation: 7 };
    });

    await sendPrompt('task-1', 'agent-1', prompt);
    expect(mockAgents['agent-1']).not.toHaveProperty('canvasGuidanceGeneration');

    await sendPrompt('task-1', 'agent-1', prompt);
    expect(writePayloads().at(-2)).toContain('mindmap_read and mindmap_update');
    expect(mockAgents['agent-1']).toMatchObject({ canvasGuidanceGeneration: 7 });
  });

  it.each([false, undefined])(
    'does not advertise unavailable canvas tools (%s)',
    async (available) => {
      mockAgents['agent-1'] = { status: 'running', canvasTools: available };
      const prompt = 'please explain our architecture in reasoning graph';

      await sendPrompt('task-1', 'agent-1', prompt);

      expect(writePayloads()).toEqual(['\x1b[I', prompt, '\r']);
    },
  );

  it('leaves unrelated prompts unchanged when canvas tools are available', async () => {
    mockAgents['agent-1'] = { status: 'running', canvasTools: true };

    await sendPrompt('task-1', 'agent-1', 'explain our architecture');

    expect(writePayloads()).toEqual(['\x1b[I', 'explain our architecture', '\r']);
  });

  it('checks canvas availability after startup when sending the initial prompt', async () => {
    const prompt = 'please explain our architecture in reasoning graph';
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].initialPrompt = prompt;
    mockInvoke.mockImplementationOnce(async () => {
      mockAgents['agent-1'] = { status: 'running', canvasTools: true };
    });

    await sendPrompt('task-1', 'agent-1', prompt);

    expect(writePayloads()[1]).toContain('canvas_open with view "reasoning"');
    expect(mockTasks['task-1'].initialPrompt).toBeUndefined();
    expect(mockTasks['task-1'].lastPrompt).toBe(prompt);
  });

  it('routes chat prompts through app-server without writing into the hidden terminal', async () => {
    mockAgents = { 'agent-1': { status: 'running', def: { id: 'codex' } } };
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].mainAgentView = 'chat';
    await sendPrompt('task-1', 'agent-1', 'hello chat');
    expect(mockInvoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'send',
      agentId: 'agent-1',
      text: 'hello chat',
    });
    expect(writePayloads()).toEqual([]);
    expect(mockTasks['task-1'].lastPrompt).toBe('hello chat');
  });

  it('supplies canvas guidance to a fresh chat and keeps it out of later messages and history', async () => {
    const items: { kind: 'user'; text: string }[] = [];
    mockAgents = {
      'agent-1': {
        status: 'running',
        def: { id: 'codex' },
        canvasTools: true,
        chatState: { items },
      },
    };
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].mainAgentView = 'chat';
    const sentText = () => (mockInvoke.mock.lastCall?.[1] as { text: string }).text;
    await sendPrompt('task-1', 'agent-1', 'Create a mind map');
    expect(sentText()).toContain('canvas_open');
    expect(mockTasks['task-1'].lastPrompt).toBe('Create a mind map');
    items.push({ kind: 'user', text: 'Create a mind map' });
    await sendPrompt('task-1', 'agent-1', 'Continue');
    expect(sentText()).toBe('Continue');
  });

  it('delivers chat images with steps and records only accepted prompts', async () => {
    mockAgents = { 'agent-1': { status: 'running', def: { id: 'codex' } } };
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].mainAgentView = 'chat';
    mockTasks['task-1'].stepsEnabled = true;
    const images = [{ name: 'shot.png', mediaType: 'image/png' as const, data: 'AAAA' }];
    mockInvoke.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(sendPrompt('task-1', 'agent-1', 'hello chat', { images })).rejects.toThrow(
      'Disconnected',
    );
    expect(mockTasks['task-1'].lastPrompt).toBe('');
    await sendPrompt('task-1', 'agent-1', 'hello chat', { images });
    expect(mockInvoke).toHaveBeenLastCalledWith(IPC.AgentChat, {
      action: 'send',
      agentId: 'agent-1',
      text: expect.stringContaining('For active statuses'),
      images,
    });
    expect(mockTasks['task-1'].lastPrompt).toBe('hello chat');
    expect(writePayloads()).toEqual([]);
  });

  it('does not record a prompt rejected by app-server', async () => {
    mockAgents = { 'agent-1': { status: 'running', def: { id: 'codex' } } };
    mockTasks['task-1'].agentIds = ['agent-1'];
    mockTasks['task-1'].mainAgentView = 'chat';
    mockInvoke.mockRejectedValue(new Error('Disconnected'));
    await expect(sendPrompt('task-1', 'agent-1', 'not accepted')).rejects.toThrow('Disconnected');
    expect(mockTasks['task-1'].lastPrompt).toBe('');
    expect(writePayloads()).toEqual([]);
  });

  it('asks tracked active steps to describe what is happening now', async () => {
    mockTasks['task-1'].stepsEnabled = true;

    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    const injectedPrompt = writePayloads()[1];
    expect(injectedPrompt).toContain(
      'For active statuses, describe what is happening now in present tense.',
    );
    expect(injectedPrompt).toContain(
      'For awaiting_review and done, describe the outcome or decision.',
    );
    expect(injectedPrompt).toContain('must always contain one valid JSON array');
    expect(injectedPrompt).toContain('rewrite the complete array');
    expect(injectedPrompt).not.toContain('Outcome-oriented, not action-oriented.');
  });

  it('keeps Enter outside the bracketed paste block', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'line 1\nline 2');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~line 1\nline 2\x1b[201~', '\r']);
  });

  it('records repeated sent prompts separately and preserves the legacy last prompt', async () => {
    mockTasks['task-1'].lastPrompt = 'Earlier prompt';
    mockAgents['agent-1'] = { status: 'running', def: { name: 'Codex' } };
    await sendPrompt('task-1', 'agent-1', 'continue');
    await sendPrompt('task-1', 'agent-1', 'continue');
    expect(mockTasks['task-1'].promptHistory).toEqual([
      { text: 'Earlier prompt' },
      { text: 'continue', sentAt: expect.any(Number), agentId: 'agent-1' },
      { text: 'continue', sentAt: expect.any(Number), agentId: 'agent-1' },
    ]);
  });

  it('records terminal-entered prompts, but ignores empty input and removed tasks', () => {
    setLastPrompt('task-1', 'Typed in the terminal', 'agent-1');
    setLastPrompt('task-1', '   ', 'agent-1');
    setLastPrompt('missing', 'Do not recreate this task', 'agent-1');
    expect(mockTasks['task-1'].promptHistory).toHaveLength(1);
    expect(mockTasks['task-1'].lastPrompt).toBe('Typed in the terminal');
    expect(mockTasks.missing).toBeUndefined();
  });

  it('keeps only the most recent prompts so a long session cannot grow the save forever', () => {
    for (let i = 0; i < MAX_PROMPT_HISTORY + 20; i++) setLastPrompt('task-1', `prompt ${i}`);
    const history = mockTasks['task-1'].promptHistory as Array<{ text: string }>;
    expect(history).toHaveLength(MAX_PROMPT_HISTORY);
    expect(history[0].text).toBe('prompt 20');
    expect(history.at(-1)?.text).toBe(`prompt ${MAX_PROMPT_HISTORY + 19}`);
  });

  it('does not record a prompt when sending fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('PTY closed'));
    await expect(sendPrompt('task-1', 'agent-1', 'not sent')).rejects.toThrow('PTY closed');
    expect(mockTasks['task-1'].promptHistory).toBeUndefined();
    expect(mockTasks['task-1'].lastPrompt).toBe('');
  });

  it.each(['landed_pending_review', 'landed_cleanup_failed', 'reviewed'] as const)(
    'does not write to the agent when the task is %s',
    async (landingState) => {
      mockTasks['task-1'].landingState = landingState;

      await expect(sendPrompt('task-1', 'agent-1', 'hello Codex')).rejects.toThrow(
        'no longer writable',
      );

      expect(writePayloads()).toEqual([]);
      expect(mockSetStore).not.toHaveBeenCalledWith('tasks', 'task-1', 'lastPrompt', 'hello Codex');
    },
  );
});

// ─── MCP_TaskCleanupFailed IPC handler ───────────────────────────────────────

const cleanupFailedHandler = ipcHandlers.get(IPC.MCP_TaskCleanupFailed);
if (!cleanupFailedHandler) throw new Error('mcp_task_cleanup_failed handler not registered');

describe('MCP_TaskCleanupFailed IPC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks = {
      'task-1': {
        agentIds: ['agent-1'],
        shellAgentIds: [],
        closingStatus: 'closing',
      },
    };
  });

  it('marks the task closingStatus as error', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'git worktree delete failed' });

    expect(mockTasks['task-1'].closingStatus).toBe('error');
  });

  it('sets closingError to the error message', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'git worktree delete failed' });

    expect(mockTasks['task-1'].closingError).toBe('git worktree delete failed');
  });

  it('does NOT remove the task from the store', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'delete failed' });

    expect(mockTasks['task-1']).toBeDefined();
  });

  it('is a no-op if the task does not exist', () => {
    expect(() =>
      cleanupFailedHandler({ taskId: 'nonexistent', error: 'delete failed' }),
    ).not.toThrow();
    expect(mockTasks['task-1'].closingStatus).toBe('closing');
  });
});

// ─── closeTask — IPC ordering (#37) ──────────────────────────────────────────

describe('closeTask — IPC cleanup ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockInvoke.mockResolvedValue(undefined);
  });

  it.each([
    { gitIsolation: 'direct', externalWorktree: undefined, removes: true },
    { gitIsolation: 'none', externalWorktree: undefined, removes: true },
    { gitIsolation: 'worktree', externalWorktree: true, removes: true },
    { gitIsolation: 'worktree', externalWorktree: undefined, removes: false },
  ])(
    'removes reasoning reports only when the checkout outlives the task: %j',
    async ({ gitIsolation, externalWorktree, removes }) => {
      mockTasks['task-1'] = {
        agentIds: [],
        shellAgentIds: [],
        gitIsolation,
        externalWorktree,
        worktreePath: '/repo',
        projectId: 'proj-1',
      };
      mockInvoke.mockResolvedValue(undefined);

      await closeTask('task-1');

      const removal = mockInvoke.mock.calls.find(([c]) => c === IPC.RemoveReasoningFeeds);
      expect(removal?.[1]).toEqual(
        removes ? { worktreePath: '/repo', taskId: 'task-1' } : undefined,
      );
      expect(mockTasks['task-1']?.closingStatus).toBe('removing');
    },
  );

  it('MCP_CoordinatedTaskClosed rejection is swallowed and task is still removed', async () => {
    mockTasks['task-1'] = {
      agentIds: ['agent-1'],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      gitIsolation: 'direct', // skip DeleteTask to keep invoke sequence simple
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatedTaskClosed) {
        return Promise.reject(new Error('backend gone'));
      }
      return Promise.resolve(undefined);
    });

    await closeTask('task-1');

    // removeTaskFromStore marks 'removing' synchronously; setTimeout deletion is not awaited
    expect(mockTasks['task-1']?.closingStatus).toBe('removing');
  });

  it('MCP_CoordinatedTaskClosed resolves before removeTaskFromStore is called', async () => {
    const order: string[] = [];
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatedTaskClosed) {
        return Promise.resolve(undefined).then(() => {
          order.push('ipc');
        });
      }
      return Promise.resolve(undefined);
    });
    // Intercept setStore to detect when removeTaskFromStore marks task as 'removing'
    const origImpl = mockSetStore.getMockImplementation();
    mockSetStore.mockImplementation((...args: unknown[]) => {
      if (origImpl) origImpl(...args);
      // Phase-1 of removeTaskFromStore: setStore('tasks', id, 'closingStatus', 'removing')
      if (args[2] === 'closingStatus' && args[3] === 'removing') order.push('remove');
    });

    await closeTask('task-1');

    const ipcIdx = order.indexOf('ipc');
    const removeIdx = order.indexOf('remove');
    expect(ipcIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(ipcIdx);
  });

  it('closes a parent through one backend lifecycle operation', async () => {
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: [], collapsed: [] });
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.DelegationRequest) return Promise.resolve({ detachedChildIds: [] });
      return Promise.resolve(undefined);
    });

    await closeTask('coord-1');

    expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
      action: 'closeParent',
      taskId: 'coord-1',
      deleteBranch: true,
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.MCP_CoordinatorDeregistered, expect.anything());
    // removeTaskFromStore marks 'removing' synchronously; setTimeout deletion is not awaited
    expect(mockTasks['coord-1']?.closingStatus).toBe('removing');
  });

  it('detaches coordinator children without clearing backend review state', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === IPC.DelegationRequest ? { detachedChildIds: ['child-1'] } : undefined,
    );
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: ['child-1'], collapsed: [] });
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockTasks['child-1'] = {
      agentIds: ['agent-child'],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      controlledBy: 'coordinator',
      mcpConfigPath: '/tmp/mcp.json',
      mcpStartupStatus: 'ready',
      mcpStartupError: 'stale',
      signalDoneReceived: true,
      needsReview: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };

    await closeTask('coord-1');

    expect(mockTasks['child-1'].coordinatedBy).toBeUndefined();
    expect(mockTasks['child-1'].controlledBy).toBeUndefined();
    expect(mockTasks['child-1'].mcpConfigPath).toBeUndefined();
    expect(mockTasks['child-1'].mcpStartupStatus).toBeUndefined();
    expect(mockTasks['child-1'].mcpStartupError).toBeUndefined();
    expect(mockTasks['child-1'].signalDoneReceived).toBe(true);
    expect(mockTasks['child-1'].needsReview).toBe(true);
  });
});

describe('Super Productivity completion wiring', () => {
  const worktreeTask = () => ({
    agentIds: [],
    shellAgentIds: [],
    gitIsolation: 'worktree',
    projectId: 'proj-1',
    branchName: 'task/task-1',
    worktreePath: '/repo/.worktrees/task-1',
    baseBranch: 'main',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
    mockInvoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === IPC.MergeTask ? { lines_added: 10, lines_removed: 2 } : undefined,
      ),
    );
  });

  it('arms a merged completion on merge with cleanup and fires it on removal', async () => {
    mockTasks['task-1'] = worktreeTask();
    await mergeTask('task-1', { cleanup: true });
    expect(armSpCompletion).toHaveBeenCalledWith('task-1', {
      kind: 'merged',
      linesAdded: 10,
      linesRemoved: 2,
    });
    expect(fireSpCompletion).toHaveBeenCalledWith('task-1');
  });

  it('does not complete anything for a merge that keeps the task', async () => {
    mockTasks['task-1'] = worktreeTask();
    await mergeTask('task-1', { cleanup: false });
    expect(armSpCompletion).not.toHaveBeenCalled();
    expect(fireSpCompletion).not.toHaveBeenCalled();
  });

  it('closeTask fires on removal but never arms by itself (project removal relies on this)', async () => {
    mockTasks['task-1'] = worktreeTask();
    await closeTask('task-1');
    expect(armSpCompletion).not.toHaveBeenCalled();
    expect(fireSpCompletion).toHaveBeenCalledWith('task-1');
  });

  it('a subtask the coordinator closes or lands is completed', () => {
    const closedHandler = expectDefined(ipcHandlers.get(IPC.MCP_TaskClosed), 'closed handler');
    // The removal also clears the task's git status entry.
    Object.assign(expectDefined(core.harness, 'mock store harness').store, { taskGitStatus: {} });
    mockTasks['child-1'] = { ...worktreeTask(), coordinatedBy: 'coord-1' };
    mockTasks['child-2'] = { ...worktreeTask(), coordinatedBy: 'coord-1' };
    closedHandler({ taskId: 'child-1' });
    // What the coordinator sends after land_self or merge_task with cleanup.
    closedHandler({ taskId: 'child-2', merged: { linesAdded: 4, linesRemoved: 1 } });
    expect(armSpCompletion).toHaveBeenCalledWith('child-1', { kind: 'closed' });
    expect(armSpCompletion).toHaveBeenCalledWith('child-2', {
      kind: 'merged',
      linesAdded: 4,
      linesRemoved: 1,
    });
    expect(fireSpCompletion).toHaveBeenCalledWith('child-1');
    expect(fireSpCompletion).toHaveBeenCalledWith('child-2');
  });

  it('a subtask that merged earlier and is closed later still counts as merged', () => {
    const closedHandler = expectDefined(ipcHandlers.get(IPC.MCP_TaskClosed), 'closed handler');
    Object.assign(expectDefined(core.harness, 'mock store harness').store, { taskGitStatus: {} });
    // approve-and-merge, or a land whose cleanup failed, then a plain close.
    mockTasks['child-3'] = {
      ...worktreeTask(),
      coordinatedBy: 'coord-1',
      landingState: 'landed_cleanup_failed',
    };
    closedHandler({ taskId: 'child-3' });
    expect(armSpCompletion).toHaveBeenCalledWith('child-3', { kind: 'merged' });
  });

  it('a rename is passed on', () => {
    mockTasks['task-1'] = worktreeTask();
    updateTaskName('task-1', 'Renamed');
    expect(onTaskRenamed).toHaveBeenCalledWith('task-1');
  });
});

describe('recordTaskMerged counts merges with cleanup, not closures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockInvoke.mockResolvedValue(undefined);
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
  });

  it('closing an unmerged task does NOT increment the counter', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };

    await closeTask('task-1');

    expect(recordTaskMerged).not.toHaveBeenCalled();
  });

  it('merging with cleanup increments the counter once', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'worktree',
      projectId: 'proj-1',
      branchName: 'task/task-1',
      worktreePath: '/repo/.worktrees/task-1',
      baseBranch: 'main',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MergeTask) {
        return Promise.resolve({ lines_added: 10, lines_removed: 2 });
      }
      return Promise.resolve(undefined);
    });

    await mergeTask('task-1', { cleanup: true });

    expect(recordTaskMerged).toHaveBeenCalledTimes(1);
    expect(recordMergedLines).toHaveBeenCalledTimes(1);
    expect(recordMergedLines).toHaveBeenCalledWith(10, 2);
  });

  it('merging without cleanup does NOT increment the counter or lines totals', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'worktree',
      projectId: 'proj-1',
      branchName: 'task/task-1',
      worktreePath: '/repo/.worktrees/task-1',
      baseBranch: 'main',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MergeTask) {
        return Promise.resolve({ lines_added: 10, lines_removed: 2 });
      }
      return Promise.resolve(undefined);
    });

    await mergeTask('task-1', { cleanup: false });

    expect(recordTaskMerged).not.toHaveBeenCalled();
    expect(recordMergedLines).not.toHaveBeenCalled();
  });
});

describe('MCP_TaskStateSync listener', () => {
  beforeEach(() => {
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      controlledBy: 'coordinator',
      mcpConfigPath: '/tmp/mcp.json',
      mcpStartupStatus: 'ready',
      mcpStartupError: 'stale',
      signalDoneReceived: true,
      signalDoneAt: '2026-05-19T10:00:00Z',
      signalDoneConsumed: true,
      needsReview: true,
    };
  });

  it('clears done/review flags when backend sends a running-state sync', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });

    expect(mockTasks['task-1'].signalDoneReceived).toBe(false);
    expect(mockTasks['task-1'].signalDoneAt).toBeUndefined();
    expect(mockTasks['task-1'].signalDoneConsumed).toBe(false);
    expect(mockTasks['task-1'].needsReview).toBe(false);
  });

  it('clears coordinator wiring and MCP startup state from null sync fields', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      coordinatedBy: null,
      controlledBy: null,
      mcpConfigPath: null,
      mcpStartupStatus: null,
      mcpStartupError: null,
    });

    expect(mockTasks['task-1'].coordinatedBy).toBeUndefined();
    expect(mockTasks['task-1'].controlledBy).toBeUndefined();
    expect(mockTasks['task-1'].mcpConfigPath).toBeUndefined();
    expect(mockTasks['task-1'].mcpStartupStatus).toBeUndefined();
    expect(mockTasks['task-1'].mcpStartupError).toBeUndefined();
  });

  it('replaces the verification run outright and clears it on null', () => {
    const base = {
      command: 'npm test',
      exitCode: null,
      headSha: null,
      dirty: false,
      startedAt: '2026-09-03T10:00:00Z',
      finishedAt: '2026-09-03T10:10:00Z',
      outputTail: '',
    };
    taskStateSyncHandler({
      taskId: 'task-1',
      verificationRun: { ...base, status: 'timed_out', message: 'Timed out after 10 min.' },
    });
    expect(mockTasks['task-1'].verificationRun).toMatchObject({
      status: 'timed_out',
      message: 'Timed out after 10 min.',
    });

    // The next run arrives without a message key; it must not inherit the old one.
    taskStateSyncHandler({
      taskId: 'task-1',
      verificationRun: { ...base, status: 'passed', exitCode: 0 },
    });
    expect(mockTasks['task-1'].verificationRun).toMatchObject({ status: 'passed' });
    expect((mockTasks['task-1'].verificationRun as { message?: string }).message).toBeUndefined();

    taskStateSyncHandler({ taskId: 'task-1', verificationRun: null });
    expect(mockTasks['task-1'].verificationRun).toBeUndefined();
  });

  it('stores automation write lock sync fields', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      automationWriteInFlight: true,
    });

    expect(mockTasks['task-1'].automationWriteInFlight).toBe(true);
  });

  it('stores landed pending-review and verification sync fields', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
      landingState: 'landed_pending_review',
      landingSummary: 'implemented',
      landedMetadata: {
        taskId: 'task-1',
        taskName: 'Task 1',
        coordinatorTaskId: 'coord-1',
        targetBranch: 'main',
        landedCommit: 'abc123',
        landedAt: '2026-05-24T00:00:00Z',
        landedOrder: 1,
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
      },
      needsReview: true,
    });

    expect(mockTasks['task-1'].landingState).toBe('landed_pending_review');
    expect(
      (mockTasks['task-1'].verification as { checks: Array<{ result: string }> }).checks[0].result,
    ).toBe('passed');
    expect((mockTasks['task-1'].landedMetadata as { landedCommit: string }).landedCommit).toBe(
      'abc123',
    );
    expect(mockTasks['task-1'].needsReview).toBe(true);
    expect(vi.mocked(saveState)).toHaveBeenCalled();
  });

  it('clears landed pending-review state locally', () => {
    mockTasks['task-1'].landingState = 'landed_pending_review';
    mockTasks['task-1'].needsReview = true;

    clearTaskLandingReview('task-1');

    expect(mockTasks['task-1'].landingState).toBe('reviewed');
    expect(mockTasks['task-1'].needsReview).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith(IPC.MCP_TaskLandingReviewCleared, {
      taskId: 'task-1',
    });
  });
});

describe('pasteDelayMs', () => {
  it('returns 50ms for a short single-line prompt', () => {
    expect(pasteDelayMs('hello')).toBe(50);
  });

  it('scales by line count for a ~31-line prompt', () => {
    const text = Array.from({ length: 31 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(Math.min(500, Math.max(50, 31 * 15)));
  });

  it('caps at 500ms for a very large prompt', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(500);
  });
});

describe('mergeTask / pushTask preconditions', () => {
  beforeEach(() => {
    const harness = expectDefined(core.harness, 'mock store harness');
    harness.reset(harness.state());
    mockInvoke.mockReset();
    vi.mocked(getProjectPath).mockReset();
  });

  it('mergeTask throws instead of silently returning for a missing task', async () => {
    await expect(mergeTask('nope')).rejects.toThrow('Task no longer exists');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('mergeTask refuses a task that is being closed', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'worktree',
      closingStatus: 'removing',
      projectId: 'proj-1',
    };
    await expect(mergeTask('task-1')).rejects.toThrow('being closed');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('mergeTask refuses direct-mode tasks with a reason', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    await expect(mergeTask('task-1')).rejects.toThrow('worktree');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('mergeTask reports a missing project folder', async () => {
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'worktree',
      projectId: 'proj-gone',
    };
    vi.mocked(getProjectPath).mockReturnValue(undefined);
    await expect(mergeTask('task-1')).rejects.toThrow('Project folder not found');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('pushTask throws for a missing task, a direct-mode task, and a missing project', async () => {
    const channel = { onmessage: undefined } as unknown as Parameters<typeof pushTask>[1];
    await expect(pushTask('nope', channel)).rejects.toThrow('Task no longer exists');

    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'direct',
      projectId: 'p',
    };
    await expect(pushTask('task-1', channel)).rejects.toThrow('worktree');

    mockTasks['task-2'] = {
      agentIds: [],
      shellAgentIds: [],
      gitIsolation: 'worktree',
      projectId: 'p',
    };
    vi.mocked(getProjectPath).mockReturnValue(undefined);
    await expect(pushTask('task-2', channel)).rejects.toThrow('Project folder not found');
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
