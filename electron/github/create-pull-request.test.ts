import { beforeEach, describe, expect, it, vi } from 'vitest';

const runGh = vi.fn<(args: string[], cwd?: string, input?: string) => Promise<string>>();
const listOpenPrUrlsForBranch = vi.fn<(cwd: string, branch: string) => Promise<string[]>>();

vi.mock('./gh.js', () => ({ runGh }));
vi.mock('../ipc/pr-checks.js', () => ({ listOpenPrUrlsForBranch }));

const { createPullRequest } = await import('./create-pull-request.js');

const OPTIONS = {
  worktreePath: '/repo/wt',
  head: 'task/fix-login',
  base: 'main',
  title: 'Fix login redirect',
  body: '## Summary\n--draft is literal text',
  draft: true,
};
const URL = 'https://github.com/acme/app/pull/418';

describe('createPullRequest', () => {
  beforeEach(() => {
    runGh.mockReset();
    listOpenPrUrlsForBranch.mockReset();
  });

  it('passes the body on stdin and returns the printed URL', async () => {
    runGh.mockResolvedValue(`Creating pull request\n${URL}\n`);

    await expect(createPullRequest(OPTIONS)).resolves.toEqual({ url: URL, existed: false });

    const [args, cwd, input] = runGh.mock.calls[0];
    expect(args).toEqual([
      'pr',
      'create',
      '--head',
      'task/fix-login',
      '--base',
      'main',
      '--title',
      'Fix login redirect',
      '--body-file',
      '-',
      '--draft',
    ]);
    expect(cwd).toBe('/repo/wt');
    expect(input).toBe(OPTIONS.body);
  });

  it('omits --draft for a ready PR', async () => {
    runGh.mockResolvedValue(URL);
    await createPullRequest({ ...OPTIONS, draft: false });
    expect(runGh.mock.calls[0][0]).not.toContain('--draft');
  });

  it('links the existing PR when gh refuses because one is open', async () => {
    runGh.mockRejectedValue(new Error('gh: a pull request for branch already exists'));
    listOpenPrUrlsForBranch.mockResolvedValue([URL]);

    await expect(createPullRequest(OPTIONS)).resolves.toEqual({ url: URL, existed: true });
    expect(listOpenPrUrlsForBranch).toHaveBeenCalledWith('/repo/wt', 'task/fix-login');
  });

  it('reports the create error when the branch has no single open PR', async () => {
    runGh.mockRejectedValue(new Error('GitHub CLI is not logged in.'));
    listOpenPrUrlsForBranch.mockResolvedValue([]);
    await expect(createPullRequest(OPTIONS)).rejects.toThrow('not logged in');

    listOpenPrUrlsForBranch.mockRejectedValue(new Error('lookup failed'));
    await expect(createPullRequest(OPTIONS)).rejects.toThrow('not logged in');
  });

  it('fails when gh prints no PR URL', async () => {
    runGh.mockResolvedValue('');
    listOpenPrUrlsForBranch.mockResolvedValue([]);
    await expect(createPullRequest(OPTIONS)).rejects.toThrow('did not report');
  });
});
