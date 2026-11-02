import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { retryTeleportInRepo, toggleNewTaskPanel } from '../store/navigation';
import { clearNotification } from '../store/notification';
import { openBeside } from './board/TaskStatus';
import { NewTaskPanel } from './NewTaskPanel';
import { effortInArgs, modelInArgs } from '../lib/agent-args';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let host: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.GetBranches) return ['main'];
    if (channel === IPC.GetMainBranch) return 'main';
    if (channel === IPC.GetGitignoredDirs) return [];
    if (channel === IPC.CheckDockerAvailable) return false;
    return undefined;
  });
  clearNotification();
  setStore('tasks', reconcile({}));
  setStore({
    newTaskPrefillPrompt: null,
    lastTeleportProjectId: null,
    mcpOrchestrationEnabled: true,
    projects: [{ id: 'project', name: 'Project', path: '/project', color: '#abc' }],
    availableAgents: [
      {
        id: 'agent',
        name: 'Agent',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: ['--dangerously-skip-permissions'],
        description: '',
      },
    ],
    showNewTaskPanel: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
});

afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function deferCreateTask(): {
  resolve: (id: string) => void;
  reject: (error: Error) => void;
} {
  const deferred = {} as { resolve: (id: string) => void; reject: (error: Error) => void };
  const pending = new Promise((resolve, reject) => {
    deferred.resolve = (id) =>
      resolve({ id, branch_name: `task/${id}`, worktree_path: `/project/.worktrees/${id}` });
    deferred.reject = reject;
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask ? pending : Promise.resolve(originalInvoke?.(channel, args)),
  );
  return deferred;
}

function typePrompt(text: string): void {
  const prompt = host.querySelector('textarea');
  if (!prompt) throw new Error('Missing prompt editor');
  prompt.value = text;
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
}

it('keeps the draft of a creation that fails before the panel finishes closing', async () => {
  const pendingClose: (() => void)[] = [];
  Object.defineProperty(document, 'startViewTransition', {
    value: (update: () => void) => {
      pendingClose.push(update);
      return { ready: Promise.resolve() };
    },
    configurable: true,
  });
  try {
    const form = host.querySelector('form');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    await vi.waitFor(() => expect(submit?.disabled).toBe(false));
    const creation = deferCreateTask();
    typePrompt('Prepare a lot');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    creation.reject(new Error('Worktree creation failed'));
    await vi.waitFor(() => expect(store.notification).toContain('Worktree creation failed'));
    pendingClose.forEach((update) => update());
    expect(store.showNewTaskPanel).toBe(false);

    toggleNewTaskPanel(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({
      prompt: 'Prepare a lot',
      projectId: 'project',
      agentId: 'agent',
    });
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});

it('sets the draft aside when a board task is opened in its place', () => {
  setStore('tasks', 'other', {
    id: 'other',
    name: 'Other',
    projectId: 'project',
    branchName: 'task/other',
    worktreePath: '/project/other',
    gitIsolation: 'worktree',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  });
  setStore('boardView', true);
  try {
    typePrompt('Half a thought');
    openBeside(store.tasks.other);
    expect(store.showNewTaskPanel).toBe(false);
    expect(store.activeTaskId).toBe('other');

    toggleNewTaskPanel(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({
      prompt: 'Half a thought',
      projectId: 'project',
      agentId: 'agent',
      gitIsolation: 'worktree',
    });
  } finally {
    setStore({ boardView: false, boardPeek: false });
  }
});

it('announces a slow task instead of taking focus from where the user went', async () => {
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const creation = deferCreateTask();
  setStore('activeTaskId', null);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(store.showNewTaskPanel).toBe(false);
    vi.advanceTimersByTime(500);
    expect(store.notification).toContain('Creating');

    creation.resolve('slow');
    await vi.waitFor(() => expect(store.tasks.slow).toBeDefined());
    expect(store.activeTaskId).toBeNull();
    expect(store.notification).toContain('is ready');
  } finally {
    vi.useRealTimers();
  }
});

it('takes the user to a task that is created quickly', async () => {
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const creation = deferCreateTask();
  setStore('activeTaskId', null);

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  creation.resolve('quick');
  await vi.waitFor(() => expect(store.activeTaskId).toBe('quick'));
});

it('creates a linked task from the editable canvas assignment with the source branch and selected agent', async () => {
  dispose();
  host.replaceChildren();
  setStore('tasks', 'parent', {
    id: 'parent',
    name: 'Parent',
    projectId: 'project',
    branchName: 'task/parent',
    worktreePath: '/project/parent',
    gitIsolation: 'worktree',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  });
  setStore('newTaskPrefillPrompt', {
    name: 'Canvas assignment',
    prompt: 'Saved branch requirements',
    projectId: 'project',
    baseBranch: 'task/parent',
    canvasSource: {
      taskId: 'parent',
      canvas: 'reasoning',
      agentId: 'owner-agent',
      runId: 'run-1',
      nodeId: 'work',
    },
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.GetBranches) return Promise.resolve(['main', 'task/parent']);
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'child',
        branch_name: 'task/child',
        worktree_path: '/project/child',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const prompt = host.querySelector('textarea');
  expect(prompt?.value).toBe('Saved branch requirements');
  if (!prompt) throw new Error('Missing prompt editor');
  prompt.value = 'User revised assignment';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks.child).toBeDefined());
  expect(invoke).toHaveBeenCalledWith(
    IPC.CreateTask,
    expect.objectContaining({ name: 'Canvas assignment', baseBranch: 'task/parent' }),
  );
  expect(store.tasks.child.savedInitialPrompt).toBe('User revised assignment');
  expect(store.agents[store.tasks.child.agentIds[0]].def.id).toBe('agent');
  expect(store.tasks.parent.canvasTaskLinks).toEqual([
    expect.objectContaining({
      canvas: 'reasoning',
      agentId: 'owner-agent',
      runId: 'run-1',
      nodeId: 'work',
      taskId: 'child',
    }),
  ]);
  expect(store.showNewTaskPanel).toBe(false);
  expect(store.newTaskPrefillPrompt).toBeNull();
});

function openAdvanced(): void {
  const button = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Advanced options'),
  );
  if (!button) throw new Error('Missing advanced options');
  button.click();
}

function checkbox(label: string): HTMLInputElement {
  const input = [...host.querySelectorAll('label')]
    .find((element) => element.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error(`Missing ${label} checkbox`);
  return input;
}

it('offers opt-in automation on ordinary tasks without a coordinator mode', async () => {
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  expect(host.textContent).not.toContain('Coordinator mode');
  expect(host.textContent).toContain('Agent automation');
  expect(checkbox('Automatically merge completed child tasks').checked).toBe(false);
  expect(checkbox('Automatically send child updates').checked).toBe(false);
  checkbox('Automatically merge completed child tasks').click();
  checkbox('Automatically send child updates').click();
  const limit = host.querySelector<HTMLInputElement>(
    '[data-nav-field="agent-automation"] input[type="number"]',
  );
  if (!limit) throw new Error('Missing concurrency limit');
  limit.value = '7';
  limit.dispatchEvent(new Event('input', { bubbles: true }));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask
      ? Promise.resolve({
          id: 'automated',
          branch_name: 'task/automated',
          worktree_path: '/project/automated',
        })
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks.automated).toBeDefined());
  expect(store.tasks.automated.autoMergeChildren).toBe(true);
  expect(store.tasks.automated.autoSendChildUpdates).toBe(true);
  expect(store.tasks.automated.maxConcurrentTasks).toBe(7);
  expect(store.tasks.automated.coordinatorMode).toBeUndefined();
});

