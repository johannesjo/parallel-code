import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { WorktreeStatus } from "../ipc/types";

// --- Trust-specific patterns (subset of QUESTION_PATTERNS) ---
// These are auto-accepted when autoTrustFolders is enabled.
const TRUST_PATTERNS: RegExp[] = [
  /\btrust\b.*\?/i,
  /\ballow\b.*\?/i,
];

// Debounce: tracks agents with a pending or recently-fired auto-trust.
// Cleared after a cooldown so subsequent trust dialogs are also auto-accepted.
const autoTrustTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autoTrustCooldowns = new Map<string, ReturnType<typeof setTimeout>>();

function isAutoTrustPending(agentId: string): boolean {
  return autoTrustTimers.has(agentId) || autoTrustCooldowns.has(agentId);
}

function clearAutoTrustState(agentId: string): void {
  const timer = autoTrustTimers.get(agentId);
  if (timer) { clearTimeout(timer); autoTrustTimers.delete(agentId); }
  const cooldown = autoTrustCooldowns.get(agentId);
  if (cooldown) { clearTimeout(cooldown); autoTrustCooldowns.delete(agentId); }
}

export type TaskDotStatus = "busy" | "waiting" | "ready";

// --- Prompt detection helpers ---

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    ""
  );
}

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 *
 * - Claude Code prompt: ends with ❯ (possibly with trailing whitespace)
 * - Common shell prompts: $, %, #, >
 * - Y/n confirmation prompts
 */
const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/,              // Claude Code prompt
  /(?:^|\s)\$\s*$/,     // bash/zsh dollar prompt (preceded by whitespace or BOL)
  /(?:^|\s)%\s*$/,      // zsh percent prompt
  /(?:^|\s)#\s*$/,      // root prompt
  /\[Y\/n\]\s*$/i,      // Y/n confirmation
  /\[y\/N\]\s*$/i,      // y/N confirmation
];

/** Returns true if `line` looks like a prompt waiting for input. */
function looksLikePrompt(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return PROMPT_PATTERNS.some((re) => re.test(stripped));
}

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
const AGENT_READY_TAIL_PATTERNS: RegExp[] = [
  /❯/,               // Claude Code
  /›/,               // Codex CLI
];

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders as
 *  the last visible element, while TUI selection UIs place ❯ earlier in
 *  the render followed by option text and other choices. */
function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const tail = stripped.slice(-50);
  return AGENT_READY_TAIL_PATTERNS.some((re) => re.test(tail));
}

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

/**
 * Normalize terminal output for quiescence comparison.
 * Strips ANSI, removes control characters, collapses whitespace so that
 * cursor repositioning and status bar redraws don't register as changes.
 */
export function normalizeForComparison(text: string): string {
  return stripAnsi(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Patterns indicating the terminal is asking a question — do NOT auto-send. */
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
  return lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
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
    if (hasQuestion) next.add(agentId); else next.delete(agentId);
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
// Per-agent decoders so streaming multi-byte state doesn't corrupt across agents.
const agentDecoders = new Map<string, TextDecoder>();

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
    }, IDLE_TIMEOUT_MS)
  );
}

/** Mark an agent as active when it is first spawned.
 *  Ensures agents start as "busy" before any PTY data arrives. */
