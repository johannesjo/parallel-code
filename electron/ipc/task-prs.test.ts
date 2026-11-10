import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListOpenPrUrls, mockFindNestedRepos, mockGetMainBranch, mockFetchPrHead, mockExec } =
  vi.hoisted(() => ({
    mockListOpenPrUrls: vi.fn(),
    mockFindNestedRepos: vi.fn(),
    mockGetMainBranch: vi.fn(),
    mockFetchPrHead: vi.fn(),
    mockExec: vi.fn(),
  }));

vi.mock('./pr-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-checks.js')>()),
  listOpenPrUrlsForBranch: mockListOpenPrUrls,
  fetchPrHead: mockFetchPrHead,
}));
vi.mock('./nested-repos.js', () => ({ findNestedRepos: mockFindNestedRepos }));
vi.mock('./git.js', () => ({ getMainBranch: mockGetMainBranch }));
vi.mock('./git-exec.js', () => ({ exec: mockExec, MAX_BUFFER: 1024 }));

import { detectTaskPrs } from './task-prs.js';

const prsByRepo = new Map<string, string[] | Error>();

beforeEach(() => {
  vi.clearAllMocks();
  prsByRepo.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockGetMainBranch.mockResolvedValue('main');
  mockFindNestedRepos.mockResolvedValue([]);
  mockListOpenPrUrls.mockImplementation((repoPath: string, branch: string) => {
    const result = prsByRepo.get(`${repoPath}@${branch}`) ?? [];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
});

describe('detectTaskPrs', () => {
  it('uses the first branch PR as primary and keeps further ones as extras', async () => {
    prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2']);

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
      url: 'https://github.com/a/b/pull/1',
      extras: [{ url: 'https://github.com/a/b/pull/2' }],
    });
  });

  it('adds PRs of nested repositories labelled with their folder', async () => {
    mockFindNestedRepos.mockResolvedValue([
      { name: 'api', branch: 'feature/api' },
      { name: 'web', branch: 'feature/web' },
    ]);
    prsByRepo.set('/wt/api@feature/api', ['https://github.com/a/api/pull/7']);
    prsByRepo.set('/wt/web@feature/web', ['https://github.com/a/web/pull/8']);

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
      url: null,
      extras: [
        { url: 'https://github.com/a/api/pull/7', repo: 'api' },
        { url: 'https://github.com/a/web/pull/8', repo: 'web' },
      ],
    });
  });

  it('skips nested repositories on their main branch or a detached HEAD', async () => {
    mockFindNestedRepos.mockResolvedValue([
      { name: 'api', branch: 'main' },
      { name: 'web', branch: 'HEAD' },
    ]);

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: null, extras: [] });
    expect(mockListOpenPrUrls).toHaveBeenCalledTimes(1);
    expect(mockListOpenPrUrls).toHaveBeenCalledWith('/wt', 'task/x');
  });

  it('keeps the task PRs and names a nested repository that fails', async () => {
    mockFindNestedRepos.mockResolvedValue([{ name: 'api', branch: 'feature/api' }]);
    prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);
    prsByRepo.set('/wt/api@feature/api', new Error('no GitHub remote'));

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
      url: 'https://github.com/a/b/pull/1',
      extras: [],
      failedRepos: ['api'],
    });
  });

  it('keeps nested PRs when the task repository is not on GitHub', async () => {
    mockFindNestedRepos.mockResolvedValue([{ name: 'api', branch: 'feature/api' }]);
    prsByRepo.set(
      '/wt@task/x',
      Object.assign(new Error('gh failed'), {
        // gh 2.101's wording; its `gh auth login` hint must not read as logged out.
        stderr:
          'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`',
      }),
    );
    prsByRepo.set('/wt/api@feature/api', ['https://github.com/a/api/pull/7']);

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
      url: null,
      extras: [{ url: 'https://github.com/a/api/pull/7', repo: 'api' }],
      failedRepos: ['.'],
    });
  });

  it('propagates a missing gh met in a nested repository', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', path: 'gh' });
    mockFindNestedRepos.mockResolvedValue([{ name: 'api', branch: 'feature/api' }]);
    prsByRepo.set('/wt/api@feature/api', err);

    await expect(detectTaskPrs('/wt', 'task/x')).rejects.toBe(err);
  });

  it('names a nested repository on a host gh is not logged into as failed', async () => {
    mockFindNestedRepos.mockResolvedValue([{ name: 'api', branch: 'feature/api' }]);
    prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);
    prsByRepo.set(
      '/wt/api@feature/api',
      Object.assign(new Error('gh failed'), { stderr: 'authentication required' }),
    );

    await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
      url: 'https://github.com/a/b/pull/1',
      extras: [],
      failedRepos: ['api'],
    });
  });

  it.each([
    ['missing', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })],
    [
      'logged out',
      Object.assign(new Error('gh failed'), { stderr: 'You are not logged into any GitHub hosts' }),
    ],
    [
      'never logged in',
      Object.assign(new Error('gh failed'), {
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
    ],
  ])('propagates a %s gh so detection can be disabled', async (_, err) => {
    prsByRepo.set('/wt@task/x', err);

    await expect(detectTaskPrs('/wt', 'task/x')).rejects.toBe(err);
  });

  describe('with a PR link the task printed', () => {
    const printed = 'https://github.com/a/b/pull/9';
    const head = 'abc123';
    // Refs `git for-each-ref --contains <head>` lists in the task worktree.
    let refsWithHead: string[];

    beforeEach(() => {
      mockFetchPrHead.mockResolvedValue({ state: 'OPEN', headRefOid: head, headRefName: 'fix/x' });
      refsWithHead = ['refs/heads/task/x', 'refs/remotes/origin/fix/x'];
      mockExec.mockImplementation((_cmd: string, args: string[]) =>
        Promise.resolve({ stdout: args.includes(head) ? refsWithHead.join('\n') + '\n' : '' }),
      );
    });

    it('adopts it when its head is the task branch pushed under another name', async () => {
      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: printed,
        extras: [],
      });
      expect(mockExec).toHaveBeenCalledWith(
        'git',
        ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/remotes'],
        expect.objectContaining({ cwd: '/wt' }),
      );
    });

    it('adopts it when the task branch was also pushed under its own name', async () => {
      refsWithHead.push('refs/remotes/origin/task/x');

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toMatchObject({
        url: printed,
      });
    });

    it('adopts it when a local branch named after its head holds it too', async () => {
      refsWithHead.push('refs/heads/fix/x');

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toMatchObject({
        url: printed,
      });
    });

    it('ignores it without retrying when the worktree lacks its head commit', async () => {
      mockExec.mockRejectedValue(new Error('error: no such commit abc123'));

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    it.each([
      ['the task branch does not hold its head', ['refs/remotes/origin/fix/x']],
      [
        'only a longer branch name ends in its head name',
        ['refs/heads/task/x', 'refs/remotes/origin/hot/fix/x'],
      ],
      // A sub-task holds its coordinator's commits, so the coordinator's PR head too.
      ['another branch holds its head too', ['refs/heads/task/x', 'refs/heads/task/parent']],
      ['its head is already on main', ['refs/heads/task/x', 'refs/remotes/origin/main']],
    ])('ignores it when %s', async (_, refs) => {
      refsWithHead = refs;

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    // A child of a coordinator holds the coordinator's branch, so its PR head too.
    it('ignores the PR of the branch the task is based on', async () => {
      mockFetchPrHead.mockResolvedValue({
        state: 'OPEN',
        headRefOid: head,
        headRefName: 'task/parent',
      });
      refsWithHead = [
        'refs/heads/task/x',
        'refs/heads/task/parent',
        'refs/remotes/origin/task/parent',
      ];

      await expect(
        detectTaskPrs('/wt', 'task/x', { url: printed, baseBranch: 'task/parent' }),
      ).resolves.toEqual({ url: null, extras: [] });
    });

    it.each([
      ['does not exist', 'GraphQL: Could not resolve to a PullRequest with the number of 9.'],
      [
        'is in a repository gh cannot see',
        "GraphQL: Could not resolve to a Repository with the name 'a/b'.",
      ],
      ['is on a host gh is not logged into', 'authentication required'],
    ])('ignores it without retrying when it %s', async (_, stderr) => {
      mockFetchPrHead.mockRejectedValue(Object.assign(new Error('gh failed'), { stderr }));

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    it.each(['MERGED', 'CLOSED'])('ignores it once %s', async (state) => {
      mockFetchPrHead.mockResolvedValue({ state, headRefOid: head, headRefName: 'fix/x' });

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    it('keeps the branch PR without looking the printed one up', async () => {
      prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: 'https://github.com/a/b/pull/1',
        extras: [],
      });
      expect(mockFetchPrHead).not.toHaveBeenCalled();
    });

    it('names the task repository as not listed when the printed PR cannot be looked up', async () => {
      mockFetchPrHead.mockRejectedValue(new Error('HTTP 502'));

      await expect(detectTaskPrs('/wt', 'task/x', { url: printed })).resolves.toEqual({
        url: null,
        extras: [],
        failedRepos: ['.'],
      });
    });
  });
});