it('hides automation when orchestration is disabled', async () => {
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  setStore('mcpOrchestrationEnabled', false);
  expect(host.textContent).not.toContain('Agent automation');
});

it('hides automation for an unsupported agent', async () => {
  dispose();
  host.replaceChildren();
  setStore('availableAgents', 0, 'command', 'custom-agent');
  dispose = render(() => <NewTaskPanel open onClose={vi.fn()} />, host);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  expect(host.textContent).not.toContain('Agent automation');
});

it('omits automation selected before switching to the current branch', async () => {
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  checkbox('Automatically merge completed child tasks').click();
  checkbox('Automatically send child updates').click();
  const direct = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Current Branch',
  );
  if (!direct) throw new Error('Missing current branch option');
  direct.click();
  expect(host.textContent).not.toContain('Agent automation');
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const directTask = () =>
    Object.values(store.tasks).find((task) => task.gitIsolation === 'direct');
  await vi.waitFor(() => expect(directTask()).toBeDefined());
  expect(directTask()?.autoMergeChildren).toBeUndefined();
  expect(directTask()?.autoSendChildUpdates).toBeUndefined();
  expect(directTask()?.maxConcurrentTasks).toBeUndefined();
});

it('checks out a picked PR while keeping the text the user typed', async () => {
  const pr = {
    kind: 'pr',
    number: 7,
    title: 'Fix login',
    url: 'https://github.com/o/r/pull/7',
    author: 'dev',
    updatedAt: '2026-10-01T00:00:00Z',
    labels: [],
    isDraft: false,
    baseRefName: 'main',
    isCrossRepository: false,
  };
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.ListGitHubWorkItems) return Promise.resolve([pr]);
    if (channel === IPC.CreatePrTask)
      return Promise.resolve({
        id: 'pr-task',
        branch_name: 'fix-login',
        worktree_path: '/project/.worktrees/fix-login',
        pr_url: pr.url,
        base_branch: 'main',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const prompt = host.querySelector('textarea');
  if (!prompt) throw new Error('Missing prompt editor');
  prompt.value = 'Also check perf';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));

  const pickPr = async () => {
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'From GitHub…');
    open?.click();
    await vi.waitFor(() => expect(host.querySelector('.github-item-option')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('.github-item-option')?.click();
  };
  await pickPr();
  // Picking again replaces the generated text instead of stacking it.
  await pickPr();
  expect(prompt.value).toBe(
    'Review pull request #7: Fix login\nhttps://github.com/o/r/pull/7\n\nAlso check perf',
  );
  expect(host.textContent).toContain('Checks out PR #7 (base main).');

  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      IPC.CreatePrTask,
      expect.objectContaining({ projectRoot: '/project', prNumber: 7 }),
    ),
  );
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.CreateTask)).toBe(false);
});

