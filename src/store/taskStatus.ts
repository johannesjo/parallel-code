import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { WorktreeStatus } from "../ipc/types";

export type TaskDotStatus = "busy" | "waiting" | "ready";

// --- Agent activity tracking ---
// Plain map for raw timestamps (no reactive cost per PTY byte).
const lastDataAt = new Map<string, number>();
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

// How long after the last data event before transitioning back to idle.
// AI agents routinely go silent for 10-30s during normal work (thinking,
// API calls, tool use), so this needs to be long enough to cover those pauses.
const IDLE_TIMEOUT_MS = 45_000;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  lastDataAt.set(agentId, Date.now());
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Call this from the TerminalView Data handler. */
export function markAgentActive(agentId: string): void {
  const now = Date.now();
  const prev = lastDataAt.get(agentId) ?? 0;
  lastDataAt.set(agentId, now);

  // Already active — just reset the idle timer (throttled).
  if (activeAgents().has(agentId)) {
    if (now - prev < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  // Not yet active — activate immediately and start idle timer.
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastDataAt.delete(agentId);
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
