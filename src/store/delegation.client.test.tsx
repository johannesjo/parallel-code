import { produce, reconcile } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type {
  DelegationChanged,
  DelegationState,
  PeerMessage,
} from '../../electron/shared/delegation-types';
import { invoke } from '../lib/ipc';
import { warn } from '../lib/log';
import { setStore, store } from './core';
import {
  canUsePeerComposer,
  delegationStates,
  refreshDelegationState,
  registerTaskAuthority,
  setDelegationStates,
  startDelegationStateHydration,
  startPeerMessageDelivery,
} from './delegation';
import type { Agent, Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));

const task: Task = {
  id: 'recipient',
  name: 'Recipient',
  projectId: 'project',
  branchName: 'task/recipient',
  worktreePath: '/repo/recipient',
  agentIds: ['first', 'second'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};
function agent(id: string): Agent {
  return {
    id,
    taskId: task.id,
    def: {
      id: 'claude',
      name: 'Claude',
      command: 'claude',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: '',
    },
    resumed: false,
    status: 'running',
    generation: 0,
    exitCode: null,
    signal: null,
    lastOutput: [],
  };
}
function message(deliveryId = 'one', agentId = 'second'): PeerMessage {
  const session = {
    agentId,
    taskId: task.id,
    sessionInstanceId: `${agentId}-instance`,
    name: task.name,
    agentLabel: 'Claude',
    branchName: task.branchName,
    status: 'running',
  };
  return {
    deliveryId,
    sender: { ...session, taskId: 'sender' },
    recipient: session,
    prompt: `Prompt ${deliveryId}`,
    state: 'waiting',
    createdAt: new Date().toISOString(),
  };
}
function inbox(messages: PeerMessage[]) {
  setDelegationStates(task.id, { attempts: [], messages, paused: false });
}
let cleanup: (() => void) | undefined;
const delivered = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  setStore('tasks', reconcile({ [task.id]: { ...task } }));
  setStore('agents', reconcile({ first: agent('first'), second: agent('second') }));
  setStore('mcpOrchestrationEnabled', true);
  setDelegationStates(reconcile({}));
  inbox([message()]);
  vi.mocked(invoke).mockResolvedValue({ deliveryId: 'one', state: 'delivered' });
  cleanup = startPeerMessageDelivery(delivered);
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('delivers to an unmounted background second pane using backend session authority', async () => {
  expect(store.agents.second.sessionInstanceId).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'deliverMessage',
    deliveryId: 'one',
    agentId: 'second',
    sessionInstanceId: 'second-instance',
  });
  expect(delivered).toHaveBeenCalledOnce();
  expect(delegationStates[task.id].messages[0].state).toBe('delivered');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(invoke).toHaveBeenCalledOnce();
});

