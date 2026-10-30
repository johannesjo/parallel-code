import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { GitHubIssuesPage } from './GitHubIssuesPage';
import { setStore, store } from '../store/core';
import {
  browseGitHubIssues,
  openGitHubIssues,
  readGitHubIssue,
  readGitHubIssueActivity,
  resolveGitHubRepository,
  startGitHubIssueTask,
  updateGitHubIssue,
} from '../store/github';
import { ensureProjectAgentTask, prefillGitHubAgentPrompt } from '../store/github-agent';
import { triggerFocus } from '../store/focused-panel';
import { publishGitHubList, showGitHubList } from '../store/github-lists';
import type { GitHubIssueSummary, GitHubIssuePage } from '../ipc/types';
import type { Task } from '../store/types';

vi.mock('../store/core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({
    projects: [],
    tasks: {},
    showNewTaskPanel: false,
    githubIssuesProjectId: null,
    newTaskPrefillPrompt: null,
    panelUserSize: {},
  });
  return { store, setStore };
});
vi.mock('../store/navigation', async () => {
  const { setStore } = await import('../store/core');
  return {
    setActiveTask: vi.fn(),
    toggleNewTaskPanel: vi.fn((show: boolean) => setStore('showNewTaskPanel', show)),
  };
});
vi.mock('../store/tasks', () => ({
  uncollapseTask: vi.fn(),
  setPrefillPrompt: vi.fn(),
  setTaskPromptDraftActive: vi.fn(),
}));
vi.mock('../store/focused-panel', () => ({ setTaskFocusedPanel: vi.fn(), triggerFocus: vi.fn() }));
const agentState = vi.hoisted(() => ({ loaded: true, failed: false, installed: true }));
vi.mock('../store/github-agent', () => ({
  ensureProjectAgentTask: vi.fn(() => null),
  prefillGitHubAgentPrompt: vi.fn(() => true),
  githubAgentAvailability: () =>
    !agentState.loaded
      ? agentState.failed
        ? 'failed'
        : 'loading'
      : agentState.installed
        ? 'ready'
        : 'none',
}));
// The terminal needs Electron; the pane's own behavior is covered with doc mode.
vi.mock('./HiddenAgentPane', () => ({
  HiddenAgentPane: (props: { task?: Task; fallback: JSX.Element }) => (
    <>{props.task ? <p>Agent pane for {props.task.id}</p> : props.fallback}</>
  ),
}));
vi.mock('../store/github', async (original) => ({
  ...(await original<typeof import('../store/github')>()),
  browseGitHubIssues: vi.fn(),
  readGitHubIssue: vi.fn(),
  readGitHubIssueActivity: vi.fn(),
  resolveGitHubRepository: vi.fn(),
  updateGitHubIssue: vi.fn(),
}));

const issue: GitHubIssueSummary = {
  kind: 'issue',
  isDraft: false,
  commentCount: 3,
  reactionCount: 4,
  createdAt: '2026-10-01T10:00:00Z',
  number: 7,
  url: 'https://github.com/owner/repo/issues/7',
  title: 'Fix broken save',
  body: 'Repro steps',
  author: 'alice',
  assignees: [],
  labels: ['bug'],
  state: 'open',
  updatedAt: '2026-10-07T10:00:00Z',
};
const page: GitHubIssuePage = {
  labels: ['bug', 'enhancement', 'question'],
  repository: 'owner/repo',
  items: [issue],
  total: 26,
  hasMore: true,
  limited: false,
};
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function selectIssue() {
  const row = document.querySelector<HTMLButtonElement>('.github-issue-row');
  if (!row) throw new Error('Missing issue row');
  row.click();
}
function mount() {
  dispose = render(() => <GitHubIssuesPage />, host);
}

beforeEach(() => {
  vi.clearAllMocks();
  agentState.loaded = true;
  agentState.failed = false;
  agentState.installed = true;
  localStorage.clear();
  showGitHubList(null);
  setStore('projects', [
    { id: 'p1', name: 'Repo', path: '/repo', color: '#ffffff' },
    { id: 'p2', name: 'Other', path: '/other', color: '#ffffff' },
  ]);
  // A merge would keep tasks that earlier tests added.
  setStore('tasks', reconcile({}));
  setStore('showNewTaskPanel', false);
  setStore('newTaskPrefillPrompt', null);
  setStore('githubIssuesProjectId', 'p1');
  vi.mocked(browseGitHubIssues).mockResolvedValue(page);
  vi.mocked(readGitHubIssue).mockResolvedValue(issue);
  vi.mocked(resolveGitHubRepository).mockResolvedValue('owner/repo');
  vi.mocked(readGitHubIssueActivity).mockResolvedValue({ items: [], hasMore: false });
  vi.mocked(updateGitHubIssue).mockResolvedValue({ ...issue, state: 'closed' });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
});

