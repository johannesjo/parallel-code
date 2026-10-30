import assert from 'node:assert/strict';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { store, setStore } from '../store/core';
import {
  jumpToTask,
  openPanelOrder,
  setTaskProjectFilter,
  setActiveTask,
  toggleNewTaskPanel,
} from '../store/navigation';
import { setTaskFocusedPanel } from '../store/focused-panel';
import {
  bringTaskToFront,
  sendTaskToBack,
  startBackgroundTaskWatcher,
} from '../store/background-tasks';
import { collapseTask, createTask } from '../store/tasks';
import {
  deletePanelUserSize,
  getPanelUserSize,
  getTaskViewportVisibility,
  setPanelUserSize,
} from '../store/ui';
import { TilingLayout } from './TilingLayout';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/tasks')>()),
  createTask: vi.fn(),
}));
vi.mock('../documents/DocumentWorkspacePanel', () => ({
  DocumentWorkspacePanel: () => <div>Document workspace</div>,
}));
vi.mock('./TaskPanel', () => ({ TaskPanel: () => <div>Existing task</div> }));
vi.mock('./TerminalPanel', () => ({
  TerminalPanel: () => <button>Existing terminal</button>,
}));

let dispose: (() => void) | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.GetBranches) return ['main'];
    if (channel === IPC.GetMainBranch) return 'main';
    if (channel === IPC.GetGitignoredDirs) return [];
    return false;
  });
  setStore({
    projects: [{ id: 'project', name: 'Project', path: '/repo', color: '#abc' }],
    availableAgents: [
      {
        id: 'agent',
        name: 'Agent',
        command: 'agent',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ],
    taskProjectFilter: null,
    taskOrder: [],
    collapsedTaskOrder: [],
    tasks: {},
    terminals: {},
    activeTaskId: null,
    activeDocumentProjectId: null,
    showNewTaskPanel: false,
    newTaskPanelFocused: false,
    focusMode: false,
    newTaskDropUrl: null,
    newTaskPrefillPrompt: null,
    defaultSkipPermissions: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <TilingLayout />, container);
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function openDraft() {
  toggleNewTaskPanel(true);
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
  await vi.waitFor(() =>
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false),
  );
  const prompt = container.querySelector('textarea');
  assert(prompt);
  return prompt;
}

it('keeps the active tile visible when a background task returns ahead of it', async () => {
  for (const id of ['returning', 'current', 'other']) {
    setStore('tasks', id, {
      id,
      name: id,
      projectId: 'project',
      branchName: id,
      worktreePath: `/repo/${id}`,
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
  }
  setStore('taskOrder', ['returning', 'current', 'other']);
  setActiveTask('returning');
  const stop = startBackgroundTaskWatcher();
  sendTaskToBack('returning');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const current = container.querySelector<HTMLElement>('[data-task-id="current"]');
  const returning = container.querySelector<HTMLElement>('[data-task-id="returning"]');
  const strip = container.querySelector<HTMLElement>('[data-tiling-strip]');
  assert(current && returning && strip);
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 1800 });
  Object.defineProperty(current, 'offsetWidth', { configurable: true, value: 600 });
  const currentScroll = vi.spyOn(current, 'scrollIntoView');
  const returningScroll = vi.spyOn(returning, 'scrollIntoView');
  try {
    setStore('tasks', 'returning', 'needsReview', true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(store.taskOrder).toEqual(['returning', 'current', 'other']);
    expect(store.activeTaskId).toBe('current');
    expect(currentScroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }));
    expect(returningScroll).not.toHaveBeenCalled();
  } finally {
    stop();
    bringTaskToFront('returning');
    currentScroll.mockRestore();
    returningScroll.mockRestore();
  }
});

