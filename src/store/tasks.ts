import { produce } from "solid-js/store";
import { invoke } from "../lib/ipc";
import { IPC } from "../../electron/ipc/channels";
import { store, setStore, updateWindowTitle } from "./core";
import { setTaskFocusedPanel } from "./focus";
import { getProject, getProjectPath, getProjectBranchPrefix } from "./projects";
import { setPendingShellCommand } from "../lib/bookmarks";
import { markAgentSpawned, clearAgentActivity, rescheduleTaskStatusPolling } from "./taskStatus";
import { recordMergedLines, recordTaskCompleted } from "./completion";
import type { AgentDef, CreateTaskResult, MergeResult } from "../ipc/types";
import { parseGitHubUrl, taskNameFromGitHubUrl } from "../lib/github-url";
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
      await invoke(IPC.WriteToAgent, { agentId, data });
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
  initialPrompt?: string,
  branchPrefixOverride?: string
): Promise<string> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error("Project not found");

  const branchPrefix = branchPrefixOverride ?? getProjectBranchPrefix(projectId);
  const result = await invoke<CreateTaskResult>(IPC.CreateTask, {
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
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return result.id;
}

export async function createDirectTask(
  name: string,
  agentDef: AgentDef,
  projectId: string,
  mainBranch: string,
  initialPrompt?: string
): Promise<string> {
  if (hasDirectModeTask(projectId)) {
    throw new Error("A direct-mode task already exists for this project");
  }
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error("Project not found");

  const id = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  const task: Task = {
    id,
    name,
    projectId,
    branchName: mainBranch,
    worktreePath: projectRoot,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: "",
    lastPrompt: "",
    initialPrompt: initialPrompt || undefined,
    directMode: true,
  };

  const agent: Agent = {
    id: agentId,
    taskId: id,
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
      s.tasks[id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(id);
      s.activeTaskId = id;
      s.activeAgentId = agentId;
      s.lastProjectId = projectId;
      s.lastAgentId = agentDef.id;
    })
  );

  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return id;
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
      await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    }

    // Skip git cleanup for direct mode (no worktree/branch to remove)
    if (!task.directMode) {
      // Remove worktree + branch
      await invoke(IPC.DeleteTask, {
        agentIds: [...agentIds, ...shellAgentIds],
        branchName,
        deleteBranch,
        projectRoot,
      });
    }

    // Backend cleanup succeeded — remove from UI
    removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
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

  // Clean up agent activity tracking (timers, buffers, decoders) before
  // the store entries are deleted — otherwise markAgentExited can't find
  // the agent and skips cleanup, leaking module-level Map entries.
  for (const agentId of agentIds) {
    clearAgentActivity(agentId);
  }

  const idx = store.taskOrder.indexOf(taskId);

  // Phase 1: mark as removing so UI can animate
  setStore("tasks", taskId, "closingStatus", "removing");

  // Phase 2: actually delete after animation completes
  setTimeout(() => {
    setStore(
      produce((s) => {
        delete s.tasks[taskId];
        delete s.taskGitStatus[taskId];
        delete s.focusedPanel[taskId];
        const prefix = taskId + ":";
        for (const key of Object.keys(s.fontScales)) {
          if (key === taskId || key.startsWith(prefix)) delete s.fontScales[key];
        }
        for (const key of Object.keys(s.panelSizes)) {
          if (key.includes(taskId)) delete s.panelSizes[key];
        }
        s.taskOrder = s.taskOrder.filter((id) => id !== taskId);

        if (s.activeTaskId === taskId) {
          const neighbor = s.taskOrder[Math.max(0, idx - 1)] ?? null;
          s.activeTaskId = neighbor;
          const neighborTask = neighbor ? s.tasks[neighbor] : null;
          s.activeAgentId = neighborTask?.agentIds[0] ?? null;
        }

        for (const agentId of agentIds) {
          delete s.agents[agentId];
        }
      })
    );

    rescheduleTaskStatusPolling();
    const activeId = store.activeTaskId;
    const activeTask = activeId ? store.tasks[activeId] : null;
    const activeTerminal = activeId ? store.terminals[activeId] : null;
    updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
  }, REMOVE_ANIMATION_MS);
}

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean }
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === "removing") return;
  if (task.directMode) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const cleanup = options?.cleanup ?? false;

  if (cleanup) {
    // Closing task flow: stop all running terminals before cleanup.
    for (const agentId of agentIds) {
      await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    }
  }

  // Merge branch into main. Cleanup is optional.
  const mergeResult = await invoke<MergeResult>(IPC.MergeTask, {
    projectRoot,
    branchName,
    squash: options?.squash ?? false,
    message: options?.message,
    cleanup,
  });
  recordMergedLines(mergeResult.lines_added, mergeResult.lines_removed);

  if (cleanup) {
    // Remove task UI only when branch/worktree were cleaned up.
    removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
  }
}

export async function pushTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.directMode) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  await invoke(IPC.PushTask, {
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

export function clearPrefillPrompt(taskId: string): void {
  setStore("tasks", taskId, "prefillPrompt", undefined);
}

export function setPrefillPrompt(taskId: string, text: string): void {
  setStore("tasks", taskId, "prefillPrompt", text);
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
  const closedIndex = store.tasks[taskId]?.shellAgentIds.indexOf(shellId) ?? -1;

  await invoke(IPC.KillAgent, { agentId: shellId }).catch(() => {});
  clearAgentActivity(shellId);
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (task) {
        task.shellAgentIds = task.shellAgentIds.filter((id) => id !== shellId);
      }
    })
  );

  if (closedIndex >= 0) {
    const remaining = store.tasks[taskId]?.shellAgentIds.length ?? 0;
    if (remaining === 0) {
      setTaskFocusedPanel(taskId, "shell-toolbar");
    } else {
      const focusIndex = Math.min(closedIndex, remaining - 1);
      setTaskFocusedPanel(taskId, `shell:${focusIndex}`);
    }
  }
}

export function hasDirectModeTask(projectId: string): boolean {
  return store.taskOrder.some((taskId) => {
    const task = store.tasks[taskId];
    return task && task.projectId === projectId && task.directMode && task.closingStatus !== "removing";
  });
}

// --- GitHub drop-to-create helpers ---

/** Find best matching project by comparing repo name to project directory basenames. */
function matchProject(repoName: string): string | null {
  const lower = repoName.toLowerCase();
  for (const project of store.projects) {
    const basename = project.path.split("/").pop() ?? "";
    if (basename.toLowerCase() === lower) return project.id;
  }
  return null;
}

/** Derive dialog defaults (name, matched project) from a GitHub URL. */
export function getGitHubDropDefaults(url: string): { name: string; projectId: string | null } | null {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;
  return {
    name: taskNameFromGitHubUrl(parsed),
    projectId: matchProject(parsed.repo),
  };
}

export function setNewTaskDropUrl(url: string): void {
  setStore("newTaskDropUrl", url);
}