describe('GitHub issue workflow', () => {
  it('renders an inline page and returns to tasks without a modal', async () => {
    mount();
    await flush();
    expect(host.querySelector('section[aria-labelledby="github-issues-title"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.dialog-overlay')).toBeNull();
    button('Back to tasks').click();
    expect(store.githubIssuesProjectId).toBeNull();
    expect(host.querySelector('.github-issues')).toBeNull();
  });

  it('stages an editable task with a durable issue link and restores browser position', async () => {
    mount();
    await flush();
    button('Next').click();
    await flush();
    selectIssue();
    await flush();
    const list = document.querySelector<HTMLDivElement>('.github-issues-rows');
    if (!list) throw new Error('Missing list');
    list.scrollTop = 120;
    list.dispatchEvent(new Event('scroll'));
    button('Start task').click();
    await flush();
    expect(store.showNewTaskPanel).toBe(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({
      projectId: 'p1',
      name: '#7 Fix broken save',
      githubUrl: issue.url,
    });
    expect(store.newTaskPrefillPrompt?.prompt).toContain('Repro steps');
    expect(store.githubIssuesProjectId).toBeNull();
    setStore('showNewTaskPanel', false);
    openGitHubIssues('p1');
    await flush();
    expect(document.body.textContent).toContain('Page 2');
    expect(document.body.textContent).toContain('Repro steps');
    expect(document.querySelector('.github-issues-rows')?.scrollTop).toBe(120);
  });
  it('never overwrites an existing task draft', async () => {
    setStore('showNewTaskPanel', true);
    setStore('newTaskPrefillPrompt', { prompt: 'Keep my draft', projectId: 'p2' });
    mount();
    await flush();
    selectIssue();
    await flush();
    expect(button('Start task').disabled).toBe(true);
    expect(startGitHubIssueTask('p1', issue)).toBe(false);
    expect(store.newTaskPrefillPrompt?.prompt).toBe('Keep my draft');
  });
  it('ignores an old repository request that finishes after switching projects', async () => {
    let resolveOld: ((page: GitHubIssuePage) => void) | undefined;
    vi.mocked(browseGitHubIssues)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...page,
        repository: 'owner/other',
        items: [{ ...issue, title: 'Other issue', url: 'https://github.com/owner/other/issues/7' }],
      });
    mount();
    await flush();
    openGitHubIssues('p2');
    await flush();
    resolveOld?.(page);
    await flush();
    expect(document.body.textContent).toContain('Other issue');
    expect(document.body.textContent).not.toContain('Fix broken save');
  });
  it('shows the gh error without the IPC wrapper', async () => {
    vi.mocked(browseGitHubIssues).mockRejectedValue(
      new Error(
        "Error invoking remote method 'browse_github_issues': Error: GitHub CLI is not logged in.",
      ),
    );
    mount();
    await flush();
    expect(host.querySelector('[role="alert"] span')?.textContent).toBe(
      'GitHub CLI is not logged in.',
    );
  });

  it('keeps failed metadata edits available for retry', async () => {
    vi.mocked(updateGitHubIssue).mockRejectedValue(new Error('Permission denied'));
    mount();
    await flush();
    selectIssue();
    await flush();
    button('Edit labels').click();
    const input = document.querySelector<HTMLTextAreaElement>('#github-issue-metadata');
    if (!input) throw new Error('Missing metadata editor');
    input.value = 'needs review';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button('Save labels').click();
    await flush();
    expect(updateGitHubIssue).toHaveBeenCalledWith(issue.url, {
      field: 'labels',
      values: ['needs review'],
    });
    expect(document.body.textContent).toContain('Permission denied');
    expect(input.value).toBe('needs review');
    expect(button('Save labels').disabled).toBe(false);
  });
  it('only changes state after GitHub confirms success', async () => {
    let resolveWrite: ((issue: GitHubIssueSummary) => void) | undefined;
    vi.mocked(updateGitHubIssue).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    mount();
    await flush();
    selectIssue();
    await flush();
    button('Close issue').click();
    await flush();
    expect(updateGitHubIssue).toHaveBeenCalledWith(issue.url, {
      field: 'state',
      value: 'closed',
      reason: 'completed',
    });
    expect(document.body.textContent).toContain('Saving to GitHub');
    expect(
      document.querySelector('.github-issue-detail-body .github-issue-state')?.textContent,
    ).toContain('open');
    resolveWrite?.({ ...issue, state: 'closed' });
    await flush();
    expect(
      document.querySelector('.github-issue-detail-body .github-issue-state')?.textContent,
    ).toContain('closed');
    expect(button('Reopen issue')).toBeDefined();
  });
  it('surfaces activity failures separately from the readable issue', async () => {
    vi.mocked(readGitHubIssueActivity).mockRejectedValue(new Error('Rate limit reached'));
    mount();
    await flush();
    selectIssue();
    await flush();
    expect(document.body.textContent).toContain('Repro steps');
    expect(document.body.textContent).toContain('Rate limit reached');
    expect(button('Retry activity')).toBeDefined();
  });
  it('appends activity pages with Load more', async () => {
    const activityItem = (author: string) => ({
      id: author,
      author,
      event: 'commented',
      body: `Comment by ${author}`,
      createdAt: '2026-10-02T10:00:00Z',
    });
    vi.mocked(readGitHubIssueActivity)
      .mockResolvedValueOnce({ items: [activityItem('bob')], hasMore: true })
      .mockResolvedValueOnce({ items: [activityItem('carol')], hasMore: false });
    mount();
    await flush();
    selectIssue();
    await flush();
    button('Load more activity').click();
    await flush();
    expect(readGitHubIssueActivity).toHaveBeenLastCalledWith(issue.url, 2);
    expect(document.body.textContent).toContain('Comment by bob');
    expect(document.body.textContent).toContain('Comment by carol');
    expect(() => button('Load more activity')).toThrow();
  });
  it('starts activity again from page 1 when the page is refreshed', async () => {
    const activityItem = (author: string) => ({
      id: author,
      author,
      event: 'commented',
      body: `Comment by ${author}`,
      createdAt: '2026-10-02T10:00:00Z',
    });
    vi.mocked(readGitHubIssueActivity)
      .mockResolvedValueOnce({ items: [activityItem('bob')], hasMore: true })
      .mockResolvedValueOnce({ items: [activityItem('carol')], hasMore: false })
      .mockResolvedValueOnce({ items: [activityItem('dave')], hasMore: true });
    mount();
    await flush();
    selectIssue();
    await flush();
    button('Load more activity').click();
    await flush();
    button('Refresh').click();
    await flush();
    expect(readGitHubIssueActivity).toHaveBeenLastCalledWith(issue.url, 1);
    expect(document.body.textContent).toContain('Comment by dave');
    expect(document.body.textContent).not.toContain('Comment by bob');
    expect(document.body.textContent).not.toContain('Comment by carol');
  });
  it('reloads the open item when the page is refreshed', async () => {
    mount();
    await flush();
    selectIssue();
    await flush();
    const reads = vi.mocked(readGitHubIssue).mock.calls.length;
    button('Refresh').click();
    await flush();
    expect(readGitHubIssue).toHaveBeenCalledTimes(reads + 1);
    expect(readGitHubIssueActivity).toHaveBeenLastCalledWith(issue.url, 1);
  });
  it('shows an unreadable issue inline and recovers on retry', async () => {
    vi.mocked(readGitHubIssue).mockRejectedValueOnce(new Error('Issue not found'));
    mount();
    await flush();
    selectIssue();
    await flush();
    expect(document.body.textContent).toContain('Issue not found');
    expect(host.querySelector('.github-issues-rows')).not.toBeNull();
    button('Retry').click();
    await flush();
    expect(document.body.textContent).toContain('Repro steps');
  });
});

