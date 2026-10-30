import { beforeEach, expect, it, vi } from 'vitest';
import { linkTaskToIssueReference } from './github-issue-link';
import { invoke } from '../lib/ipc';
import { saveState } from './persistence';
import { IPC } from '../../electron/ipc/channels';
import type { GitHubIssueSummary } from '../ipc/types';

const mockStore = vi.hoisted(() => ({
  tasks: {} as Record<string, { githubUrl?: string }>,
}));
vi.mock('./core', () => ({
  store: mockStore,
  setStore: (_tasks: string, id: string, key: 'githubUrl', value: string) => {
    mockStore.tasks[id][key] = value;
  },
}));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
const readGitHubIssue = vi.fn<(url: string) => Promise<GitHubIssueSummary>>();
const resolveGitHubRepository = vi.fn<(projectRoot: string) => Promise<string>>();
vi.mock('./persistence', () => ({ saveState: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    const a = args as { url: string; projectRoot: string };
    return channel === IPC.ReadGitHubIssue
      ? readGitHubIssue(a.url)
      : resolveGitHubRepository(a.projectRoot);
  });
  mockStore.tasks = { t: {} };
  resolveGitHubRepository.mockResolvedValue('acme/app');
  readGitHubIssue.mockImplementation(
    async (url) =>
      ({
        kind: 'issue',
        url,
        number: 123,
        title: '',
        body: '',
        state: 'open',
        createdAt: '',
        commentCount: 0,
        reactionCount: 0,
      }) as GitHubIssueSummary,
  );
});

it('links a task whose prompt says #123 to that issue in the project repo', async () => {
  await linkTaskToIssueReference('t', '/p', 'fix #123 please');
  expect(resolveGitHubRepository).toHaveBeenCalledWith('/p');
  expect(readGitHubIssue).toHaveBeenCalledWith('https://github.com/acme/app/issues/123');
  expect(mockStore.tasks.t.githubUrl).toBe('https://github.com/acme/app/issues/123');
  expect(saveState).toHaveBeenCalled();
});

it('keeps a link the task already has', async () => {
  mockStore.tasks.t.githubUrl = 'https://github.com/acme/app/issues/9';
  await linkTaskToIssueReference('t', '/p', 'fix #123');
  expect(resolveGitHubRepository).not.toHaveBeenCalled();
  expect(mockStore.tasks.t.githubUrl).toBe('https://github.com/acme/app/issues/9');
});

it('leaves the task unlinked when the project is not on GitHub', async () => {
  resolveGitHubRepository.mockRejectedValue(new Error('no remote'));
  await linkTaskToIssueReference('t', '/p', 'fix #123');
  expect(mockStore.tasks.t.githubUrl).toBeUndefined();
  expect(saveState).not.toHaveBeenCalled();
});

it('skips a task closed while the repository was resolved', async () => {
  resolveGitHubRepository.mockImplementation(async () => {
    delete mockStore.tasks.t;
    return 'acme/app';
  });
  await linkTaskToIssueReference('t', '/p', 'fix #123');
  expect(saveState).not.toHaveBeenCalled();
});

it('does not link a pull request: the task works on its own branch, not that PR', async () => {
  readGitHubIssue.mockResolvedValue({
    kind: 'pr',
    url: 'https://github.com/acme/app/pull/123',
  } as GitHubIssueSummary);
  await linkTaskToIssueReference('t', '/p', 'review #123');
  expect(mockStore.tasks.t.githubUrl).toBeUndefined();
  expect(saveState).not.toHaveBeenCalled();
});

it('does not link a number that is no issue in the repo', async () => {
  readGitHubIssue.mockRejectedValue(new Error('Not Found'));
  await linkTaskToIssueReference('t', '/p', 'fix #99999');
  expect(mockStore.tasks.t.githubUrl).toBeUndefined();
});

it('links an issue URL in the prompt, even from another repo', async () => {
  await linkTaskToIssueReference(
    't',
    '/p',
    'Work on https://github.com/other/lib/issues/7#issuecomment-1 now',
  );
  expect(resolveGitHubRepository).not.toHaveBeenCalled();
  expect(readGitHubIssue).toHaveBeenCalledWith('https://github.com/other/lib/issues/7');
  expect(mockStore.tasks.t.githubUrl).toBe('https://github.com/other/lib/issues/7');
});

it('does not link a pull request URL in the prompt', async () => {
  await linkTaskToIssueReference('t', '/p', 'Review https://github.com/acme/app/pull/8');
  expect(readGitHubIssue).not.toHaveBeenCalled();
  expect(mockStore.tasks.t.githubUrl).toBeUndefined();
});
