import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGhJson } from './gh.js';
import {
  browseGitHubIssues,
  issueApiPath,
  readGitHubIssueActivity,
  updateGitHubIssue,
} from './issues.js';

vi.mock('./gh.js', async (original) => ({
  ...(await original<typeof import('./gh.js')>()),
  runGhJson: vi.fn(),
}));
const rawIssue = {
  number: 7,
  html_url: 'https://github.com/owner/repo/issues/7',
  title: 'Broken save',
  body: 'Full body',
  state: 'open',
  user: { login: 'alice' },
  labels: [{ name: 'bug' }],
  assignees: [],
  updated_at: '2026-10-07T10:00:00Z',
};
const query = {
  kind: 'issue' as const,
  sort: 'updated-desc' as const,
  author: '',
  search: '',
  state: 'open' as const,
  label: '',
  assignee: '',
  page: 1,
};
beforeEach(() => {
  vi.mocked(runGhJson).mockReset();
});

it.each([
  'https://evil.test/owner/repo/issues/7',
  'http://github.com/owner/repo/issues/7',
  'https://user:pass@github.com/owner/repo/issues/7',
  'https://github.com/owner/repo/pull/7',
  'https://github.com/owner/repo/issues/7?x=1',
  'https://github.com/owner/repo/issues/0',
  'https://github.com/owner/repo/issues/7/../../labels',
])('rejects noncanonical issue write target %s', (url) => {
  expect(() => issueApiPath(url)).toThrow();
});