it('filters and sorts the repository immediately, resets pagination, and debounces text search', async () => {
  mount();
  await flush();
  button('Next').click();
  await flush();
  button('Bugs').click();
  await flush();
  expect(browseGitHubIssues).toHaveBeenLastCalledWith(
    '/repo',
    expect.objectContaining({ kind: 'bug', page: 1 }),
  );
  const sort = document.querySelector<HTMLSelectElement>('[aria-label="Sort issues"]');
  if (!sort) throw new Error('Missing sort control');
  sort.value = 'created-asc';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(browseGitHubIssues).toHaveBeenLastCalledWith(
    '/repo',
    expect.objectContaining({ sort: 'created-asc', kind: 'bug' }),
  );
  vi.useFakeTimers();
  try {
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search issues"]');
    if (!search) throw new Error('Missing search');
    const calls = vi.mocked(browseGitHubIssues).mock.calls.length;
    search.value = 'save';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.value = 'save windows';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(399);
    expect(browseGitHubIssues).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(browseGitHubIssues).toHaveBeenLastCalledWith(
      '/repo',
      expect.objectContaining({ search: 'save windows', page: 1 }),
    );
  } finally {
    vi.useRealTimers();
  }
  button('Reset').click();
  await flush();
  expect(browseGitHubIssues).toHaveBeenLastCalledWith(
    '/repo',
    expect.objectContaining({ kind: 'all', search: '', sort: 'updated-desc', page: 1 }),
  );
});

