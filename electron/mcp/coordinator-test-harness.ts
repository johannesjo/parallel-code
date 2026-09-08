import type { BrowserWindow } from 'electron';
import { vi } from 'vitest';
import type { AgentHookEventPayload } from '../agent-hooks/status.js';

export type BackendTaskFixture = {
  id: string;
  branch_name: string;
  worktree_path: string;
};

export type CoordinatorHarnessOptions = {
  coordinatorId?: string;
  projectId?: string;
  projectPath?: string;
  register?: boolean;
};

const defaultBackendTask = (): BackendTaskFixture => ({
  id: 'task-1',
  branch_name: 'task/test',
  worktree_path: '/tmp/test',
});

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

const mocks = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  const mockWriteFileSync = vi.fn();
  const mockReadFileSync = vi.fn();
  const mockExistsSync = vi.fn();
  const mockUnlinkSync = vi.fn();
  const mockMkdirSync = vi.fn();
  const mockFsWriteFile = vi.fn();
  const mockFsReadFile = vi.fn();
  const mockFsAccess = vi.fn();
  const mockFsUnlink = vi.fn();
  const mockFsMkdir = vi.fn();
  const mockAtomicWriteFileSync = vi.fn();
  const mockAtomicWriteFile = vi.fn();
  const mockNotifyRenderer = vi.fn();
  const mockLogInfo = vi.fn();
  const mockLogWarn = vi.fn();
  const mockOnPtyEvent = vi.fn();
  const mockOnAgentHookEvent = vi.fn();
  const mockSpawnAgent = vi.fn();
  const mockWriteToAgent = vi.fn();
  const mockKillAgent = vi.fn();
  const mockSubscribeToAgent = vi.fn();
  const mockUnsubscribeFromAgent = vi.fn();
  const mockGetAgentScrollback = vi.fn();
  const mockGetChangedFiles = vi.fn();
  const mockGetAllFileDiffs = vi.fn();
  const mockGetDiffBaseSha = vi.fn();
  const mockGitMergeTask = vi.fn();
  const mockCreateBackendTask = vi.fn();
  const mockDeleteBackendTask = vi.fn();
  const mockVerifyStart = vi.fn();
  const mockVerifyCancel = vi.fn();

  return {
    mockExecFile,
    mockWriteFileSync,
    mockReadFileSync,
    mockExistsSync,
    mockUnlinkSync,
    mockMkdirSync,
    mockFsWriteFile,
    mockFsReadFile,
    mockFsAccess,
    mockFsUnlink,
    mockFsMkdir,
    mockAtomicWriteFileSync,
    mockAtomicWriteFile,
    mockNotifyRenderer,
    mockLogInfo,
    mockLogWarn,
    mockOnPtyEvent,
    mockOnAgentHookEvent,
    mockSpawnAgent,
    mockWriteToAgent,
    mockKillAgent,
    mockSubscribeToAgent,
    mockUnsubscribeFromAgent,
    mockGetAgentScrollback,
    mockGetChangedFiles,
    mockGetAllFileDiffs,
    mockGetDiffBaseSha,
    mockGitMergeTask,
    mockCreateBackendTask,
    mockDeleteBackendTask,
    mockVerifyStart,
    mockVerifyCancel,
  };
});

vi.mock('child_process', () => ({
  execFile: mocks.mockExecFile,
}));

vi.mock('fs', () => ({
  writeFileSync: mocks.mockWriteFileSync,
  readFileSync: mocks.mockReadFileSync,
  existsSync: mocks.mockExistsSync,
  unlinkSync: mocks.mockUnlinkSync,
  mkdirSync: mocks.mockMkdirSync,
}));

vi.mock('fs/promises', () => ({
  writeFile: mocks.mockFsWriteFile,
  readFile: mocks.mockFsReadFile,
  access: mocks.mockFsAccess,
  unlink: mocks.mockFsUnlink,
  mkdir: mocks.mockFsMkdir,
}));

vi.mock('./atomic.js', () => ({
  atomicWriteFileSync: mocks.mockAtomicWriteFileSync,
  atomicWriteFile: mocks.mockAtomicWriteFile,
}));

