import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

// Hoisted so these refs are available both in vi.mock() factories and in test bodies.
const { mockInvoke, mockIsAgentBracketedPasteEnabled, mockSaveState, mockSetStore } = vi.hoisted(
  () => ({
    mockInvoke: vi.fn(),
    mockIsAgentBracketedPasteEnabled: vi.fn(),
    mockSaveState: vi.fn(),
    mockSetStore: vi.fn(),
  }),
);

// ─── Coordinator test infrastructure ─────────────────────────────────────────

type MockTask = {
  controlledBy?: 'coordinator' | 'human';
  coordinatedBy?: string;
  agentIds: string[];
  shellAgentIds: string[];
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
let mockAgents: Record<string, unknown> = {};
let mockTaskOrder: string[] = [];
let mockCollapsedTaskOrder: string[] = [];
let mockProjects: { id: string; path: string }[] = [];
let mockPanelGroupCollapsed: Record<string, boolean> = {};
const ipcHandlers = new Map<string, (data: unknown) => void>();

function applySetStore(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === 'function') {
    (
      args[0] as (s: {
        tasks: Record<string, MockTask>;
        agents: Record<string, unknown>;
        taskOrder: string[];
        collapsedTaskOrder: string[];
        panelGroupCollapsed: Record<string, boolean>;
      }) => void
    )({
      tasks: mockTasks,
      agents: mockAgents,
      taskOrder: mockTaskOrder,
      collapsedTaskOrder: mockCollapsedTaskOrder,
      panelGroupCollapsed: mockPanelGroupCollapsed,
    });
    return;
  }
  // Path-based: setStore('tasks', taskId, 'field', value)
  const value = args[args.length - 1];
  let target: Record<string, unknown> = {
    tasks: mockTasks,
    agents: mockAgents,
    taskOrder: mockTaskOrder,
  };
  for (let i = 0; i < args.length - 2; i++) {
    const next = target[args[i] as string] as Record<string, unknown> | undefined;
    if (next === undefined || next === null) return;
    target = next;
  }
  target[args[args.length - 2] as string] = value;
}

// Wire up mockSetStore to apply mutations so coordinator tests can read back state.
// Re-applied in sendPrompt's beforeEach after vi.clearAllMocks().
mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../lib/ipc', () => ({ Channel: vi.fn(), invoke: mockInvoke }));

let mockDefaultStepsEnabled = false;

vi.mock('./core', () => ({
  store: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'tasks') return mockTasks;
      if (prop === 'agents') return mockAgents;
      if (prop === 'taskOrder') return mockTaskOrder;
      if (prop === 'collapsedTaskOrder') return mockCollapsedTaskOrder;
      if (prop === 'panelGroupCollapsed') return mockPanelGroupCollapsed;
      if (prop === 'availableAgents') return [];
      if (prop === 'projects') return mockProjects;
      if (prop === 'defaultStepsEnabled') return mockDefaultStepsEnabled;
      return undefined;
    },
  }),
  setStore: mockSetStore,
  cleanupPanelEntries: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ Channel: vi.fn(), invoke: mockInvoke }));
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
vi.mock('./coordinator-preamble', () => ({ COORDINATOR_PREAMBLE: '' }));
vi.mock('./sidebar-order', () => ({ getCoordinatorChildren: vi.fn() }));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
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
  closeTask,
  mergeTask,
  sendPrompt,
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
  updateTaskBranch,
} from './tasks';
import { getCoordinatorChildren } from './sidebar-order';
import { recordMergedLines, recordTaskMerged } from './completion';
import { markAgentSpawned, rescheduleTaskStatusPolling } from './taskStatus';
import { saveState } from './persistence';
import { getProjectBranchPrefix, getProjectPath, isProjectMissing } from './projects';

// ─── Coordinator listener setup ───────────────────────────────────────────────

