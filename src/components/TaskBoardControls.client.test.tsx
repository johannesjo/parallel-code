import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { openKanban } from '../store/kanban';
import { setTaskProjectFilter } from '../store/navigation';
import { TaskBoardControls } from './TaskBoardControls';

let flakyCalls = 0;
// Only /github-repo resolves to a github.com repository.
const resolveRepository = vi.hoisted(() =>
  vi.fn(async (_channel: string, args: { projectRoot: string }) => {
    if (args.projectRoot === '/github-repo') return 'acme/api';
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
    expect(host.querySelector('[aria-label="GitHub issues"]')).toBeNull();

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
    expect(host.querySelector('[aria-label="GitHub issues"]')).toBeNull();
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
