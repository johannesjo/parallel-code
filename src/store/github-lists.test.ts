import { beforeEach, expect, it, vi } from 'vitest';
import {
  deleteGitHubList,
  loadGitHubLists,
  publishGitHubList,
  shownGitHubList,
  showGitHubList,
} from './github-lists';
import { forgetGitHubLists } from './github-list-storage';
import { resolveGitHubRepository } from './github';
import { showNotification } from './notification';

const mockStore = vi.hoisted(() => ({
  tasks: {} as Record<string, { projectId: string }>,
  projects: [] as { id: string; path: string; kind?: string }[],
  githubIssuesProjectId: null as string | null,
}));
vi.mock('./core', () => ({ store: mockStore }));
vi.mock('./github', () => ({ resolveGitHubRepository: vi.fn() }));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));

const data = new Map<string, string>();
beforeEach(() => {
  data.clear();
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  });
  showGitHubList(null);
  mockStore.projects = [
    { id: 'p', path: '/p' },
    { id: 'doc', path: '/doc', kind: 'document' },
  ];
  mockStore.tasks = {
    t: { projectId: 'p' },
    d: { projectId: 'doc' },
    'gh-agent-p': { projectId: 'p' },
  };
  mockStore.githubIssuesProjectId = 'p';
  vi.mocked(resolveGitHubRepository).mockResolvedValue('Acme/Repo');
});

function list(name: string, number = 1, repo = 'Acme/Repo') {
  return {
    name,
    groups: [
      {
        name: 'G',
        items: [{ url: `https://github.com/${repo}/issues/${number}`, title: 'T', reason: 'R' }],
      },
    ],
  };
}

it('stores lists per project under the lower-cased repository and shows it', async () => {
  await publishGitHubList('gh-agent-p', list('A'));
  expect(loadGitHubLists('p', 'ACME/repo').map((l) => l.name)).toEqual(['A']);
  expect(shownGitHubList()).toEqual({ projectId: 'p', repository: 'acme/repo', name: 'A' });
});

it('replaces a list with the same name and keeps the newest twenty', async () => {
  await publishGitHubList('gh-agent-p', list('A', 1));
  await publishGitHubList('gh-agent-p', list('A', 2));
  expect(loadGitHubLists('p', 'acme/repo')).toHaveLength(1);
  for (let i = 0; i < 25; i++) await publishGitHubList('gh-agent-p', list(`L${i}`));
  const names = loadGitHubLists('p', 'acme/repo').map((l) => l.name);
  expect(names).toHaveLength(20);
  expect(names.at(-1)).toBe('L24');
});

it('rejects tasks without a code project and invalid lists', async () => {
  await expect(publishGitHubList('missing', list('A'))).rejects.toThrow();
  await expect(publishGitHubList('d', list('A'))).rejects.toThrow(/Document/);
  await expect(publishGitHubList('gh-agent-p', { name: 'x' })).rejects.toThrow();
  expect(data.size).toBe(0);
});

it('rejects ordinary tasks and does not call them a missing project', async () => {
  await expect(publishGitHubList('t', list('A'))).rejects.toThrow(/GitHub page agent/);
  mockStore.tasks = {};
  const error = await publishGitHubList('t', list('A')).catch((e: unknown) => String(e));
  expect(error).not.toMatch(/no longer available/);
  expect(data.size).toBe(0);
});

it('rejects a list for another repository than the project’s', async () => {
  await expect(publishGitHubList('gh-agent-p', list('A', 1, 'other/repo'))).rejects.toThrow(
    /other\/repo.*Acme\/Repo/,
  );
  expect(data.size).toBe(0);
});

it('selects the list for the user’s return and says where it went when they are away', async () => {
  mockStore.githubIssuesProjectId = null;
  await publishGitHubList('gh-agent-p', list('A'));
  expect(loadGitHubLists('p', 'acme/repo')).toHaveLength(1);
  expect(shownGitHubList()).toEqual({ projectId: 'p', repository: 'acme/repo', name: 'A' });
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('“A”'));
});

it('keeps another project’s page as it is', async () => {
  mockStore.githubIssuesProjectId = 'other';
  showGitHubList({ projectId: 'other', repository: 'acme/other', name: 'Mine' });
  await publishGitHubList('gh-agent-p', list('A'));
  expect(shownGitHubList()?.projectId).toBe('other');
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('“A”'));
});

it('keeps valid lists when another stored entry is invalid', async () => {
  data.set('github-custom-lists:p:acme/repo', JSON.stringify([list('A'), { name: 'bad' }]));
  expect(loadGitHubLists('p', 'acme/repo').map((l) => l.name)).toEqual(['A']);
  await publishGitHubList('gh-agent-p', list('B'));
  expect(loadGitHubLists('p', 'acme/repo').map((l) => l.name)).toEqual(['A', 'B']);
  deleteGitHubList('p', 'acme/repo', 'B');
  expect(loadGitHubLists('p', 'acme/repo').map((l) => l.name)).toEqual(['A']);
});

it('replaces non-array stored data when publishing', async () => {
  data.set('github-custom-lists:p:acme/repo', '{oops');
  await publishGitHubList('gh-agent-p', list('A'));
  expect(loadGitHubLists('p', 'acme/repo')).toHaveLength(1);
});

it('deletes a list, and hides it only when that exact list is shown', async () => {
  await publishGitHubList('gh-agent-p', list('A'));
  await publishGitHubList('gh-agent-p', list('B'));
  deleteGitHubList('p', 'ACME/Repo', 'A');
  expect(loadGitHubLists('p', 'acme/repo').map((l) => l.name)).toEqual(['B']);
  expect(shownGitHubList()?.name).toBe('B');
  deleteGitHubList('p', 'acme/repo', 'B');
  expect(shownGitHubList()).toBeNull();
});

it('keeps another repository’s same-named list shown', async () => {
  vi.mocked(resolveGitHubRepository).mockResolvedValue('acme/other');
  await publishGitHubList('gh-agent-p', list('A', 1, 'acme/other'));
  data.set('github-custom-lists:p:acme/repo', JSON.stringify([list('A')]));
  deleteGitHubList('p', 'acme/repo', 'A');
  expect(shownGitHubList()?.repository).toBe('acme/other');
});

it('can delete when the stored data is corrupt', () => {
  data.set('github-custom-lists:p:acme/repo', '{oops');
  deleteGitHubList('p', 'acme/repo', 'A');
  expect(data.has('github-custom-lists:p:acme/repo')).toBe(false);
});

it('forgets every list of a removed project only', async () => {
  await publishGitHubList('gh-agent-p', list('A'));
  vi.mocked(resolveGitHubRepository).mockResolvedValue('acme/other');
  await publishGitHubList('gh-agent-p', list('B', 1, 'acme/other'));
  data.set('github-custom-lists:p2:acme/repo', '[]');
  forgetGitHubLists('p');
  expect([...data.keys()]).toEqual(['github-custom-lists:p2:acme/repo']);
});

it('saves nothing when the project is removed while its repository resolves', async () => {
  vi.mocked(resolveGitHubRepository).mockImplementation(async () => {
    mockStore.projects = [];
    return 'Acme/Repo';
  });
  await expect(publishGitHubList('gh-agent-p', list('A'))).rejects.toThrow('removed');
  expect(data.size).toBe(0);
});

it('saves nothing when the repository cannot be resolved', async () => {
  vi.mocked(resolveGitHubRepository).mockRejectedValue(new Error('gh not found'));
  await expect(publishGitHubList('gh-agent-p', list('A'))).rejects.toThrow('gh not found');
  expect(data.size).toBe(0);
});