it('offers Reset only once a filter is set', async () => {
  mount();
  await flush();
  expect(button('Reset').style.visibility).toBe('hidden');
  const state = document.querySelector<HTMLSelectElement>('[aria-label="Issue state"]');
  if (!state) throw new Error('Missing state filter');
  state.value = 'closed';
  state.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(button('Reset').style.visibility).toBe('');
});

it('shows distinct classifications and keeps a selection across pages for agent triage', async () => {
  vi.mocked(browseGitHubIssues)
    .mockResolvedValueOnce({
      ...page,
      items: [
        issue,
        {
          ...issue,
          number: 8,
          url: 'https://github.com/owner/repo/issues/8',
          labels: ['enhancement'],
        },
        {
          ...issue,
          number: 9,
          url: 'https://github.com/owner/repo/pull/9',
          kind: 'pr',
          isDraft: true,
        },
      ],
    })
    .mockResolvedValue({
      ...page,
      items: [
        {
          ...issue,
          number: 10,
          url: 'https://github.com/owner/repo/issues/10',
          labels: ['question'],
        },
      ],
    });
  mount();
  await flush();
  expect([...document.querySelectorAll('.github-item-kind')].map((e) => e.textContent)).toEqual([
    'Bug',
    'Feature',
    'PR',
    'Draft',
  ]);
  button('Select page').click();
  button('Next').click();
  await flush();
  expect(document.body.textContent).toContain('Discussion');
  button('Select page').click();
  expect(document.body.textContent).toContain('4 / 25 selected');
  button('Triage with agent').click();
  await flush();
  expect(store.newTaskPrefillPrompt?.name).toBe('Triage 4 GitHub items');
  expect(store.newTaskPrefillPrompt?.githubUrl).toBeNull();
  expect(store.newTaskPrefillPrompt?.prompt).toContain('https://github.com/owner/repo/pull/9');
  expect(store.newTaskPrefillPrompt?.prompt).toContain('https://github.com/owner/repo/issues/10');
  expect(store.newTaskPrefillPrompt?.prompt).toContain('This is analysis only');
  expect(store.showNewTaskPanel).toBe(true);
});

it('shows PR details without issue close controls and prefills a PR review task', async () => {
  const pr = {
    ...issue,
    kind: 'pr' as const,
    url: 'https://github.com/owner/repo/pull/7',
    baseRefName: 'main',
    isCrossRepository: false,
  };
  vi.mocked(browseGitHubIssues).mockResolvedValue({ ...page, items: [pr] });
  vi.mocked(readGitHubIssue).mockResolvedValue(pr);
  mount();
  await flush();
  selectIssue();
  await flush();
  expect(document.body.textContent).not.toContain('Close issue');
  button('Review with agent').click();
  expect(store.newTaskPrefillPrompt?.githubPr).toMatchObject({
    kind: 'pr',
    number: 7,
    baseRefName: 'main',
  });
  expect(store.newTaskPrefillPrompt?.prompt).toContain('Review pull request #7');
});

