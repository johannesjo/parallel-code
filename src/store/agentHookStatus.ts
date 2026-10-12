import { createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import {
  AGENT_HOOK_STALE_MS,
  isAgentActivityObservation,
  isAgentActivitySnapshot,
  transitionAgentHookStatus,
  type AgentActivityObservation,
  type AgentActivitySnapshot,
  type AgentHookEventPayload,
  type AgentHookPrompt,
  type AgentHookStatusState,
  type ReducedAgentHookStatus,
} from '../../electron/agent-hooks/status';
import { formatRelativeAge } from '../lib/relativeAge';
import { invoke } from '../lib/ipc';
import { errMessage, warn } from '../lib/log';
import { store } from './core';

/**
 * Status an agent reported about itself through Claude Code hooks. Unlike the
 * PTY heuristics in `taskStatus.ts`, this is a hook report, except for explicitly
 * labeled local input inferences. `done` may mean ready or a finished turn.
 */
export interface AgentHookStatus {
  state: AgentHookStatusState;
  /** Hook event that produced this state, or `Interrupt` / `PermissionAnswered`
   *  when inferred from a keypress. */
  event: string;
  prompt?: AgentHookPrompt;
  /** When the agent entered this state (epoch ms); kept across same-state events. */
  since: number;
  updatedAt: number;
  toolName?: string;
  /** The tool call a `waiting` dialog belongs to; kept across same-state events. */
  toolUseId?: string;
  detail?: string;
  lastAssistantMessage?: string;
  /** The turn ended while the task was not on screen and nobody has looked since. */
  unread: boolean;
  launchId?: string;
  source?: 'hook' | 'terminal';
}

export interface TaskAgentHookStatus extends AgentHookStatus {
  agentId: string;
}

/** A `working` claim this old has lost its hook stream; heuristics take over. */
export { AGENT_HOOK_STALE_MS };
/** Esc/Ctrl-C only counts as an interrupt if no hook event follows within this window. */
const INTERRUPT_SETTLE_MS = 500;
/** Tool events of the interrupted turn can still land shortly after; ignore them. */
const INTERRUPT_SUPPRESS_MS = 5_000;
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);
const ESC = '\x1b';
const CTRL_C = '\x03';
/** Enter in its terminal spellings (incl. kitty keyboard protocol) plus the digit shortcuts of Claude's dialogs. */
const ANSWER_INPUTS: ReadonlySet<string> = new Set([
  '\r',
  '\n',
  '\r\n',
  '\x1b[13u',
  '\x1b[13;1u',
  ...'123456789',
]);

const [statuses, setStatuses] = createSignal<ReadonlyMap<string, AgentHookStatus>>(new Map());
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const interruptTimers = new Map<string, ReturnType<typeof setTimeout>>();
const suppressToolEventsUntil = new Map<string, number>();
// Retain retirement sequences so an in-flight snapshot cannot revive an exit.
const observationSequences = new Map<string, number>();
let snapshotSequence = -1;

function updateStatuses(mutate: (next: Map<string, AgentHookStatus>) => void): void {
  setStatuses((prev) => {
    const next = new Map(prev);
    mutate(next);
    return next;
  });
}

function clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, agentId: string): void {
  const timer = timers.get(agentId);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(agentId);
}

function setStatus(agentId: string, status: AgentHookStatus): void {
  updateStatuses((next) => next.set(agentId, status));
  clearTimer(staleTimers, agentId);
  // Only `working` can go stale: a working agent keeps firing hooks, so long
  // silence means the stream was lost. A waiting agent is silent by design
  // until someone answers, and an unanswered prompt matters most after a long
  // absence. `done` is a terminal fact and stays put.
  if (status.state !== 'working') return;
  const remaining = status.updatedAt + AGENT_HOOK_STALE_MS - Date.now();
  if (remaining <= 0) {
    updateStatuses((next) => next.delete(agentId));
    return;
  }
  staleTimers.set(
    agentId,
    setTimeout(() => {
      staleTimers.delete(agentId);
      updateStatuses((next) => next.delete(agentId));
    }, remaining),
  );
}

function isSuppressedToolEvent(event: AgentHookEventPayload): boolean {
  const until = suppressToolEventsUntil.get(event.agentId);
  if (until === undefined) return false;
  if (event.at >= until) {
    suppressToolEventsUntil.delete(event.agentId);
    return false;
  }
  return TOOL_EVENTS.has(event.event);
}