vi.mock('../shared/prompt-detect.js', () => ({
  stripAnsi: (s: string) =>
    s.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
      '',
    ),
  AGENT_READY_TAIL_CHARS: 1000,
  getAgentPromptReadiness: (s: string) => {
    const tail = s.slice(-1000);
    if (
      /\bDo\s+you\s+trust\b|\bPress\s+enter\s+to\s+continue\b|\bBooting\s+MCP\s+server\b|\bStarting\s+MCP\s+servers?\b/i.test(
        tail,
      )
    ) {
      return { ready: false, reason: 'startup_or_dialog', tail };
    }
    if (
      /\bq*Working\s*\(|\bbackground\s+terminal\s+running\b|\besc\s+to\s+interrupt\b|\/stop\s+to\s+close\b/i.test(
        tail,
      )
    ) {
      return { ready: false, reason: 'busy', tail };
    }
    const ready = tail
      .slice(-1000)
      .split(/\r\n?|\n/)
      .some((line) =>
        /(?:^|\s)[❯›]\s*$|^\s*--\s*INSERT\s*--\s*$|^\s*>\s*(?:Type your message|$)/i.test(
          line.trim(),
        ),
      );
    return { ready, reason: ready ? 'ready' : 'no_prompt', tail };
  },
  chunkContainsAgentPrompt: (s: string) => {
    const tail = s.slice(-1000);
    if (
      /\bDo\s+you\s+trust\b|\bPress\s+enter\s+to\s+continue\b|\bBooting\s+MCP\s+server\b|\bStarting\s+MCP\s+servers?\b/i.test(
        tail,
      )
    ) {
      return false;
    }
    if (
      /\bq*Working\s*\(|\bbackground\s+terminal\s+running\b|\besc\s+to\s+interrupt\b|\/stop\s+to\s+close\b/i.test(
        tail,
      )
    ) {
      return false;
    }
    return tail
      .split(/\r\n?|\n/)
      .some((line) =>
        /(?:^|\s)[❯›]\s*$|^\s*--\s*INSERT\s*--\s*$|^\s*>\s*(?:Type your message|$)/i.test(
          line.trim(),
        ),
      );
  },
}));

vi.mock('../ipc/pty.js', () => ({
  spawnAgent: mocks.mockSpawnAgent,
  writeToAgent: mocks.mockWriteToAgent,
  killAgent: mocks.mockKillAgent,
  subscribeToAgent: mocks.mockSubscribeToAgent,
  unsubscribeFromAgent: mocks.mockUnsubscribeFromAgent,
  getAgentScrollback: mocks.mockGetAgentScrollback,
  onPtyEvent: mocks.mockOnPtyEvent,
}));

vi.mock('../agent-hooks/events.js', () => ({
  onAgentHookEvent: mocks.mockOnAgentHookEvent,
}));

vi.mock('../ipc/git.js', () => ({
  getChangedFiles: mocks.mockGetChangedFiles,
  getAllFileDiffs: mocks.mockGetAllFileDiffs,
  getDiffBaseSha: mocks.mockGetDiffBaseSha,
  mergeTask: mocks.mockGitMergeTask,
}));

vi.mock('../ipc/tasks.js', () => ({
  createTask: mocks.mockCreateBackendTask,
  deleteTask: mocks.mockDeleteBackendTask,
}));

vi.mock('../ipc/verify.js', () => ({
  verificationRunner: {
    start: mocks.mockVerifyStart,
    cancel: mocks.mockVerifyCancel,
    isRunning: () => false,
  },
  buildVerifyEnv: (args: { taskId: string; branchName?: string; worktreePath: string }) => ({
    PARALLEL_CODE_TASK_ID: args.taskId,
    PARALLEL_CODE_BRANCH: args.branchName ?? '',
    PARALLEL_CODE_WORKTREE: args.worktreePath,
  }),
}));

vi.mock('../ipc/channels.js', () => ({
  IPC: {
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_TaskCleanupFailed: 'mcp_task_cleanup_failed',
    MCP_TaskStateSync: 'mcp_task_state_sync',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_CoordinatorDeregistered: 'mcp_coordinator_deregistered',
    MCP_CoordinatorNotificationAck: 'mcp_coordinator_notification_ack',
  },
}));

vi.mock('../log.js', () => ({
  info: mocks.mockLogInfo,
  warn: mocks.mockLogWarn,
}));

export const {
  mockExecFile,
  mockWriteFileSync,
  mockReadFileSync,
  mockExistsSync,
  mockUnlinkSync,
  mockMkdirSync,
  mockFsWriteFile,
  mockFsReadFile,
  mockFsAccess,
  mockFsUnlink,
  mockFsMkdir,
  mockAtomicWriteFileSync,
  mockAtomicWriteFile,
  mockNotifyRenderer,
  mockLogInfo,
  mockLogWarn,
  mockOnPtyEvent,
  mockOnAgentHookEvent,
  mockSpawnAgent,
  mockWriteToAgent,
  mockKillAgent,
  mockSubscribeToAgent,
  mockUnsubscribeFromAgent,
  mockGetAgentScrollback,
  mockGetChangedFiles,
  mockGetAllFileDiffs,
  mockGetDiffBaseSha,
  mockGitMergeTask,
  mockCreateBackendTask,
  mockDeleteBackendTask,
  mockVerifyStart,
  mockVerifyCancel,
} = mocks;

export const mockWin = {
  isDestroyed: () => false,
  webContents: { send: mockNotifyRenderer },
} as unknown as BrowserWindow;

export function createCoordinatorTask(
  overrides: Partial<BackendTaskFixture> = {},
): BackendTaskFixture {
  return { ...defaultBackendTask(), ...overrides };
}

export function mockNextTask(overrides: Partial<BackendTaskFixture> = {}): BackendTaskFixture {
  const task = createCoordinatorTask(overrides);
  mockCreateBackendTask.mockResolvedValueOnce(task);
  return task;
}

export function resetCoordinatorMocks(): void {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[] | ((err: Error | null, stdout: string, stderr: string) => void),
      _opts?: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback =
        typeof _args === 'function' ? _args : typeof _opts === 'function' ? _opts : cb;
      callback?.(null, '', '');
      return { on: vi.fn() };
    },
  );

  mockWriteFileSync.mockReset();
  mockReadFileSync.mockReset();
  mockReadFileSync.mockReturnValue('# existing\n');
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockUnlinkSync.mockReset();
  mockMkdirSync.mockReset();

  mockFsWriteFile.mockReset();
  mockFsWriteFile.mockResolvedValue(undefined);
  mockFsReadFile.mockReset();
  mockFsReadFile.mockResolvedValue('# existing\n');
  mockFsAccess.mockReset();
  mockFsAccess.mockRejectedValue(enoent());
  mockFsUnlink.mockReset();
  mockFsUnlink.mockResolvedValue(undefined);
  mockFsMkdir.mockReset();
  mockFsMkdir.mockResolvedValue(undefined);

  mockAtomicWriteFileSync.mockReset();
  mockAtomicWriteFile.mockReset();
  mockAtomicWriteFile.mockResolvedValue(undefined);

  mockNotifyRenderer.mockReset();
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockOnPtyEvent.mockReset();
  mockOnAgentHookEvent.mockReset();
  mockOnAgentHookEvent.mockReturnValue(() => {});
  mockSpawnAgent.mockReset();
  mockWriteToAgent.mockReset();
  mockWriteToAgent.mockImplementation((agentId: string, data: string) => ({ id: agentId, data }));
  mockKillAgent.mockReset();
  mockSubscribeToAgent.mockReset();
  mockUnsubscribeFromAgent.mockReset();
  mockGetAgentScrollback.mockReset();
  mockGetAgentScrollback.mockReturnValue(null);

  mockGetChangedFiles.mockReset();
  mockGetChangedFiles.mockResolvedValue([]);
  mockGetAllFileDiffs.mockReset();
  mockGetAllFileDiffs.mockResolvedValue('');
  mockGetDiffBaseSha.mockReset();
  mockGetDiffBaseSha.mockResolvedValue('abc123sha');
  mockGitMergeTask.mockReset();
  mockGitMergeTask.mockResolvedValue({ main_branch: 'main', lines_added: 10, lines_removed: 5 });

  mockCreateBackendTask.mockReset();
  mockCreateBackendTask.mockResolvedValue(defaultBackendTask());
  mockDeleteBackendTask.mockReset();
  mockDeleteBackendTask.mockResolvedValue(undefined);
}

