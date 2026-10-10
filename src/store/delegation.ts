import { createEffect, createRoot, untrack } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type {
  DelegationChanged,
  DelegationRequest,
  DelegationState,
  PeerMessage,
  TaskAuthorityInput,
} from '../../electron/shared/delegation-types';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import { store, setStore } from './core';
import { isLandedTaskState } from './landing';
import { isHiddenAgentTaskId } from '../documents/task-id';
import type { AgentDef } from '../ipc/types';
import type { PersistedTask, Project, Task } from './types';

export const [delegationStates, setDelegationStates] = createStore<Record<string, DelegationState>>(
  {},
);

export function delegationRequest<T>(request: DelegationRequest): Promise<T> {
  return invoke<T>(IPC.DelegationRequest, request);
}

/** Acknowledge the backend policy before displaying or persisting a change. */
export async function setMcpOrchestrationEnabled(enabled: boolean): Promise<void> {
  await delegationRequest({ action: 'orchestrationSetting', enabled });
  setStore('mcpOrchestrationEnabled', enabled);
}

export function taskAuthorityInput(
  task: Task | PersistedTask,
  project: Project,
  agent: AgentDef | undefined,
  agentEnvFile?: string,
): TaskAuthorityInput {
  return {
    taskId: task.id,
    name: task.name,
    projectId: project.id,
    projectRoot: project.path,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    gitIsolation: task.gitIsolation,
    parentTaskId: task.coordinatedBy,
    coordinatorMode: task.coordinatorMode,
    autoMergeChildren: task.autoMergeChildren,
    autoSendChildUpdates: task.autoSendChildUpdates,
    externalWorktree: task.externalWorktree,
    integrationPolicy: task.integrationPolicy,
    delegationPaused: task.delegationPaused,
    delegationParent: task.delegationParent,
    agentCommand: agent?.command ?? '',
    agentArgs: agent?.args ?? [],
    agentEnvFile,
    dockerMode: task.dockerMode,
    dockerImage: task.dockerImage,
    verifyCommand: project.verifyCommand,
    maxConcurrentTasks: task.maxConcurrentTasks,
    propagateSkipPermissions: task.propagateSkipPermissions,
  };
}

export async function registerTaskAuthority(task: Task, agent?: AgentDef): Promise<void> {
  const project = store.projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error('Project not found');
  const registeredTask = store.tasks[task.id];
  await delegationRequest({
    action: 'register',
    task: taskAuthorityInput(
      task,
      project,
      agent,
      agent ? store.agentEnvFiles[agent.id] : undefined,
    ),
  });
  if (!registeredTask || store.tasks[task.id] !== registeredTask) return;
  void refreshDelegationState(task.id).catch((error: unknown) => {
    logWarn('delegation.hydration', 'Delegation state hydration failed', {
      taskId: task.id,
      error: String(error),
    });
  });
}

let nextStateRevision = 0;
const stateRevisions = new Map<string, number>();

export function applyDelegationChange(change: DelegationChanged): void {
  stateRevisions.set(change.taskId, ++nextStateRevision);
  if ('state' in change) {
    if (!store.tasks[change.taskId]) return;
    setDelegationStates(change.taskId, reconcile(change.state));
    setStore('tasks', change.taskId, 'delegationPaused', change.state.paused);
    if (change.state.attempts.length > 0)
      setStore('tasks', change.taskId, 'delegationParent', true);
  } else {
    for (const id of change.detachedChildIds) {
      stateRevisions.set(id, ++nextStateRevision);
      if (!store.tasks[id]) continue;
      setStore('tasks', id, {
        coordinatedBy: undefined,
        controlledBy: undefined,
        mcpConfigPath: undefined,
        mcpLaunchArgs: undefined,
        integrationPolicy: undefined,
        delegationPaused: true,
        mcpStartupStatus: undefined,
        mcpStartupError: undefined,
      });
    }
  }
}

async function loadDelegationState(taskId: string, isCurrent: () => boolean): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;
  const revision = ++nextStateRevision;
  stateRevisions.set(taskId, revision);
  const state = await delegationRequest<DelegationState>({ action: 'state', taskId });
  if (
    state &&
    isCurrent() &&
    store.tasks[taskId] === task &&
    stateRevisions.get(taskId) === revision
  )
    applyDelegationChange({ taskId, state });
}

export function refreshDelegationState(taskId: string): Promise<void> {
  return loadDelegationState(taskId, () => true);
}

/** Subscribe before reading snapshots; task adoption and restoration need no mounted panel. */
export function startDelegationStateHydration(): () => void {
  let disposed = false;
  const unsubscribe = window.electron.ipcRenderer.on(IPC.DelegationChanged, (data: unknown) => {
    if (!disposed) applyDelegationChange(data as DelegationChanged);
  });
  const dispose = createRoot((dispose) => {
    let previous = new Map<string, Task>();
    createEffect(() => {
      const tasks = new Map(
        Object.entries(store.tasks).filter(
          ([id, task]) =>
            !isHiddenAgentTaskId(id) &&
            store.projects.find((project) => project.id === task.projectId)?.kind !== 'document',
        ),
      );
      untrack(() => {
        for (const taskId of previous.keys()) {
          if (tasks.has(taskId)) continue;
          setDelegationStates(produce((states) => delete states[taskId]));
          stateRevisions.delete(taskId);
        }
        for (const [taskId, task] of tasks) {
          if (previous.get(taskId) === task) continue;
          void loadDelegationState(taskId, () => !disposed).catch((error: unknown) => {
            if (!disposed && store.tasks[taskId] === task)
              logWarn('delegation.hydration', 'Delegation state hydration failed', {
                taskId,
                error: String(error),
              });
          });
        }
        previous = tasks;
      });
    });
    return dispose;
  });
  return () => {
    disposed = true;
    unsubscribe();
    dispose();
  };
}

