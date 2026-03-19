import { createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { WorktreeStatus } from '../ipc/types';
import {
  stripAnsi as sharedStripAnsi,
  PROMPT_PATTERNS as SHARED_PROMPT_PATTERNS,
  chunkContainsAgentPrompt as sharedChunkContainsAgentPrompt,
} from '../../electron/mcp/prompt-detect';

// --- Trust-specific patterns (subset of QUESTION_PATTERNS) ---
// These are auto-accepted when autoTrustFolders is enabled.
// Note: TUI apps (Ink/blessed) use ANSI cursor-positioning to lay out text.
// After stripping ANSI, words run together (e.g. "Itrustthisfolder"),
// so patterns must work without word boundaries or spaces.
const TRUST_PATTERNS: RegExp[] = [
  /\btrust\b.*\?/i, // normal text with spaces: "trust this folder?"
  /\ballow\b.*\?/i, // normal text: "allow access?"
  /trust.*folder/i, // TUI-garbled: "Itrustthisfolder"
];

// Safety guard: reject auto-trust if the dialog mentions dangerous operations.
// Uses \b so garbled TUI text ("forkeyboardshortcuts") doesn't false-positive.
// In garbled text, \b doesn't match between concatenated words — that's fine:
// Claude Code's trust dialog content is fixed and won't contain these keywords.
const TRUST_EXCLUSION_KEYWORDS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

// Debounce: tracks agents with a pending or recently-fired auto-trust.
// Cleared after a cooldown so subsequent trust dialogs are also auto-accepted.
const autoTrustTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autoTrustCooldowns = new Map<string, ReturnType<typeof setTimeout>>();

function isAutoTrustPending(agentId: string): boolean {
  return autoTrustTimers.has(agentId) || autoTrustCooldowns.has(agentId);
}

// Throttle for background (non-active) auto-trust checks so we don't run
// ANSI strip + regex on every PTY chunk from every agent.
const AUTO_TRUST_BG_THROTTLE_MS = 500;
const lastAutoTrustCheckAt = new Map<string, number>();

// Tracks when auto-trust last accepted a dialog for each agent.
// Used to enforce a settling period before auto-send can fire — some agents
// (e.g. Claude Code) render their ❯ prompt before fully initializing.
const autoTrustAcceptedAt = new Map<string, number>();
const POST_AUTO_TRUST_SETTLE_MS = 1_000;

/** True while auto-trust is handling or settling a dialog for this agent.
 *  Covers both the pending phase (timer scheduled, Enter not yet sent) and
 *  the settling phase (Enter sent, agent still initializing).
 *  Auto-send should wait until this returns false.
 *  Note: cleans up expired entries as a side effect to avoid a separate timer. */
export function isAutoTrustSettling(agentId: string): boolean {
  // Pending: auto-trust timer is scheduled but hasn't fired yet, or cooldown
  // is active (Enter just sent, waiting for PTY output to transition).
  if (isAutoTrustPending(agentId)) return true;
  const acceptedAt = autoTrustAcceptedAt.get(agentId);
  if (!acceptedAt) return false;
  if (Date.now() - acceptedAt >= POST_AUTO_TRUST_SETTLE_MS) {
    autoTrustAcceptedAt.delete(agentId);
    return false;
  }
  return true;
}

function clearAutoTrustState(agentId: string): void {
  lastAutoTrustCheckAt.delete(agentId);
  autoTrustAcceptedAt.delete(agentId);
  const timer = autoTrustTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    autoTrustTimers.delete(agentId);
  }
  const cooldown = autoTrustCooldowns.get(agentId);
  if (cooldown) {
    clearTimeout(cooldown);
    autoTrustCooldowns.delete(agentId);
  }
}

export type TaskDotStatus = 'busy' | 'waiting' | 'ready';

// --- Prompt detection helpers ---
// Re-exported from shared module for backward compatibility.

export const stripAnsi = sharedStripAnsi;
const PROMPT_PATTERNS = SHARED_PROMPT_PATTERNS;

/** Returns true if `line` looks like a prompt waiting for input. */
function looksLikePrompt(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return PROMPT_PATTERNS.some((re) => re.test(stripped));
}