it('offers a picked PR again when its checkout fails', async () => {
  const pr = {
    kind: 'pr',
    number: 7,
    title: 'Fix login',
    url: 'https://github.com/o/r/pull/7',
    author: 'dev',
    updatedAt: '2026-10-01T00:00:00Z',
    labels: [],
    isDraft: false,
    baseRefName: 'main',
    isCrossRepository: false,
  };
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.ListGitHubWorkItems) return Promise.resolve([pr]);
    if (channel === IPC.CreatePrTask) return Promise.reject(new Error('PR fetch failed'));
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'From GitHub…')?.click();
  await vi.waitFor(() => expect(host.querySelector('.github-item-option')).not.toBeNull());
  host.querySelector<HTMLButtonElement>('.github-item-option')?.click();
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.notification).toContain('PR fetch failed'));

  toggleNewTaskPanel(true);
  expect(store.newTaskPrefillPrompt?.githubPr).toMatchObject({ number: 7 });
});

it('shows the busy overlay while a direct task switches branches', async () => {
  dispose();
  host.replaceChildren();
  setStore('projects', 0, 'defaultGitIsolation', 'direct');
  let switched!: (branch: string) => void;
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.GetCurrentBranch
      ? new Promise((resolve) => (switched = resolve))
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(switched).toBeTypeOf('function'));
  expect(form?.inert).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Creating task…');
  expect(store.showNewTaskPanel).toBe(true);
  switched('main');
  await vi.waitFor(() => expect(store.showNewTaskPanel).toBe(false));
});

it('preserves the browser issue link when the user rewrites the task prompt', async () => {
  dispose();
  const issueUrl = 'https://github.com/owner/repo/issues/42';
  setStore('newTaskPrefillPrompt', {
    projectId: 'project',
    name: '#42 Fix save',
    prompt: `Resolve issue\n${issueUrl}`,
    githubUrl: issueUrl,
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'issue-task',
        branch_name: 'fix-save',
        worktree_path: '/project/.worktrees/fix-save',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const prompt = host.querySelector('textarea');
  if (!prompt) throw new Error('Missing prompt editor');
  prompt.value = 'My customized plan without a URL';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.textContent).not.toContain('From GitHub…');
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks['issue-task']).toBeDefined());
  expect(store.tasks['issue-task'].githubUrl).toBe(issueUrl);
  expect(store.tasks['issue-task'].initialPrompt).toBe('My customized plan without a URL');
});

