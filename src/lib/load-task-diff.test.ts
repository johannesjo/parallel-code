import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTaskDiffBaseBranch, loadTaskDiff } from './load-task-diff';

vi.mock('./ipc', () => ({ invoke: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('auto-detects the diff base for direct tasks', () => {
  expect(getTaskDiffBaseBranch('direct', 'feature/direct')).toBeUndefined();
  expect(getTaskDiffBaseBranch('worktree', 'main')).toBe('main');
});

it.each([
  [null, IPC.GetAllFileDiffs, { worktreePath: '/task', baseBranch: 'main' }],
  ['uncommitted', IPC.GetUncommittedFileDiffs, { worktreePath: '/task' }],
  ['abc123', IPC.GetCommitDiffs, { worktreePath: '/task', commitHash: 'abc123' }],
] as const)('loads the selected diff (%s)', async (selectedCommit, channel, args) => {
  vi.mocked(invoke).mockResolvedValue('diff');
  await expect(
    loadTaskDiff({ worktreePath: '/task', baseBranch: 'main', selectedCommit }),
  ).resolves.toEqual({ rawDiff: 'diff', cwd: '/task' });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, args);
});

it('falls back to the branch when the worktree is unavailable', async () => {
  vi.mocked(invoke)
    .mockRejectedValueOnce(new Error('missing worktree'))
    .mockResolvedValueOnce('branch diff');
  await expect(
    loadTaskDiff({
      worktreePath: '/missing',
      projectRoot: '/repo',
      branchName: 'task',
      baseBranch: 'main',
    }),
  ).resolves.toEqual({ rawDiff: 'branch diff', cwd: '/repo' });
  expect(invoke).toHaveBeenLastCalledWith(IPC.GetAllFileDiffsFromBranch, {
    projectRoot: '/repo',
    branchName: 'task',
    baseBranch: 'main',
  });
});

it('does not silently substitute the branch for a failed commit diff', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('bad commit'));
  await expect(
    loadTaskDiff({
      worktreePath: '/task',
      projectRoot: '/repo',
      branchName: 'task',
      selectedCommit: 'abc123',
    }),
  ).rejects.toThrow('bad commit');
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('does not substitute branch history for uncommitted changes without a worktree', async () => {
  await expect(
    loadTaskDiff({
      worktreePath: '',
      projectRoot: '/repo',
      branchName: 'main',
      selectedCommit: 'uncommitted',
    }),
  ).rejects.toThrow('worktree is required');
  expect(invoke).not.toHaveBeenCalled();
});