const chunkContainsAgentPrompt = sharedChunkContainsAgentPrompt;

// --- Agent ready event callbacks ---
// Fired from markAgentOutput when a main prompt is detected in a PTY chunk.
const agentReadyCallbacks = new Map<string, () => void>();

/** Register a callback that fires once when the agent's main prompt is detected. */
export function onAgentReady(agentId: string, callback: () => void): void {
  agentReadyCallbacks.set(agentId, callback);
}

/** Remove a pending agent-ready callback. */
export function offAgentReady(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

/** Fire the one-shot agentReady callback if the tail buffer shows a known agent prompt. */
function tryFireAgentReadyCallback(agentId: string): void {
  if (!agentReadyCallbacks.has(agentId)) return;
  const rawTail = outputTailBuffers.get(agentId) ?? '';
  const tailStripped = stripAnsi(rawTail)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (chunkContainsAgentPrompt(tailStripped)) {
    const cb = agentReadyCallbacks.get(agentId);
    agentReadyCallbacks.delete(agentId);
    if (cb) cb();
  }
}

/**
 * Normalize terminal output for quiescence comparison.
 * Strips ANSI, removes control characters, collapses whitespace so that
 * cursor repositioning and status bar redraws don't register as changes.
 */
export function normalizeForComparison(text: string): string {
  return (
    stripAnsi(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Patterns indicating the terminal is asking a question — do NOT auto-send.
 *  Includes both normal-text and TUI-garbled variants (no spaces between words
 *  after ANSI cursor-positioning sequences are stripped). */
const QUESTION_PATTERNS: RegExp[] = [
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)\s*$/i,
  /\btrust\b.*\?/i,
  /\bupdate\b.*\?/i,
  /\bproceed\b.*\?/i,
  /\boverwrite\b.*\?/i,
  /\bcontinue\b.*\?/i,
  /\ballow\b.*\?/i,
  /Do you want to/i,
  /Would you like to/i,
  /Are you sure/i,
  // TUI-garbled: words concatenated after ANSI strip ("Itrustthisfolder").
  /trust.*folder/i,
];

/** True when recent output contains a question or confirmation prompt.
 *  Checks ALL recent lines because TUI dialogs render the question above
 *  selection options — the question text may not be the last line.
 *
 *  Strips ANSI before slicing so the character budget covers visible text,
 *  not escape codes. TUI dialog renders can be 500+ raw ANSI bytes where
 *  only ~150 chars are visible — slicing raw bytes missed questions at the top. */
export function looksLikeQuestion(tail: string): boolean {
  const visible = stripAnsi(tail);
  const chunk = visible.slice(-500);
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  // If the last visible line is a known agent main prompt (❯ or ›), any
  // earlier question/trust dialog text in the buffer has already been
  // answered — this is not a live question.  TUI selection UIs also use ❯
  // but always followed by option text (e.g. "❯ Yes"), so they won't match.
  const lastLine = lines[lines.length - 1].trimEnd();
  if (/^\s*[❯›]\s*$/.test(lastLine)) return false;

  return lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}

/** True when the tail buffer's question patterns are entirely from trust/allow
 *  dialogs that auto-trust will handle. Returns false when:
 *  - autoTrustFolders is disabled
 *  - the tail doesn't contain trust dialog patterns
 *  - exclusion keywords (delete, password, etc.) are present
 *  - non-trust question patterns are also found in the tail */
export function isTrustQuestionAutoHandled(tail: string): boolean {
  if (!store.autoTrustFolders) return false;
  if (!looksLikeTrustDialog(tail)) return false;
  const visible = stripAnsi(tail).slice(-500);
  if (TRUST_EXCLUSION_KEYWORDS.test(visible)) return false;
  const lines = visible.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return !lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    // Lines matching trust patterns are handled by auto-trust — skip them.
    if (TRUST_PATTERNS.some((re) => re.test(trimmed))) return false;
    // If a line matches a non-trust question pattern, this is NOT only a trust question.
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}

/** True when recent output contains a trust or permission dialog. */
function looksLikeTrustDialog(tail: string): boolean {
  const visible = stripAnsi(tail);
  const chunk = visible.slice(-500);
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.some((line) => {
    const trimmed = line.trimEnd();
    return TRUST_PATTERNS.some((re) => re.test(trimmed));
  });
}

// --- Agent question tracking ---
// Reactive set of agent IDs that currently have a question/dialog in their terminal.
const [questionAgents, setQuestionAgents] = createSignal<Set<string>>(new Set());

/** True when the agent's terminal is showing a question or confirmation dialog. */
export function isAgentAskingQuestion(agentId: string): boolean {
  return questionAgents().has(agentId);
}

function updateQuestionState(agentId: string, hasQuestion: boolean): void {
  setQuestionAgents((prev) => {
    if (hasQuestion === prev.has(agentId)) return prev;
    const next = new Set(prev);
    if (hasQuestion) next.add(agentId);
    else next.delete(agentId);
    return next;
  });
}

// --- Agent activity tracking ---
// Plain map for raw timestamps (no reactive cost per PTY byte).
const lastDataAt = new Map<string, number>();
// Last time we refreshed each agent's idle timeout.
const lastIdleResetAt = new Map<string, number>();
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

// How long after the last data event before transitioning back to idle.
// AI agents routinely go silent for 10-30s during normal work (thinking,
// API calls, tool use), so this needs to be long enough to cover those pauses.
const IDLE_TIMEOUT_MS = 15_000;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Tail buffer per agent — keeps the last N chars of PTY output for prompt matching.
// Must be large enough to hold a full TUI dialog render (with ANSI codes) so that
// question text at the top of the dialog isn't truncated away.
const TAIL_BUFFER_MAX = 4096;
const outputTailBuffers = new Map<string, string>();
// Per-agent UTF-8 decoders to correctly handle multi-byte characters split across chunks.
const agentDecoders = new Map<string, TextDecoder>();

// Per-agent timestamp of last expensive analysis (question/prompt detection).
const lastAnalysisAt = new Map<string, number>();
const pendingAnalysis = new Map<string, ReturnType<typeof setTimeout>>();
const ANALYSIS_INTERVAL_MS = 200;

function addToActive(agentId: string): void {
  setActiveAgents((s) => {
    if (s.has(agentId)) return s;
    const next = new Set(s);
    next.add(agentId);
    return next;
  });
}

function removeFromActive(agentId: string): void {
  setActiveAgents((s) => {
    if (!s.has(agentId)) return s;
    const next = new Set(s);
    next.delete(agentId);
    return next;
  });
}

function resetIdleTimer(agentId: string): void {
  lastIdleResetAt.set(agentId, Date.now());
  const existing = idleTimers.get(agentId);
  if (existing) clearTimeout(existing);
  idleTimers.set(
    agentId,
    setTimeout(() => {
      removeFromActive(agentId);
      idleTimers.delete(agentId);
    }, IDLE_TIMEOUT_MS),
  );
}

/** Mark an agent as active when it is first spawned.
 *  Ensures agents start as "busy" before any PTY data arrives. */
export function markAgentSpawned(agentId: string): void {
  outputTailBuffers.delete(agentId);
  clearAutoTrustState(agentId);
  // Reset analysis throttle state for fresh session.
  lastAnalysisAt.delete(agentId);
  const pending = pendingAnalysis.get(agentId);
  if (pending) {
    clearTimeout(pending);
    pendingAnalysis.delete(agentId);
  }
  lastDataAt.set(agentId, Date.now());
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Try to auto-accept trust/permission dialogs for any agent (active or background).
 *  Lightweight check that only runs trust-specific patterns. */
function tryAutoTrust(agentId: string, rawTail: string): boolean {
  if (!store.autoTrustFolders || isAutoTrustPending(agentId)) return false;
  if (!looksLikeTrustDialog(rawTail)) return false;
  const visibleTail = stripAnsi(rawTail).slice(-500);
  if (TRUST_EXCLUSION_KEYWORDS.test(visibleTail)) return false;

  // Short delay to let the TUI finish rendering before sending Enter.
  const timer = setTimeout(() => {
    autoTrustTimers.delete(agentId);
    // Clear stale trust-dialog content (including ❯ selection cursor) so
    // chunkContainsAgentPrompt only fires on the agent's real prompt.
    outputTailBuffers.set(agentId, '');
    // Deregister the agent-ready callback so the fast path (immediate ❯
    // detection) is disabled.  The agent may render ❯ before it's fully
    // initialized — the quiescence fallback (1500ms of stable output)
    // is more reliable after trust acceptance.
    agentReadyCallbacks.delete(agentId);
    // Start the settling period — blocks auto-send for POST_AUTO_TRUST_SETTLE_MS
    // to give slow-starting agents (e.g. Claude Code) time to fully initialize.
    autoTrustAcceptedAt.set(agentId, Date.now());
    invoke(IPC.WriteToAgent, { agentId, data: '\r' }).catch(() => {});
    // Cooldown: ignore trust patterns for 3s so the same dialog
    // isn't re-matched while the PTY output transitions.
    const cd = setTimeout(() => autoTrustCooldowns.delete(agentId), 3_000);
    autoTrustCooldowns.set(agentId, cd);
  }, 50);
  autoTrustTimers.set(agentId, timer);
  return true;
}

/** Run expensive prompt/question/agent-ready detection on the tail buffer.
 *  Called at most every ANALYSIS_INTERVAL_MS (200ms) per agent. */
function analyzeAgentOutput(agentId: string): void {
  const rawTail = outputTailBuffers.get(agentId) ?? '';
  let hasQuestion = looksLikeQuestion(rawTail);

  // Suppress question state for trust dialogs when auto-trust is enabled —
  // whether we just scheduled auto-trust or it's already pending/in cooldown.
  // Without this, subsequent analysis calls re-detect the stale dialog text in
  // the tail buffer and set hasQuestion=true, which disables the prompt
  // textarea and steals focus to the terminal.
  if (hasQuestion && store.autoTrustFolders) {
    const visibleTail = stripAnsi(rawTail).slice(-500);
    if (looksLikeTrustDialog(rawTail) && !TRUST_EXCLUSION_KEYWORDS.test(visibleTail)) {
      // Auto-trust may not have fired yet if this is the first analysis for
      // an active task that just became visible — trigger it now.
      tryAutoTrust(agentId, rawTail);
      hasQuestion = false;
    }
  }

  updateQuestionState(agentId, hasQuestion);

  // Agent-ready prompt scanning. Uses the tail buffer (always current) so
  // throttled/trailing calls don't miss prompts from intermediate chunks.
  // Guard: don't fire if the tail buffer contains a question — TUI selection
  // UIs (e.g. "trust this folder?") also use ❯ as a cursor.
  // Also skip while auto-trust Enter is scheduled (50ms window) — the ❯ in
  // the selection UI is a false positive.  After the timer fires, the tail
  // buffer is cleared so only the agent's real prompt can trigger this.
  if (!hasQuestion && !autoTrustTimers.has(agentId)) tryFireAgentReadyCallback(agentId);
}

/** Call this from the TerminalView Data handler with the raw PTY bytes.
 *  Detects prompt patterns to immediately mark agents idle instead of
 *  waiting for the full idle timeout. */
export function markAgentOutput(agentId: string, data: Uint8Array, taskId?: string): void {
  const now = Date.now();
  lastDataAt.set(agentId, now);

  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }
  const text = decoder.decode(data, { stream: true });
  const prev = outputTailBuffers.get(agentId) ?? '';
  const combined = prev + text;
  outputTailBuffers.set(
    agentId,
    combined.length > TAIL_BUFFER_MAX
      ? combined.slice(combined.length - TAIL_BUFFER_MAX)
      : combined,
  );

  // Expensive analysis (regex, ANSI strip) — only for active task's agents.
  const isActiveTask = !taskId || taskId === store.activeTaskId;

  // Auto-trust runs for ALL agents (including background tasks) so trust
  // dialogs are accepted immediately without needing to switch to the task.
  // Active-task agents get this via analyzeAgentOutput; background agents
  // are throttled to avoid ANSI strip + regex on every PTY chunk.
  if (store.autoTrustFolders && !isAutoTrustPending(agentId) && !isActiveTask) {
    const lastCheck = lastAutoTrustCheckAt.get(agentId) ?? 0;
    if (now - lastCheck >= AUTO_TRUST_BG_THROTTLE_MS) {
      lastAutoTrustCheckAt.set(agentId, now);
      tryAutoTrust(agentId, outputTailBuffers.get(agentId) ?? '');
    }
  }
  if (isActiveTask) {
    // Throttle expensive analysis (question/prompt/agent-ready detection).
    const lastAnalysis = lastAnalysisAt.get(agentId) ?? 0;
    if (now - lastAnalysis >= ANALYSIS_INTERVAL_MS) {
      lastAnalysisAt.set(agentId, now);
      if (pendingAnalysis.has(agentId)) {
        clearTimeout(pendingAnalysis.get(agentId));
        pendingAnalysis.delete(agentId);
      }
      analyzeAgentOutput(agentId);
    } else if (!pendingAnalysis.has(agentId)) {
      // Schedule a trailing analysis so the last chunk is always analyzed.
      pendingAnalysis.set(
        agentId,
        setTimeout(() => {
          pendingAnalysis.delete(agentId);
          lastAnalysisAt.set(agentId, Date.now());
          analyzeAgentOutput(agentId);
        }, ANALYSIS_INTERVAL_MS),
      );
    }
  }

  // Extract last non-empty line from recent output for prompt matching.
  // This check is UNTHROTTLED — it's cheap (single line, 6 patterns) and
  // important for responsive idle detection.
  const tail = combined.slice(-200);
  let lastLine = '';
  let searchEnd = tail.length;
  while (searchEnd > 0) {
    const nlIdx = tail.lastIndexOf('\n', searchEnd - 1);
    const candidate = tail.slice(nlIdx + 1, searchEnd).trim();
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
    searchEnd = nlIdx >= 0 ? nlIdx : 0;
  }

  if (looksLikePrompt(lastLine)) {
    // Prompt detected — agent is idle. Remove from active set immediately.
    // Cancel any pending trailing analysis — question detection is irrelevant
    // once idle, and letting it fire could set a spurious question flag.
    const pendingTimer = pendingAnalysis.get(agentId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingAnalysis.delete(agentId);
    }

    // Agent is at its prompt — clear stale question state so auto-send
    // isn't blocked by old dialog text (e.g. trust dialogs that were already
    // accepted). Only clear if the tail buffer is genuinely free of questions
    // to avoid briefly hiding a real Y/n prompt that also matches looksLikePrompt.
    if (!looksLikeQuestion(outputTailBuffers.get(agentId) ?? '')) {
      updateQuestionState(agentId, false);
    }

    // The cancelled trailing analysis may have been the only chance to fire
    // the agentReady callback (used by PromptInput auto-send). Fire it here
    // so the callback isn't lost. The chunkContainsAgentPrompt guard inside
    // tryFireAgentReadyCallback ensures shell prompts ($, %) don't trigger it.
    tryFireAgentReadyCallback(agentId);

    const timer = idleTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(agentId);
    }
    removeFromActive(agentId);
    return;
  }

  // Non-prompt output — agent is producing real work.
  if (activeAgents().has(agentId)) {
    const lastReset = lastIdleResetAt.get(agentId) ?? 0;
    if (now - lastReset < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Return the last ~4096 chars of raw PTY output for `agentId`. */
export function getAgentOutputTail(agentId: string): string {
  return outputTailBuffers.get(agentId) ?? '';
}

/** True when the agent is NOT producing output (e.g. sitting at a prompt). */
export function isAgentIdle(agentId: string): boolean {
  return !activeAgents().has(agentId);
}

/** Lightweight busy marker — adds to active set + resets idle timer.
 *  Unlike markAgentSpawned this preserves the output tail buffer. */
export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastDataAt.delete(agentId);
  lastIdleResetAt.delete(agentId);
  outputTailBuffers.delete(agentId);
  agentDecoders.delete(agentId);
  agentReadyCallbacks.delete(agentId);
  clearAutoTrustState(agentId);
  lastAnalysisAt.delete(agentId);
  const pending = pendingAnalysis.get(agentId);
  if (pending) {
    clearTimeout(pending);
    pendingAnalysis.delete(agentId);
  }
  const timer = idleTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(agentId);
  }
  removeFromActive(agentId);
  updateQuestionState(agentId, false);
}

// --- Derived status ---

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  const task = store.tasks[taskId];
  if (!task) return 'waiting';
  const active = activeAgents(); // reactive read
  const hasActive = task.agentIds.some((id) => {
    const a = store.agents[id];
    return a?.status === 'running' && active.has(id);
  });
  if (hasActive) return 'busy';

  const git = store.taskGitStatus[taskId];
  if (git?.has_committed_changes && !git?.has_uncommitted_changes) return 'ready';
  return 'waiting';
}

// --- Git status polling ---

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  try {
    const status = await invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
    });
    setStore('taskGitStatus', taskId, status);
  } catch {
    // Worktree may not exist yet or was removed — ignore
  }
}