it('opens a browser PR review on the PR branch', async () => {
  dispose();
  const pr = {
    kind: 'pr' as const,
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'Fix save',
    author: 'dev',
    labels: [],
    updatedAt: '',
    baseRefName: 'main',
    isCrossRepository: false,
  };
  setStore('newTaskPrefillPrompt', {
    projectId: 'project',
    name: '#7 Fix save',
    prompt: 'Review this PR',
    githubUrl: pr.url,
    githubPr: pr,
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreatePrTask)
      return Promise.resolve({
        id: 'browser-pr',
        branch_name: 'fix-save',
        worktree_path: '/project/.worktrees/fix-save',
        pr_url: pr.url,
        base_branch: 'main',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  expect(host.textContent).toContain('Checks out PR #7');
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      IPC.CreatePrTask,
      expect.objectContaining({ prNumber: 7, projectRoot: '/project' }),
    ),
  );
});

it('checks out a browser PR in a worktree even when the project defaults to direct mode', async () => {
  dispose();
  setStore('projects', 0, 'defaultGitIsolation', 'direct');
  const pr = {
    kind: 'pr' as const,
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'Fix save',
    author: 'dev',
    labels: [],
    updatedAt: '',
    baseRefName: 'main',
    isCrossRepository: false,
  };
  setStore('newTaskPrefillPrompt', {
    projectId: 'project',
    name: '#7 Fix save',
    prompt: 'Review this PR',
    githubUrl: pr.url,
    githubPr: pr,
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreatePrTask)
      return Promise.resolve({
        id: 'direct-default-pr',
        branch_name: 'fix-save',
        worktree_path: '/project/.worktrees/fix-save',
        pr_url: pr.url,
        base_branch: 'main',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.CreatePrTask, expect.objectContaining({ prNumber: 7 })),
  );
  expect(invoke).not.toHaveBeenCalledWith(IPC.CheckoutBranch, expect.anything());
});

it('does not attach a batch triage task to the first URL in its prompt', async () => {
  dispose();
  setStore('newTaskPrefillPrompt', {
    projectId: 'project',
    name: 'Triage 2 GitHub items',
    prompt: 'Triage https://github.com/o/r/issues/1 and https://github.com/o/r/issues/2',
    githubUrl: null,
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'batch-triage',
        branch_name: 'triage',
        worktree_path: '/project/.worktrees/triage',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks['batch-triage']).toBeDefined());
  expect(store.tasks['batch-triage'].githubUrl).toBeUndefined();
});

it('re-detects agents and explains how to install one when none is found', async () => {
  dispose();
  host.replaceChildren();
  const missing = (id: string, command: string) => ({
    id,
    name: id,
    command,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
    available: false,
  });
  const detected = [missing('Claude Code', 'claude'), missing('Codex CLI', 'codex')];
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.ListAgents
      ? Promise.resolve(detected)
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  setStore({ availableAgents: detected, lastAgentId: null, customAgents: [] });

  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);

  await vi.waitFor(() => expect(host.textContent).toContain('No coding agent CLI found'));
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.ListAgents)).toBe(true);

  // With one agent installed, choosing a missing one names what is missing.
  setStore('availableAgents', 1, 'available', true);
  host.querySelector<HTMLButtonElement>('button[role="radio"]')?.click();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Claude Code was not found on this machine'),
  );
});

