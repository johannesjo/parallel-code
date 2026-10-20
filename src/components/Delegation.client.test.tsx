import { createSignal, untrack } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { DelegationState } from '../../electron/shared/delegation-types';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { DelegationPanel } from './DelegationPanel';
import { SubTaskStrip } from './SubTaskStrip';
import { setDelegationStates, canUsePeerComposer, usePeerComposer } from '../store/delegation';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/tasks', () => ({ clearStagedNotification: vi.fn() }));
const task: Task = {
  id: 'parent',
  name: 'Parent',
  projectId: 'project',
  branchName: 'task/parent',
  worktreePath: '/repo/parent',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  promptDraft: 'Keep my draft',
  gitIsolation: 'worktree',
};
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
let state: DelegationState;
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
beforeEach(() => {
  state = { attempts: [], messages: [], paused: false };
  setStore({
    projects: [{ id: 'project', name: 'Repo', path: '/repo', color: '' }],
    tasks: { parent: { ...task } },
    taskOrder: ['parent'],
    collapsedTaskOrder: [],
    mcpOrchestrationEnabled: true,
    availableAgents: [
      {
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: ['--continue'],
        skip_permissions_args: [],
        description: '',
      },
    ],
  });
  setStore('agents', 'agent', {
    id: 'agent',
    taskId: 'parent',
    def: store.availableAgents[0],
    resumed: false,
    status: 'running',
    capabilities: { profile: 'ordinary', canCreate: true, peers: true },
    generation: 0,
    exitCode: null,
    signal: null,
    lastOutput: [],
  });
  vi.mocked(invoke).mockImplementation(async (_channel, args) => {
    if (args?.action === 'state') return state;
    return {};
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  setDelegationStates('parent', { attempts: [], messages: [], paused: false });
});

it('offers tools restart after enabling MCP for a session without tools', () => {
  setStore('tasks', 'parent', 'agentSessionIds', { agent: 'conversation' });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
  setStore('agents', 'agent', 'capabilities', undefined);
  expect(button('Restart and resume Claude')).toBeDefined();
  setStore('mcpOrchestrationEnabled', false);
  expect(button('Restart and resume Claude')).toBeUndefined();
  setStore('mcpOrchestrationEnabled', true);
  expect(button('Restart and resume Claude')).toBeDefined();
  setStore('agents', 'agent', 'capabilities', {
    profile: 'ordinary',
    canCreate: true,
    peers: true,
  });
  setStore('tasks', 'parent', 'delegationParent', true);
  expect(button('Restart and resume Claude')).toBeUndefined();
});

it('shows no tools notice for the chat pane, which never receives delegation tools', () => {
  setStore('tasks', 'parent', 'agentSessionIds', { agent: 'conversation' });
  setStore('tasks', 'parent', 'mainAgentView', 'chat');
  setStore('agents', 'agent', 'capabilities', undefined);
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
});

it.each(['delegationParent', 'coordinatorMode'] as const)(
  'keeps the child limit available for an idle %s parent',
  (parentFlag) => {
    setStore('tasks', 'parent', parentFlag, true);
    setStore('tasks', 'parent', 'maxConcurrentTasks', 6);
    dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
    expect(host.textContent).toContain('0 subtasks');
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('6');
  },
);

it.each(['Please inspect this patch', 'Please inspect this patch. '.repeat(12)])(
  'copies queued messages without changing delivery or drafts (%s)',
  async (prompt) => {
    const sender = {
      agentId: 'sender',
      sessionInstanceId: 'sender-instance',
      taskId: 'other',
      name: 'Other task',
      agentLabel: 'Claude',
      branchName: 'other',
      status: 'running',
    };
    state.messages = [
      {
        deliveryId: 'delivery',
        sender,
        recipient: {
          ...sender,
          agentId: 'agent',
          sessionInstanceId: 'exact-instance',
          taskId: 'parent',
          name: 'Parent',
        },
        prompt,
        state: 'waiting',
        createdAt: new Date().toISOString(),
      },
    ];
    setStore('tasks', 'parent', 'stagedNotification', {
      batchId: 'summary',
      notificationIds: ['child-result'],
      text: 'Result ready',
      autoFireAt: 0,
      userEdited: false,
    });
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
    await vi.waitFor(() => expect(button('Copy text')).toBeDefined());
    const sections = [...host.querySelectorAll('details')];
    expect(sections).toHaveLength(2);
    expect(sections.every((section) => !section.open)).toBe(true);
    expect(sections[0].querySelector('summary')?.textContent).toContain('Subtask updates (1)');
    expect(sections[1].querySelector('summary')?.textContent).toContain('Queued messages (1)');
    sections[1].open = true;
    if (prompt.length > 180) {
      expect(host.querySelector('article p')?.textContent).toBe(prompt.slice(0, 180) + '…');
      button('Show full message')?.click();
      expect(host.querySelector('article p')?.textContent).toBe(prompt);
      button('Show less')?.click();
      expect(host.querySelector('article p')?.textContent).toBe(prompt.slice(0, 180) + '…');
    } else {
      expect(button('Show full message')).toBeUndefined();
    }
    expect(vi.mocked(invoke).mock.calls.some(([, args]) => args?.action === 'handleMessage')).toBe(
      false,
    );
    button('Copy text')?.click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(prompt));
    expect(vi.mocked(invoke).mock.calls.some(([, args]) => args?.action === 'handleMessage')).toBe(
      false,
    );
    await vi.waitFor(() => expect(button('Cancel delivery')?.disabled).toBe(false));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Delivery remains queued');
    button('Cancel delivery')?.click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
        action: 'handleMessage',
        deliveryId: 'delivery',
        agentId: 'agent',
        sessionInstanceId: 'exact-instance',
        state: 'closed',
      }),
    );
    expect(copy).toHaveBeenCalledWith(prompt);
    expect(store.tasks.parent.promptDraft).toBe('Keep my draft');
    expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel !== IPC.WriteToAgent)).toBe(
      true,
    );
  },
);