it.each([
  { promptDraft: 'my draft' },
  { promptDraftActive: true },
  { terminalInputPending: true },
  { userActivityHoldUntil: 20_000 },
  { initialPrompt: 'assignment' },
  { prefillPrompt: 'prefill' },
  { closingStatus: 'closing' as const },
  { closingStatus: 'removing' as const },
  { delegationPaused: true },
  { controlledBy: 'human' as const },
  { automationWriteInFlight: true },
  { landingState: 'landed_pending_review' as const },
  {
    autoSendChildUpdates: true,
    stagedNotification: {
      batchId: 'child',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited: false,
    },
  },
])('holds messages while task input is blocked: %j', async (blocked) => {
  setStore('tasks', task.id, blocked);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).not.toHaveBeenCalled();
  setStore('tasks', task.id, reconcile({ ...task }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledOnce();
});

it.each([
  {},
  { autoSendChildUpdates: false },
  { coordinatorMode: true, autoSendChildUpdates: false },
])('delivers child messages while completion updates await manual review: %j', async (policy) => {
  inbox([message('one', 'first')]);
  setStore('tasks', task.id, {
    ...policy,
    delegationParent: true,
    stagedNotification: {
      batchId: 'completion',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited: false,
    },
  });
  setStore('tasks', 'sender', { ...task, id: 'sender', coordinatedBy: task.id });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(delivered).toHaveBeenCalledOnce();
  expect(delegationStates[task.id].messages[0].state).toBe('delivered');
  expect(store.tasks[task.id].stagedNotification?.batchId).toBe('completion');
});

it.each([
  { coordinatorMode: true },
  { autoSendChildUpdates: false, userEdited: true },
  { autoSendChildUpdates: false, promptDraft: 'My instructions' },
])('preserves notification and draft holds: %j', async ({ userEdited = false, ...policy }) => {
  setStore('tasks', task.id, {
    ...policy,
    stagedNotification: {
      batchId: 'completion',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited,
    },
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(invoke).not.toHaveBeenCalled();
});

it('holds while orchestration is off, state is paused, or the known recipient changed', async () => {
  setStore('mcpOrchestrationEnabled', false);
  await vi.advanceTimersByTimeAsync(1_000);
  setStore('mcpOrchestrationEnabled', true);
  setDelegationStates(task.id, 'paused', true);
  await vi.advanceTimersByTimeAsync(1_000);
  setDelegationStates(task.id, 'paused', false);
  setStore('agents', 'second', 'sessionInstanceId', 'replacement');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).not.toHaveBeenCalled();
  setStore('agents', 'second', 'sessionInstanceId', 'second-instance');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledOnce();
});

it('does not deliver to removed tasks, exited agents, or an unrelated pane', async () => {
  setStore('tasks', task.id, 'agentIds', ['first']);
  await vi.advanceTimersByTimeAsync(1_000);
  setStore('tasks', task.id, 'agentIds', ['first', 'second']);
  setStore('agents', 'second', 'status', 'exited');
  await vi.advanceTimersByTimeAsync(1_000);
  setStore('agents', 'second', 'status', 'running');
  setStore('tasks', reconcile({}));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).not.toHaveBeenCalled();
});

it('serializes queued messages per recipient and continues after readiness becomes available', async () => {
  inbox([message(), message('two')]);
  let resolve: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(invoke).toHaveBeenCalledOnce();
  resolve?.({ deliveryId: 'one', state: 'waiting', reason: 'busy' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(delivered).toHaveBeenCalledOnce();
  vi.mocked(invoke).mockResolvedValue({ deliveryId: 'two', state: 'delivered' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenLastCalledWith(
    IPC.DelegationRequest,
    expect.objectContaining({ deliveryId: 'two' }),
  );
});

it('polls independent recipients without blocking each other', async () => {
  inbox([message('one', 'second'), message('two', 'first')]);
  vi.mocked(invoke).mockImplementation(async (_channel, args) => ({
    deliveryId: args?.deliveryId,
    state: 'waiting',
  }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('prevents filling the composer once automatic delivery starts', async () => {
  const incoming = message('one', 'first');
  const composer = { getText: () => '', setText: vi.fn() };
  inbox([incoming]);
  setStore('agents', 'first', 'sessionInstanceId', 'first-instance');
  expect(canUsePeerComposer(store.tasks.recipient, incoming, composer, true)).toBe(true);
  let resolve: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(canUsePeerComposer(store.tasks.recipient, incoming, composer, true)).toBe(false);
  resolve?.({ deliveryId: 'one', state: 'delivered' });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    canUsePeerComposer(
      store.tasks.recipient,
      delegationStates.recipient.messages[0],
      composer,
      true,
    ),
  ).toBe(false);
});

it('cleans up polling and ignores a response after cleanup without releasing an ongoing claim', async () => {
  let resolve: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  await vi.advanceTimersByTimeAsync(1_000);
  cleanup?.();
  cleanup = startPeerMessageDelivery(delivered);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(invoke).toHaveBeenCalledOnce();
  cleanup();
  resolve?.({ deliveryId: 'one', state: 'delivered' });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(delivered).not.toHaveBeenCalled();
  expect(delegationStates[task.id].messages[0].state).toBe('waiting');
  expect(invoke).toHaveBeenCalledOnce();
});

it('records terminal failures without repeatedly logging or treating them as delivered', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('IPC unavailable'));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(warn).toHaveBeenCalledOnce();
  expect(delivered).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue({ deliveryId: 'one', state: 'closed', reason: 'expired' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(delegationStates[task.id].messages[0].state).toBe('closed');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledTimes(4);
});

describe('delegation state hydration', () => {
  let changed: ((data: DelegationChanged) => void) | undefined;
  const unsubscribe = vi.fn();
  const failure: DelegationState = {
    attempts: [
      {
        requestId: 'attempt',
        parentTaskId: task.id,
        name: 'Child',
        status: 'failed',
        error: 'Launch failed',
      },
    ],
    messages: [{ ...message(), state: 'closed', deliveryFailed: true, reason: 'Recipient exited' }],
    paused: false,
  };

  beforeEach(() => {
    cleanup?.();
    cleanup = undefined;
    setDelegationStates(reconcile({}));
    changed = undefined;
    vi.stubGlobal('electron', {
      ipcRenderer: {
        on: vi.fn((channel: string, handler: (data: DelegationChanged) => void) => {
          expect(channel).toBe(IPC.DelegationChanged);
          changed = handler;
          return unsubscribe;
        }),
      },
    });
    vi.mocked(invoke).mockImplementation(async () => {
      expect(changed).toBeDefined();
      return failure;
    });
  });

  it('loads pre-existing failures for active, background, and collapsed tasks without a panel', async () => {
    setStore('tasks', 'background', { ...task, id: 'background' });
    setStore('tasks', 'collapsed', { ...task, id: 'collapsed', collapsed: true });
    setStore('taskOrder', [task.id, 'background']);
    setStore('collapsedTaskOrder', ['collapsed']);
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    for (const id of [task.id, 'background', 'collapsed'])
      expect(delegationStates[id]?.messages[0].deliveryFailed).toBe(true);
    expect(delegationStates[task.id]?.attempts[0].error).toBe('Launch failed');
    setStore('tasks', task.id, 'name', 'Renamed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('loads adopted tasks and refreshes an existing task after authority registration', async () => {
    setStore('tasks', reconcile({}));
    setStore('projects', [{ id: 'project', name: 'Repo', path: '/repo', color: '' }]);
    cleanup = startDelegationStateHydration();
    setStore('tasks', task.id, { ...task });
    await vi.advanceTimersByTimeAsync(0);
    expect(delegationStates[task.id]?.messages).toEqual(failure.messages);
    await registerTaskAuthority(store.tasks[task.id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenLastCalledWith(IPC.DelegationRequest, {
      action: 'state',
      taskId: task.id,
    });
  });

  it('preserves a saved pause flag when failed authority restoration makes the snapshot unavailable', async () => {
    setStore('tasks', task.id, 'delegationPaused', true);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Task unavailable or closing'));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.tasks[task.id].delegationPaused).toBe(true);
    expect(delegationStates[task.id]).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips hidden document-agent tasks, which have no delegation authority', async () => {
    setStore('projects', [
      { id: 'documents', name: 'Documents', path: '/docs', color: '', kind: 'document' },
    ]);
    setStore('tasks', 'document-agent', { ...task, id: 'document-agent', projectId: 'documents' });
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    expect(delegationStates['document-agent']).toBeUndefined();
  });

  it('does not refresh a replacement task after an older authority registration resolves', async () => {
    setStore('projects', [{ id: 'project', name: 'Repo', path: '/repo', color: '' }]);
    let resolve: (() => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise((done) => (resolve = () => done({ ready: true }))),
    );
    const registration = registerTaskAuthority(store.tasks[task.id]);
    setStore(
      'tasks',
      produce((tasks) => delete tasks.recipient),
    );
    setStore('tasks', task.id, { ...task, name: 'Replacement' });
    resolve?.();
    await registration;
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps a newer subscribed change when the initial snapshot resolves late', async () => {
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    changed?.({ taskId: task.id, state: { ...failure, paused: true } });
    resolve?.({ attempts: [], messages: [], paused: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(delegationStates[task.id]?.paused).toBe(true);
    expect(delegationStates[task.id]?.messages[0].deliveryFailed).toBe(true);
  });

  it('replaces omitted optional fields and ignores older concurrent refreshes', async () => {
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const older = refreshDelegationState(task.id);
    const newer = { attempts: [], messages: [message()], paused: false };
    vi.mocked(invoke).mockResolvedValueOnce(newer);
    await refreshDelegationState(task.id);
    resolve?.(failure);
    await older;
    expect(delegationStates[task.id]?.messages[0].reason).toBeUndefined();
    expect(delegationStates[task.id]?.messages[0].deliveryFailed).toBeUndefined();
  });

  it('keeps a detached child paused when an earlier child snapshot arrives', async () => {
    setStore('tasks', task.id, 'coordinatedBy', 'parent');
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    changed?.({ taskId: 'parent', detachedChildIds: [task.id] });
    resolve?.(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.tasks[task.id].coordinatedBy).toBeUndefined();
    expect(store.tasks[task.id].delegationPaused).toBe(true);
    expect(delegationStates[task.id]).toBeUndefined();
  });

  it('does not revive a removed task from an in-flight snapshot or late event', async () => {
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    changed?.({ taskId: task.id, state: failure });
    setStore(
      'tasks',
      produce((tasks) => delete tasks.recipient),
    );
    resolve?.(failure);
    await vi.advanceTimersByTimeAsync(0);
    changed?.({ taskId: task.id, state: failure });
    expect(delegationStates[task.id]).toBeUndefined();
  });

  it('disposes the subscription and ignores pending snapshots and later task insertions', async () => {
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
    resolve?.(failure);
    setStore('tasks', 'later', { ...task, id: 'later' });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    expect(delegationStates[task.id]).toBeUndefined();
  });

  it('does not apply a removed task snapshot to an adopted replacement with the same ID', async () => {
    let resolve: ((state: DelegationState) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    cleanup = startDelegationStateHydration();
    await vi.advanceTimersByTimeAsync(0);
    setStore(
      'tasks',
      produce((tasks) => delete tasks.recipient),
    );
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(invoke).mockResolvedValueOnce({ attempts: [], messages: [], paused: true });
    setStore('tasks', task.id, { ...task, name: 'Replacement' });
    await vi.advanceTimersByTimeAsync(0);
    resolve?.(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(delegationStates[task.id]?.paused).toBe(true);
    expect(delegationStates[task.id]?.messages).toEqual([]);
  });
});

it('delivers an explicitly requested user handoff under human control, without taking control', async () => {
  inbox([{ ...message(), origin: 'user' }]);
  setStore('tasks', task.id, 'controlledBy', 'human');
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered).toHaveBeenCalledOnce();
  expect(store.tasks[task.id].controlledBy).toBe('human');
});

it.each([{ promptDraft: 'draft' }, { terminalInputPending: true }, { promptDraftActive: true }])(
  'keeps user handoffs to the main agent queued when human input is present: %j',
  async (blocked) => {
    inbox([{ ...message('one', 'first'), origin: 'user' }]);
    setStore('tasks', task.id, { controlledBy: 'human', ...blocked });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([
  { promptDraft: 'draft' },
  { promptDraftActive: true },
  { prefillPrompt: 'Main pane instructions' },
  {
    autoSendChildUpdates: true,
    stagedNotification: {
      batchId: 'completion',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited: false,
    },
  },
])('delivers a second opinion without waiting for the main agent composer: %j', async (draft) => {
  inbox([{ ...message(), origin: 'user' }]);
  setStore('tasks', task.id, { controlledBy: 'human', ...draft });
  await vi.advanceTimersByTimeAsync(1000);
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'deliverMessage',
    deliveryId: 'one',
    agentId: 'second',
    sessionInstanceId: 'second-instance',
  });
  expect(delivered).toHaveBeenCalledOnce();
  expect(store.tasks[task.id]).toMatchObject(draft);
});

it('keeps second opinions queued while terminal input is pending', async () => {
  inbox([{ ...message(), origin: 'user' }]);
  setStore('tasks', task.id, 'terminalInputPending', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(invoke).not.toHaveBeenCalled();
});