export async function setupCoordinatorHarness(options: CoordinatorHarnessOptions = {}) {
  resetCoordinatorMocks();
  const { Coordinator } = await import('./coordinator.js');
  const coordinator = new Coordinator();
  registerDefaultCoordinator(coordinator, options);
  return {
    Coordinator,
    coordinator,
    mockWin,
    resetCoordinatorMocks,
    mockNextTask,
    registerDefaultCoordinator,
    createCoordinatorTask,
    getOutputCb,
    emitAgentOutput,
    deliverReadyPrompt,
    getAgentId,
    getSpawnHandler,
    getExitHandler,
    getInterruptHandler,
    getHookEventHandler,
    getAgentTextWrites,
    getSubtaskConfigWrites,
    getSettingsLocalWrites,
    rendererEvents,
    ...mocks,
  };
}

export function registerDefaultCoordinator(
  coordinator: InstanceType<(typeof import('./coordinator.js'))['Coordinator']>,
  {
    coordinatorId = 'coord-1',
    projectId = 'proj-1',
    projectPath = '/tmp/project',
    register = false,
  }: CoordinatorHarnessOptions = {},
) {
  coordinator.setWindow(mockWin);
  coordinator.setDefaultProject(projectId, projectPath);
  if (register) coordinator.registerCoordinator(coordinatorId, projectId);
  return coordinator;
}

