// What the coordinator learns from its agents' terminals: PTY exits, respawns,
// interrupts and submitted prompts, plus lifecycle hook events. Also the
// per-agent output subscription and buffers those events reset.

import type { CoordinatorInternals } from './internals.js';
import { onPtyEvent, subscribeToAgent, unsubscribeFromAgent } from '../../ipc/pty.js';
import { onAgentHookEvent } from '../../agent-hooks/events.js';
import type { AgentHookEventPayload } from '../../agent-hooks/status.js';
import type { CoordinatedTask } from '../types.js';
import { findTaskByAgentId, advanceReviewRevision, withdrawCloseSuggestion } from './internals.js';

// Tool hooks of an interrupted turn can still land shortly after the Esc; no
// Stop follows them, so they must not re-arm hook ownership (mirrors the
// renderer's INTERRUPT_SUPPRESS_MS).
const HOOK_INTERRUPT_SUPPRESS_MS = 5_000;
const HOOK_TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

/** True for a tool hook that belongs to a turn the user has already interrupted.
 *  Turn boundaries (UserPromptSubmit, SessionStart, Stop) end the window early. */
export function isToolHookOfInterruptedTurn(
  c: CoordinatorInternals,
  evt: AgentHookEventPayload,
): boolean {
  const since = c.interruptedAt.get(evt.agentId);
  if (since === undefined) return false;
  if (!HOOK_TOOL_EVENTS.has(evt.event) || evt.at - since >= HOOK_INTERRUPT_SUPPRESS_MS) {
    c.interruptedAt.delete(evt.agentId);
    return false;
  }
  return true;
}

export function handleAgentHookEvent(c: CoordinatorInternals, evt: AgentHookEventPayload): void {
  const task = findTaskByAgentId(c, evt.agentId);
  if (!task) return;
  // A hook fired by a session that already exited must not revive its task.
  if (task.status === 'exited' || task.status === 'error') return;
  if (evt.event === 'UserPromptSubmit') advanceReviewRevision(c, task);
  if (isToolHookOfInterruptedTurn(c, evt)) return;
  c.hookLiveAgentIds.add(evt.agentId);
  if (evt.state === 'done') {
    // Stop/StopFailure/SessionStart cannot be prompt echo, so clear (not
    // consume) the echo-suppression window before the shared idle
    // transition. The idle_prompt notification fires ~60 s after the previous
    // turn and can race a prompt sent just now, so it stays subject to it.
    // stableAgentPrompt=false: Stop fires before the TUI repaints its input
    // prompt, so queued prompts go through the delayed, ❯-checked flush.
    if (evt.event !== 'Notification') {
      task.suppressIdleUntil = undefined;
      task.lastPromptEchoText = undefined;
    }
    c.prompts.handlePromptDetected(task, false, 'hook');
    return;
  }
  // 'working' and 'waiting' both mean the agent is mid-turn.
  c.prompts.markPromptStarted(task);
  c.promptReadySeenAt.delete(task.id);
  if (task.status === 'idle') {
    task.status = 'running';
    c.notifications.suppressPendingNotificationForTask(task);
  }
}

// --- Per-task teardown helpers ---
// Shared by cleanupLandedTaskResources, removeCoordinatedTask, cleanupTask,
// and deregisterCoordinator so the four paths can't drift apart.

/** Stop receiving PTY output for an agent and drop its subscriber callback. */
export function unsubscribeAgentOutput(c: CoordinatorInternals, agentId: string): void {
  const cb = c.subscribers.get(agentId);
  if (cb) {
    unsubscribeFromAgent(agentId, cb);
    c.subscribers.delete(agentId);
  }
}

/** Drop the per-agent output buffers (tail, bracketed-paste flag, decoder) and hook state. */
export function clearAgentBuffers(c: CoordinatorInternals, agentId: string): void {
  c.tailBuffers.delete(agentId);
  c.bracketedPasteAgentIds.delete(agentId);
  c.decoders.delete(agentId);
  c.hookLiveAgentIds.delete(agentId);
  c.interruptedAt.delete(agentId);
}