export function applyAgentHookEvent(event: AgentHookEventPayload): boolean {
  // Any real event during the settle window means the keypress was not an interrupt.
  clearTimer(interruptTimers, event.agentId);
  if (isSuppressedToolEvent(event)) return false;
  const prev = statuses().get(event.agentId);
  const reduced = transitionAgentHookStatus(prev, event);
  if (reduced === prev) return false;
  setHookStatus(event, reduced);
  return true;
}

/** Only unread bookkeeping is carried across accepted hook observations. */
function setHookStatus(event: AgentHookEventPayload, status: ReducedAgentHookStatus): void {
  const prev = statuses().get(event.agentId);
  const sameState = prev?.state === event.state;
  const finished = event.event === 'Stop' || event.event === 'StopFailure';
  setStatus(event.agentId, {
    ...status,
    launchId: event.launchId ?? prev?.launchId,
    source: 'hook',
    unread: finished
      ? event.taskId !== store.activeTaskId
      : sameState && event.state === 'done' && prev.unread,
  });
}

/** Main observations are already reduced; the snapshot must retain their onset. */
export function applyAgentActivityObservation(observation: AgentActivityObservation): void {
  if (
    observation.sequence <= snapshotSequence ||
    observation.sequence <= (observationSequences.get(observation.agentId) ?? -1)
  )
    return;
  observationSequences.set(observation.agentId, observation.sequence);
  const prev = statuses().get(observation.agentId);
  if (observation.kind !== 'hook') {
    clearAgentHookStatus(observation.agentId);
    return;
  }
  if (prev?.launchId !== observation.launchId) clearAgentHookStatus(observation.agentId);
  clearTimer(interruptTimers, observation.agentId);
  if (isSuppressedToolEvent(observation)) return;
  // Main already matched tool results and reduced this state. Reducing it
  // against local inference can invent hook details or reject a newer snapshot.
  setHookStatus(observation, { ...observation, updatedAt: observation.at });
}

export function applyAgentActivitySnapshot(snapshot: AgentActivitySnapshot): void {
  if (snapshot.sequence <= snapshotSequence) return;
  for (const observation of snapshot.observations) applyAgentActivityObservation(observation);
  const present = new Set(snapshot.observations.map((observation) => observation.agentId));
  for (const agentId of new Set([...statuses().keys(), ...observationSequences.keys()])) {
    if (!present.has(agentId) && (observationSequences.get(agentId) ?? -1) <= snapshot.sequence) {
      clearAgentHookStatus(agentId);
      observationSequences.delete(agentId);
    }
  }
  snapshotSequence = snapshot.sequence;
}

/**
 * Two things the hook stream cannot say are visible in what the user types.
 * Claude Code fires no `Stop` for a user interrupt, so a bare Esc or Ctrl-C
 * while working is the only signal; and nothing fires between approving a
 * permission dialog and the tool finishing, so an approved long command would
 * sit at "Needs you" for its whole run. Both are inferences: the interrupt
 * waits out a settle window, the approval is corrected by the next hook event.
 */
export function noteAgentTerminalInput(agentId: string, data: string): void {
  const current = statuses().get(agentId);
  if (!current) return;
  if (current.state === 'working' && (data === ESC || data === CTRL_C)) {
    scheduleInterrupt(agentId, current.updatedAt);
    return;
  }
  // AskUserQuestion is left alone: a digit only advances a multi-question
  // prompt, and its own PostToolUse clears the wait promptly anyway.
  if (current.state === 'waiting' && current.prompt === 'permission' && ANSWER_INPUTS.has(data)) {
    const now = Date.now();
    setStatus(agentId, {
      ...current,
      state: 'working',
      event: 'PermissionAnswered',
      source: 'terminal',
      since: now,
      updatedAt: now,
      prompt: undefined,
      unread: false,
    });
  }
}

/** Confirm the interrupt only if no hook event lands in the settle window;
 *  otherwise the key meant something else (a menu, a dialog) and the turn is live. */
function scheduleInterrupt(agentId: string, baseline: number): void {
  clearTimer(interruptTimers, agentId);
  interruptTimers.set(
    agentId,
    setTimeout(() => {
      interruptTimers.delete(agentId);
      const latest = statuses().get(agentId);
      if (latest?.state !== 'working' || latest.updatedAt !== baseline) return;
      const now = Date.now();
      suppressToolEventsUntil.set(agentId, now + INTERRUPT_SUPPRESS_MS);
      setStatus(agentId, {
        state: 'done',
        event: 'Interrupt',
        source: 'terminal',
        launchId: latest.launchId,
        since: now,
        updatedAt: now,
        detail: 'Interrupted',
        unread: false,
      });
    }, INTERRUPT_SETTLE_MS),
  );
}

