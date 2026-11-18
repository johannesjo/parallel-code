import { describe, expect, it, vi, beforeEach } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type StagedNotification = {
  batchId: string;
  notificationIds: string[];
  text: string;
  autoFireAt: number;
  userEdited: boolean;
  hiddenCompletionCount?: number;
};

type MockTask = {
  stagedNotification?: StagedNotification;
  agentIds: string[];
  shellAgentIds: string[];
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<{ tasks: Record<string, MockTask> }> | undefined,
}));
const ipcHandlers = new Map<string, (data: unknown) => void>();
const activeHandlerCounts = new Map<string, number>();

vi.mock('solid-js/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('solid-js/store')>();
  const { mockSolidStoreProduce } = await import('./test-helpers');
  return { ...actual, ...mockSolidStoreProduce() };
});

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get tasks() {
      return mockTasks;
    },
    set tasks(next) {
      mockTasks = next;
    },
  });
  return core.harness.moduleMock({ cleanupPanelEntries: vi.fn() });
});

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../electron/ipc/channels', () => ({
  IPC: {
    DelegationChanged: 'delegation_changed',
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_TaskStateSync: 'mcp_task_state_sync',
  },
}));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));
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
  isAgentIdle: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));
vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskMerged: vi.fn(),
}));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));
vi.mock('../lib/clean-task-name', () => ({ cleanTaskName: vi.fn() }));
vi.mock('./sidebar-order', () => ({ getCoordinatorChildren: vi.fn() }));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
}));

// Stub window so initMCPListeners can register IPC handlers.
// Must run before initMCPListeners() is called below.
vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        activeHandlerCounts.set(_channel, (activeHandlerCounts.get(_channel) ?? 0) + 1);
        ipcHandlers.set(_channel, handler);
        let cleanedUp = false;
        return () => {
          if (cleanedUp) return;
          cleanedUp = true;
          activeHandlerCounts.set(
            _channel,
            Math.max(0, (activeHandlerCounts.get(_channel) ?? 0) - 1),
          );
          if (ipcHandlers.get(_channel) === handler) ipcHandlers.delete(_channel);
        };
      },
    },
  },
});

import {
  initMCPListeners,
  clearStagedNotification,
  setStagedNotificationUserEdited,
} from './tasks';

// Register IPC handlers once. The captured stageHandler closes over the store
// proxy, which always reads from the current mockTasks variable.
initMCPListeners();
const stageHandler = ipcHandlers.get('mcp_coordinator_notification_staged');
if (!stageHandler) throw new Error('mcp_coordinator_notification_staged handler not registered');

function setTask(id: string, overrides: Partial<MockTask> = {}): void {
  mockTasks[id] = { agentIds: [], shellAgentIds: [], ...overrides };
}

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockTasks = {};
});

describe('staged notification store logic', () => {
  it('replaces existing MCP listeners instead of stacking duplicate handlers', () => {
    expect(activeHandlerCounts.get('mcp_coordinator_notification_staged')).toBe(1);
    expect(activeHandlerCounts.get('mcp_coordinator_notification_cleared')).toBe(1);

    initMCPListeners();

    expect(activeHandlerCounts.get('mcp_coordinator_notification_staged')).toBe(1);
    expect(activeHandlerCounts.get('mcp_coordinator_notification_cleared')).toBe(1);
  });

  it('replaces notification A when notification B arrives before A fires', () => {
    setTask('task-1');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1'],
      text: 'notification A',
      autoFireAt: 1000,
    });
    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-a');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-b',
      notificationIds: ['n2'],
      text: 'notification B',
      autoFireAt: 2000,
    });

    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-b');
    expect(mockTasks['task-1'].stagedNotification?.text).toBe('notification B');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(false);
  });

  it('stages new notification normally after userEdited — userEdited is per-notification not sticky', () => {
    setTask('task-1');

    // Stage notification A with two notification IDs
    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1', 'n2'],
      text: 'notification A',
      autoFireAt: 1000,
    });

    // User edits the staged notification
    setStagedNotificationUserEdited('task-1');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(true);

    // New batch arrives with fewer IDs — should replace, not be suppressed
    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-b',
      notificationIds: ['n3'],
      text: 'notification B',
      autoFireAt: 2000,
    });

    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-b');
    expect(mockTasks['task-1'].stagedNotification?.text).toBe('notification B');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(false);
  });

  it.each([
    { ids: ['n1', 'n2'], added: 0 },
    { ids: ['n2', 'n1'], added: 0 },
    { ids: ['n1'], added: 0 },
    { ids: ['n1', 'n3'], added: 1 },
    { ids: ['n1', 'n2', 'n3', 'n4'], added: 2 },
  ])('holds a canceled batch across overlapping restaging: $ids', ({ ids, added }) => {
    setTask('task-1');
    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'original',
      notificationIds: ['n1', 'n2'],
      text: 'Held draft',
      autoFireAt: 1000,
    });
    setStagedNotificationUserEdited('task-1');
    const restaged = {
      coordinatorTaskId: 'task-1',
      batchId: 'restaged',
      notificationIds: ids,
      text: 'Replacement summary',
      autoFireAt: 301000,
    };
    stageHandler(restaged);
    stageHandler({ ...restaged, batchId: 'restaged-again', autoFireAt: 601000 });
    expect(mockTasks['task-1'].stagedNotification).toEqual({
      batchId: 'restaged-again',
      notificationIds: ids,
      text: 'Held draft',
      autoFireAt: 601000,
      userEdited: true,
      hiddenCompletionCount: added,
    });
    clearStagedNotification('task-1');
    stageHandler({ ...restaged, batchId: 'fresh', notificationIds: ['fresh-id'] });
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(false);
  });

  it('clears the staged notification', () => {
    setTask('task-1');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1'],
      text: 'notification A',
      autoFireAt: 1000,
    });
    expect(mockTasks['task-1'].stagedNotification).toBeDefined();

    clearStagedNotification('task-1');

    expect(mockTasks['task-1'].stagedNotification).toBeUndefined();
  });
});