export function markAgentSpawned(agentId: string): void {
  outputTailBuffers.delete(agentId);
  agentDecoders.delete(agentId);
  clearAutoTrustState(agentId);
  lastDataAt.set(agentId, Date.now());
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** @deprecated Use markAgentOutput when raw bytes are available. */
export function markAgentActive(agentId: string): void {
  const now = Date.now();
  lastDataAt.set(agentId, now);

  // Already active — just reset the idle timer (throttled).
  if (activeAgents().has(agentId)) {
    const lastReset = lastIdleResetAt.get(agentId) ?? 0;
    if (now - lastReset < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  // Not yet active — activate immediately and start idle timer.
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Call this from the TerminalView Data handler with the raw PTY bytes.
 *  Detects prompt patterns to immediately mark agents idle instead of
 *  waiting for the full idle timeout. */
export function markAgentOutput(agentId: string, data: Uint8Array): void {
  const now = Date.now();
  lastDataAt.set(agentId, now);

  // Decode and append to tail buffer for prompt detection.
  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }
  const text = decoder.decode(data, { stream: true });
  const prev = outputTailBuffers.get(agentId) ?? "";
  const combined = prev + text;
  outputTailBuffers.set(
    agentId,
    combined.length > TAIL_BUFFER_MAX
      ? combined.slice(combined.length - TAIL_BUFFER_MAX)
      : combined
  );

  // Track whether the terminal is showing a question/dialog.
  const rawTail = outputTailBuffers.get(agentId) ?? "";
  let hasQuestion = looksLikeQuestion(rawTail);

  // Auto-trust: when enabled, auto-accept trust/permission dialogs.
  if (hasQuestion && store.autoTrustFolders && !isAutoTrustPending(agentId)) {
    if (looksLikeTrustDialog(rawTail)) {
      // Brief delay to let the TUI finish rendering before sending Enter.
      const timer = setTimeout(() => {
        autoTrustTimers.delete(agentId);
        invoke("write_to_agent", { agentId, data: "\r" }).catch(() => {});
        // Cooldown: ignore trust patterns for 3s so the same dialog
        // isn't re-matched while the PTY output transitions.
        const cd = setTimeout(() => autoTrustCooldowns.delete(agentId), 3_000);
        autoTrustCooldowns.set(agentId, cd);
      }, 150);
      autoTrustTimers.set(agentId, timer);
      hasQuestion = false;
    }
  }

  updateQuestionState(agentId, hasQuestion);

  // Extract last non-empty line from recent output for prompt matching.
  const tail = combined.slice(-200);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? "";

  // Scan the CURRENT data chunk (not the tail buffer) for prompt characters.
  // TUI apps render full screens — the prompt may appear early in a large
  // chunk and get rotated out of the tail buffer.
  if (agentReadyCallbacks.has(agentId)) {
    const chunkStripped = stripAnsi(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (chunkContainsAgentPrompt(chunkStripped)) {
      // Guard: don't fire if the tail buffer contains a question.
      // TUI selection UIs (e.g. "trust this folder?") also use ❯ as a
      // cursor, and the question text may appear earlier in the buffer.
      if (!hasQuestion) {
        const cb = agentReadyCallbacks.get(agentId);
        agentReadyCallbacks.delete(agentId);
        if (cb) cb();
      }
    }
  }

  if (looksLikePrompt(lastLine)) {
    // Prompt detected — agent is idle. Remove from active set immediately.
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
  return outputTailBuffers.get(agentId) ?? "";
}

/** True when the agent is not actively producing output (prompt detected or idle timeout). */
export function isAgentIdle(agentId: string): boolean {
  return !activeAgents().has(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastDataAt.delete(agentId);
  lastIdleResetAt.delete(agentId);
  outputTailBuffers.delete(agentId);
  agentDecoders.delete(agentId);
  agentReadyCallbacks.delete(agentId);
  clearAutoTrustState(agentId);
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
  const agents = Object.values(store.agents).filter(
    (a) => a.taskId === taskId
  );
  const active = activeAgents(); // reactive read
  const hasActive = agents.some(
    (a) => a.status === "running" && active.has(a.id)
  );
  if (hasActive) return "busy";

  const git = store.taskGitStatus[taskId];
  if (git?.has_committed_changes && !git?.has_uncommitted_changes)
    return "ready";
  return "waiting";
}

// --- Git status polling ---

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  try {
    const status = await invoke<WorktreeStatus>("get_worktree_status", {
      worktreePath: task.worktreePath,
    });
    setStore("taskGitStatus", taskId, status);
  } catch {
    // Worktree may not exist yet or was removed — ignore
  }
}

/** Refresh git status for all tasks that don't have an active agent. */
export async function refreshAllTaskGitStatus(): Promise<void> {
  const taskIds = store.taskOrder;
  const active = activeAgents();
  const promises = taskIds
    .filter((taskId) => {
      const agents = Object.values(store.agents).filter(
        (a) => a.taskId === taskId
      );
      return !agents.some((a) => a.status === "running" && active.has(a.id));
    })
    .map((taskId) => refreshTaskGitStatus(taskId));
  await Promise.allSettled(promises);
}

/** Refresh git status for a single task (e.g. after agent exits). */
export function refreshTaskStatus(taskId: string): void {
  refreshTaskGitStatus(taskId);
}

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startTaskStatusPolling(): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(refreshAllTaskGitStatus, 5000);
  // Run once immediately
  refreshAllTaskGitStatus();
}

export function stopTaskStatusPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