export function getAgentHookStatus(agentId: string): AgentHookStatus | null {
  return statuses().get(agentId) ?? null;
}

export function getAgentActivitySubject(agentId: string): string {
  const name = store.agents?.[agentId]?.def?.name;
  return name ? `Agent ${name} (${agentId.slice(0, 8)})` : `Agent ${agentId}`;
}

/** Diagnostic provenance; task attention may summarize several different panes. */
export function formatAgentHookTooltip(status: TaskAgentHookStatus, nowMs?: number): string {
  const activity =
    status.state === 'waiting'
      ? status.prompt === 'permission'
        ? 'Waiting for approval'
        : 'Waiting for an answer'
      : status.state === 'working'
        ? 'Working'
        : status.event === 'SessionStart'
          ? 'Session ready'
          : status.event === 'StopFailure'
            ? 'Turn failed'
            : status.event === 'Stop'
              ? 'Turn finished'
              : status.event === 'Interrupt'
                ? 'Interrupted'
                : 'Ready for input';
  const source =
    status.source === 'terminal' ? 'Activity inferred from terminal input' : 'hook report';
  const age = nowMs === undefined ? undefined : formatRelativeAge(status.updatedAt, nowMs);
  const observed =
    age === undefined
      ? `observed ${new Date(status.updatedAt).toLocaleString()}`
      : age === 'just now'
        ? 'observed just now'
        : `observed ${age} ago`;
  return `${getAgentActivitySubject(status.agentId)} · ${activity}${status.detail ? `: ${status.detail}` : ''} · ${source} (${status.event}) · ${observed}`;
}

export function clearAgentHookStatus(agentId: string): void {
  clearTimer(staleTimers, agentId);
  clearTimer(interruptTimers, agentId);
  suppressToolEventsUntil.delete(agentId);
  if (!statuses().has(agentId)) return;
  updateStatuses((next) => next.delete(agentId));
}

const STATE_RANK: Record<AgentHookStatusState, number> = { waiting: 0, working: 1, done: 2 };

/** The task's most attention-worthy agent status: waiting beats working beats done, newest wins ties. */
export function getTaskAgentHookStatus(taskId: string): TaskAgentHookStatus | null {
  const task = store.tasks[taskId];
  if (!task) return null;
  const all = statuses();
  let best: TaskAgentHookStatus | null = null;
  for (const agentId of task.agentIds) {
    const status = all.get(agentId);
    if (!status) continue;
    const outranks =
      best === null ||
      STATE_RANK[status.state] < STATE_RANK[best.state] ||
      (STATE_RANK[status.state] === STATE_RANK[best.state] && status.updatedAt > best.updatedAt);
    if (outranks) best = { ...status, agentId };
  }
  return best;
}

export function isTaskUnread(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task) return false;
  const all = statuses();
  return task.agentIds.some((agentId) => all.get(agentId)?.unread === true);
}

export function markTaskRead(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const all = statuses();
  const unread = task.agentIds.filter((agentId) => all.get(agentId)?.unread === true);
  if (unread.length === 0) return;
  updateStatuses((next) => {
    for (const agentId of unread) {
      const status = next.get(agentId);
      if (status) next.set(agentId, { ...status, unread: false });
    }
  });
}

/** Subscribe to hook events from the main process; returns the unsubscribe. */
export function startAgentHookStatusListener(): () => void {
  let disposed = false;
  // eslint-disable-next-line solid/reactivity -- IPC callback is not a reactive context; it writes our own signal
  const off = window.electron.ipcRenderer.on(IPC.AgentHookEvent, (data: unknown) => {
    if (isAgentActivityObservation(data)) applyAgentActivityObservation(data);
  });
  // Subscribe first: a response may be older than events received during its read.
  void invoke<unknown>(IPC.AgentHookSnapshot)
    // eslint-disable-next-line solid/reactivity -- asynchronous IPC response writes our own signal
    .then((snapshot) => {
      if (!disposed && isAgentActivitySnapshot(snapshot)) applyAgentActivitySnapshot(snapshot);
    })
    .catch((error: unknown) =>
      warn('agent-hooks', 'Could not read agent activity evidence', { error: errMessage(error) }),
    );
  // Opening a task is how the user "reads" it; runs outside the mount owner
  // because callers start this past an await.
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      const taskId = store.activeTaskId;
      untrack(() => {
        if (taskId) markTaskRead(taskId);
      });
    });
    return dispose;
  });
  return () => {
    disposed = true;
    off();
    dispose();
  };
}
