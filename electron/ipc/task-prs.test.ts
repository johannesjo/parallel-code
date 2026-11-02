import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListOpenPrUrls, mockFindNestedRepos, mockGetMainBranch } = vi.hoisted(() => ({
  mockListOpenPrUrls: vi.fn(),
  mockFindNestedRepos: vi.fn(),
  mockGetMainBranch: vi.fn(),
}));

vi.mock('./pr-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-checks.js')>()),
  listOpenPrUrlsForBranch: mockListOpenPrUrls,
}));
vi.mock('./nested-repos.js', () => ({ findNestedRepos: mockFindNestedRepos }));
vi.mock('./git.js', () => ({ getMainBranch: mockGetMainBranch }));

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
});
