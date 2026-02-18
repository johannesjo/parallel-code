import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { WorktreeStatus } from "../ipc/types";

export type TaskDotStatus = "busy" | "waiting" | "ready";

// --- Prompt detection helpers ---

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
function stripAnsi(text: string): string {
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
const TAIL_BUFFER_MAX = 512;
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

  // Extract last non-empty line from recent output for prompt matching.
  const tail = combined.slice(-200);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? "";

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

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastDataAt.delete(agentId);
  lastIdleResetAt.delete(agentId);
  outputTailBuffers.delete(agentId);
  agentDecoders.delete(agentId);
  const timer = idleTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(agentId);
  }
  removeFromActive(agentId);
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
  for (const taskId of taskIds) {
    const agents = Object.values(store.agents).filter(
      (a) => a.taskId === taskId
    );
    const hasActive = agents.some(
      (a) => a.status === "running" && active.has(a.id)
    );
    if (!hasActive) {
      await refreshTaskGitStatus(taskId);
    }
  }
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
