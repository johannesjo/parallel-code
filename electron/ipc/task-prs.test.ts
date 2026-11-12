import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListOpenPrUrls,
  mockListPrsForHead,
  mockFindNestedRepos,
  mockGetMainBranch,
  mockFetchPrHead,
  mockExec,
} = vi.hoisted(() => ({
  mockListOpenPrUrls: vi.fn(),
  mockListPrsForHead: vi.fn(),
  mockFindNestedRepos: vi.fn(),
  mockGetMainBranch: vi.fn(),
  mockFetchPrHead: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('./pr-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-checks.js')>()),
  listOpenPrUrlsForBranch: mockListOpenPrUrls,
  listPrsForHead: mockListPrsForHead,
  fetchPrHead: mockFetchPrHead,
}));
vi.mock('./nested-repos.js', () => ({ findNestedRepos: mockFindNestedRepos }));
vi.mock('./git.js', () => ({ getMainBranch: mockGetMainBranch }));
vi.mock('./git-exec.js', () => ({ exec: mockExec, MAX_BUFFER: 1024 }));

import type { PrHead } from './pr-checks.js';
import { detectTaskPrs } from './task-prs.js';

const prsByRepo = new Map<string, string[] | Error>();
// What the task worktree's git answers: the task branch's upstream as
// `<remote> <remote ref>`, the refs holding each commit, and `<a> <b>` ancestry pairs.
let upstream: string;
let refsByCommit: Map<string, string[]>;
let ancestry: Set<string>;

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
  mockListPrsForHead.mockResolvedValue([]);
  upstream = '';
  refsByCommit = new Map();
  ancestry = new Set();
  mockExec.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'for-each-ref' && args[1]?.startsWith('--format=%(upstream')) {
      return Promise.resolve({ stdout: `${upstream}\n` });
    }
    if (args[0] === 'for-each-ref') {
      const refs = refsByCommit.get(args[2] ?? '');
      return refs
        ? Promise.resolve({ stdout: refs.map((r) => `${r}\n`).join('') })
        : Promise.reject(new Error(`error: no such commit ${args[2]}`));
    }
    if (args[0] === 'merge-base') {
      return ancestry.has(`${args[2]} ${args[3]}`)
        ? Promise.resolve({ stdout: '' })
        : Promise.reject(Object.assign(new Error('not an ancestor'), { code: 1 }));
    }
    return Promise.reject(new Error(`unexpected git ${args.join(' ')}`));
  });
});

