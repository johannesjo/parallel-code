import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../ipc/channels.js';
import { runGhJson } from './gh.js';
import { registerGitHubHandlers } from './register.js';

const handlers = vi.hoisted(() => new Map<string, (e: unknown, args: unknown) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, args: unknown) => unknown) =>
      handlers.set(channel, fn),
  },
}));
vi.mock('./gh.js', async (original) => ({
  ...(await original<typeof import('./gh.js')>()),
  runGhJson: vi.fn(),
}));

function resolve(args: unknown): unknown {
  const handler = handlers.get(IPC.ResolveGitHubRepository);
  if (!handler) throw new Error('handler not registered');
  return handler({}, args);
}

beforeEach(() => {
  vi.mocked(runGhJson).mockReset();
  registerGitHubHandlers();
});

describe('resolve_github_repository handler', () => {
  it.each([
    ['missing', {}],
    ['non-string', { projectRoot: 42 }],
    ['relative', { projectRoot: 'project' }],
    ['traversing', { projectRoot: '/project/../etc' }],
  ])('rejects %s projectRoot without running gh', (_label, args) => {
    expect(() => resolve(args)).toThrow(/projectRoot/);
    expect(runGhJson).not.toHaveBeenCalled();
  });

  it('returns the owner/repo gh resolves', async () => {
    vi.mocked(runGhJson).mockResolvedValueOnce({
      nameWithOwner: 'owner/repo',
      url: 'https://github.com/owner/repo',
    });
    await expect(resolve({ projectRoot: '/project' })).resolves.toBe('owner/repo');
    expect(runGhJson).toHaveBeenCalledWith(expect.arrayContaining(['repo', 'view']), '/project');
  });

  it('surfaces gh failures', async () => {
    vi.mocked(runGhJson).mockRejectedValueOnce(new Error('gh: not logged in'));
    await expect(resolve({ projectRoot: '/project' })).rejects.toThrow('gh: not logged in');
  });

  it.each([
    ['a non-github.com host', { nameWithOwner: 'o/r', url: 'https://ghe.corp/o/r' }],
    ['a missing repository', { url: 'https://github.com/o/r' }],
    ['a malformed repository', { nameWithOwner: 'o/r/x', url: 'https://github.com/o/r/x' }],
  ])('rejects %s with a clear error', async (_label, repo) => {
    vi.mocked(runGhJson).mockResolvedValueOnce(repo);
    await expect(resolve({ projectRoot: '/project' })).rejects.toThrow(/github\.com repositories/);
  });
});

describe('create_pull_request handler', () => {
  const valid = {
    worktreePath: '/repo/wt',
    head: 'task/fix-login',
    base: 'main',
    title: 'Fix login',
    body: '',
    draft: true,
  };
  function create(args: unknown): unknown {
    const handler = handlers.get(IPC.CreatePullRequest);
    if (!handler) throw new Error('handler not registered');
    return handler({}, args);
  }

  it.each([
    ['a relative worktree path', { worktreePath: 'wt' }, /worktreePath/],
    ['an option-like head', { head: '--web' }, /head/],
    ['an empty base', { base: '' }, /base/],
    ['a blank title', { title: '   ' }, /title/],
    ['an overlong title', { title: 'x'.repeat(257) }, /title/],
    ['a non-string body', { body: 1 }, /body/],
    ['a missing draft flag', { draft: undefined }, /draft/],
  ])('rejects %s', (_label, change, error) => {
    expect(() => create({ ...valid, ...change })).toThrow(error);
  });
});