export function clearAgentOutputState(c: CoordinatorInternals, task: CoordinatedTask): void {
  unsubscribeAgentOutput(c, task.agentId);
  clearAgentBuffers(c, task.agentId);
}

/**
 * Subscribes to PTY and hook events for the lifetime of the app. The Coordinator
 * calls this once, from its constructor.
 */
export function listenToAgentEvents(c: CoordinatorInternals): void {
  // Listen for PTY exits to update task status when agents are killed externally
  // (e.g., user closes a child task from the UI).
  onPtyEvent('exit', (agentId, data) => {
    c.hookLiveAgentIds.delete(agentId);
    c.interruptedAt.delete(agentId);
    for (const task of c.tasks.values()) {
      if (task.agentId === agentId) {
        const { exitCode } = (data ?? {}) as { exitCode?: number };
        task.status = 'exited';
        task.exitCode = exitCode ?? null;
        // Resolve any idle waiters so they don't hang
        const resolvers = c.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve({ reason: 'exited' });
          c.idleResolvers.delete(task.id);
        }
        // Closing and archiving stop the agent on purpose; neither is a result to report.
        if (c.closingTaskIds.has(task.id) || task.archived) break;
        c.signalWaits.deliverExitToSignalWaiter(task);
        c.notifications.maybeQueueReviewNotification(task, 'exited', exitCode ?? null);
        break;
      }
    }
  });

  // Re-subscribe our output callback when the renderer reattaches to, or explicitly
  // replaces, a managed agent. Without this, our outputCb is lost and we can never
  // detect idle for that sub-task.
  onPtyEvent('spawn', (agentId, data) => {
    const outputCb = c.subscribers.get(agentId);
    if (!outputCb) return; // not a coordinated agent, or initial spawn (not yet subscribed)
    const reattached = (data as { reattached?: boolean } | undefined)?.reattached === true;
    if (!reattached) {
      c.hookLiveAgentIds.delete(agentId);
      c.tailBuffers.set(agentId, '');
    }
    for (const task of c.tasks.values()) {
      if (task.agentId === agentId && task.status === 'exited') {
        task.status = 'running';
        task.exitCode = null;
      }
      if (task.agentId === agentId) {
        if (!reattached) {
          // Only the user restoring the collapsed task respawns an archived child's agent;
          // they want it back, so the parent's waits count it again.
          if (task.archived) {
            task.archived = undefined;
            withdrawCloseSuggestion(c, task);
          }
          // A fresh process has an empty input line.
          task.unsubmittedPrompt = false;
          // Its empty prompt says nothing about prompts the old process took.
          task.promptSubmittedAt = undefined;
          task.promptStartedAt = undefined;
          advanceReviewRevision(c, task);
        }
        c.prompts.updateTailFromScrollback(task);
      }
    }
    subscribeToAgent(agentId, outputCb);
  });

  // A bare Esc/Ctrl+C ends the turn without a Stop hook, so hand idle
  // detection back to the ❯-regex path until the next hook event.
  onPtyEvent('interrupt', (agentId) => {
    c.hookLiveAgentIds.delete(agentId);
    c.interruptedAt.set(agentId, Date.now());
  });

  // Hookless native and renderer submissions must also cancel an in-flight
  // report capture. Focus, draft edits and secondary panes do not advance it.
  onPtyEvent('prompt-submitted', (agentId) => {
    const task = findTaskByAgentId(c, agentId);
    if (!task) return;
    // Any Enter, the human's included, submits a body whose own Enter failed.
    task.unsubmittedPrompt = false;
    advanceReviewRevision(c, task);
  });

  // Hook events (Claude Code lifecycle hooks) are the authoritative state
  // channel for agents that emit them; see handleAgentHookEvent.
  onAgentHookEvent((evt) => handleAgentHookEvent(c, evt));
}
