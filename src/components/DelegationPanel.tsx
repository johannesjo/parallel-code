import './Delegation.css';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { canResumeSessionId } from '../../electron/shared/session-resume';
import type { PeerMessage } from '../../electron/shared/delegation-types';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { theme } from '../lib/theme';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  MIN_COORDINATOR_CONCURRENT_TASKS,
} from '../lib/coordinator-limits';
import { store, setStore } from '../store/core';
import { restartAgent } from '../store/agents';
import { clearStagedNotification } from '../store/tasks';
import {
  delegationRequest,
  delegationStates,
  peerDeliveryBlocker,
  refreshDelegationState,
  hasUserMcpConfiguration,
  isSupportedDelegationAgent,
} from '../store/delegation';
import type { Task } from '../store/types';
import { getCoordinatorChildren } from '../store/sidebar-order';
import { CheckIcon, CloseIcon, CommentIcon, CopyIcon, PlayIcon, StopIcon, SyncIcon } from './icons';

export function DelegationPanel(props: {
  task: Task;
  canUseComposer?: (message: PeerMessage) => boolean;
  onUseComposer?: (message: PeerMessage) => boolean;
}) {
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<string>();
  const [copied, setCopied] = createSignal<string>();
  const autoSendChildUpdates = () => props.task.autoSendChildUpdates ?? props.task.coordinatorMode;
  const state = () => delegationStates[props.task.id];
  const children = () => {
    const all = getCoordinatorChildren(props.task.id);
    return [...all.active, ...all.collapsed];
  };
  const attempts = () => state()?.attempts.filter((a) => a.status !== 'created') ?? [];
  const messages = () => state()?.messages.filter((m) => m.state === 'waiting') ?? [];
  // A handoff seen leaving the queue is confirmed briefly, then dropped: the
  // recipient's terminal already shows the prompt, and a lasting line would
  // keep the task's terminals pushed down.
  const [recentHandoffs, setRecentHandoffs] = createSignal<readonly string[]>([]);
  const seenWaiting = new Set<string>();
  const confirmTimers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => confirmTimers.forEach(clearTimeout));
  createEffect(() => {
    for (const m of state()?.messages ?? []) {
      if (m.origin !== 'user') continue;
      if (m.state === 'waiting') seenWaiting.add(m.deliveryId);
      else if (seenWaiting.delete(m.deliveryId) && !m.deliveryFailed) {
        const id = m.deliveryId;
        setRecentHandoffs((ids) => [...ids, id]);
        const timer = setTimeout(() => {
          confirmTimers.delete(timer);
          setRecentHandoffs((ids) => ids.filter((entry) => entry !== id));
        }, 4_000);
        confirmTimers.add(timer);
      }
    }
  });
  const handoffs = () =>
    state()?.messages.filter((m) => recentHandoffs().includes(m.deliveryId)) ?? [];
  const agentLabel = (id: string, fallback: string) => store.agents[id]?.def.name ?? fallback;
  // The typing hold expires without a store change; tick so its reason clears.
  const [nowMs, setNowMs] = createSignal(Date.now());
  createEffect(() => {
    if (messages().length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    onCleanup(() => clearInterval(id));
  });
  const waitingReason = (message: PeerMessage) =>
    peerDeliveryBlocker(message, state() ?? { paused: false }, nowMs()) ??
    message.reason ??
    'Waiting for the recipient to be ready';
  const failures = () => state()?.messages.filter((m) => m.deliveryFailed) ?? [];
  const coordinating = () =>
    props.task.delegationParent ||
    props.task.coordinatorMode ||
    props.task.delegationPaused ||
    state()?.paused ||
    children().length > 0 ||
    attempts().length > 0;
  createEffect(() => {
    const taskId = props.task.id;
    void refreshDelegationState(taskId).catch((err: unknown) => setError(String(err)));
  });
  async function act(operation: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refreshDelegationState(props.task.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  const childLimit = () => props.task.maxConcurrentTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS;
  async function changeChildLimit(input: HTMLInputElement) {
    const parsed = parseInt(input.value, 10);
    const limit = Number.isNaN(parsed) ? childLimit() : clampCoordinatorConcurrentTasks(parsed);
    input.value = String(limit);
    if (limit === childLimit()) return;
    const taskId = props.task.id;
    // Store only after the backend accepts, so the shown limit is the enforced one.
    await act(async () => {
      await delegationRequest({ action: 'childLimit', taskId, limit });
      setStore('tasks', taskId, 'maxConcurrentTasks', limit);
    });
    // A rejected change leaves the store untouched, so the input must be reset by hand.
    input.value = String(childLimit());
  }
  async function copyMessage(message: PeerMessage) {
    // Copying is read-only: automatic delivery stays queued.
    await navigator.clipboard.writeText(message.prompt);
    setCopied(message.deliveryId);
  }
  async function useComposer(message: PeerMessage) {
    if (!props.onUseComposer?.(message)) {
      throw new Error(
        'The composer has a draft or the recipient changed. Keep this message queued or copy its text.',
      );
    }
    await delegationRequest({
      action: 'handleMessage',
      deliveryId: message.deliveryId,
      agentId: message.recipient.agentId,
      sessionInstanceId: message.recipient.sessionInstanceId,
      state: 'handled',
    });
  }
  // Chat mode registers only canvas tools, so no restart can give its pane delegation tools.
  const isChatPane = (agentId: string) =>
    props.task.mainAgentView === 'chat' && props.task.agentIds[0] === agentId;
  const rolloutAgents = () => {
    if (
      !store.mcpOrchestrationEnabled ||
      props.task.coordinatedBy ||
      props.task.coordinatorMode ||
      props.task.gitIsolation !== 'worktree'
    )
      return [];
    return props.task.agentIds
      .filter((id) => !isChatPane(id))
      .map((id) => store.agents[id])
      .filter(
        (agent) => agent && !agent.capabilities?.canCreate && isSupportedDelegationAgent(agent.def),
      );
  };
  const canResume = (agentId: string) => {
    const agent = store.agents[agentId];
    return (
      !!agent &&
      !!props.task.agentSessionIds?.[agentId] &&
      canResumeSessionId(agent.def.command) &&
      !hasUserMcpConfiguration(agent.def.args) &&
      !hasUserMcpConfiguration(agent.def.resume_args ?? [])
    );
  };
  async function restartForTools(agentId: string) {
    await invoke(IPC.KillAgent, { agentId });
    setStore('agents', agentId, 'requireResumeSuccess', true);
    restartAgent(agentId, true);
  }
  return (
    <Show
      when={
        coordinating() ||
        props.task.coordinatedBy ||
        props.task.stagedNotification ||
        messages().length > 0 ||
        handoffs().length > 0 ||
        failures().length > 0 ||
        rolloutAgents().length > 0
      }
    >
      <section
        class="delegation-surface delegation-panel"
        aria-label="Task collaboration"
        style={{
          padding: '6px 12px',
          'font-size': '12px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <For each={failures()}>
          {(message) => (
            <div role="alert" style={{ 'overflow-wrap': 'anywhere', 'margin-bottom': '8px' }}>
              <strong style={{ color: theme.error }}>Message delivery failed</strong>
              <div>
                From {message.origin === 'user' ? 'you' : message.sender.name} to{' '}
                {agentLabel(message.recipient.agentId, message.recipient.agentLabel)}
              </div>
              <p>{message.reason}</p>
              <button
                class="btn-with-icon"
                disabled={busy()}
                onClick={() =>
                  void act(() =>
                    delegationRequest({
                      action: 'dismissMessageFailure',
                      deliveryId: message.deliveryId,
                    }),
                  )
                }
              >
                <CloseIcon size={12} />
                Dismiss failure
              </button>
            </div>
          )}
        </For>
        <Show when={coordinating()}>
          <details>
            <summary>
              Subtask controls
              {props.task.delegationPaused || state()?.paused ? ' · Launches paused' : ''}
            </summary>
            <div
              style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' }}
            >
              <span>{children().length} subtasks</span>
              <label style={{ display: 'flex', gap: '4px', 'align-items': 'center' }}>
                Concurrent limit
                <input
                  type="number"
                  min={MIN_COORDINATOR_CONCURRENT_TASKS}
                  max={MAX_COORDINATOR_CONCURRENT_TASKS}
                  value={childLimit()}
                  disabled={busy()}
                  onChange={(e) => void changeChildLimit(e.currentTarget)}
                  style={{ width: '48px' }}
                />
              </label>
              <Show
                when={props.task.delegationPaused || state()?.paused}
                fallback={
                  <button
                    class="btn-with-icon"
                    disabled={busy()}
                    onClick={() =>
                      // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                      void act(() =>
                        delegationRequest({ action: 'pause', taskId: props.task.id, paused: true }),
                      )
                    }
                  >
                    <StopIcon size={12} />
                    Stop all subtasks
                  </button>
                }
              >
                <span>Subtask launches paused; worktrees are preserved.</span>
                <button
                  class="btn-with-icon"
                  disabled={busy()}
                  onClick={() =>
                    // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                    void act(() =>
                      delegationRequest({ action: 'pause', taskId: props.task.id, paused: false }),
                    )
                  }
                >
                  <PlayIcon size={12} />
                  Resume subtask launches
                </button>
              </Show>
            </div>
          </details>
        </Show>
        <For each={attempts()}>
          {(attempt) => (
            <div role={attempt.status === 'failed' ? 'alert' : 'status'}>
              {attempt.name}:{' '}
              {attempt.status === 'starting'
                ? 'Starting…'
                : `Failed — ${attempt.error ?? 'Unknown startup error'}`}
              <Show when={attempt.status === 'failed'}>
                <button
                  class="btn-with-icon"
                  disabled={busy()}
                  onClick={() =>
                    // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                    void act(() =>
                      delegationRequest({
                        action: 'dismissAttempt',
                        parentTaskId: props.task.id,
                        requestId: attempt.requestId,
                      }),
                    )
                  }
                >
                  <CloseIcon size={12} />
                  Dismiss attempt
                </button>
              </Show>
            </div>
          )}
        </For>
        <Show when={!autoSendChildUpdates() && props.task.stagedNotification}>
          <details>
            <summary>
              Subtask updates ({props.task.stagedNotification?.notificationIds.length ?? 0})
            </summary>
            <pre style={{ 'white-space': 'pre-wrap', 'max-height': '130px', overflow: 'auto' }}>
              {props.task.stagedNotification?.text}
            </pre>
            <button
              class="btn-with-icon"
              disabled={busy()}
              onClick={() =>
                // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                void act(async () => {
                  const batch = props.task.stagedNotification;
                  if (!batch) return;
                  await invoke(IPC.MCP_CoordinatorNotificationAck, {
                    coordinatorTaskId: props.task.id,
                    batchId: batch.batchId,
                  });
                  clearStagedNotification(props.task.id);
                })
              }
            >
              <CheckIcon size={12} />
              Mark read
            </button>
            <small> Marks these updates as read without merging changes.</small>
          </details>
        </Show>
        <For each={handoffs()}>
          {(message) => (
            <div
              role="status"
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '4px 0',
                color: message.state === 'delivered' ? theme.success : undefined,
              }}
            >
              <Show when={message.state === 'delivered'}>
                <CheckIcon size={12} />
              </Show>
              {message.state === 'delivered'
                ? 'Delivered to '
                : message.state === 'handled'
                  ? 'Moved to composer for '
                  : 'Canceled for '}
              {agentLabel(message.recipient.agentId, message.recipient.agentLabel)}
              <Show when={message.state === 'closed' && message.reason}>: {message.reason}</Show>
            </div>
          )}
        </For>
        <Show when={messages().length > 0}>
          {/* A queued handoff is something you just sent; keep its status in view.
              Open once per new handoff, so a section the reader collapsed stays
              collapsed while reasons and other messages change. */}
          <details
            ref={(el) => {
              const shown = new Set<string>();
              createEffect(() => {
                for (const m of messages()) {
                  if (m.origin !== 'user' || shown.has(m.deliveryId)) continue;
                  shown.add(m.deliveryId);
                  el.open = true;
                }
              });
            }}
          >
            <summary>Queued messages ({messages().length})</summary>
            <p>
              Messages send automatically when the recipient is ready and your drafts and terminal
              input are clear. Copying text leaves delivery queued. Cancel delivery to prevent a
              queued message from being sent.
            </p>
            <For each={messages()}>
              {(message) => (
                <article
                  style={{
                    border: `1px solid ${theme.border}`,
                    padding: '8px',
                    margin: '8px 0',
                    'overflow-wrap': 'anywhere',
                  }}
                >
                  <strong>
                    {message.origin === 'user' ? 'You' : message.sender.name} ·{' '}
                    {agentLabel(message.sender.agentId, message.sender.agentLabel)}
                  </strong>
                  <div class="delegation-message-meta">
                    To {message.recipient.name} ·{' '}
                    {agentLabel(message.recipient.agentId, message.recipient.agentLabel)} ·{' '}
                    {new Date(message.createdAt).toLocaleTimeString()}
                  </div>
                  <div class="delegation-message-meta">{waitingReason(message)}</div>
                  <p style={{ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' }}>
                    {preview() === message.deliveryId
                      ? message.prompt
                      : message.prompt.slice(0, 180) + (message.prompt.length > 180 ? '…' : '')}
                  </p>
                  <div class="delegation-message-actions">
                    <Show when={message.prompt.length > 180}>
                      <button
                        aria-expanded={preview() === message.deliveryId}
                        onClick={() =>
                          setPreview(
                            preview() === message.deliveryId ? undefined : message.deliveryId,
                          )
                        }
                      >
                        {preview() === message.deliveryId ? 'Show less' : 'Show full message'}
                      </button>
                    </Show>
                    <Show when={props.canUseComposer?.(message)}>
                      <button
                        class="btn-with-icon"
                        disabled={busy()}
                        onClick={() =>
                          // eslint-disable-next-line solid/reactivity -- act invokes the callback synchronously in this click handler.
                          void act(() => useComposer(message))
                        }
                      >
                        <CommentIcon size={12} />
                        Use in composer
                      </button>
                    </Show>
                    <button
                      class="btn-with-icon"
                      disabled={busy()}
                      onClick={() => void act(() => copyMessage(message))}
                    >
                      {copied() === message.deliveryId ? (
                        <CheckIcon size={12} />
                      ) : (
                        <CopyIcon size={12} />
                      )}
                      {copied() === message.deliveryId ? 'Copied' : 'Copy text'}
                    </button>
                    <button
                      disabled={busy()}
                      onClick={() =>
                        void act(() =>
                          delegationRequest({
                            action: 'handleMessage',
                            deliveryId: message.deliveryId,
                            agentId: message.recipient.agentId,
                            sessionInstanceId: message.recipient.sessionInstanceId,
                            state: 'closed',
                          }),
                        )
                      }
                      class="delegation-cancel-delivery"
                    >
                      Cancel delivery
                    </button>
                  </div>
                  <Show when={props.canUseComposer?.(message)}>
                    <small>
                      Use in composer moves this message into your draft without sending.
                    </small>
                  </Show>
                  <span role="status" class="delegation-message-meta">
                    {copied() === message.deliveryId
                      ? 'Copied to clipboard. Delivery remains queued.'
                      : ''}
                  </span>
                </article>
              )}
            </For>
          </details>
        </Show>
        <Show when={rolloutAgents().length > 0}>
          <For each={rolloutAgents()}>
            {(agent) => (
              <div>
                <Show
                  when={canResume(agent.id)}
                  fallback={
                    <small>
                      {agent.def.name}: delegation tools require a managed MCP configuration and a
                      resumable conversation. Start a new task session to acquire tools.
                    </small>
                  }
                >
                  <button
                    class="btn-with-icon"
                    disabled={busy()}
                    onClick={() => void act(() => restartForTools(agent.id))}
                  >
                    <SyncIcon size={12} />
                    Restart and resume {agent.def.name} to enable delegation tools
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <Show when={props.task.coordinatedBy}>
          <small>
            {props.task.integrationPolicy === 'review'
              ? 'Changes require review before merging.'
              : 'Subtask updates are reported to the parent task.'}
          </small>
        </Show>
        <Show when={error()}>
          <p role="alert" style={{ color: theme.error }}>
            {error()}
          </p>
        </Show>
      </section>
    </Show>
  );
}