it('changes the child limit only after the backend accepts it', async () => {
  setStore('tasks', 'parent', 'delegationParent', true);
  let acceptLimit: () => void = () => {};
  const acceptance = new Promise<void>((resolve) => {
    acceptLimit = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (_channel, args) => {
    if (args?.action === 'childLimit') await acceptance;
    if (args?.action === 'state') return state;
    return {};
  });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  const input = () => host.querySelector<HTMLInputElement>('input[type="number"]');
  expect(input()?.value).toBe('4');
  const change = (value: string) => {
    const el = input();
    if (!el) throw new Error('limit input missing');
    el.value = value;
    el.dispatchEvent(new Event('change'));
  };
  change('7');
  expect(input()?.disabled).toBe(true);
  expect(store.tasks.parent.maxConcurrentTasks).toBeUndefined();
  acceptLimit();
  await vi.waitFor(() => expect(store.tasks.parent.maxConcurrentTasks).toBe(7));
  expect(input()?.disabled).toBe(false);
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'childLimit',
    taskId: 'parent',
    limit: 7,
  });
  vi.mocked(invoke).mockImplementation(async (_channel, args) => {
    if (args?.action === 'childLimit') throw new Error('Invalid child limit');
    if (args?.action === 'state') return state;
    return {};
  });
  change('99');
  await vi.waitFor(() => expect(host.textContent).toContain('Invalid child limit'));
  expect(invoke).toHaveBeenLastCalledWith(IPC.DelegationRequest, {
    action: 'childLimit',
    taskId: 'parent',
    limit: 20,
  });
  expect(store.tasks.parent.maxConcurrentTasks).toBe(7);
  expect(input()?.value).toBe('7');
});