it('cannot submit again while the panel close after creation is pending', async () => {
  const pending: (() => void)[] = [];
  Object.defineProperty(document, 'startViewTransition', {
    value: (update: () => void) => {
      pending.push(update);
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    },
    configurable: true,
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask
      ? Promise.resolve({
          id: 'once',
          branch_name: 'once',
          worktree_path: '/project/.worktrees/once',
        })
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  try {
    await vi.waitFor(() => expect(submit?.disabled).toBe(false));
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The task exists and the close waits for its view transition.
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(
      vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.CreateTask),
    ).toHaveLength(1);
    pending.forEach((update) => update());
    expect(store.showNewTaskPanel).toBe(false);
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});

it('leaves the form undimmed while a worktree task hands off to the background', async () => {
  const pendingClose: (() => void)[] = [];
  Object.defineProperty(document, 'startViewTransition', {
    value: (update: () => void) => {
      pendingClose.push(update);
      return { ready: Promise.resolve() };
    },
    configurable: true,
  });
  try {
    const form = host.querySelector('form');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    await vi.waitFor(() => expect(submit?.disabled).toBe(false));
    deferCreateTask();
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The view transition captures this frame as the old layout.
    expect(form?.inert).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(form?.style.opacity).toBe('1');
    pendingClose.forEach((update) => update());
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});

it('adds risk warnings below the options that cause them', async () => {
  setStore('defaultSkipPermissions', false);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  const skip = checkbox('Dangerously skip all confirms');
  skip.click();
  const warning = [...host.querySelectorAll('div')].find((div) =>
    div.textContent?.startsWith('The agent will run without asking'),
  );
  if (!warning) throw new Error('Missing skip-permissions warning');
  expect(skip.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('names the branch a direct task will work on', async () => {
  dispose();
  host.replaceChildren();
  setStore('projects', 0, { defaultGitIsolation: 'direct', defaultBaseBranch: 'develop' });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  openAdvanced();
  expect(host.textContent).not.toContain('main branch (detected on create)');
  expect(host.querySelector('[data-direct-target]')?.textContent).toContain('develop');
});

it('says why Create Task is disabled while branches load', async () => {
  dispose();
  host.replaceChildren();
  let loaded!: (branches: string[]) => void;
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.GetBranches
      ? new Promise((resolve) => (loaded = resolve))
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const reason = host.querySelector<HTMLElement>('[data-submit-reason]');
  await vi.waitFor(() => expect(loaded).toBeTypeOf('function'));
  expect(reason?.textContent).toBe('Loading branches…');
  expect(reason?.style.visibility).toBe('visible');
  loaded(['main']);
  await vi.waitFor(() => expect(reason?.style.visibility).toBe('hidden'));
});

it('shows the submit shortcut on the Create Task button', () => {
  expect(host.querySelector('button[type="submit"] kbd')?.textContent).toMatch(/(Ctrl|⌘)/);
});

it('announces a submit error', async () => {
  dispose();
  host.replaceChildren();
  setStore('projects', 0, 'defaultGitIsolation', 'direct');
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.GetCurrentBranch) return Promise.resolve('other');
    if (channel === IPC.CheckoutBranch) return Promise.reject(new Error('dirty tree'));
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('dirty tree'),
  );
});

it('offers the split tip once, after a pause on a long prompt', async () => {
  dispose();
  host.replaceChildren();
  vi.useFakeTimers();
  // happy-dom lays nothing out; the tip only shows beside a visible anchor.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, window.innerWidth, window.innerHeight),
  );
  setStore({ featureHintsEnabled: true, seenFeatureHints: [], taskOrder: ['other'] });
  try {
    dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    const tip = () => document.querySelector('[role="note"]');
    vi.advanceTimersByTime(3000);
    expect(tip()).toBeNull();

    typePrompt(
      'Rework the settings dialog: split it into tabs, move the shortcuts, and add search.',
    );
    vi.advanceTimersByTime(3000);
    expect(tip()?.textContent).toContain('Add split request');

    typePrompt(
      'Rework the settings dialog: split it into tabs, move the shortcuts, and add search!',
    );
    vi.advanceTimersByTime(3000);
    expect(tip()).toBeNull();
    expect(store.seenFeatureHints).toContain('delegate-subtasks');
  } finally {
    dispose();
    vi.runAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    setStore({ featureHintsEnabled: true, seenFeatureHints: [], taskOrder: [] });
  }
});

function submitTask(id: string): void {
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask
      ? Promise.resolve({ id, branch_name: `task/${id}`, worktree_path: `/project/${id}` })
      : Promise.resolve(originalInvoke?.(channel, args)),
  );
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function pickMenuRow(group: string, label: string): void {
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Task model"]');
  if (!trigger) throw new Error('Missing task model menu');
  trigger.click();
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>(
      `[role="group"][aria-label="${group}"] [role="menuitemradio"]`,
    ),
  ].find((item) => item.textContent === label);
  if (!row) throw new Error(`Missing ${group} row ${label}`);
  row.click();
}

it('launches the task with the model and reasoning level picked for it', async () => {
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  pickMenuRow('Claude Code', 'opus');
  pickMenuRow('Reasoning', 'High');
  expect(host.querySelector('button[aria-label^="Task model"]')?.textContent).toBe('opus · High');
  submitTask('picked');
  await vi.waitFor(() => expect(store.tasks.picked).toBeDefined());
  const args = store.agents[store.tasks.picked.agentIds[0]].def.args;
  expect(modelInArgs(args)).toBe('opus');
  expect(effortInArgs(args)).toBe('high');
});

it('leaves the agent args alone while the model stays on its default', async () => {
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  expect(host.querySelector('button[aria-label^="Task model"]')?.textContent).toBe('Default model');
  submitTask('plain');
  await vi.waitFor(() => expect(store.tasks.plain).toBeDefined());
  expect(store.agents[store.tasks.plain.agentIds[0]].def.args).toEqual([]);
});

it('offers no model for an agent that does not take one', async () => {
  dispose();
  host.replaceChildren();
  setStore('availableAgents', 0, 'command', 'custom-agent');
  dispose = render(() => <NewTaskPanel open onClose={vi.fn()} />, host);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  expect(host.querySelector('button[aria-label^="Task model"]')).toBeNull();
});

it('hides agents whose CLI is missing unless one is already selected', async () => {
  dispose();
  host.replaceChildren();
  setStore('availableAgents', (agents) => [
    ...agents,
    { ...agents[0], id: 'missing', name: 'Missing CLI', command: 'agy', available: false },
  ]);
  dispose = render(() => <NewTaskPanel open onClose={vi.fn()} />, host);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  const agentNames = () =>
    [...host.querySelectorAll('[data-nav-field="agent"] [role="radio"]')].map(
      (button) => button.textContent,
    );
  expect(agentNames()).toEqual(['Agent']);
  setStore('lastAgentId', 'missing');
  dispose();
  host.replaceChildren();
  dispose = render(() => <NewTaskPanel open onClose={vi.fn()} />, host);
  await vi.waitFor(() => expect(agentNames()).toEqual(['Agent', 'Missing CLI(not installed)']));

  setStore('lastAgentId', null);
});

function dropFiles(names: string[]): Event {
  const files = names.map((n) => new File(['x'], n, { type: 'image/png' }));
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files, types: ['Files'] } });
  host.querySelector('[data-new-task-panel]')?.dispatchEvent(drop);
  return drop;
}

