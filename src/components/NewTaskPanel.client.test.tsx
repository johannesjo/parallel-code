import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { NewTaskPanel } from './NewTaskPanel';

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
  setStore('tasks', reconcile({}));
  setStore({
    newTaskPrefillPrompt: null,
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

it('dims only the form, keeps status clear, and restores editing after creation fails', async () => {
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));

  let rejectCreation!: (error: Error) => void;
  const pending = new Promise((_, reject) => (rejectCreation = reject));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask ? pending : Promise.resolve(originalInvoke?.(channel, args)),
  );
  const outside = document.createElement('button');
  const outsideClick = vi.fn();
  outside.onclick = outsideClick;
  document.body.append(outside);

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(form?.inert).toBe(true);
  expect(form?.style.opacity).toBe('0.4');
  expect(form?.getAttribute('aria-busy')).toBe('true');
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain('Creating task...');
  expect(status?.querySelector('.inline-spinner')).not.toBeNull();
  expect(form?.contains(status)).toBe(false);
  expect(document.body.inert).toBe(false);
  outside.click();
  expect(outsideClick).toHaveBeenCalledOnce();

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(
    vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.CreateTask),
  ).toHaveLength(1);
  rejectCreation(new Error('Worktree creation failed'));
  await vi.waitFor(() => expect(form?.inert).toBe(false));
  expect(form?.style.opacity).toBe('1');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain('Worktree creation failed');
  expect(submit?.disabled).toBe(false);
  expect(store.showNewTaskPanel).toBe(true);
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