it('keeps an automatic failure visible after remount until explicitly dismissed', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'old-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Claude',
    branchName: 'task/parent',
    status: 'exited',
  };
  state.messages = [
    {
      deliveryId: 'failed-delivery',
      sender: { ...session, name: 'Other task' },
      recipient: session,
      prompt: 'Review this patch',
      createdAt: new Date().toISOString(),
      state: 'closed',
      deliveryFailed: true,
      reason: 'Delivery failed; inspect the recipient before resending: Enter failed',
    },
  ];
  vi.mocked(invoke).mockImplementation(async (_channel, args) => {
    if (args?.action === 'dismissMessageFailure') state = { ...state, messages: [] };
    if (args?.action === 'state') return state;
    return {};
  });
  const mount = () => {
    dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  };
  mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter failed'),
  );
  expect(host.querySelector('[role="alert"]')?.closest('details')).toBeNull();
  expect(host.textContent).toContain('inspect the recipient before resending');
  expect(button('Use in composer')).toBeUndefined();
  dispose?.();
  mount();
  await vi.waitFor(() => expect(button('Dismiss failure')).toBeDefined());
  button('Dismiss failure')?.click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'dismissMessageFailure',
    deliveryId: 'failed-delivery',
  });
  expect(store.tasks.parent.promptDraft).toBe('Keep my draft');
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel !== IPC.WriteToAgent)).toBe(
    true,
  );
});

it('uses only the exact recipient empty composer and marks handling without sending', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Claude',
    branchName: 'task/parent',
    status: 'running',
  };
  const message = {
    deliveryId: 'composer-delivery',
    sender: { ...session, taskId: 'sender' },
    recipient: session,
    prompt: 'Review this child',
    state: 'waiting' as const,
    createdAt: new Date().toISOString(),
  };
  state.messages = [message];
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  const [text, setText] = createSignal('');
  const composer = { getText: text, setText };
  dispose = render(
    () => (
      <DelegationPanel
        task={store.tasks.parent}
        canUseComposer={(incoming) =>
          canUsePeerComposer(store.tasks.parent, incoming, composer, true)
        }
        onUseComposer={(incoming) => usePeerComposer(store.tasks.parent, incoming, composer, true)}
      />
    ),
    host,
  );
  await vi.waitFor(() => expect(button('Use in composer')).toBeDefined());
  expect(button('Show full message')).toBeUndefined();
  button('Use in composer')?.click();
  await vi.waitFor(() => expect(untrack(text)).toBe(message.prompt));
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'handleMessage',
    deliveryId: message.deliveryId,
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    state: 'handled',
  });
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel !== IPC.WriteToAgent)).toBe(
    true,
  );
  // An existing draft, restarted recipient, secondary pane, and hidden composer all fail closed.
  setText('my draft');
  expect(usePeerComposer(store.tasks.parent, message, composer, true)).toBe(false);
  expect(untrack(text)).toBe('my draft');
  setText('');
  setStore('agents', 'agent', 'sessionInstanceId', 'replacement-instance');
  expect(usePeerComposer(store.tasks.parent, message, composer, true)).toBe(false);
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  expect(
    usePeerComposer(
      store.tasks.parent,
      { ...message, recipient: { ...session, agentId: 'secondary' } },
      composer,
      true,
    ),
  ).toBe(false);
  expect(usePeerComposer(store.tasks.parent, message, composer, false)).toBe(false);
  expect(untrack(text)).toBe('');
});

it('does not show an empty collaboration section merely for automatic updates', () => {
  setStore('tasks', 'parent', 'autoSendChildUpdates', true);
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
});

it('respects explicit automatic update policy over the legacy mode marker', () => {
  setStore('tasks', 'parent', {
    coordinatorMode: true,
    autoSendChildUpdates: false,
    stagedNotification: {
      batchId: 'batch',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited: false,
    },
  });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.textContent).toContain('Subtask updates');
  setStore('tasks', 'parent', 'autoSendChildUpdates', true);
  expect(host.textContent).not.toContain('Subtask updates');
});