it('inserts the paths of files dropped on the panel at the prompt caret', async () => {
  const electron = Reflect.get(window, 'electron') as unknown;
  Reflect.set(window, 'electron', { getPathForFile: (file: File) => `/home/me/${file.name}` });
  const shellDrop = vi.fn();
  host.addEventListener('drop', shellDrop);
  try {
    typePrompt('Fix the layout');
    const prompt = host.querySelector('textarea');
    prompt?.setSelectionRange(3, 3);
    const drop = dropFiles(['screen shot.png']);

    expect(drop.defaultPrevented).toBe(true);
    expect(shellDrop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(prompt?.value).toBe('Fix /home/me/screen\\ shot.png the layout'));
  } finally {
    Reflect.set(window, 'electron', electron);
  }
});

it('reports dropped files it cannot attach', async () => {
  const electron = Reflect.get(window, 'electron') as unknown;
  Reflect.set(window, 'electron', { getPathForFile: () => '' });
  try {
    typePrompt('Fix it');
    dropFiles(['image.png']);
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Could not attach the dropped files.'),
    );
    expect(host.querySelector('textarea')?.value).toBe('Fix it');
  } finally {
    Reflect.set(window, 'electron', electron);
  }
});

it('teleports a dropped Claude web session into the new task', async () => {
  dispose();
  // UI mode would open the chat view, whose launch cannot teleport.
  setStore({
    newTaskDropUrl: 'https://claude.ai/code/session_011CUabcXYZ',
    preferUiMode: true,
    lastTeleportProjectId: 'project',
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'teleported',
        branch_name: 'task/teleport',
        worktree_path: '/project/.worktrees/teleport',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  try {
    dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    await vi.waitFor(() => expect(submit?.disabled).toBe(false));
    expect(host.querySelector('textarea')?.value).toBe('');
    expect(host.textContent).toContain('Teleports Claude web session session_011CUabcXYZ');
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.tasks.teleported).toBeDefined());
    const task = store.tasks.teleported;
    expect(task.name).toBe('Teleport 011CUabc');
    expect(task.teleportSessionId).toBe('session_011CUabcXYZ');
    expect(task.githubUrl).toBeUndefined();
    // No minted id: the first launch must teleport, not start a new session.
    expect(task.agentSessionIds?.[task.agentIds[0]]).toBeUndefined();
    expect(task.mainAgentView).toBe('terminal');
    expect(task.projectId).toBe('project');
  } finally {
    setStore({ newTaskDropUrl: null, preferUiMode: false });
  }
});