const peerDeliveriesInFlight = new Set<string>();

/** Delivery runs independently of task panels, including for background children. */
export function startPeerMessageDelivery(onDelivered: (message: PeerMessage) => void): () => void {
  let disposed = false;
  const loggedFailures = new Set<string>();
  const timer = setInterval(() => {
    if (!store.mcpOrchestrationEnabled) return;
    const recipients = new Set<string>();
    for (const state of Object.values(delegationStates)) {
      for (const message of state.messages) {
        if (message.state !== 'waiting') continue;
        const { taskId, agentId, sessionInstanceId } = message.recipient;
        if (recipients.has(agentId)) continue;
        recipients.add(agentId);
        const task = store.tasks[taskId];
        const agent = store.agents[agentId];
        // The task composer targets the first pane. An explicit handoff to a
        // reviewer in another pane must not wait for that unrelated draft.
        const checkComposerDraft = message.origin !== 'user' || task?.agentIds[0] === agentId;
        if (
          peerDeliveriesInFlight.has(agentId) ||
          !task ||
          !agent ||
          agent.taskId !== taskId ||
          !task.agentIds.includes(agentId) ||
          agent.status === 'exited' ||
          (agent.sessionInstanceId && agent.sessionInstanceId !== sessionInstanceId) ||
          task.closingStatus === 'closing' ||
          task.closingStatus === 'removing' ||
          isLandedTaskState(task.landingState) ||
          task.delegationPaused ||
          state.paused ||
          (task.controlledBy === 'human' && message.origin !== 'user') ||
          task.initialPrompt ||
          task.automationWriteInFlight ||
          (checkComposerDraft && (task.promptDraftActive || task.promptDraft?.trim())) ||
          task.terminalInputPending ||
          (task.userActivityHoldUntil ?? 0) > Date.now() ||
          (checkComposerDraft && task.prefillPrompt) ||
          // Manual completion summaries can remain unread indefinitely. Only
          // reserve input for an automatic notification or a user-edited one.
          (checkComposerDraft &&
            task.stagedNotification &&
            ((task.autoSendChildUpdates ?? task.coordinatorMode) ||
              task.stagedNotification.userEdited))
        )
          continue;
        const generation = agent.generation;
        peerDeliveriesInFlight.add(agentId);
        void delegationRequest<{
          deliveryId: string;
          state: PeerMessage['state'];
          reason?: string;
        }>({ action: 'deliverMessage', deliveryId: message.deliveryId, agentId, sessionInstanceId })
          .then((result) => {
            if (disposed || !untrack(() => store.tasks[taskId] && delegationStates[taskId])) return;
            setDelegationStates(taskId, 'messages', (m) => m.deliveryId === result.deliveryId, {
              state: result.state,
              reason: result.reason,
            });
            if (result.state === 'delivered' && store.agents[agentId]?.generation === generation)
              onDelivered(message);
          })
          .catch((error: unknown) => {
            if (disposed || loggedFailures.has(message.deliveryId)) return;
            loggedFailures.add(message.deliveryId);
            logWarn('delegation.delivery', 'Peer message delivery failed', {
              deliveryId: message.deliveryId,
              error: String(error),
            });
          })
          .finally(() => peerDeliveriesInFlight.delete(agentId));
      }
    }
  }, 1_000);
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

export function isSupportedDelegationAgent(agent: AgentDef): boolean {
  return ['claude', 'codex', 'copilot'].includes(agent.command.split('/').pop() ?? '');
}

export function hasUserMcpConfiguration(args: string[]): boolean {
  return args.some(
    (arg) =>
      /^(--mcp-config|--additional-mcp-config|--strict-mcp-config)(=|$)/.test(arg) ||
      /^(?:(?:--config|-c)=)?mcp_servers(?:\.|\[|=)/.test(arg),
  );
}

interface PeerComposer {
  getText(): string;
  setText(value: string): void;
}

/** A composer belongs to the first pane; peer messages never select a different pane. */
export function canUsePeerComposer(
  task: Task,
  message: PeerMessage,
  composer: PeerComposer | undefined,
  enabled: boolean,
): boolean {
  const agentId = task.agentIds[0];
  return (
    enabled &&
    !!composer &&
    message.state === 'waiting' &&
    !peerDeliveriesInFlight.has(agentId) &&
    message.recipient.taskId === task.id &&
    message.recipient.agentId === agentId &&
    !!store.agents[agentId]?.sessionInstanceId &&
    store.agents[agentId].sessionInstanceId === message.recipient.sessionInstanceId &&
    composer.getText() === ''
  );
}

/** Called synchronously by the explicit Review action; never submits terminal input. */
export function usePeerComposer(
  task: Task,
  message: PeerMessage,
  composer: PeerComposer | undefined,
  enabled: boolean,
): boolean {
  if (!composer || !canUsePeerComposer(task, message, composer, enabled)) return false;
  composer.setText(message.prompt);
  setStore('tasks', task.id, 'promptDraftActive', true);
  return true;
}
