import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAllHandlers } from './register.js';
import { IPC } from './channels.js';
import * as git from './git.js';
import * as tasks from './tasks.js';
import { DelegationService } from '../mcp/delegation.js';

const { handlers, spawnAgent } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: Record<string, unknown>) => unknown>(),
  spawnAgent: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, args: Record<string, unknown>) => unknown,
    ) => handlers.set(channel, handler),
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
  spawnAgent,
  getAgentMeta: vi.fn(() => null),
  validateCommand: vi.fn(),
}));

const tempDirs: string[] = [];

beforeEach(() => {
  registerAllHandlers({
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow);
});

afterEach(async () => {
  await handlers.get(IPC.StopRemoteServer)?.(undefined, {});
  handlers.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const shellSpawn = (extra: Record<string, unknown>) => ({
  command: '',
  args: ['-l'],
  taskId: 'task',
  agentId: 'setup-shell',
  cols: 80,
  rows: 24,
  cwd: os.tmpdir(),
  isShell: true,
  ...extra,
});

it.skipIf(process.platform === 'win32')(
  'turns a setup script into a shell invocation chosen by the main process',
  async () => {
    await handlers.get(IPC.SpawnAgent)?.(undefined, shellSpawn({ shellScript: 'npm ci' }));
    const [, spawned] = spawnAgent.mock.calls[0] as [unknown, { command: string; args: string[] }];
    expect(spawned.args).toEqual(['-e', '-c', 'npm ci']);
    expect(spawned.command).toMatch(/(^|\/)(sh|bash|zsh|dash|ksh|mksh|ash)$/);
  },
);

it('runs a setup script inside Docker with /bin/sh', async () => {
  await handlers.get(IPC.SpawnAgent)?.(
    undefined,
    shellSpawn({ shellScript: 'npm ci', dockerMode: true }),
  );
  const [, spawned] = spawnAgent.mock.calls[0] as [unknown, { command: string; args: string[] }];
  expect(spawned).toMatchObject({ command: '/bin/sh', args: ['-e', '-c', 'npm ci'] });
});

it('refuses a script for an agent terminal and leaves plain shells untouched', async () => {
  await expect(
    handlers.get(IPC.SpawnAgent)?.(
      undefined,
      shellSpawn({ isShell: false, command: 'claude', shellScript: 'npm ci' }),
    ),
  ).rejects.toThrow('only allowed for shell terminals');

  await handlers.get(IPC.SpawnAgent)?.(undefined, shellSpawn({}));
  const [, spawned] = spawnAgent.mock.lastCall as [unknown, { command: string; args: string[] }];
  expect(spawned).toMatchObject({ command: '', args: ['-l'] });
});

it('validates the teardown script before deleting anything', async () => {
  const del = vi.spyOn(tasks, 'deleteTask');
  await expect(
    handlers.get(IPC.DeleteTask)?.(undefined, {
      agentIds: [],
      projectRoot: '/repo',
      branchName: 'task/x',
      deleteBranch: true,
      teardownScript: ['rm', '-rf'],
    }),
  ).rejects.toThrow('teardownScript');
  expect(del).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')(
  'merges first, then runs teardown, then removes the worktree',
  async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-merge-teardown-'));
    tempDirs.push(projectRoot);
    const worktreePath = path.join(projectRoot, '.worktrees', 'task', 'x');
    fs.mkdirSync(worktreePath, { recursive: true });
    vi.spyOn(DelegationService.prototype, 'assertDirectMergeAllowed').mockResolvedValue();
    vi.spyOn(DelegationService.prototype, 'recordDirectMerge').mockResolvedValue();
    const order: string[] = [];
    const merge = vi.spyOn(git, 'mergeTask').mockImplementation(async () => {
      order.push('merge');
      return { main_branch: 'main', lines_added: 1, lines_removed: 0 };
    });
    vi.spyOn(git, 'removeWorktree').mockImplementation(async () => {
      order.push(fs.existsSync(path.join(worktreePath, 'torn-down')) ? 'remove-after' : 'remove');
    });

    const result = await handlers.get(IPC.MergeTask)?.(undefined, {
      projectRoot,
      branchName: 'task/x',
      worktreePath,
      squash: false,
      cleanup: true,
      teardownScript: 'touch torn-down\nexit 4',
    });

    // The merge itself never removes the worktree when a teardown must run first.
    expect(merge.mock.calls[0]?.[4]).toBe(false);
    expect(order).toEqual(['merge', 'remove-after']);
    expect(result).toMatchObject({ main_branch: 'main' });
    expect((result as { warning?: string }).warning).toContain('exited with code 4');
  },
);

it('keeps the merge-time cleanup path unchanged without a teardown script', async () => {
  vi.spyOn(DelegationService.prototype, 'assertDirectMergeAllowed').mockResolvedValue();
  vi.spyOn(DelegationService.prototype, 'recordDirectMerge').mockResolvedValue();
  const merge = vi
    .spyOn(git, 'mergeTask')
    .mockResolvedValue({ main_branch: 'main', lines_added: 0, lines_removed: 0 });
  const remove = vi.spyOn(git, 'removeWorktree');

  await handlers.get(IPC.MergeTask)?.(undefined, {
    projectRoot: '/repo',
    branchName: 'task/x',
    squash: false,
    cleanup: true,
  });

  expect(merge.mock.calls[0]?.[4]).toBe(true);
  expect(remove).not.toHaveBeenCalled();
});