it('opens the pane by itself when the project already has an agent task', async () => {
  setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
  mount();
  await flush();
  expect(host.querySelector('.github-agent')).not.toBeNull();
});

it('keeps the agent pane closed and starts no session until opened, then starts it at once', async () => {
  mount();
  await flush();
  expect(host.querySelector('.github-agent')).toBeNull();
  expect(ensureProjectAgentTask).not.toHaveBeenCalled();
  vi.mocked(ensureProjectAgentTask).mockImplementationOnce(() => {
    const task = { id: 'gh-agent-p1', projectId: 'p1' } as Task;
    setStore('tasks', task.id, task);
    return task;
  });
  button('Agent').click();
  expect(ensureProjectAgentTask).toHaveBeenCalledTimes(1);
  expect(ensureProjectAgentTask).toHaveBeenCalledWith(
    'gh-agent-p1',
    expect.objectContaining({ id: 'p1' }),
  );
  expect(host.querySelector('.github-agent')?.textContent).toContain('Agent pane for gh-agent-p1');
  expect(host.querySelector('.github-agent')?.textContent).not.toContain('Start agent');
  await flush();
  expect(triggerFocus).toHaveBeenCalledWith('gh-agent-p1:prompt');
  expect(ensureProjectAgentTask).toHaveBeenCalledTimes(1);
  button('Agent').click();
  expect(host.querySelector('.github-agent')).toBeNull();
  expect(store.githubIssuesProjectId).toBe('p1');
  expect(host.querySelector('.github-issue-row')).not.toBeNull();
});

it('shows a loading state, then the missing-agent reason', async () => {
  agentState.loaded = false;
  agentState.installed = false;
  mount();
  await flush();
  button('Agent').click();
  expect(host.querySelector('.github-agent')?.textContent).toContain('Loading agents');
  expect(host.querySelector('.github-agent')?.textContent).not.toContain('No agent is installed');
  dispose?.();
  agentState.loaded = true;
  mount();
  await flush();
  button('Agent').click();
  expect(host.querySelector('.github-agent')?.textContent).toContain('No agent is installed');
});

it('says the agent list failed instead of claiming none is installed', async () => {
  agentState.loaded = false;
  agentState.failed = true;
  agentState.installed = false;
  mount();
  await flush();
  button('Agent').click();
  const text = host.querySelector('.github-agent')?.textContent;
  expect(text).toContain('Could not load the agent list');
  expect(text).not.toContain('No agent is installed');
});

it('asks the agent panel to list the selected items', async () => {
  mount();
  await flush();
  button('Select page').click();
  button('List with agent').click();
  expect(prefillGitHubAgentPrompt).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'p1' }),
    expect.stringContaining(`github_list_publish:\n${issue.url}`),
  );
  expect(store.showNewTaskPanel).toBe(false);
});

it('explains in the opened pane that no agent is installed instead of starting one', async () => {
  agentState.installed = false;
  mount();
  await flush();
  button('Agent').click();
  expect(host.querySelector('.github-agent')?.textContent).toContain('No agent is installed');
  expect(ensureProjectAgentTask).not.toHaveBeenCalled();
});

it('disables "List with agent" and says why when no agent is installed', async () => {
  agentState.installed = false;
  mount();
  await flush();
  button('Select page').click();
  expect(button('List with agent').disabled).toBe(true);
  expect(host.textContent).toContain('Install a coding agent');
});

it('explains "List with agent" before and after a selection and when a session will start', async () => {
  mount();
  await flush();
  expect(button('List with agent').disabled).toBe(true);
  expect(host.textContent).toContain('Select items to list them.');
  button('Select page').click();
  expect(button('List with agent').disabled).toBe(false);
  expect(host.textContent).toContain('Starts the agent session and drafts a prompt.');
  setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
  await flush();
  expect(host.textContent).not.toContain('Starts the agent session');
});

it('selects a list published while the page shows a mixed-case repository', async () => {
  vi.mocked(browseGitHubIssues).mockResolvedValue({ ...page, repository: 'Owner/Repo' });
  vi.mocked(resolveGitHubRepository).mockResolvedValue('Owner/Repo');
  setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
  mount();
  await flush();
  await publishGitHubList('gh-agent-p1', {
    name: 'Top 10',
    groups: [{ name: 'Sync', items: [{ url: issue.url, title: issue.title, reason: 'R' }] }],
  });
  await flush();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Shown list"]')?.value).toBe('Top 10');
  expect(host.querySelector('section[aria-label="Agent list"]')).not.toBeNull();
});

