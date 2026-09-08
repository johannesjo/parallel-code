import { createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import {
  isAgentHookEventPayload,
  type AgentHookEventPayload,
  type AgentHookPrompt,
  type AgentHookStatusState,
} from '../../electron/agent-hooks/status';
import { store } from './core';

/**
 * Status an agent reported about itself through Claude Code hooks. Unlike the
 * PTY heuristics in `taskStatus.ts`, this is authoritative: `working` means a
 * turn is in flight, `waiting` means it is blocked on the human, `done` means
 * the turn ended. Absent for shells, Docker agents, and non-Claude agents.
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
}

export interface TaskAgentHookStatus extends AgentHookStatus {
  agentId: string;
}

/** A `working`/`waiting` claim this old has lost its hook stream; heuristics take over. */
export const AGENT_HOOK_STALE_MS = 30 * 60_000;
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
  // `done` is a terminal fact and stays put; only an ongoing claim can go stale.
  if (status.state === 'done') return;
  staleTimers.set(
    agentId,
    setTimeout(() => {
      staleTimers.delete(agentId);
      updateStatuses((next) => next.delete(agentId));
    }, AGENT_HOOK_STALE_MS),
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

const TOOL_RESULT_EVENTS: ReadonlySet<string> = new Set(['PostToolUse', 'PostToolUseFailure']);

/** Claude runs sibling tool calls in parallel, so a result for some other call
 *  says nothing about the dialog the agent is parked on; only the matching
 *  result (or a non-tool event) ends the wait. Unknown ids fall back to
 *  treating any result as the end. */
function isUnrelatedToolResult(
  prev: AgentHookStatus | undefined,
  event: AgentHookEventPayload,
): boolean {
  if (prev?.state !== 'waiting' || !TOOL_RESULT_EVENTS.has(event.event)) return false;
  if (prev.toolUseId === undefined || event.toolUseId === undefined) return false;
  return prev.toolUseId !== event.toolUseId;
}

export function applyAgentHookEvent(event: AgentHookEventPayload): void {
  // Any real event during the settle window means the keypress was not an interrupt.
  clearTimer(interruptTimers, event.agentId);
  if (isSuppressedToolEvent(event)) return;
  const prev = statuses().get(event.agentId);
  if (isUnrelatedToolResult(prev, event)) return;
  const sameState = prev?.state === event.state;
  const finished = event.event === 'Stop' || event.event === 'StopFailure';
  setStatus(event.agentId, {
    state: event.state,
    event: event.event,
    since: sameState ? prev.since : event.at,
    updatedAt: event.at,
    toolName: event.toolName,
    toolUseId:
      event.toolUseId ?? (sameState && event.state === 'waiting' ? prev.toolUseId : undefined),
    detail: event.detail,
    prompt: event.prompt ?? (sameState && event.state === 'waiting' ? prev.prompt : undefined),
    // A later idle-prompt notification must not wipe the final message Stop carried,
    // nor count as the user having looked: only opening the task clears unread.
    lastAssistantMessage:
      event.lastAssistantMessage ??
      (sameState && event.state === 'done' ? prev.lastAssistantMessage : undefined),
    unread: finished
      ? event.taskId !== store.activeTaskId
      : sameState && event.state === 'done' && prev.unread,
  });
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
  // eslint-disable-next-line solid/reactivity -- IPC callback is not a reactive context; it writes our own signal
  const off = window.electron.ipcRenderer.on(IPC.AgentHookEvent, (data: unknown) => {
    if (isAgentHookEventPayload(data)) applyAgentHookEvent(data);
  });
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
    off();
    dispose();
  };
}