it('recomputes which tiles are on screen when the project order changes', async () => {
  setStore('projects', [
    { id: 'project', name: 'Project', path: '/repo', color: '#abc' },
    { id: 'other', name: 'Other', path: '/other', color: '#def' },
  ]);
  for (const [id, projectId] of [
    ['first', 'project'],
    ['second', 'other'],
  ] as const) {
    setStore('tasks', id, {
      id,
      name: id,
      projectId,
      branchName: id,
      worktreePath: `/repo/${id}`,
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
  }
  setStore('taskOrder', ['first', 'second']);
  // One 100px tile fits; each tile sits at its DOM position.
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const tiles = [...container.querySelectorAll('[data-task-id]')];
      const left = this.dataset.taskId ? tiles.indexOf(this) * 100 : 0;
      return DOMRect.fromRect({ x: left, y: 0, width: 100, height: 100 });
    });
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(getTaskViewportVisibility('second')).toBe('offscreen-right');

    setStore('projects', (projects) => [...projects].reverse());
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(getTaskViewportVisibility('second')).toBe('visible');
    expect(getTaskViewportVisibility('first')).toBe('offscreen-right');
  } finally {
    rect.mockRestore();
  }
});

it('hides a snoozed tile from the strip but keeps it mounted until it returns', async () => {
  for (const id of ['snoozed', 'current']) {
    setStore('tasks', id, {
      id,
      name: id,
      projectId: 'project',
      branchName: id,
      worktreePath: `/repo/${id}`,
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
  }
  setStore('taskOrder', ['snoozed', 'current']);
  setActiveTask('snoozed');
  const stop = startBackgroundTaskWatcher();
  try {
    sendTaskToBack('snoozed', 1);
    // A visible snoozed tile woke on any click into it; a hidden one cannot be clicked.
    const tile = container.querySelector<HTMLElement>('[data-task-id="snoozed"]');
    assert(tile);
    expect(tile.parentElement?.style.display).toBe('none');
    jumpToTask(1);
    expect(store.activeTaskId).toBe('snoozed');
    expect(store.tasks.snoozed?.snoozedUntil).toBeUndefined();
    expect(container.querySelector('[data-task-id="snoozed"]')).toBe(tile);
    expect(tile.parentElement?.style.display).not.toBe('none');
  } finally {
    stop();
  }
});

it('says the tasks are snoozed rather than missing when every task is snoozed', () => {
  setStore('tasks', 'only', {
    id: 'only',
    name: 'only',
    projectId: 'project',
    branchName: 'only',
    worktreePath: '/repo/only',
    gitIsolation: 'worktree',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  });
  setStore('taskOrder', ['only']);
  setActiveTask('only');
  const stop = startBackgroundTaskWatcher();
  try {
    sendTaskToBack('only');
    expect(container.textContent).toContain('All tasks are snoozed');
    expect(container.textContent).not.toContain('No tasks yet');
  } finally {
    stop();
    bringTaskToFront('only');
  }
});

it('keeps focus inside a background tile that moves forward when selected', async () => {
  for (const id of ['current', 'returning']) {
    setStore('tasks', id, {
      id,
      name: id,
      projectId: 'project',
      branchName: id,
      worktreePath: `/repo/${id}`,
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
  }
  setStore('taskOrder', ['returning', 'current']);
  setActiveTask('returning');
  const stop = startBackgroundTaskWatcher();
  try {
    sendTaskToBack('returning');
    const tile = container.querySelector<HTMLElement>('[data-task-id="returning"]');
    assert(tile);
    // Stands in for the terminal the user clicks, which selects its task on focus.
    const input = document.createElement('textarea');
    tile.append(input);
    input.focus();
    setActiveTask('returning');
    expect(store.taskOrder).toEqual(['returning', 'current']);
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
  } finally {
    stop();
  }
});

describe('inline task creation', () => {
  it('hides add controls until the first task exists, including during its draft', async () => {
    expect(container.querySelector('[aria-label="New task"]')).toBeNull();
    expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
    await openDraft();
    expect(container.querySelector('[aria-label="New task"]')).toBeNull();
    expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Cancel')
      ?.click();
    expect(container.textContent).toContain('No tasks yet');
    expect(container.querySelector('[aria-label="New task"]')).toBeNull();

    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/test',
      worktreePath: '/repo/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    const addTask = container.querySelector<HTMLElement>('[aria-label="New task"]');
    const addTerminal = container.querySelector<HTMLElement>('[aria-label="New terminal"]');
    assert(addTask);
    assert(addTerminal);
    addTask.click();
    await openDraft();
    expect(container.querySelector('[aria-label="New task"]')).toBe(addTask);
    expect(container.querySelector('[aria-label="New terminal"]')).toBe(addTerminal);
    addTerminal.click();
    expect(store.taskOrder).toHaveLength(2);
    expect(store.terminals[store.taskOrder[1]]).toBeDefined();
    setStore('taskOrder', []);
    expect(container.querySelector('[aria-label="New task"]')).toBeNull();
    expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
  });

  it.each(['no projects', 'collapsed tasks', 'focus mode'])(
    'hides the add controls in an empty strip with %s',
    (state) => {
      if (state === 'no projects') setStore('projects', []);
      if (state === 'collapsed tasks') setStore('collapsedTaskOrder', ['collapsed']);
      if (state === 'focus mode') setStore('focusMode', true);
      expect(container.querySelector('[aria-label="New task"]')).toBeNull();
      expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
    },
  );

  it('starts with prompt, project, and agent, with advanced settings collapsed', async () => {
    const prompt = await openDraft();
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-nav-field]'));
    expect(sections.slice(0, 3).map((section) => section.dataset.navField)).toEqual([
      'prompt',
      'project',
      'agent',
    ]);
    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Advanced options'),
    );
    assert(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-nav-field="task-name"]')).toBeNull();
    expect(container.querySelector('[data-nav-field="base-branch"]')).toBeNull();
    prompt.focus();
    for (let step = 0; step < 3; step++) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
      );
    }
    expect(document.activeElement).toBe(toggle);
  });

  it('retains advanced settings when collapsed and includes them in task creation', async () => {
    await openDraft();
    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Advanced options'),
    );
    assert(toggle);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const name = container.querySelector<HTMLInputElement>('[data-nav-field="task-name"] input');
    assert(name);
    name.value = 'Custom task name';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    toggle.click();
    expect(container.querySelector('[data-nav-field="task-name"]')).toBeNull();
    vi.mocked(createTask).mockResolvedValueOnce('created-task');
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.showNewTaskPanel).toBe(false));
    expect(createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Custom task name' }),
    );
  });

  it('reveals advanced options when branch loading fails so Retry stays reachable', async () => {
    const originalInvoke = vi.mocked(invoke).getMockImplementation();
    assert(originalInvoke);
    vi.mocked(invoke).mockImplementation((channel, args) =>
      channel === IPC.GetBranches
        ? Promise.reject(new Error('Branch lookup failed'))
        : originalInvoke(channel, args),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      toggleNewTaskPanel(true);
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Couldn't load branches",
        ),
      );
      const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Advanced options'),
      );
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Retry',
        ),
      ).toBeDefined();
      vi.mocked(invoke).mockImplementation(originalInvoke);
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Retry')
        ?.click();
      await vi.waitFor(() =>
        expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(
          false,
        ),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps the skip-confirmation warning visible when advanced options are collapsed', async () => {
    setStore('availableAgents', 0, 'skip_permissions_args', ['--skip-permissions']);
    setStore('defaultSkipPermissions', true);
    await openDraft();
    expect(container.querySelector('[data-nav-field="skip-permissions"]')).toBeNull();
    expect(container.textContent).toContain('The agent will run without asking for confirmation.');
  });

  it('opens inside the task strip even when there are no tasks', async () => {
    const prompt = await openDraft();
    expect(prompt.closest('[data-tiling-strip]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(prompt);
    expect(store.newTaskPanelFocused).toBe(true);
    expect(container.textContent).not.toContain('No tasks yet');
  });

  it('keeps the draft while interacting with another column and scopes Alt+Arrow to the form', async () => {
    setStore('terminals', 'terminal', { id: 'terminal', name: 'Terminal', agentId: 'shell' });
    setStore('taskOrder', ['terminal']);
    const prompt = await openDraft();
    prompt.value = 'Keep this draft';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const other = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'Existing terminal',
    );
    assert(other);
    other.focus();
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    other.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(other);
    setStore('activeDocumentProjectId', 'documents');
    toggleNewTaskPanel(true);
    expect(store.activeDocumentProjectId).toBe('documents');
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(prompt.value).toBe('Keep this draft');
  });

  it('guards Escape with discard confirmation and resets after discard', async () => {
    const prompt = await openDraft();
    prompt.value = 'Unsaved prompt';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard draft?');
    const discard = Array.from(document.querySelectorAll('button')).find(
      (el) => el.textContent === 'Discard',
    );
    assert(discard);
    discard.click();
    expect(store.showNewTaskPanel).toBe(false);
    expect((await openDraft()).value).toBe('');
  });

  it('keeps a failed draft with its settings for the next New Task and retries it', async () => {
    const originalInvoke = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (channel, args) =>
      channel === IPC.GetBranches ? ['main', 'dev'] : originalInvoke?.(channel, args),
    );
    setStore('availableAgents', (agents) => [
      ...agents,
      { ...agents[0], id: 'other', name: 'Other' },
    ]);
    setStore('projects', 0, 'defaultBaseBranch', 'dev');
    const prompt = await openDraft();
    Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'))
      .find((el) => el.textContent?.includes('Other'))
      ?.click();
    prompt.value = 'Implement inline tasks';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    vi.mocked(createTask).mockRejectedValueOnce(new Error('Cannot create worktree'));
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(store.showNewTaskPanel).toBe(false);
    await vi.waitFor(() => expect(store.notification).toContain('Cannot create worktree'));
    // The failure must not pull focus into a reopened panel.
    expect(store.showNewTaskPanel).toBe(false);

    setStore('projects', 0, { defaultBaseBranch: 'main', defaultGitIsolation: 'direct' });
    expect((await openDraft()).value).toBe('Implement inline tasks');
    vi.mocked(createTask).mockResolvedValueOnce('created-task');
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPrompt: 'Implement inline tasks',
        projectId: 'project',
        baseBranch: 'dev',
        gitIsolation: 'worktree',
        agentDef: expect.objectContaining({ id: 'other' }),
      }),
    );
  });

  it('does not link another repository issue when a draft from another project is retried', async () => {
    const issue = 'https://github.com/other/repo/issues/7';
    setStore('projects', (projects) => [
      ...projects,
      { id: 'other', name: 'Other', path: '/other', color: '#cba' },
    ]);
    setStore('newTaskPrefillPrompt', {
      prompt: `Fix ${issue}`,
      projectId: 'other',
      githubUrl: issue,
    });
    await openDraft();
    const project = container.querySelector('select');
    assert(project);
    project.value = 'project';
    project.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(
        false,
      ),
    );
    vi.mocked(createTask).mockRejectedValueOnce(new Error('Cannot create worktree'));
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.notification).toContain('Cannot create worktree'));
    expect(createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project', githubUrl: undefined }),
    );

    await openDraft();
    vi.mocked(createTask).mockResolvedValueOnce('created-task');
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project', githubUrl: undefined }),
    );
  });

  it('leaves a newer draft alone when a slow creation fails and offers the failed one next', async () => {
    const first = await openDraft();
    first.value = 'First task';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    let fail!: (error: Error) => void;
    vi.mocked(createTask).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const next = await openDraft();
    next.value = 'Second task';
    next.dispatchEvent(new Event('input', { bubbles: true }));

    fail(new Error('Cannot create worktree'));
    await vi.waitFor(() => expect(store.notification).toContain('Cannot create worktree'));
    expect(container.querySelector('textarea')).toBe(next);
    expect(next.value).toBe('Second task');

    toggleNewTaskPanel(false);
    const restored = await openDraft();
    expect(restored.value).toBe('First task');
    // The queue held the only copy, so leaving it must ask first.
    restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.showNewTaskPanel).toBe(true);
    expect(
      Array.from(document.querySelectorAll('button')).some((el) => el.textContent === 'Discard'),
    ).toBe(true);
  });

  it('keeps the panel visible in focus mode without changing the preference', async () => {
    setStore('focusMode', true);
    await openDraft();
    expect(
      container.querySelector('[data-new-task-panel]')?.parentElement?.style.visibility,
    ).not.toBe('hidden');
    expect(store.focusMode).toBe(true);
    Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Cancel')
      ?.click();
    expect(store.showNewTaskPanel).toBe(false);
    expect(store.focusMode).toBe(true);
  });

  it('shows the draft alone in focus mode, the task behind it', async () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/test',
      worktreePath: '/repo/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    setActiveTask('task');
    await openDraft();
    const wrapperOf = (selector: string) =>
      container.querySelector(selector)?.parentElement?.style.visibility;
    expect(wrapperOf('[data-task-id="task"]')).not.toBe('hidden');

    setStore('focusMode', true);

    expect(wrapperOf('[data-new-task-panel]')).toBe('visible');
    expect(wrapperOf('[data-task-id="task"]')).toBe('hidden');
  });

  it('returns to the active task instantly when the draft is cancelled', async () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/test',
      worktreePath: '/repo/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    setActiveTask('task');
    await openDraft();

    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
    Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Cancel')
      ?.click();

    await vi.waitFor(() =>
      expect(scrollIntoView.mock.calls.length + scrollTo.mock.calls.length).toBeGreaterThan(0),
    );
    const scrollOptions = [...scrollIntoView.mock.calls, ...scrollTo.mock.calls].map(
      ([options]) => options,
    );
    expect(scrollOptions).toContainEqual(expect.objectContaining({ behavior: 'instant' }));
    expect(scrollOptions).not.toContainEqual(expect.objectContaining({ behavior: 'smooth' }));
    scrollIntoView.mockRestore();
    scrollTo.mockRestore();
  });

  it('keeps the draft in view when it opens in an unfocused window', async () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/test',
      worktreePath: '/repo/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    setActiveTask('task');
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // A link dragged in from another app leaves the window unfocused, and
    // Chromium then withholds focus events, so the draft never reports focus.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
    toggleNewTaskPanel(true);
    // Fixed frames rather than vi.waitFor: this asserts an absence, and polling
    // could stop on the draft's scroll before the active task's scroll lands.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // The draft scrolls in instantly; a smooth scroll is the active task pulling
    // the strip back to it.
    const scrollOptions = [...scrollIntoView.mock.calls, ...scrollTo.mock.calls].map(
      ([options]) => options,
    );
    expect(scrollOptions).toContainEqual(expect.objectContaining({ behavior: 'instant' }));
    expect(scrollOptions).not.toContainEqual(expect.objectContaining({ behavior: 'smooth' }));
    focus.mockRestore();
    scrollIntoView.mockRestore();
    scrollTo.mockRestore();
  });

  it('does not scroll to the active task while the draft holds focus in an unfocused window', async () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/test',
      worktreePath: '/repo/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    setActiveTask('task');
    const prompt = await openDraft();
    expect(document.activeElement).toBe(prompt);

    // Chromium withholds the draft's focus events until the window regains
    // focus, so the store flag lags DOM focus.
    setStore('newTaskPanelFocused', false);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
    setTaskFocusedPanel('task', 'notes');
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    hasFocus.mockRestore();
    scrollIntoView.mockRestore();
    scrollTo.mockRestore();
  });

  it('lets the next draft start while a slow creation is pending', async () => {
    await openDraft();
    let finish!: (taskId: string) => void;
    vi.mocked(createTask).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const form = container.querySelector('form');
    assert(form);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(store.showNewTaskPanel).toBe(false);
    const next = await openDraft();
    expect(next.value).toBe('');
    finish('created-task');
    await Promise.resolve();
    expect(createTask).toHaveBeenCalledOnce();
    expect(store.showNewTaskPanel).toBe(true);
  });

  it('keeps typing focus in the draft when the first task arrives beside it', async () => {
    const prompt = await openDraft();
    prompt.focus();
    setStore('tasks', 'first', {
      id: 'first',
      name: 'First',
      projectId: 'project',
      branchName: 'task/first',
      worktreePath: '/repo/first',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['first']);
    await vi.waitFor(() =>
      expect(container.querySelector('[data-task-id="first"]')).not.toBeNull(),
    );
    expect(document.activeElement).toBe(prompt);
  });

  it('prefills immediately and does not reclaim focus when agent discovery finishes', async () => {
    const agents = [...store.availableAgents];
    let resolveAgents!: (value: typeof agents) => void;
    const pending = new Promise<typeof agents>((resolve) => {
      resolveAgents = resolve;
    });
    const originalInvoke = vi.mocked(invoke).getMockImplementation();
    assert(originalInvoke);
    vi.mocked(invoke).mockImplementation((channel, args) =>
      channel === IPC.ListAgents ? pending : originalInvoke(channel, args),
    );
    setStore('availableAgents', []);
    setStore('newTaskPrefillPrompt', { prompt: 'Compare these results', projectId: 'project' });
    toggleNewTaskPanel(true);
    const prompt = container.querySelector('textarea');
    assert(prompt);
    expect(prompt.value).toBe('Compare these results');
    prompt.value = 'Edited comparison';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(store.newTaskPanelFocused).toBe(false);
    resolveAgents(agents);
    await vi.waitFor(() =>
      expect(container.querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull(),
    );
    expect(prompt.value).toBe('Edited comparison');
    expect(document.activeElement).toBe(outside);
  });
});