it('selects a list published while the user was away once they return', async () => {
  setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
  setStore('githubIssuesProjectId', null);
  await publishGitHubList('gh-agent-p1', {
    name: 'Top 10',
    groups: [{ name: 'Sync', items: [{ url: issue.url, title: issue.title, reason: 'R' }] }],
  });
  setStore('githubIssuesProjectId', 'p1');
  mount();
  await flush();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Shown list"]')?.value).toBe('Top 10');
  expect(host.querySelector('section[aria-label="Agent list"]')).not.toBeNull();
});

it('shows a published agent list in place of search results', async () => {
  setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
  mount();
  await flush();
  await publishGitHubList('gh-agent-p1', {
    name: 'This week',
    groups: [
      { name: 'Sync', items: [{ url: issue.url, title: issue.title, reason: 'Data loss' }] },
    ],
  });
  await flush();
  const list = host.querySelector('section[aria-label="Agent list"]');
  expect(list?.textContent).toContain('1. Sync');
  expect(list?.textContent).toContain('Data loss');
  expect(host.querySelector('[aria-label="Search issues"]')).toBeNull();
  list?.querySelector<HTMLButtonElement>('.github-issue-row')?.click();
  await flush();
  expect(host.querySelector('.github-issues-detail h2')?.textContent).toBe(issue.title);
  const picker = host.querySelector<HTMLSelectElement>('[aria-label="Shown list"]');
  if (!picker) throw new Error('Missing list picker');
  picker.value = '';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(host.querySelector('section[aria-label="Agent list"]')).toBeNull();
  expect(host.querySelector('[aria-label="Search issues"]')).not.toBeNull();
});

describe('agent overlay on narrow pages', () => {
  const observers: { notify: (width: number) => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const key = (target: Element, name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
  };
  const inertPage = () => host.querySelector('.github-issues')?.hasAttribute('inert');
  async function openNarrow() {
    mount();
    await flush();
    observers[0].notify(600);
    button('Agent').click();
    await flush();
  }

  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          observers.push({
            disconnect: this.disconnect,
            notify: (width) =>
              callback([{ contentRect: { width } } as ResizeObserverEntry], this as never),
          });
        }
        observe() {}
        unobserve() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('makes the page inert only while the agent overlays it', async () => {
    await openNarrow();
    expect(inertPage()).toBe(true);
    observers[0].notify(1200);
    await flush();
    expect(inertPage()).toBe(false);
    expect(host.querySelector('.github-page-scrim')).toBeNull();
  });

  it('closes on scrim click and on Escape from the pane header', async () => {
    await openNarrow();
    host.querySelector<HTMLElement>('.github-page-scrim')?.click();
    await flush();
    expect(host.querySelector('.github-agent')).toBeNull();
    expect(inertPage()).toBe(false);
    button('Agent').click();
    await flush();
    key(button('Close agent panel'), 'Escape');
    await flush();
    expect(host.querySelector('.github-agent')).toBeNull();
  });

  it('leaves Escape typed into pane inputs alone', async () => {
    await openNarrow();
    const pane = host.querySelector('.github-agent');
    for (const tag of ['input', 'textarea']) {
      const field = document.createElement(tag);
      pane?.append(field);
      key(field, 'Escape');
    }
    await flush();
    expect(host.querySelector('.github-agent')).not.toBeNull();
  });

  it('moves focus into the pane, then back to the Agent toggle', async () => {
    await openNarrow();
    expect(document.activeElement).toBe(button('Close agent panel'));
    button('Close agent panel').click();
    await flush();
    expect(document.activeElement).toBe(button('Agent'));
  });

  it('focuses the prompt when the agent task exists', async () => {
    setStore('tasks', { 'gh-agent-p1': { id: 'gh-agent-p1', projectId: 'p1' } as Task });
    mount();
    await flush();
    observers[0].notify(600);
    await flush();
    expect(triggerFocus).toHaveBeenCalledWith('gh-agent-p1:prompt');
  });

  it('disconnects the observer on unmount', async () => {
    mount();
    await flush();
    dispose?.();
    dispose = undefined;
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
