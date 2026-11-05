import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { toggleGitHubIssues } from '../store/github-issues-target';
import { openKanban } from '../store/kanban';
import { setTaskProjectFilter } from '../store/navigation';
import { TaskBoardControls } from './TaskBoardControls';

let flakyCalls = 0;
// Only /github-repo and /unasked-repo resolve to a github.com repository.
const resolveRepository = vi.hoisted(() =>
  vi.fn(async (_channel: string, args: { projectRoot: string }) => {
    if (args.projectRoot === '/github-repo') return 'acme/api';
    // Kept for one test, as answers are cached for the whole file.
    if (args.projectRoot === '/unasked-repo') return 'acme/docs';
    // Fails once, as when offline, then answers.
    if (args.projectRoot === '/flaky' && flakyCalls++ > 0) return 'acme/web';
    throw new Error('not a github.com repository');
  }),
);
vi.mock('../lib/ipc', () => ({ invoke: resolveRepository }));

let dispose: (() => void) | undefined;

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskBoardControls />, host);
  return host;
}

function githubButton(host: HTMLElement): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('[aria-label="GitHub issues"]');
  if (!found) throw new Error('missing GitHub button');
  return found;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function planToggle(host: HTMLElement): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('[aria-label="Board page"] button');
  if (!found) throw new Error('missing plan toggle');
  return found;
}

beforeEach(() => {
  setStore({
    projects: [{ id: 'p1', name: 'weather-app', color: '#abc', path: '/w' }],
    taskProjectFilter: null,
    kanbanProjectId: null,
    githubIssuesProjectId: null,
    boardView: true,
    sidebarVisible: true,
    taskOrder: [],
    activeTaskId: null,
  });
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

describe('TaskBoardControls', () => {
  it("toggles between the running tasks and the selected project's plan", () => {
    const host = mount();
    expect(host.querySelector('[aria-label="Board page"]')).toBeNull();

    setTaskProjectFilter('p1');
    planToggle(host).click();
    expect(store.kanbanProjectId).toBe('p1');
    expect(planToggle(host).getAttribute('aria-pressed')).toBe('true');

    planToggle(host).click();
    expect(store.kanbanProjectId).toBeNull();
    expect(store.boardView).toBe(true);
    expect(store.taskProjectFilter).toBe('p1');
  });

  it('keeps the way back from a plan when the project filter is cleared under it', () => {
    const host = mount();
    openKanban('p1');
    // Activating another project's task clears the filter and leaves the plan open.
    setStore('taskProjectFilter', null);
    expect(planToggle(host).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers ideas on the running tasks only, where their lane is', () => {
    const host = mount();
    expect(host.querySelector('[aria-label="Add idea"]')).not.toBeNull();
    openKanban('p1');
    expect(host.querySelector('[aria-label="Add idea"]')).toBeNull();
  });

  it("opens a GitHub project's issues, disabled for the others", async () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/github-repo' });
    const host = mount();
    setTaskProjectFilter('p1');
    await settle();
    expect(githubButton(host).disabled).toBe(true);
    expect(githubButton(host).title).toBe('GitHub issues unavailable for weather-app');

    setTaskProjectFilter('p2');
    await settle();
    expect(githubButton(host).disabled).toBe(false);
    githubButton(host).click();
    expect(store.githubIssuesProjectId).toBe('p2');

    setStore('githubIssuesProjectId', null);
    setTaskProjectFilter('p1');
    setTaskProjectFilter('p2');
    await settle();
    // Asked once per project; the answer is kept.
    expect(
      resolveRepository.mock.calls.filter(([, a]) => a.projectRoot === '/github-repo'),
    ).toHaveLength(1);
  });

  it('with all projects, lets you pick the project from a menu', async () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/github-repo' });
    // The active task does not choose for you: a hidden target confused.
    setStore('tasks', { t1: { id: 't1', projectId: 'p2' } as never });
    setStore('activeTaskId', 't1');
    const host = mount();
    expect(githubButton(host).disabled).toBe(false);
    expect(githubButton(host).getAttribute('aria-haspopup')).toBe('menu');

    githubButton(host).click();
    await settle();
    const item = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (b) => b.textContent === name,
      );
    expect(item('weather-app')?.disabled).toBe(true);
    expect(item('weather-app')?.title).toBe('GitHub issues unavailable for weather-app');
    expect(item('api')?.disabled).toBe(false);
    item('api')?.click();
    expect(store.githubIssuesProjectId).toBe('p2');
  });

  it('keeps a menu entry, and its focus, while gh answers', async () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/unasked-repo' });
    const host = mount();
    githubButton(host).click();
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (b) => b.textContent === 'api',
    );
    expect(entry?.disabled).toBe(true);
    entry?.focus();

    await settle();
    expect(entry?.isConnected).toBe(true);
    expect(entry?.disabled).toBe(false);
    expect(document.activeElement).toBe(entry);
  });

  it('checks again later after a failed check, without blaming the project', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    setStore('projects', 1, { id: 'p2', name: 'web', color: '#def', path: '/flaky' });
    const host = mount();
    setTaskProjectFilter('p2');
    await settle();
    expect(githubButton(host).disabled).toBe(true);
    expect(githubButton(host).title).toBe('GitHub issues unavailable for web');

    setTaskProjectFilter('p1');
    now.mockReturnValue(1_000 + 60_000);
    setTaskProjectFilter('p2');
    await settle();
    expect(githubButton(host).disabled).toBe(false);
    now.mockRestore();
  });

  it('shows the project filter only while the sidebar, which has its own, is hidden', () => {
    const host = mount();
    expect(host.querySelector('.task-project-filter')).toBeNull();
    setStore('sidebarVisible', false);
    expect(host.querySelector('.task-project-filter')).not.toBeNull();
  });

  it('keeps a plan on the selected project, and shows the running tasks for all projects', () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/a' });
    openKanban('p1');
    expect(store.taskProjectFilter).toBe('p1');
    setTaskProjectFilter('p2');
    expect(store.kanbanProjectId).toBe('p2');

    setTaskProjectFilter(null);
    expect(store.kanbanProjectId).toBeNull();
    expect(store.boardView).toBe(true);
  });
});

describe('toggleGitHubIssues', () => {
  it('opens the project in context, prefers the selected one, and closes again', () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/github-repo' });
    setStore('tasks', {
      t1: { id: 't1', projectId: 'p2' },
      t2: { id: 't2', projectId: 'p1' },
    } as never);
    setStore('activeTaskId', 't1');
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBe('p2');
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBeNull();

    // The selected project wins over the active task's.
    setStore('activeTaskId', 't2');
    setTaskProjectFilter('p2');
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBe('p2');
  });

  it("prefers an open plan's project, and refuses a known non-GitHub project", async () => {
    setStore('projects', 1, { id: 'p2', name: 'api', color: '#def', path: '/github-repo' });
    openKanban('p2');
    // Activating another project's task clears the filter; the plan still names p2.
    setStore('taskProjectFilter', null);
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBe('p2');

    setStore('githubIssuesProjectId', null);
    setStore('kanbanProjectId', null);
    setTaskProjectFilter('p1');
    mount();
    await settle(); // the button's check learns /w is not on GitHub
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBeNull();
  });

  it('stays closed without a project or task', () => {
    toggleGitHubIssues();
    expect(store.githubIssuesProjectId).toBeNull();
  });
});
