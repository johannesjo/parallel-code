import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const state = vi.hoisted(() => ({
  tasks: {} as Record<string, unknown>,
  agents: {} as Record<string, unknown>,
}));
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listWorktreeSessions: vi.fn(),
  createImportedTask: vi.fn(async () => 'imported'),
}));

vi.mock('../lib/ipc', () => ({ invoke: mocks.invoke }));
vi.mock('./core', () => ({ store: state }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./sessions', () => ({ listWorktreeSessions: mocks.listWorktreeSessions }));
vi.mock('./tasks', () => ({ createImportedTask: mocks.createImportedTask }));

const { importWorktreeForAgent } = await import('./agent-import-worktree');

const claude = { id: 'claude-code', name: 'Claude', command: 'claude', args: [] };
const lost = {
  path: '/repo/.worktrees/task/lost',
  branch_name: 'task/lost',
  has_committed_changes: true,
  has_uncommitted_changes: false,
  app_created: true,
};
const tracked = { ...lost, path: '/repo/.worktrees/task/open', branch_name: 'task/open' };
const newest = '240604e8-6d6c-43ce-9178-6d63236f39a9';
const older = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  state.tasks = {
    creator: { projectId: 'project', agentIds: ['agent-1'], worktreePath: '/repo/.worktrees/c' },
    open: { projectId: 'project', agentIds: [], worktreePath: tracked.path },
  };
  state.agents = { 'agent-1': { def: claude } };
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === IPC.ListImportableWorktrees ? [lost, tracked] : undefined,
  );
  mocks.listWorktreeSessions.mockResolvedValue([
    { id: newest, agent: 'claude', cwd: lost.path, updatedAt: 2 },
    { id: older, agent: 'claude', cwd: lost.path, updatedAt: 1 },
  ]);
});

const request = (extra: Record<string, unknown> = {}) => ({
  creatorTaskId: 'creator',
  path: lost.path,
  cleanupOnClose: false,
  ...extra,
});

describe('importWorktreeForAgent', () => {
  it("imports with the creator's agent, resumes the newest session and stays in the background", async () => {
    await expect(importWorktreeForAgent(request({ path: `${lost.path}/` }))).resolves.toEqual({
      taskId: 'imported',
      resumedSessionId: newest,
    });
    expect(mocks.createImportedTask).toHaveBeenCalledWith({
      projectId: 'project',
      worktree: lost,
      agentDef: claude,
      resumeSessionId: newest,
      cleanupOnClose: false,
      activate: false,
    });
  });

  it('resumes a requested session only if the worktree recorded it', async () => {
    await expect(importWorktreeForAgent(request({ sessionId: older }))).resolves.toMatchObject({
      resumedSessionId: older,
    });
    await expect(
      importWorktreeForAgent(request({ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })),
    ).rejects.toThrow('was not recorded');
  });

  it('starts a new conversation when the worktree has no sessions', async () => {
    mocks.listWorktreeSessions.mockResolvedValue([]);
    await expect(importWorktreeForAgent(request())).resolves.toEqual({
      taskId: 'imported',
      resumedSessionId: null,
    });
  });

  it('refuses paths outside the importable list and names the ones that are on it', async () => {
    await expect(importWorktreeForAgent(request({ path: '/other/project/wt' }))).rejects.toThrow(
      `Importable: ${lost.path}`,
    );
    await expect(importWorktreeForAgent(request({ path: tracked.path }))).rejects.toThrow(
      'Not an importable worktree',
    );
    expect(mocks.createImportedTask).not.toHaveBeenCalled();
  });

  it('removes on close only worktrees the app created', async () => {
    await importWorktreeForAgent(request({ cleanupOnClose: true }));
    expect(mocks.createImportedTask).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupOnClose: true }),
    );
    mocks.invoke.mockResolvedValue([{ ...lost, app_created: false }]);
    await expect(importWorktreeForAgent(request({ cleanupOnClose: true }))).rejects.toThrow(
      'cleanupOnClose',
    );
    expect(mocks.createImportedTask).toHaveBeenCalledOnce();
  });

  it('refuses a creator in a Docker sandbox', async () => {
    state.tasks.creator = { ...(state.tasks.creator as object), dockerMode: true };
    await expect(importWorktreeForAgent(request())).rejects.toThrow('Docker');
    expect(mocks.createImportedTask).not.toHaveBeenCalled();
  });
});
