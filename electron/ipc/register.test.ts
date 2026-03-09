import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

type IpcHandler = (event: unknown, args?: unknown) => unknown;

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  clipboardReadText: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mockState.handlers.set(channel, handler);
    }),
  },
  dialog: {},
  shell: {},
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
  BrowserWindow: function BrowserWindow() {},
  clipboard: {
    readText: mockState.clipboardReadText,
    writeText: mockState.clipboardWriteText,
  },
}));

vi.mock('./pty.js', () => ({
  spawnAgent: vi.fn(),
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  killAgent: vi.fn(),
  countRunningAgents: vi.fn(),
  killAllAgents: vi.fn(),
  getAgentMeta: vi.fn(),
}));

vi.mock('./plans.js', () => ({
  ensurePlansDirectory: vi.fn(),
  startPlanWatcher: vi.fn(),
  stopAllPlanWatchers: vi.fn(),
}));

vi.mock('../remote/server.js', () => ({
  startRemoteServer: vi.fn(),
}));

vi.mock('./git.js', () => ({
  getGitIgnoredDirs: vi.fn(),
  getMainBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  getChangedFiles: vi.fn(),
  getChangedFilesFromBranch: vi.fn(),
  getFileDiff: vi.fn(),
  getFileDiffFromBranch: vi.fn(),
  getWorktreeStatus: vi.fn(),
  commitAll: vi.fn(),
  discardUncommitted: vi.fn(),
  checkMergeStatus: vi.fn(),
  mergeTask: vi.fn(),
  getBranchLog: vi.fn(),
  pushTask: vi.fn(),
  rebaseTask: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock('./tasks.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('./agents.js', () => ({
  listAgents: vi.fn(),
}));

vi.mock('./persistence.js', () => ({
  saveAppState: vi.fn(),
  loadAppState: vi.fn(),
}));

import { registerAllHandlers } from './register.js';

describe('registerAllHandlers clipboard IPC', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockState.handlers.clear();
    mockState.clipboardReadText.mockReset();
    mockState.clipboardWriteText.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function registerFor(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
    registerAllHandlers({
      on: vi.fn(),
      isFocused: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
      getPosition: vi.fn(() => [0, 0] as const),
      getSize: vi.fn(() => [1280, 720] as const),
      close: vi.fn(),
      destroy: vi.fn(),
      hide: vi.fn(),
      webContents: {
        send: vi.fn(),
      },
    } as unknown as Parameters<typeof registerAllHandlers>[0]);
  }

  it('reads from the Linux selection clipboard when requested', () => {
    mockState.clipboardReadText.mockReturnValue('from-selection');
    registerFor('linux');

    const handler = mockState.handlers.get(IPC.ClipboardRead);
    expect(handler).toBeTypeOf('function');
    expect(handler?.({}, { target: 'selection' })).toBe('from-selection');
    expect(mockState.clipboardReadText).toHaveBeenCalledWith('selection');
  });

  it('falls back to the default clipboard for selection reads on non-Linux platforms', () => {
    mockState.clipboardReadText.mockReturnValue('from-clipboard');
    registerFor('darwin');

    const handler = mockState.handlers.get(IPC.ClipboardRead);
    expect(handler?.({}, { target: 'selection' })).toBe('from-clipboard');
    expect(mockState.clipboardReadText).toHaveBeenCalledWith();
  });

  it('writes to both clipboard buffers on Linux when requested', () => {
    registerFor('linux');

    const handler = mockState.handlers.get(IPC.ClipboardWrite);
    handler?.({}, { text: 'copied text', target: 'both' });

    expect(mockState.clipboardWriteText).toHaveBeenNthCalledWith(1, 'copied text');
    expect(mockState.clipboardWriteText).toHaveBeenNthCalledWith(2, 'copied text', 'selection');
  });

  it('rejects invalid clipboard write targets', () => {
    registerFor('linux');

    const handler = mockState.handlers.get(IPC.ClipboardWrite);
    expect(() => handler?.({}, { text: 'copied text', target: 'invalid' })).toThrow(
      'target must be "clipboard", "selection", or "both"',
    );
  });
});