describe('issue browser', () => {
  it('requests a scoped page and does not silently hide the search limit', async () => {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce({ nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' })
      .mockResolvedValueOnce([
        [{ name: 'bug' }, { name: 'type: enhancement' }, { name: 'question' }],
      ])
      .mockResolvedValueOnce({ items: [rawIssue], total_count: 1500 });
    const page = await browseGitHubIssues('/project', {
      ...query,
      page: 40,
      search: 'repo:other/repo OR bug',
      label: 'needs review',
    });
    expect(page).toMatchObject({ total: 1500, limited: true, hasMore: false });
    expect(page.items[0]).toMatchObject({
      number: 7,
      labels: ['bug'],
      assignees: [],
      body: 'Full body',
    });
    expect(vi.mocked(runGhJson).mock.calls[2][0]).toContain('page=40');
    expect(vi.mocked(runGhJson).mock.calls[2][0]).toContain(
      'q=repo:owner/repo is:issue is:open "repo:other/repo" "OR" "bug" label:"needs review"',
    );
  });
  it('drops double quotes that GitHub search cannot escape', async () => {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce({ nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' })
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce({ items: [], total_count: 0 });
    await browseGitHubIssues('/project', { ...query, search: ' save" "crash ' });
    expect(vi.mocked(runGhJson).mock.calls[2][0]).toContain(
      'q=repo:owner/repo is:issue is:open "save" "crash"',
    );
  });
  it('filters out results from a different repository', async () => {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce({ nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' })
      .mockResolvedValueOnce([
        [{ name: 'bug' }, { name: 'type: enhancement' }, { name: 'question' }],
      ])
      .mockResolvedValueOnce({
        items: [{ ...rawIssue, html_url: 'https://github.com/other/repo/issues/7' }],
        total_count: 1,
      });
    expect((await browseGitHubIssues('/project', query)).items).toEqual([]);
  });
  it('preserves comments and event order with explicit activity pagination', async () => {
    vi.mocked(runGhJson).mockResolvedValue([
      { id: 1, event: 'labeled', actor: { login: 'bob' }, label: { name: 'bug' } },
      { id: 2, event: 'commented', user: { login: 'alice' }, body: 'Repro details' },
    ]);
    const page = await readGitHubIssueActivity(rawIssue.html_url, 2);
    expect(page.items.map((i) => [i.author, i.event, i.body])).toEqual([
      ['bob', 'labeled · bug', ''],
      ['alice', 'commented', 'Repro details'],
    ]);
    expect(page.hasMore).toBe(false);
    expect(vi.mocked(runGhJson).mock.calls[0][0]).toContain(
      'repos/owner/repo/issues/7/timeline?per_page=25&page=2',
    );
  });
});

describe('triage writes', () => {
  it('sends exact JSON metadata, including an empty array to remove all labels', async () => {
    vi.mocked(runGhJson).mockResolvedValue(rawIssue);
    await updateGitHubIssue(rawIssue.html_url, { field: 'labels', values: [] });
    expect(runGhJson).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'PATCH',
        'repos/owner/repo/issues/7',
        '--input',
        '-',
      ],
      undefined,
      '{"labels":[]}',
    );
  });
  it('closes with a reason and clears the reason when reopening', async () => {
    vi.mocked(runGhJson).mockResolvedValue(rawIssue);
    await updateGitHubIssue(rawIssue.html_url, {
      field: 'state',
      value: 'closed',
      reason: 'not_planned',
    });
    expect(vi.mocked(runGhJson).mock.calls[0][2]).toBe(
      '{"state":"closed","state_reason":"not_planned"}',
    );
    await updateGitHubIssue(rawIssue.html_url, { field: 'state', value: 'open' });
    expect(vi.mocked(runGhJson).mock.calls[1][2]).toBe('{"state":"open","state_reason":null}');
  });
  it('reports failed writes without inventing updated issue data', async () => {
    vi.mocked(runGhJson).mockRejectedValue(new Error('Permission denied'));
    await expect(
      updateGitHubIssue(rawIssue.html_url, { field: 'assignees', values: ['alice'] }),
    ).rejects.toThrow('Permission denied');
  });
});

describe('repository-wide triage queries', () => {
  function mockRepository(items: unknown[] = [rawIssue]) {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce({ nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' })
      .mockResolvedValueOnce([
        [{ name: 'type: bug' }, { name: 'bug' }],
        [{ name: 'question' }, { name: 'enhancement' }],
      ])
      .mockResolvedValueOnce({ items, total_count: 50 });
  }
  it('combines native types and actual repository labels before paging and sorting', async () => {
    mockRepository();
    await browseGitHubIssues('/project', {
      ...query,
      kind: 'bug',
      sort: 'created-asc',
      page: 2,
      assignee: '@none',
      author: 'alice',
    });
    const args = vi.mocked(runGhJson).mock.calls[2][0];
    expect(args).toContain(
      'q=repo:owner/repo is:issue (type:Bug OR label:"type: bug","bug") is:open no:assignee author:"alice"',
    );
    expect(args).toEqual(
      expect.arrayContaining(['advanced_search=true', 'sort=created', 'order=asc', 'page=2']),
    );
  });
  it('lists mixed issues and PRs without mistaking bug-labelled PRs for issues', async () => {
    mockRepository([
      rawIssue,
      {
        ...rawIssue,
        number: 8,
        html_url: 'https://github.com/owner/repo/pull/8',
        pull_request: { merged_at: '2026-10-07' },
        draft: false,
        comments: 12,
        reactions: { total_count: 5 },
      },
    ]);
    const result = await browseGitHubIssues('/project', {
      ...query,
      kind: 'all',
      state: 'all',
      sort: 'comments-desc',
    });
    expect(result.items.map((i) => i.kind)).toEqual(['issue', 'pr']);
    expect(result.items[1]).toMatchObject({ state: 'merged', commentCount: 12, reactionCount: 5 });
    expect(vi.mocked(runGhJson).mock.calls[2][0]).toContain('q=repo:owner/repo');
    expect(result.labels).toEqual(['type: bug', 'bug', 'question', 'enhancement']);
  });
  it('supports PR-only, unlabelled, and best-match filters', async () => {
    mockRepository([]);
    await browseGitHubIssues('/project', {
      ...query,
      kind: 'pr',
      label: '@none',
      sort: 'best-match',
    });
    const args = vi.mocked(runGhJson).mock.calls[2][0];
    expect(args).toContain('q=repo:owner/repo is:pr is:open no:label');
    expect(args.some((arg) => arg.startsWith('sort='))).toBe(false);
  });
  it('never sends issue state mutations to a PR', async () => {
    await expect(
      updateGitHubIssue('https://github.com/owner/repo/pull/8', {
        field: 'state',
        value: 'closed',
        reason: 'completed',
      }),
    ).rejects.toThrow();
    expect(runGhJson).not.toHaveBeenCalled();
  });
});