describe('inline document workspace', () => {
  it('keeps coding and document panels mounted when focus changes', () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: '',
      worktreePath: '/repo',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', ['task']);
    setStore('activeDocumentProjectId', 'docs');
    setActiveTask('doc-agent-docs');
    const code = container.querySelector<HTMLElement>('[data-task-id="task"]');
    const doc = container.querySelector<HTMLElement>('[data-task-id="doc-agent-docs"]');
    assert(code);
    assert(doc);
    expect(doc.textContent).toContain('Document workspace');
    expect(code.parentElement?.style.visibility).not.toBe('hidden');
    setStore('focusMode', true);
    expect(code.parentElement?.style.visibility).toBe('hidden');
    // Hidden panes must also skip rendering so xterm pauses their repaints.
    expect(code.parentElement?.style.getPropertyValue('content-visibility')).toBe('hidden');
    expect(doc.parentElement?.style.visibility).toBe('visible');
    expect(doc.parentElement?.style.getPropertyValue('content-visibility')).toBe('visible');
    setActiveTask('task');
    expect(code.parentElement?.style.visibility).toBe('visible');
    expect(doc.parentElement?.style.visibility).toBe('hidden');
    expect(container.querySelector('[data-task-id="doc-agent-docs"]')).toBe(doc);
    setStore('focusMode', false);
    expect(doc.parentElement?.style.visibility).not.toBe('hidden');
    setStore('activeDocumentProjectId', 'other-docs');
    expect(container.querySelector('[data-task-id="doc-agent-other-docs"]')).toBe(doc);
    setStore('activeDocumentProjectId', null);
    expect(container.querySelector('[data-task-id="doc-agent-other-docs"]')).toBeNull();
    expect(container.querySelector('[data-task-id="task"]')).toBe(code);
  });

  it('shows a document without coding tasks, including in focus mode without an agent', () => {
    setStore('activeDocumentProjectId', 'docs');
    setActiveTask('doc-agent-docs');
    setStore('focusMode', true);
    expect(store.activeTaskId).toBe('doc-agent-docs');
    expect(container.textContent).not.toContain('No tasks yet');
    const doc = container.querySelector<HTMLElement>('[data-task-id="doc-agent-docs"]');
    expect(doc?.parentElement?.style.visibility).toBe('visible');
  });
});