initMCPListeners();
const taskCreatedHandler = ipcHandlers.get('mcp_task_created');
if (!taskCreatedHandler) throw new Error('mcp_task_created handler not registered');
const taskStateSyncHandler = ipcHandlers.get('mcp_task_state_sync');
if (!taskStateSyncHandler) throw new Error('mcp_task_state_sync handler not registered');

beforeEach(() => {
  vi.clearAllMocks();
  mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
  mockCollapsedTaskOrder = [];
  mockProjects = [];
  mockPanelGroupCollapsed = {};
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
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

describe('createTask coordinator base branch prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockTasks = {};
    mockAgents = {};
    mockTaskOrder = [];
    vi.mocked(getProjectPath).mockReturnValue('/repo');
    vi.mocked(getProjectBranchPrefix).mockReturnValue('task');
    vi.mocked(isProjectMissing).mockReturnValue(false);
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.CreateTask) {
        return Promise.resolve({
          id: 'coord-1',
          branch_name: 'task/coordinator-work',
          worktree_path: '/repo/.worktrees/coordinator-work',
        });
      }
      if (channel === IPC.StartMCPServer) {
        return Promise.resolve({ mcpLaunchArgs: ['--mcp-config', '/tmp/coord.json'] });
      }
      return Promise.resolve(undefined);
    });
  });

  it('tells coordinators to base sub-tasks on the coordinator branch, not its base branch', async () => {
    await createTask({
      name: 'Coordinator',
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
      initialPrompt: 'Pick a task',
      coordinatorMode: true,
    });

    expect(mockTasks['coord-1'].initialPrompt).toContain(
      'Use `task/coordinator-work` as the baseBranch for all sub-tasks.',
    );
    expect(mockTasks['coord-1'].initialPrompt).not.toContain(
      'Use `main` as the baseBranch for all sub-tasks.',
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.StartMCPServer,
      expect.objectContaining({ coordinatorBranch: 'task/coordinator-work' }),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.MCP_CoordinatorRegistered,
      expect.objectContaining({ coordinatorBranch: 'task/coordinator-work' }),
    );
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockTasks = {};
    mockAgents = {};
    mockTaskOrder = [];
    mockPanelGroupCollapsed = {};
    mockDefaultStepsEnabled = false;
    vi.mocked(getProjectPath).mockReturnValue('/repo');
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

  it('expands a collapsed project group so a newly active task panel is visible', async () => {
    mockPanelGroupCollapsed['proj-1:independent'] = true;

    await createTask({
      name: 'My Task',
      agentDef,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      baseBranch: 'main',
    });

    expect(mockTaskOrder).toEqual(['task-1']);
    expect(mockTasks['task-1']).toMatchObject({ projectId: 'proj-1' });
    expect(mockPanelGroupCollapsed['proj-1:independent']).toBe(false);
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
    // Re-apply after clearAllMocks() so coordinator store mutations still work.
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
    mockIsAgentBracketedPasteEnabled.mockReturnValue(false);
    mockAgents = { 'agent-1': { status: 'running' } };
    mockTasks = { 'task-1': { agentIds: [], shellAgentIds: [], lastPrompt: '' } };
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

  it('keeps Enter outside the bracketed paste block', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'line 1\nline 2');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~line 1\nline 2\x1b[201~', '\r']);
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
  });

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

  it('MCP_CoordinatorDeregistered rejection is swallowed and coordinator is still removed', async () => {
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: [], collapsed: [] });
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatorDeregistered) {
        return Promise.reject(new Error('deregister failed'));
      }
      return Promise.resolve(undefined);
    });

    await closeTask('coord-1');

    // removeTaskFromStore marks 'removing' synchronously; setTimeout deletion is not awaited
    expect(mockTasks['coord-1']?.closingStatus).toBe('removing');
  });

  it('detaches coordinator children without clearing backend review state', async () => {
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

describe('recordTaskMerged counts merges with cleanup, not closures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
    vi.mocked(getProjectPath).mockReturnValue('/repo');
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
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
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