let isRefreshingAll = false;

/** Refresh git status for inactive tasks (active task is handled by its own 5s timer).
 *  Limits concurrency to avoid spawning too many parallel git processes. */
export async function refreshAllTaskGitStatus(): Promise<void> {
  if (isRefreshingAll) return;
  isRefreshingAll = true;
  try {
    const taskIds = store.taskOrder;
    const active = activeAgents();
    const currentTaskId = store.activeTaskId;
    const toRefresh = taskIds.filter((taskId) => {
      // Active task is covered by the faster refreshActiveTaskGitStatus timer
      if (taskId === currentTaskId) return false;
      const task = store.tasks[taskId];
      if (!task) return false;
      return !task.agentIds.some((id) => {
        const a = store.agents[id];
        return a?.status === 'running' && active.has(id);
      });
    });

    // Process in batches of 4 to limit concurrent git processes
    const BATCH_SIZE = 4;
    for (let i = 0; i < toRefresh.length; i += BATCH_SIZE) {
      const batch = toRefresh.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((taskId) => refreshTaskGitStatus(taskId)));
    }
  } finally {
    isRefreshingAll = false;
  }
}

/** Refresh git status for the currently active task only. */
async function refreshActiveTaskGitStatus(): Promise<void> {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  await refreshTaskGitStatus(taskId);
}