describe('task column resizing', () => {
  beforeEach(() => {
    deletePanelUserSize(['tiling:terminal', 'tiling:task']);
    setStore('terminals', 'terminal', { id: 'terminal', name: 'Terminal', agentId: 'shell' });
    setStore('taskOrder', ['terminal']);
    setStore('activeTaskId', 'terminal');
  });

  function startDrag() {
    const handle = container.querySelector('.resize-handle-h');
    assert(handle);
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200 }));
  }

  it('starts at the visible minimum width when the saved width is too small', () => {
    setPanelUserSize('tiling:terminal', 100);
    startDrag();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 210 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(getPanelUserSize('tiling:terminal')).toBe(310);
  });

  it('sizes an undragged task column for its canvas without pinning it', () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: '',
      worktreePath: '/repo',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      canvasOpen: true,
    });
    setStore('taskOrder', ['task']);
    const columnWidth = () =>
      container.querySelector<HTMLElement>('[data-task-id="task"]')?.parentElement?.style.width;
    expect(columnWidth()).toBe('920px');
    setStore('tasks', 'task', 'canvasOpen', false);
    expect(columnWidth()).toBe('520px');
    expect(getPanelUserSize('tiling:task')).toBeUndefined();
  });

  it('fits side-by-side agents and pins from that width when dragged', () => {
    setStore('tasks', 'task', {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: '',
      worktreePath: '/repo',
      agentIds: ['agent-a', 'agent-b'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      canvasOpen: false,
    });
    setStore('taskOrder', ['task']);
    const column = container.querySelector<HTMLElement>('[data-task-id="task"]')?.parentElement;
    expect(column?.style.width).toBe('840px');
    expect(getPanelUserSize('tiling:task')).toBeUndefined();
    startDrag();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 210 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(getPanelUserSize('tiling:task')).toBe(850);
  });

  it('does not pin a column on a click without movement', () => {
    startDrag();
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(getPanelUserSize('tiling:terminal')).toBeUndefined();
  });

  it.each(['blur', 'unmount', 'focus mode', 'remove panel'])('cancels a drag on %s', (reason) => {
    startDrag();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 240 }));
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    if (reason === 'unmount') dispose?.();
    if (reason === 'focus mode') setStore('focusMode', true);
    if (reason === 'remove panel') setStore('taskOrder', []);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 280 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(getPanelUserSize('tiling:terminal')).toBeUndefined();
    expect(container.querySelector('.resize-handle.dragging')).toBeNull();
  });
});