it('takes a Claude web session link dropped while the panel is already open', async () => {
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'late-drop',
        branch_name: 'task/late',
        worktree_path: '/project/.worktrees/late',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  try {
    setStore({
      lastTeleportProjectId: 'project',
      newTaskDropUrl: 'https://claude.ai/code/session_011CUabcXYZ',
    });
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.tasks['late-drop']).toBeDefined());
    expect(store.tasks['late-drop'].teleportSessionId).toBe('session_011CUabcXYZ');
    expect(store.tasks['late-drop'].name).toBe('Teleport 011CUabc');
  } finally {
    setStore('newTaskDropUrl', null);
  }
});

it('leaves the project for the user to pick when no teleport project is remembered', async () => {
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  try {
    // A deleted project counts as none.
    setStore({
      lastTeleportProjectId: 'gone',
      newTaskDropUrl: 'https://claude.ai/code/session_011CUabcXYZ',
    });
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.textContent).toContain('Select a project'));
    expect(Object.keys(store.tasks)).toEqual([]);
  } finally {
    setStore('newTaskDropUrl', null);
  }
});

it('retries a refused teleport in the project matching the session repo', async () => {
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'retried',
        branch_name: 'task/retried',
        worktree_path: '/code/web-app/.worktrees/retried',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  const url = 'https://claude.ai/code/session_011CUabcXYZ';
  setStore({
    projects: [
      { id: 'project', name: 'Project', path: '/project', color: '#abc' },
      { id: 'web', name: 'Web', path: '/code/Web-App', color: '#def' },
    ],
    lastTeleportProjectId: 'project',
    newTaskDropUrl: url,
  });
  try {
    // The panel still holds the same link, so only the project changes.
    retryTeleportInRepo('session_011CUabcXYZ', 'web-app');
    expect(store.newTaskDropUrl).toBe(url);
    expect(host.querySelector('select')?.value).toBe('web');
    await vi.waitFor(() => expect(submit?.disabled).toBe(false));
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.tasks.retried, host.textContent ?? '').toBeDefined());
    expect(store.tasks.retried.projectId).toBe('web');
    expect(store.tasks.retried.teleportSessionId).toBe('session_011CUabcXYZ');
  } finally {
    setStore('newTaskDropUrl', null);
  }
});

it('creates an ordinary task when the user declines the teleport', async () => {
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'declined',
        branch_name: 'task/declined',
        worktree_path: '/project/.worktrees/declined',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  setStore({
    lastTeleportProjectId: 'project',
    newTaskDropUrl: 'https://claude.ai/code/session_011CUabcXYZ',
  });
  const decline = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === "Don't teleport",
  );
  decline?.click();
  expect(host.textContent).not.toContain('Teleports Claude web session');
  expect(host.querySelector<HTMLInputElement>('input[value^="Teleport "]')).toBeNull();
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks.declined).toBeDefined());
  expect(store.tasks.declined.teleportSessionId).toBeUndefined();
});
