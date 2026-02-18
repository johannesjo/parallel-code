import { produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore, updateWindowTitle } from "./core";
import { getProject, getProjectPath, getProjectBranchPrefix } from "./projects";
import { setPendingShellCommand } from "../lib/bookmarks";
import { markAgentSpawned } from "./taskStatus";
import { recordTaskCompleted } from "./completion";
import type { AgentDef, CreateTaskResult } from "../ipc/types";
import type { Agent, Task } from "./types";

const AGENT_WRITE_READY_TIMEOUT_MS = 8_000;
const AGENT_WRITE_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentNotFoundError(err: unknown): boolean {
  return String(err).toLowerCase().includes("agent not found");
}

async function writeToAgentWhenReady(agentId: string, data: string): Promise<void> {
  const deadline = Date.now() + AGENT_WRITE_READY_TIMEOUT_MS;
  let lastErr: unknown;

  while (Date.now() <= deadline) {
    try {
      await invoke("write_to_agent", { agentId, data });
      return;
    } catch (err) {
      lastErr = err;
      if (!isAgentNotFoundError(err)) throw err;
      const agent = store.agents[agentId];
      if (!agent || agent.status !== "running") throw err;
      await sleep(AGENT_WRITE_RETRY_MS);
    }
  }

  throw lastErr ?? new Error(`Timed out waiting for agent ${agentId} to become writable`);
}

export async function createTask(
  name: string,
  agentDef: AgentDef,
  projectId: string,
  symlinkDirs: string[] = [],
  initialPrompt?: string
): Promise<void> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error("Project not found");

  const branchPrefix = getProjectBranchPrefix(projectId);
  const result = await invoke<CreateTaskResult>("create_task", {
    name,
    projectRoot,
    symlinkDirs,
    branchPrefix,
  });

  const agentId = crypto.randomUUID();
  const task: Task = {
    id: result.id,
    name,
    projectId,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: "",
    lastPrompt: "",
    initialPrompt: initialPrompt || undefined,
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((s) => {
      s.tasks[result.id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(result.id);
      s.activeTaskId = result.id;
      s.activeAgentId = agentId;
      s.lastProjectId = projectId;
      s.lastAgentId = agentDef.id;
    })
  );

  // Mark as busy immediately; terminal output may arrive later.
  markAgentSpawned(agentId);
  updateWindowTitle(name);
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === "closing" || task.closingStatus === "removing") return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const projectRoot = getProjectPath(task.projectId) ?? "";
  const deleteBranch = getProject(task.projectId)?.deleteBranchOnClose ?? true;

  // Mark as closing — task stays visible but UI shows closing state
  setStore("tasks", taskId, "closingStatus", "closing");
  setStore("tasks", taskId, "closingError", undefined);

  try {
    // Kill agents
    for (const agentId of agentIds) {
      await invoke("kill_agent", { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke("kill_agent", { agentId: shellId }).catch(console.error);
    }

    // Remove worktree + branch
    await invoke("delete_task", {
      agentIds: [...agentIds, ...shellAgentIds],
      branchName,
      deleteBranch,
      projectRoot,
    });

    // Backend cleanup succeeded — remove from UI
    removeTaskFromStore(taskId, agentIds);
  } catch (err) {
    // Backend cleanup failed — show error, allow retry
    console.error("Failed to close task:", err);
    setStore("tasks", taskId, "closingStatus", "error");
    setStore("tasks", taskId, "closingError", String(err));
  }
}

export function retryCloseTask(taskId: string): void {
  setStore("tasks", taskId, "closingStatus", undefined);
  setStore("tasks", taskId, "closingError", undefined);
  closeTask(taskId);
}

const REMOVE_ANIMATION_MS = 300;

function removeTaskFromStore(taskId: string, agentIds: string[]): void {
  recordTaskCompleted();

  // Phase 1: mark as removing so UI can animate
  setStore("tasks", taskId, "closingStatus", "removing");

  // Phase 2: actually delete after animation completes
  setTimeout(() => {
    setStore(
      produce((s) => {
        delete s.tasks[taskId];
        const prefix = taskId + ":";
        for (const key of Object.keys(s.fontScales)) {
          if (key === taskId || key.startsWith(prefix)) delete s.fontScales[key];
        }
        for (const key of Object.keys(s.panelSizes)) {
          if (key.includes(taskId)) delete s.panelSizes[key];
        }
        s.taskOrder = s.taskOrder.filter((id) => id !== taskId);

        if (s.activeTaskId === taskId) {
          s.activeTaskId = s.taskOrder[0] ?? null;
          const firstTask = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
          s.activeAgentId = firstTask?.agentIds[0] ?? null;
        }

        for (const agentId of agentIds) {
          delete s.agents[agentId];
        }
      })
    );

    const activeTask = store.activeTaskId ? store.tasks[store.activeTaskId] : null;
    updateWindowTitle(activeTask?.name);
  }, REMOVE_ANIMATION_MS);
}

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean }
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === "removing") return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const cleanup = options?.cleanup ?? false;

  if (cleanup) {
    // Closing task flow: stop all running terminals before cleanup.
    for (const agentId of agentIds) {
      await invoke("kill_agent", { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke("kill_agent", { agentId: shellId }).catch(console.error);
    }
  }

  // Merge branch into main. Cleanup is optional.
  await invoke<string>("merge_task", {
    projectRoot,
    branchName,
    squash: options?.squash ?? false,
    message: options?.message,
    cleanup,
  });

  if (cleanup) {
    // Remove task UI only when branch/worktree were cleaned up.
    removeTaskFromStore(taskId, agentIds);
  }
}

export async function pushTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  await invoke("push_task", {
    projectRoot,
    branchName: task.branchName,
  });
}

export function updateTaskName(taskId: string, name: string): void {
  setStore("tasks", taskId, "name", name);
  if (store.activeTaskId === taskId) {
    updateWindowTitle(name);
  }
}

export function updateTaskNotes(taskId: string, notes: string): void {
  setStore("tasks", taskId, "notes", notes);
}

export async function sendPrompt(
  taskId: string,
  agentId: string,
  text: string
): Promise<void> {
  // Send text and Enter separately so TUI apps (Claude Code, Codex)
  // don't treat the \r as part of a pasted block
  await writeToAgentWhenReady(agentId, text);
  await new Promise((r) => setTimeout(r, 50));
  await writeToAgentWhenReady(agentId, "\r");
  setStore("tasks", taskId, "lastPrompt", text);
}

export function setLastPrompt(taskId: string, text: string): void {
  setStore("tasks", taskId, "lastPrompt", text);
}

export function clearInitialPrompt(taskId: string): void {
  setStore("tasks", taskId, "initialPrompt", undefined);
}

export function reorderTask(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  setStore(
    produce((s) => {
      const [moved] = s.taskOrder.splice(fromIndex, 1);
      s.taskOrder.splice(toIndex, 0, moved);
    })
  );
}

export function spawnShellForTask(taskId: string, initialCommand?: string): string {
  const shellId = crypto.randomUUID();
  if (initialCommand) setPendingShellCommand(shellId, initialCommand);
  setStore(
    produce((s) => {
      s.tasks[taskId].shellAgentIds.push(shellId);
    })
  );
  return shellId;
}

export async function closeShell(taskId: string, shellId: string): Promise<void> {
  await invoke("kill_agent", { agentId: shellId }).catch(() => {});
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (task) {
        task.shellAgentIds = task.shellAgentIds.filter((id) => id !== shellId);
      }
    })
  );
}
