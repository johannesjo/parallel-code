import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore, updateWindowTitle, cleanupPanelEntries } from './core';
import { setTaskFocusedPanel } from './focus';
import { getProject, getProjectPath, getProjectBranchPrefix, isProjectMissing } from './projects';
import { setPendingShellCommand } from '../lib/bookmarks';
import {
  markAgentSpawned,
  markAgentBusy,
  clearAgentActivity,
  isAgentIdle,
  rescheduleTaskStatusPolling,
} from './taskStatus';
import { recordMergedLines, recordTaskCompleted } from './completion';
import { cleanTaskName } from '../lib/clean-task-name';
import type { AgentDef, CreateTaskResult, ImportableWorktree, MergeResult } from '../ipc/types';
import { parseGitHubUrl, taskNameFromGitHubUrl } from '../lib/github-url';
import type { Agent, Task } from './types';

const AGENT_WRITE_READY_TIMEOUT_MS = 8_000;
const AGENT_WRITE_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentNotFoundError(err: unknown): boolean {
  return String(err).toLowerCase().includes('agent not found');
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
      if (!agent || agent.status !== 'running') throw err;
      await sleep(AGENT_WRITE_RETRY_MS);
    }
  }

  throw lastErr ?? new Error(`Timed out waiting for agent ${agentId} to become writable`);
}

export interface CreateTaskOptions {
  name: string;
  agentDef: AgentDef;
  projectId: string;
  symlinkDirs?: string[];
  initialPrompt?: string;
  branchPrefixOverride?: string;
  githubUrl?: string;
  skipPermissions?: boolean;
}

export async function createTask(opts: CreateTaskOptions): Promise<string> {
  const {
    name,
    agentDef,
    projectId,
    symlinkDirs = [],
    initialPrompt,
    githubUrl,
    skipPermissions,
  } = opts;
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error('Project not found');
  if (isProjectMissing(projectId)) throw new Error('Project folder not found');

  const branchPrefix = opts.branchPrefixOverride ?? getProjectBranchPrefix(projectId);
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
    notes: '',
    lastPrompt: '',
    initialPrompt: initialPrompt || undefined,
    skipPermissions: skipPermissions || undefined,
    githubUrl,
    savedInitialPrompt: initialPrompt || undefined,
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    resumed: false,
    status: 'running',
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
    }),
  );

  // Mark as busy immediately; terminal output may arrive later.
  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return result.id;
}

export interface CreateDirectTaskOptions {
  name: string;
  agentDef: AgentDef;
  projectId: string;
  mainBranch: string;
  initialPrompt?: string;
  githubUrl?: string;
  skipPermissions?: boolean;
}

export interface CreateImportedTaskOptions {
  projectId: string;
  worktree: ImportableWorktree;
  agentDef: AgentDef;
}

function deriveImportedTaskName(branchName: string, worktreePath: string): string {
  const branchTail = branchName.split('/').pop()?.trim() ?? '';
  const normalized = branchTail.replace(/[-_]+/g, ' ').trim();
  if (normalized) return cleanTaskName(normalized);
  return worktreePath.split('/').pop()?.trim() || branchName;
}

export async function createDirectTask(opts: CreateDirectTaskOptions): Promise<string> {
  const { name, agentDef, projectId, mainBranch, initialPrompt, githubUrl, skipPermissions } = opts;
  if (hasDirectModeTask(projectId)) {
    throw new Error('A direct-mode task already exists for this project');
  }
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error('Project not found');
  if (isProjectMissing(projectId)) throw new Error('Project folder not found');

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
    notes: '',
    lastPrompt: '',
    initialPrompt: initialPrompt || undefined,
    savedInitialPrompt: initialPrompt || undefined,
    directMode: true,
    skipPermissions: skipPermissions || undefined,
    githubUrl,
  };

  const agent: Agent = {
    id: agentId,
    taskId: id,
    def: agentDef,
    resumed: false,
    status: 'running',
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
    }),
  );

  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return id;
}