/** Refresh git status for a single task (e.g. after agent exits). */
export function refreshTaskStatus(taskId: string): void {
  refreshTaskGitStatus(taskId);
}

let allTasksTimer: ReturnType<typeof setInterval> | null = null;
let activeTaskTimer: ReturnType<typeof setInterval> | null = null;
let lastPollingTaskCount = 0;

function computeAllTasksInterval(): number {
  const taskCount = store.taskOrder.length;
  return Math.min(120_000, 30_000 + Math.max(0, taskCount - 3) * 5_000);
}

export function startTaskStatusPolling(): void {
  if (allTasksTimer || activeTaskTimer) return;
  // Active task polls every 5s for responsive UI
  activeTaskTimer = setInterval(refreshActiveTaskGitStatus, 5_000);
  // Scale interval: 30s base + 5s per additional task beyond 3
  lastPollingTaskCount = store.taskOrder.length;
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
  // Run once immediately
  refreshActiveTaskGitStatus();
  refreshAllTaskGitStatus();
}

/** Call when tasks are added/removed to recalculate the all-tasks polling interval. */
export function rescheduleTaskStatusPolling(): void {
  if (!allTasksTimer) return;
  const currentCount = store.taskOrder.length;
  if (currentCount === lastPollingTaskCount) return;
  lastPollingTaskCount = currentCount;
  clearInterval(allTasksTimer);
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
}

export function stopTaskStatusPolling(): void {
  if (allTasksTimer) {
    clearInterval(allTasksTimer);
    allTasksTimer = null;
  }
  if (activeTaskTimer) {
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
  }
  lastPollingTaskCount = 0;
}