export function getOutputCb(index = 0): (encoded: string) => void {
  const call = mockSubscribeToAgent.mock.calls[index];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[1] as (encoded: string) => void;
}

export function getAgentId(index = 0): string {
  const call = mockSubscribeToAgent.mock.calls[index];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[0] as string;
}

export function getSpawnHandler(): (agentId: string) => void {
  const call = mockOnPtyEvent.mock.calls.find((c) => c[0] === 'spawn');
  if (!call) throw new Error('spawn handler not registered');
  return call[1] as (agentId: string) => void;
}

export function getExitHandler(): (agentId: string, data: unknown) => void {
  const call = mockOnPtyEvent.mock.calls.find((c) => c[0] === 'exit');
  if (!call) throw new Error('exit handler not registered');
  return call[1] as (agentId: string, data: unknown) => void;
}

export function getInterruptHandler(): (agentId: string) => void {
  const call = mockOnPtyEvent.mock.calls.find((c) => c[0] === 'interrupt');
  if (!call) throw new Error('interrupt handler not registered');
  return call[1] as (agentId: string) => void;
}

export function getHookEventHandler(): (evt: AgentHookEventPayload) => void {
  const call = mockOnAgentHookEvent.mock.calls[0];
  if (!call) throw new Error('onAgentHookEvent not subscribed');
  return call[0] as (evt: AgentHookEventPayload) => void;
}

export function encodeAgentOutput(s: string): string {
  return Buffer.from(s).toString('base64');
}

export function encodeAgentBytes(bytes: Buffer): string {
  return bytes.toString('base64');
}

export function emitAgentOutput(text: string, index = 0): void {
  getOutputCb(index)(encodeAgentOutput(text));
}

export function deliverReadyPrompt({ text = 'Done ❯ ', index = 0 } = {}): void {
  emitAgentOutput(text, index);
}

export function emitWorkThenIdle(outputCb: (encoded: string) => void = getOutputCb()): void {
  outputCb(encodeAgentOutput('Working...\n'));
  outputCb(encodeAgentOutput('Done ❯ '));
}

export function getAgentTextWrites(agentId?: string): string[] {
  return mockWriteToAgent.mock.calls
    .filter(([id, text]) => (!agentId || id === agentId) && text !== '\r' && text !== '\x1b[I')
    .map(([, text]) => text as string);
}

type AtomicWrite = { path: string; content: string; sync: boolean; call: unknown[] };

function atomicWrites(): AtomicWrite[] {
  return [
    ...mockAtomicWriteFile.mock.calls.map((call) => ({
      path: String(call[0]),
      content: String(call[1]),
      sync: false,
      call,
    })),
    ...mockAtomicWriteFileSync.mock.calls.map((call) => ({
      path: String(call[0]),
      content: String(call[1]),
      sync: true,
      call,
    })),
  ];
}

export function getSubtaskConfigWrites(): AtomicWrite[] {
  return atomicWrites().filter(
    ({ path }) => path.includes('parallel-code-subtask-') || path.includes('/subtask-'),
  );
}

export function getSettingsLocalWrites(): AtomicWrite[] {
  return atomicWrites().filter(({ path }) => path.endsWith('settings.local.json'));
}

export function rendererEvents(channel?: string): unknown[][] {
  return channel
    ? mockNotifyRenderer.mock.calls.filter(([eventChannel]) => eventChannel === channel)
    : mockNotifyRenderer.mock.calls;
}

resetCoordinatorMocks();
