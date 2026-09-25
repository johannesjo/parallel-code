import type { BrowserWindow } from 'electron';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';
import { registerAllHandlers } from './register.js';

/**
 * Guards the wiring of `registerAllHandlers` while it is split into modules:
 * every channel is handled exactly once, window and PTY listeners are attached
 * once, and the coordinator handlers stay lazy and register exactly once.
 */

type Handler = (event: unknown, args: Record<string, unknown>) => unknown;

const { handlers, duplicates, onPtyEvent } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: Record<string, unknown>) => unknown>(),
  duplicates: [] as string[],
  onPtyEvent: vi.fn((_event: string, _listener: (agentId: string) => void) => () => {}),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, args: Record<string, unknown>) => unknown,
    ) => {
      if (handlers.has(channel)) duplicates.push(channel);
      handlers.set(channel, handler);
    },
  },
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  dialog: {},
  shell: {},
  clipboard: {},
  BrowserWindow: {},
  Notification: {},
}));
vi.mock('./pty.js', async (original) => ({
  ...(await original<typeof import('./pty.js')>()),
  onPtyEvent,
}));
// Only what `ensureCoordinator` calls exists, so StartMCPServer stops right after it.
vi.mock('../mcp/coordinator.js', () => ({
  Coordinator: class {
    setOrchestrationEnabled(): void {}
    setNotify(): void {}
    setSessionMcpProvider(): void {}
  },
}));

/** Manifest channels `registerAllHandlers` must not handle. */
const NOT_HANDLED_HERE: readonly string[] = [
  // Registered by `electron/main.ts` through other modules.
  IPC.BrowserBounds,
  IPC.BrowserCommand,
  IPC.LogFromRenderer,
  // Main → renderer only.
  IPC.AgentHookEvent,
  IPC.BrowserState,
  IPC.DelegationChanged,
  IPC.DocumentAnnotationEvent,
  IPC.DocumentChanged,
  IPC.DocumentRunEvent,
  IPC.MCP_CoordinatorNotificationCleared,
  IPC.MCP_CoordinatorNotificationStaged,
  IPC.MCP_CoordinatorOrphanedNotification,
  IPC.MCP_OpenCanvasRequest,
  IPC.MCP_PublishTourRequest,
  IPC.MCP_ReadMindMapRequest,
  IPC.MCP_ReadReasoningRequest,
  IPC.MCP_StaleUrlWarning,
  IPC.MCP_TaskCleanupFailed,
  IPC.MCP_TaskClosed,
  IPC.MCP_TaskCreated,
  IPC.MCP_TaskHydrated,
  IPC.MCP_TaskStateSync,
  IPC.MCP_UpdateMindMapRequest,
  IPC.MCP_UpdateReasoningRequest,
  IPC.NotificationClicked,
  IPC.NotificationFailed,
  IPC.PlanContent,
  IPC.PrChecksUpdate,
  IPC.Remote_CreateTaskRequest,
  IPC.Remote_GetNotesRequest,
  IPC.Remote_GetProjectsRequest,
  IPC.Remote_SetNotesRequest,
  IPC.StepsContent,
  IPC.SuperProductivityOpenTaskRequested,
  IPC.UpdateStatusChanged,
  IPC.WindowBlur,
  IPC.WindowCloseRequested,
  IPC.WindowFocus,
  IPC.WindowMoved,
  IPC.WindowResized,
];

/** Registered only once the coordinator is loaded. */
const COORDINATOR_CHANNELS: readonly string[] = [
  IPC.MCP_ControlChanged,
  IPC.MCP_CoordinatedTaskClosed,
  IPC.MCP_CoordinatedTaskPromptDelivered,
  IPC.MCP_CoordinatorDeregistered,
  IPC.MCP_CoordinatorNotificationAck,
  IPC.MCP_CoordinatorNotificationDropAck,
  IPC.MCP_CoordinatorRegistered,
  IPC.MCP_CoordinatorRestageAfterUserSend,
  IPC.MCP_HydrateCoordinatedTask,
  IPC.MCP_TaskLandingReviewCleared,
];

function register(): ReturnType<typeof vi.fn> {
  const on = vi.fn();
  const win = { on, isDestroyed: () => false, webContents: { send: vi.fn() } };
  registerAllHandlers(win as unknown as BrowserWindow);
  return on;
}

/** Loads the coordinator through StartMCPServer; the stub makes the rest of it fail. */
async function startCoordinator(): Promise<void> {
  const start: Handler | undefined = handlers.get(IPC.StartMCPServer);
  const pending = start?.(undefined, {
    coordinatorTaskId: '12345678-1234-4234-8234-123456789abc',
    projectId: 'project',
    projectRoot: os.tmpdir(),
  });
  await Promise.resolve(pending).catch(() => undefined);
}

const sorted = (values: Iterable<string>) => [...values].sort();

afterEach(() => {
  handlers.clear();
  duplicates.length = 0;
  vi.clearAllMocks();
});

describe('registerAllHandlers wiring', () => {
  it('handles every manifest channel exactly once, coordinator channels only when loaded', async () => {
    register();
    const eager = new Set(handlers.keys());
    await startCoordinator();
    await startCoordinator();

    expect(duplicates).toEqual([]);
    expect(sorted(COORDINATOR_CHANNELS.filter((c) => eager.has(c)))).toEqual([]);
    expect(sorted([...handlers.keys()].filter((c) => !eager.has(c)))).toEqual(
      sorted(COORDINATOR_CHANNELS),
    );
    expect(sorted(Object.values(IPC).filter((c) => !handlers.has(c)))).toEqual(
      sorted(NOT_HANDLED_HERE),
    );
    expect(
      sorted([...handlers.keys()].filter((c) => !Object.values<string>(IPC).includes(c))),
    ).toEqual([]);
  });

  it('attaches window listeners and the PTY exit listener once', () => {
    const on = register();

    expect(sorted(on.mock.calls.map(([event]) => String(event)))).toEqual(
      sorted([
        // register.ts
        'blur',
        'close',
        'closed',
        'focus',
        'move',
        'resize',
        // pr-checks.ts polls only while the window is visible
        'hide',
        'minimize',
        'restore',
        'show',
        // browser.ts
        'closed',
      ]),
    );
    expect(onPtyEvent.mock.calls.map(([event]) => event)).toEqual(['exit']);
  });
});