it('marks only the displayed summary batch read without approving a merge', async () => {
  setStore('tasks', 'parent', 'stagedNotification', {
    batchId: 'summary-batch',
    notificationIds: ['child-result'],
    text: 'Result ready',
    autoFireAt: 0,
    userEdited: false,
  });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  button('Mark read')?.click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_CoordinatorNotificationAck, {
      coordinatorTaskId: 'parent',
      batchId: 'summary-batch',
    }),
  );
  expect(vi.mocked(invoke).mock.calls.some(([, args]) => args?.action === 'merge')).toBe(false);
});

it.each([
  ['landing_failed', 'Merge failed'],
  ['landing_escalated', 'Merge needs attention'],
  ['landed_cleanup_failed', 'Merged · cleanup failed'],
  ['landed_pending_review', 'Merged · review pending'],
  ['reviewed', 'Merged'],
] as const)('shows %s explicitly in the subtask strip', (landingState, label) => {
  setStore('tasks', 'child', {
    ...task,
    id: 'child',
    name: 'Child',
    coordinatedBy: 'parent',
    landingState,
    agentIds: [],
  });
  setStore('taskOrder', ['parent', 'child']);
  dispose = render(() => <SubTaskStrip coordinatorTaskId="parent" />, host);
  const childButton = button('Child');
  expect(childButton?.textContent).toContain(label);
  expect(childButton?.querySelector('svg')).toBeNull();
});

it('lists every subtask under a collapsible header', () => {
  for (const id of ['a', 'b', 'c']) {
    setStore('tasks', id, {
      ...task,
      id,
      name: `Child ${id}`,
      coordinatedBy: 'parent',
      agentIds: [],
    });
  }
  setStore('taskOrder', ['parent', 'a', 'b', 'c']);
  dispose = render(() => <SubTaskStrip coordinatorTaskId="parent" />, host);
  const toggle = button('Subtasks (3)');
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  toggle?.click();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  const list = host.querySelector('ul');
  expect(list?.id).toBe(toggle?.getAttribute('aria-controls'));
  expect(list?.hidden).toBe(true);
  toggle?.click();
  expect(list?.hidden).toBe(false);
});

it('opens a queued handoff and says why it is still waiting', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex',
    branchName: 'task/parent',
    status: 'running',
  };
  state.messages = [
    {
      deliveryId: 'handoff',
      sender: session,
      recipient: session,
      prompt: 'Review the diff',
      state: 'waiting',
      origin: 'user',
      reason: 'Recipient has unsent input in its terminal',
      createdAt: new Date().toISOString(),
    },
  ];
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.waitFor(() => expect(host.querySelector('details')?.open).toBe(true));
  // Renderer holds come first: main never saw this attempt.
  expect(host.textContent).toContain('Your draft in the task prompt is unsent');
  setStore('tasks', 'parent', 'promptDraft', '');
  expect(host.textContent).toContain('Recipient has unsent input in its terminal');
  setDelegationStates('parent', 'messages', 0, 'reason', undefined);
  expect(host.textContent).toContain('Waiting for the recipient to be ready');
});

it('drops the typing reason once the typing hold ends', async () => {
  vi.useFakeTimers();
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex',
    branchName: 'task/parent',
    status: 'running',
  };
  setStore('tasks', 'parent', 'promptDraft', '');
  setStore('tasks', 'parent', 'userActivityHoldUntil', Date.now() + 2_000);
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  state.messages = [
    {
      deliveryId: 'handoff',
      sender: session,
      recipient: session,
      prompt: 'Review the diff',
      state: 'waiting',
      origin: 'user',
      reason: 'Recipient is starting or showing a dialog',
      createdAt: new Date().toISOString(),
    },
  ];
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toContain('Waiting for you to stop typing');
  await vi.advanceTimersByTimeAsync(3_000);
  expect(host.textContent).toContain('Recipient is starting or showing a dialog');
  vi.useRealTimers();
});

