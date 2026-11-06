import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveGitHubRepository = vi.fn<(root: string) => Promise<string>>();
vi.mock('./issues.js', () => ({ resolveGitHubRepository }));
// gh answers a repository's canonical name, following renames and transfers.
const runGhJson = vi.fn<(args: string[], cwd?: string) => Promise<unknown>>();
vi.mock('./gh.js', async (original) => ({
  ...(await original<typeof import('./gh.js')>()),
  runGhJson,
}));

const { githubRepository, qualifyHead, resolvePrHead } = await import('./pr-head.js');

describe('githubRepository', () => {
  it('reads owner/repo from github.com remote URLs', () => {
    expect(githubRepository('git@github.com:Acme/App.git')).toBe('Acme/App');
    expect(githubRepository('https://github.com/jane/app.git')).toBe('jane/app');
  });

  it('is null for other hosts and unparseable remotes', () => {
    expect(githubRepository('git@gitlab.com:jane/app.git')).toBeNull();
    expect(githubRepository('not a url')).toBeNull();
    expect(githubRepository('https://github.com/-x/app')).toBeNull();
  });
});

describe('qualifyHead', () => {
  it('keeps the bare branch when origin is the repository the PR opens in', () => {
    expect(qualifyHead('Acme/App', 'acme/app', 'task/x')).toBe('task/x');
  });

  it('names the fork owner when origin is another repository', () => {
    expect(qualifyHead('Jane/app', 'acme/app', 'task/x')).toBe('Jane:task/x');
  });
});

describe('resolvePrHead', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });
  function gitRepo(origin?: string): string {
    repo = mkdtempSync(path.join(tmpdir(), 'pr-head-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    return repo;
  }

  it("names the owner of origin's fork when gh opens the PR upstream", async () => {
    resolveGitHubRepository.mockResolvedValue('johannesjo/parallel-code');
    runGhJson.mockResolvedValue({ nameWithOwner: 'jane/parallel-code' });
    const root = gitRepo('git@github.com:jane/parallel-code.git');
    await expect(resolvePrHead(root, 'task/x')).resolves.toBe('jane:task/x');
    expect(resolveGitHubRepository).toHaveBeenCalledWith(root);
  });

  it('keeps the bare branch when origin names the repository before a rename', async () => {
    resolveGitHubRepository.mockResolvedValue('newowner/app');
    runGhJson.mockResolvedValue({ nameWithOwner: 'newowner/app' });
    const root = gitRepo('https://github.com/oldowner/app.git');
    await expect(resolvePrHead(root, 'task/x')).resolves.toBe('task/x');
    expect(runGhJson).toHaveBeenCalledWith(
      ['repo', 'view', 'oldowner/app', '--json', 'nameWithOwner'],
      root,
    );
  });

  it('keeps the bare branch without asking gh when origin is not on github.com', async () => {
    runGhJson.mockClear();
    resolveGitHubRepository.mockResolvedValue('acme/app');
    await expect(resolvePrHead(gitRepo('git@gitlab.com:jane/app.git'), 'task/x')).resolves.toBe(
      'task/x',
    );
    expect(runGhJson).not.toHaveBeenCalled();
  });

  it('falls back to the bare branch when origin is missing', async () => {
    resolveGitHubRepository.mockResolvedValue('johannesjo/parallel-code');
    await expect(resolvePrHead(gitRepo(), 'task/x')).resolves.toBe('task/x');
  });
});