export async function createImportedTask(opts: CreateImportedTaskOptions): Promise<string> {
  const { projectId, worktree, agentDef } = opts;
  if (!getProjectPath(projectId)) throw new Error('Project not found');
  if (isProjectMissing(projectId)) throw new Error('Project folder not found');

  const id = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const name = deriveImportedTaskName(worktree.branch_name, worktree.path);

  const task: Task = {
    id,
    name,
    projectId,
    branchName: worktree.branch_name,
    worktreePath: worktree.path,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    externalWorktree: true,
  };

  const agent: Agent = {
    id: agentId,
    taskId: id,
    def: agentDef,
    resumed: false,
    status: 'running',
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
    }),
  );

  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return id;
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'closing' || task.closingStatus === 'removing') return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const projectRoot = getProjectPath(task.projectId) ?? '';
  const deleteBranch = task.externalWorktree
    ? false
    : (getProject(task.projectId)?.deleteBranchOnClose ?? true);

  // Mark as closing — task stays visible but UI shows closing state
  setStore('tasks', taskId, 'closingStatus', 'closing');
  setStore('tasks', taskId, 'closingError', undefined);

  try {
    // Kill agents
    for (const agentId of agentIds) {
      await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    }

    // Skip git cleanup for direct mode (no worktree/branch to remove)
    if (!task.directMode && !task.externalWorktree) {
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
    console.error('Failed to close task:', err);
    setStore('tasks', taskId, 'closingStatus', 'error');
    setStore('tasks', taskId, 'closingError', String(err));
  }
}

export async function retryCloseTask(taskId: string): Promise<void> {
  setStore('tasks', taskId, 'closingStatus', undefined);
  setStore('tasks', taskId, 'closingError', undefined);
  await closeTask(taskId);
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

  // Phase 1: mark as removing so UI can animate
  setStore('tasks', taskId, 'closingStatus', 'removing');

  // Phase 2: actually delete after animation completes
  setTimeout(() => {
    setStore(
      produce((s) => {
        delete s.tasks[taskId];
        delete s.taskGitStatus[taskId];

        // Compute neighbor BEFORE cleanupPanelEntries removes taskId from taskOrder
        let neighbor: string | null = null;
        if (s.activeTaskId === taskId) {
          const idx = s.taskOrder.indexOf(taskId);
          const filteredOrder = s.taskOrder.filter((id) => id !== taskId);
          const neighborIdx = idx <= 0 ? 0 : idx - 1;
          neighbor = filteredOrder[neighborIdx] ?? null;
        }

        cleanupPanelEntries(s, taskId);

        if (s.activeTaskId === taskId) {
          s.activeTaskId = neighbor;
          const neighborTask = neighbor ? s.tasks[neighbor] : null;
          s.activeAgentId = neighborTask?.agentIds[0] ?? null;
        }

        for (const agentId of agentIds) {
          delete s.agents[agentId];
        }
      }),
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
  options?: { squash?: boolean; message?: string; cleanup?: boolean },
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'removing') return;
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
  setStore('tasks', taskId, 'name', name);
  if (store.activeTaskId === taskId) {
    updateWindowTitle(name);
  }
}

export function updateTaskNotes(taskId: string, notes: string): void {
  setStore('tasks', taskId, 'notes', notes);
}

export async function sendPrompt(taskId: string, agentId: string, text: string): Promise<void> {
  // Send text and Enter separately so TUI apps (Claude Code, Codex)
  // don't treat the \r as part of a pasted block
  await writeToAgentWhenReady(agentId, text);
  await new Promise((r) => setTimeout(r, 50));
  await writeToAgentWhenReady(agentId, '\r');
  setStore('tasks', taskId, 'lastPrompt', text);
}

export function setLastPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'lastPrompt', text);
}

export function clearInitialPrompt(taskId: string): void {
  setStore('tasks', taskId, 'initialPrompt', undefined);
}

export function clearPrefillPrompt(taskId: string): void {
  setStore('tasks', taskId, 'prefillPrompt', undefined);
}

export function setPrefillPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'prefillPrompt', text);
}

export function reorderTask(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  setStore(
    produce((s) => {
      const len = s.taskOrder.length;
      if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) return;
      const [moved] = s.taskOrder.splice(fromIndex, 1);
      s.taskOrder.splice(toIndex, 0, moved);
    }),
  );
}

export function spawnShellForTask(taskId: string, initialCommand?: string): string {
  const shellId = crypto.randomUUID();
  if (initialCommand) setPendingShellCommand(shellId, initialCommand);
  markAgentSpawned(shellId);
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (!task) return;
      task.shellAgentIds.push(shellId);
    }),
  );
  return shellId;
}

/** Send a bookmark command to an existing idle shell, or spawn a new one. */
export function runBookmarkInTask(taskId: string, command: string): void {
  const task = store.tasks[taskId];
  if (!task) return;

  // Prefer the most-recently-created idle shell (sitting at a prompt).
  for (let i = task.shellAgentIds.length - 1; i >= 0; i--) {
    const shellId = task.shellAgentIds[i];
    if (isAgentIdle(shellId)) {
      // Mark busy immediately so rapid clicks don't reuse the same shell.
      markAgentBusy(shellId);
      setTaskFocusedPanel(taskId, `shell:${i}`);
      invoke(IPC.WriteToAgent, { agentId: shellId, data: command + '\r' }).catch(() => {
        spawnShellForTask(taskId, command);
      });
      return;
    }
  }

  spawnShellForTask(taskId, command);
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
    }),
  );

  if (closedIndex >= 0) {
    const remaining = store.tasks[taskId]?.shellAgentIds.length ?? 0;
    if (remaining === 0) {
      setTaskFocusedPanel(taskId, 'shell-toolbar');
    } else {
      const focusIndex = Math.min(closedIndex, remaining - 1);
      setTaskFocusedPanel(taskId, `shell:${focusIndex}`);
    }
  }
}