it('keeps the queue open after a handoff leaves it', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex',
    branchName: 'task/parent',
    status: 'running',
  };
  const waiting = { recipient: session, sender: session, state: 'waiting' as const };
  const createdAt = new Date().toISOString();
  state.messages = [
    { ...waiting, deliveryId: 'handoff', prompt: 'Review', origin: 'user', createdAt },
    { ...waiting, deliveryId: 'peer', prompt: 'Status', createdAt },
  ];
  const queue = () =>
    [...host.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.startsWith('Queued messages'),
    );
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.waitFor(() => expect(queue()?.open).toBe(true));
  setDelegationStates('parent', 'messages', 0, 'state', 'delivered');
  expect(queue()?.querySelector('summary')?.textContent).toBe('Queued messages (1)');
  expect(queue()?.open).toBe(true);
});

it('leaves a collapsed queue closed while its messages only change state', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex',
    branchName: 'task/parent',
    status: 'running',
  };
  const waiting = { recipient: session, sender: session, state: 'waiting' as const };
  const createdAt = new Date().toISOString();
  const handoff = {
    ...waiting,
    deliveryId: 'handoff',
    prompt: 'Review',
    origin: 'user' as const,
    createdAt,
  };
  const peer = { ...waiting, deliveryId: 'peer', prompt: 'Status', createdAt };
  state.messages = [handoff, peer];
  const queue = () =>
    [...host.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.startsWith('Queued messages'),
    );
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.waitFor(() => expect(queue()?.open).toBe(true));
  const details = queue();
  if (!details) throw new Error('Missing queue');
  details.open = false;
  // Main reports reasons and deliveries by replacing the whole state.
  const update = (messages: DelegationState['messages']) =>
    setDelegationStates('parent', reconcile({ ...state, messages }));
  update([{ ...handoff, reason: 'Waiting for Codex CLI to show its prompt' }, peer]);
  update([
    { ...handoff, reason: 'Codex CLI has unsent input' },
    { ...peer, state: 'delivered' },
  ]);
  expect(details.open).toBe(false);
  update([
    { ...handoff, reason: 'Codex CLI has unsent input' },
    { ...handoff, deliveryId: 'second', prompt: 'Again' },
  ]);
  expect(details.open).toBe(true);
});

it('says why a handoff was not delivered', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex CLI',
    branchName: 'task/parent',
    status: 'running',
  };
  const createdAt = new Date().toISOString();
  const handoff = { sender: session, recipient: session, origin: 'user' as const, createdAt };
  state.messages = [{ ...handoff, deliveryId: 'handoff', prompt: 'Review', state: 'waiting' }];
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain('Queued messages (1)'));
  setDelegationStates('parent', 'messages', 0, {
    state: 'closed',
    reason: 'Recipient session ended or access revoked',
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    'Recipient session ended or access revoked',
  );
});

it('confirms a delivered handoff briefly instead of keeping it', async () => {
  vi.useFakeTimers();
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Codex CLI',
    branchName: 'task/parent',
    status: 'running',
  };
  const createdAt = new Date().toISOString();
  const handoff = { sender: session, recipient: session, origin: 'user' as const, createdAt };
  state.messages = [
    { ...handoff, deliveryId: 'earlier', prompt: 'Old review', state: 'delivered' },
    { ...handoff, deliveryId: 'handoff', prompt: 'Review', state: 'waiting' },
  ];
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.advanceTimersByTimeAsync(0);
  // Handoffs finished before this view existed are history, not news.
  expect(host.textContent).not.toContain('Delivered to');
  setDelegationStates('parent', 'messages', 1, 'state', 'delivered');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Delivered to Claude');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(host.textContent).not.toContain('Delivered to');
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
  vi.useRealTimers();
});