it('filters projects without unmounting panels and keeps navigation in the selected project', async () => {
  setStore('projects', [
    { id: 'one', name: 'One', path: '/one', color: '#abc' },
    { id: 'two', name: 'Two', path: '/two', color: '#def' },
  ]);
  for (const id of ['one', 'two']) {
    setStore('tasks', id, {
      id,
      name: id,
      projectId: id,
      branchName: id,
      worktreePath: `/${id}`,
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
  }
  setStore('taskOrder', ['one', 'two']);
  setActiveTask('one');
  const one = container.querySelector('[data-task-id="one"]');
  const two = container.querySelector('[data-task-id="two"]');
  assert(one && two);
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
  const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
  setTaskProjectFilter('two');
  await new Promise(requestAnimationFrame);
  const scrollOptions = [...scrollIntoView.mock.calls, ...scrollTo.mock.calls].map(
    (call) => call[0] as ScrollToOptions | undefined,
  );
  expect(scrollOptions.length).toBeGreaterThan(0);
  expect(scrollOptions.every((options) => options?.behavior === 'instant')).toBe(true);
  scrollIntoView.mockRestore();
  scrollTo.mockRestore();
  expect(one.parentElement?.style.display).toBe('none');
  expect(two.parentElement?.style.display).not.toBe('none');
  expect(store.activeTaskId).toBe('two');
  expect(openPanelOrder()).toEqual(['two']);
  setTaskProjectFilter(null);
  expect(container.querySelector('[data-task-id="one"]')).toBe(one);
  expect(one.parentElement?.style.display).not.toBe('none');
  expect(openPanelOrder()).toEqual(['one', 'two']);
  setTaskProjectFilter('two');
  setActiveTask('one');
  expect(store.taskProjectFilter).toBeNull();
  setTaskProjectFilter('two');
  await collapseTask('two');
  expect(store.activeTaskId).toBeNull();
  expect(store.taskProjectFilter).toBe('two');
  expect(openPanelOrder()).toEqual([]);
  setTaskProjectFilter('one');
  expect(store.activeTaskId).toBe('one');
});