export function hasDirectModeTask(projectId: string): boolean {
  const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  return allTaskIds.some((taskId) => {
    const task = store.tasks[taskId];
    return (
      task && task.projectId === projectId && task.directMode && task.closingStatus !== 'removing'
    );
  });
}

export async function collapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus) return;

  // Save agent def before killing so uncollapse can restart cleanly.
  // Collapsing unmounts the TaskPanel which destroys the TerminalView,
  // so agents must be killed explicitly to avoid orphaned PTY processes.
  const firstAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : null;
  const agentDef = firstAgent?.def;
  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];

  for (const agentId of agentIds) {
    await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    clearAgentActivity(agentId);
  }
  for (const shellId of shellAgentIds) {
    await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    clearAgentActivity(shellId);
  }

  setStore(
    produce((s) => {
      if (!s.tasks[taskId]) return;
      s.tasks[taskId].collapsed = true;
      s.tasks[taskId].savedAgentDef = agentDef;
      s.tasks[taskId].agentIds = [];
      s.tasks[taskId].shellAgentIds = [];
      const idx = s.taskOrder.indexOf(taskId);
      if (idx !== -1) s.taskOrder.splice(idx, 1);
      s.collapsedTaskOrder.push(taskId);

      // Clean up agent entries
      for (const agentId of agentIds) {
        delete s.agents[agentId];
      }

      // Switch active task to neighbor
      if (s.activeTaskId === taskId) {
        const neighbor = s.taskOrder[Math.max(0, idx - 1)] ?? null;
        s.activeTaskId = neighbor;
        const neighborTask = neighbor ? s.tasks[neighbor] : null;
        s.activeAgentId = neighborTask?.agentIds[0] ?? null;
      }
    }),
  );

  rescheduleTaskStatusPolling();
  const activeId = store.activeTaskId;
  const activeTask = activeId ? store.tasks[activeId] : null;
  const activeTerminal = activeId ? store.terminals[activeId] : null;
  updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
}

export function uncollapseTask(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task || !task.collapsed) return;

  const savedDef = task.savedAgentDef;
  const agentId = savedDef ? crypto.randomUUID() : null;

  setStore(
    produce((s) => {
      const t = s.tasks[taskId];
      t.collapsed = false;
      s.collapsedTaskOrder = s.collapsedTaskOrder.filter((id) => id !== taskId);
      s.taskOrder.push(taskId);
      s.activeTaskId = taskId;

      if (agentId && savedDef) {
        const agent: Agent = {
          id: agentId,
          taskId,
          def: savedDef,
          resumed: true,
          status: 'running',
          exitCode: null,
          signal: null,
          lastOutput: [],
          generation: 0,
        };
        s.agents[agentId] = agent;
        t.agentIds = [agentId];
        t.savedAgentDef = undefined;
      }

      s.activeAgentId = t.agentIds[0] ?? null;
    }),
  );

  if (agentId) {
    markAgentSpawned(agentId);
    rescheduleTaskStatusPolling();
  }

  updateWindowTitle(task.name);
}

// --- GitHub drop-to-create helpers ---

/** Find best matching project by comparing repo name to project directory basenames. */
function matchProject(repoName: string): string | null {
  const lower = repoName.toLowerCase();
  for (const project of store.projects) {
    const basename = project.path.split('/').pop() ?? '';
    if (basename.toLowerCase() === lower) return project.id;
  }
  return null;
}

/** Derive dialog defaults (name, matched project) from a GitHub URL. */
export function getGitHubDropDefaults(
  url: string,
): { name: string; projectId: string | null } | null {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;
  return {
    name: taskNameFromGitHubUrl(parsed),
    projectId: matchProject(parsed.repo),
  };
}

export function setNewTaskDropUrl(url: string): void {
  setStore('newTaskDropUrl', url);
}

export function setNewTaskPrefillPrompt(prompt: string, projectId: string | null): void {
  setStore('newTaskPrefillPrompt', { prompt, projectId });
}

export function setPlanContent(
  taskId: string,
  content: string | null,
  fileName: string | null,
): void {
  setStore('tasks', taskId, 'planContent', content ?? undefined);
  setStore('tasks', taskId, 'planFileName', fileName ?? undefined);
}