const prHead = (fields: Partial<PrHead>): PrHead => ({
  url: 'https://github.com/a/b/pull/9',
  state: 'OPEN',
  headRefOid: 'abc123',
  headRefName: 'fix/x',
  mergeCommitOid: '',
  ...fields,
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
    const merge = 'merge1';
    const hints = { printedPrUrl: printed };

    beforeEach(() => {
      mockFetchPrHead.mockResolvedValue(prHead({}));
      refsByCommit.set(head, ['refs/heads/task/x', 'refs/remotes/origin/fix/x']);
    });

    it('adopts it when its head is the task branch pushed under another name', async () => {
      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
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
      refsByCommit.get(head)?.push('refs/remotes/origin/task/x');

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toMatchObject({ url: printed });
    });

    it('adopts it when a local branch named after its head holds it too', async () => {
      refsByCommit.get(head)?.push('refs/heads/fix/x');

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toMatchObject({ url: printed });
    });

    it('ignores it without retrying when the worktree lacks its head commit', async () => {
      refsByCommit.delete(head);

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
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
      refsByCommit.set(head, refs);

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    // A child of a coordinator holds the coordinator's branch, so its PR head too.
    it('ignores the PR of the branch the task is based on', async () => {
      mockFetchPrHead.mockResolvedValue(prHead({ headRefName: 'task/parent' }));
      refsByCommit.set(head, [
        'refs/heads/task/x',
        'refs/heads/task/parent',
        'refs/remotes/origin/task/parent',
      ]);

      await expect(
        detectTaskPrs('/wt', 'task/x', { ...hints, baseBranch: 'task/parent' }),
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

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    describe('once merged', () => {
      it('adopts it after a squash merge when its head is the task’s own', async () => {
        mockFetchPrHead.mockResolvedValue(prHead({ state: 'MERGED', mergeCommitOid: merge }));

        await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
          url: printed,
          extras: [],
        });
      });

      it('adopts it when only a fetched merge commit brought its head to main', async () => {
        mockFetchPrHead.mockResolvedValue(prHead({ state: 'MERGED', mergeCommitOid: merge }));
        refsByCommit.set(head, ['refs/heads/task/x', 'refs/remotes/origin/main']);
        refsByCommit.set(merge, ['refs/remotes/origin/main']);

        await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toMatchObject({
          url: printed,
        });
        expect(mockExec).toHaveBeenCalledWith(
          'git',
          ['merge-base', '--is-ancestor', head, `${merge}^1`],
          expect.objectContaining({ cwd: '/wt' }),
        );
      });

      it.each([
        // The task branch started from main after that PR merged; the commit is not its own.
        ['its head was on main before', `${head} ${merge}^1`, merge],
        ['main got its head by a push', '', head],
        ['its merge commit was not fetched', '', 'unfetched'],
      ])('ignores it when its head is on main and %s', async (_, ancestor, mergeCommitOid) => {
        mockFetchPrHead.mockResolvedValue(prHead({ state: 'MERGED', mergeCommitOid }));
        refsByCommit.set(head, ['refs/heads/task/x', 'refs/remotes/origin/main']);
        refsByCommit.set(merge, ['refs/remotes/origin/main']);
        if (ancestor) ancestry.add(ancestor);

        await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
          url: null,
          extras: [],
        });
      });

      it('ignores it when a branch holds its head but not its merge', async () => {
        mockFetchPrHead.mockResolvedValue(prHead({ state: 'MERGED', mergeCommitOid: merge }));
        refsByCommit.set(head, [
          'refs/heads/task/x',
          'refs/remotes/origin/main',
          'refs/heads/task/parent',
        ]);
        refsByCommit.set(merge, ['refs/remotes/origin/main']);

        await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toMatchObject({ url: null });
      });
    });

    it('ignores it once closed unmerged', async () => {
      mockFetchPrHead.mockResolvedValue(prHead({ state: 'CLOSED' }));

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
        url: null,
        extras: [],
      });
    });

    it('keeps the branch PR without looking the printed one up', async () => {
      prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
        url: 'https://github.com/a/b/pull/1',
        extras: [],
      });
      expect(mockFetchPrHead).not.toHaveBeenCalled();
    });

    it('names the task repository as not listed when the printed PR cannot be looked up', async () => {
      mockFetchPrHead.mockRejectedValue(new Error('HTTP 502'));

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toEqual({
        url: null,
        extras: [],
        failedRepos: ['.'],
      });
    });

    it('prefers it to a merged PR of the tracked branch', async () => {
      upstream = 'origin refs/heads/fix/x';
      mockListPrsForHead.mockResolvedValue([
        prHead({ url: 'https://github.com/a/b/pull/3', state: 'MERGED' }),
      ]);

      await expect(detectTaskPrs('/wt', 'task/x', hints)).resolves.toMatchObject({ url: printed });
    });
  });

  describe('with a branch that tracks a remote branch of another name', () => {
    const head = 'abc123';
    const openPr = 'https://github.com/a/b/pull/5';
    const mergedPr = 'https://github.com/a/b/pull/4';

    beforeEach(() => {
      upstream = 'origin refs/heads/fix/x';
      refsByCommit.set(head, ['refs/heads/task/x', 'refs/remotes/origin/fix/x']);
    });

    it('adopts its open PR', async () => {
      mockListPrsForHead.mockResolvedValue([prHead({ url: openPr })]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: openPr, extras: [] });
      expect(mockListPrsForHead).toHaveBeenCalledWith('/wt', 'fix/x');
      // An open PR is the branch's like one under the local name, without checking its head.
      expect(mockExec).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--contains']),
        expect.anything(),
      );
    });

    it('lists its open PRs after those under the local name, once each', async () => {
      prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1', openPr]);
      mockListPrsForHead.mockResolvedValue([
        prHead({ url: openPr }),
        prHead({ url: 'https://github.com/a/b/pull/6' }),
      ]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
        url: 'https://github.com/a/b/pull/1',
        extras: [{ url: openPr }, { url: 'https://github.com/a/b/pull/6' }],
      });
    });

    it('adopts a merged PR whose head is the task’s own', async () => {
      mockListPrsForHead.mockResolvedValue([prHead({ url: mergedPr, state: 'MERGED' })]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: mergedPr, extras: [] });
    });

    it('prefers an open PR to a merged one', async () => {
      mockListPrsForHead.mockResolvedValue([
        prHead({ url: mergedPr, state: 'MERGED' }),
        prHead({ url: openPr, headRefOid: 'def456' }),
      ]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: openPr, extras: [] });
    });

    it.each([
      ['its head is shared', { state: 'MERGED' }, ['refs/heads/task/x', 'refs/heads/task/parent']],
      ['the task branch lacks its head', { state: 'MERGED' }, ['refs/remotes/origin/fix/x']],
      ['it was closed unmerged', { state: 'CLOSED' }, ['refs/heads/task/x']],
    ])('ignores a PR when %s', async (_, fields, refs) => {
      refsByCommit.set(head, refs);
      mockListPrsForHead.mockResolvedValue([prHead({ url: mergedPr, ...fields })]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: null, extras: [] });
    });

    it('adopts the newest merged PR that is the task’s own', async () => {
      refsByCommit.set('old', ['refs/heads/task/x', 'refs/heads/task/parent']);
      mockListPrsForHead.mockResolvedValue([
        prHead({ url: 'https://github.com/a/b/pull/3', state: 'MERGED', headRefOid: 'old' }),
        prHead({ url: mergedPr, state: 'MERGED' }),
      ]);

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toMatchObject({ url: mergedPr });
    });

    it.each([
      ['has no upstream', ''],
      ['tracks its own name', 'origin refs/heads/task/x'],
      ['tracks a local branch', '. refs/heads/task/parent'],
      ['tracks main, as when created from origin/main', 'origin refs/heads/main'],
    ])('does not look further when the branch %s', async (_, tracked) => {
      upstream = tracked;

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({ url: null, extras: [] });
      expect(mockListPrsForHead).not.toHaveBeenCalled();
    });

    it.each(['develop', 'origin/develop'])(
      'does not look further when it tracks the base branch %s',
      async (baseBranch) => {
        upstream = 'origin refs/heads/develop';

        await expect(detectTaskPrs('/wt', 'task/x', { baseBranch })).resolves.toEqual({
          url: null,
          extras: [],
        });
        expect(mockListPrsForHead).not.toHaveBeenCalled();
      },
    );

    it('looks the branch up by name alone when git cannot say what it tracks', async () => {
      prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);
      mockExec.mockRejectedValue(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
        url: 'https://github.com/a/b/pull/1',
        extras: [],
      });
      expect(mockListPrsForHead).not.toHaveBeenCalled();
    });

    it('keeps the local-name PRs and names the task repository when the lookup fails', async () => {
      prsByRepo.set('/wt@task/x', ['https://github.com/a/b/pull/1']);
      mockListPrsForHead.mockRejectedValue(new Error('HTTP 502'));

      await expect(detectTaskPrs('/wt', 'task/x')).resolves.toEqual({
        url: 'https://github.com/a/b/pull/1',
        extras: [],
        failedRepos: ['.'],
      });
    });

    it('propagates a logged-out gh', async () => {
      const err = Object.assign(new Error('gh failed'), {
        stderr: 'You are not logged into any GitHub hosts',
      });
      mockListPrsForHead.mockRejectedValue(err);

      await expect(detectTaskPrs('/wt', 'task/x')).rejects.toBe(err);
    });
  });
});
