import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { GitHubListPicker, GitHubListView } from './GitHubCustomLists';
import { readGitHubIssue, resolveGitHubRepository, startGitHubTriageTask } from '../store/github';
import { publishGitHubList, shownGitHubList, showGitHubList } from '../store/github-lists';
import type { GitHubIssueSummary } from '../ipc/types';

vi.mock('../store/core', () => ({
  store: {
    tasks: { 'gh-agent-p': { id: 'gh-agent-p', projectId: 'p' } },
    projects: [{ id: 'p', name: 'Code', path: '/code' }],
    githubIssuesProjectId: 'p',
    showNewTaskPanel: false,
  },
}));
vi.mock('../store/github', () => ({
  GITHUB_BATCH_LIMIT: 25,
  resolveGitHubRepository: vi.fn(),
  readGitHubIssue: vi.fn(),
  startGitHubTriageTask: vi.fn(() => true),
}));
const item = { url: 'https://github.com/o/r/issues/2', title: 'Second', reason: 'High impact' };
const list = { name: 'Plan', groups: [{ name: 'Fixes', items: [item] }] };
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
const open = vi.fn();
const issue: GitHubIssueSummary = {
  ...item,
  number: 2,
  kind: 'issue',
  body: '',
  state: 'open',
  author: 'dev',
  assignees: [],
  labels: [],
  isDraft: false,
  commentCount: 0,
  reactionCount: 0,
  createdAt: '',
  updatedAt: '',
};
function mountView(shown = list) {
  dispose = render(
    () => <GitHubListView projectId="p" list={shown} selectedUrl={null} onOpen={open} />,
    host,
  );
}
function mountPicker(repository = 'o/r') {
  dispose = render(
    () => <GitHubListPicker projectId="p" repository={repository} shown={shownGitHubList()} />,
    host,
  );
}
function button(text: string) {
  // The confirm dialog renders outside the host.
  const button = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  showGitHubList(null);
  host = document.createElement('div');
  document.body.append(host);
  vi.mocked(readGitHubIssue).mockResolvedValue(issue);
  vi.mocked(resolveGitHubRepository).mockResolvedValue('o/r');
});
afterEach(() => {
  dispose?.();
  host.remove();
});

describe('GitHubListPicker', () => {
  it('switches back to search results and deletes the shown list', async () => {
    await publishGitHubList('gh-agent-p', list);
    mountPicker();
    button('Delete list').click();
    expect(shownGitHubList()).not.toBeNull();
    button('Cancel').click();
    expect(shownGitHubList()).not.toBeNull();
    button('Delete list').click();
    button('Delete').click();
    expect(shownGitHubList()).toBeNull();
    expect(host.querySelector('select')).toBeNull();
    dispose?.();
    mountPicker();
    expect(host.textContent).not.toContain('Plan');
  });

  it('does not show another repository’s saved lists', async () => {
    await publishGitHubList('gh-agent-p', list);
    mountPicker('elsewhere/repo');
    expect(host.textContent).not.toContain('Plan');
  });

  it('reports unreadable saved lists', () => {
    localStorage.setItem('github-custom-lists:p:o/r', '{"not":"an array"}');
    mountPicker();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load saved lists',
    );
  });
});

describe('GitHubListView', () => {
  it('shows groups with reasons, opens details, and starts a group using fresh data', async () => {
    mountView();
    expect(host.textContent).toContain('1. Fixes');
    expect(host.textContent).toContain('High impact');
    button('Second · #2High impact').click();
    expect(open).toHaveBeenCalledWith(item.url);
    button('Triage group').click();
    await vi.waitFor(() => expect(startGitHubTriageTask).toHaveBeenCalledWith('p', [issue]));
    expect(readGitHubIssue).toHaveBeenCalledWith(item.url);
  });

  it('labels each group action and keeps the button out of the heading', () => {
    mountView();
    const action = host.querySelector('button[aria-label="Triage group with agent: Fixes"]');
    expect(action).not.toBeNull();
    expect(action?.closest('h4')).toBeNull();
  });

  it('shows why a group cannot be triaged as visible text tied to the button', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ ...item, url: `${item.url}${i}` }));
    mountView({ name: 'Big', groups: [{ name: 'All', items: many }] });
    const action = button('Triage group');
    expect(action.disabled).toBe(true);
    const note = host.querySelector(`#${action.getAttribute('aria-describedby')}`);
    expect(note?.textContent).toContain('up to 25 items');
  });

  it('says so when a list has no groups', () => {
    mountView({ name: 'Empty', groups: [] });
    expect(host.textContent).toContain('This list has no groups.');
  });

  it('does not navigate when loading finishes after the view was closed', async () => {
    let resolve: (value: GitHubIssueSummary) => void = () => {};
    vi.mocked(readGitHubIssue).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    mountView();
    button('Triage group').click();
    dispose?.();
    resolve(issue);
    await new Promise((r) => setTimeout(r, 0));
    expect(startGitHubTriageTask).not.toHaveBeenCalled();
  });

  it('does not start a group task when fetching current issue details fails', async () => {
    vi.mocked(readGitHubIssue).mockRejectedValue(new Error('Not found'));
    mountView();
    button('Triage group').click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Not found'),
    );
    expect(startGitHubTriageTask).not.toHaveBeenCalled();
  });
});
