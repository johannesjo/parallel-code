import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentDef, CreateTaskResult } from "../ipc/types";
import type { AppStore, Agent, Task, PersistedState, PersistedTask, Project } from "./types";

// --- Plan Watcher ---

export async function startGlobalPlanWatcher(): Promise<void> {
  await invoke("watch_for_plans").catch((e) =>
    console.warn("Failed to start plan watcher:", e)
  );
}

export async function stopGlobalPlanWatcher(): Promise<void> {
  await invoke("stop_watching_plans").catch(() => {});
}

export function setPendingPlan(
  taskId: string,
  filePath: string,
  fileName: string,
  content: string
): void {
  setStore("tasks", taskId, "pendingPlan", { filePath, fileName, content });
}

// Track dismissed plan file paths to prevent re-triggering
const dismissedPlanPaths = new Set<string>();

export function dismissPlan(taskId: string): void {
  const plan = store.tasks[taskId]?.pendingPlan;
  if (plan) {
    dismissedPlanPaths.add(plan.filePath);
  }
  setStore("tasks", taskId, "pendingPlan", null);
}

export function isPlanDismissed(filePath: string): boolean {
  return dismissedPlanPaths.has(filePath);
}

export async function executeEditedPlan(taskId: string, editedContent: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const oldAgentId = task.agentIds[0];
  const oldAgent = oldAgentId ? store.agents[oldAgentId] : null;
  if (!oldAgent) return;

  // Snapshot values before async operations
  const agentDef = { ...oldAgent.def };
  const planFilePath = task.pendingPlan?.filePath;

  // Suppress re-trigger for this file path
  if (planFilePath) dismissedPlanPaths.add(planFilePath);

  // Kill the current agent
  await invoke("kill_agent", { agentId: oldAgentId }).catch(() => {});

  // Write the edited plan back to the file
  if (planFilePath) {
    await invoke("write_plan_file", {
      path: planFilePath,
      content: editedContent,
    }).catch((e) => console.warn("Failed to write edited plan:", e));
  }

  // Create a new agent with planPrompt
  // NOTE: The new agent's PTY process is spawned when TerminalView remounts
  // due to Solid's keyed <Show> detecting the agent reference change.
  const newAgentId = crypto.randomUUID();
  const planPrompt = `Implement this plan step by step:\n\n${editedContent}`;

  const newAgent: Agent = {
    id: newAgentId,
    taskId,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    planPrompt,
  };

  setStore(
    produce((s) => {
      // Remove old agent
      delete s.agents[oldAgentId];

      // Replace agentIds: swap out old for new
      const agentIds = s.tasks[taskId].agentIds;
      const idx = agentIds.indexOf(oldAgentId);
      if (idx !== -1) {
        agentIds[idx] = newAgentId;
      } else {
        agentIds.push(newAgentId);
      }

      // Add new agent and clear pending plan
      s.agents[newAgentId] = newAgent;
      s.tasks[taskId].pendingPlan = null;

      if (s.activeAgentId === oldAgentId) {
        s.activeAgentId = newAgentId;
      }
    })
  );

}

const [store, setStore] = createStore<AppStore>({
  projects: [],
  lastProjectId: null,
  taskOrder: [],
  tasks: {},
  agents: {},
  activeTaskId: null,
  activeAgentId: null,
  availableAgents: [],
  showNewTaskDialog: false,
  sidebarVisible: true,
  fontScales: {},
});

export { store };

// --- Font Scale ---

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.1;

export function getFontScale(panelId: string): number {
  return store.fontScales[panelId] ?? 1;
}

export function adjustFontScale(panelId: string, delta: 1 | -1): void {
  const current = getFontScale(panelId);
  const next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta * SCALE_STEP)) * 10) / 10;
  setStore("fontScales", panelId, next);
}

export function resetFontScale(panelId: string): void {
  setStore("fontScales", panelId, 1.0);
}

// --- Projects ---

const PASTEL_HUES = [0, 30, 60, 120, 180, 210, 260, 300, 330];

function randomPastelColor(): string {
  const hue = PASTEL_HUES[Math.floor(Math.random() * PASTEL_HUES.length)];
  return `hsl(${hue}, 70%, 75%)`;
}

export function getProject(projectId: string): Project | undefined {
  return store.projects.find((p) => p.id === projectId);
}

export function addProject(name: string, path: string): string {
  const id = crypto.randomUUID();
  const color = randomPastelColor();
  const project: Project = { id, name, path, color };
  setStore(
    produce((s) => {
      s.projects.push(project);
      s.lastProjectId = id;
    })
  );
  return id;
}

export function removeProject(projectId: string): void {
  setStore(
    produce((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      if (s.lastProjectId === projectId) {
        s.lastProjectId = s.projects[0]?.id ?? null;
      }
    })
  );
}

export function getProjectPath(projectId: string): string | undefined {
  return store.projects.find((p) => p.id === projectId)?.path;
}

// --- Agents ---

export async function loadAgents(): Promise<void> {
  const agents = await invoke<AgentDef[]>("list_agents");
  setStore("availableAgents", agents);
}

// --- Tasks ---

export async function createTask(
  name: string,
  agentDef: AgentDef,
  projectId: string,
  symlinkDirs: string[] = []
): Promise<void> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error("Project not found");

  const result = await invoke<CreateTaskResult>("create_task", {
    name,
    projectRoot,
    symlinkDirs,
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
    pendingPlan: null,
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    planPrompt: null,
  };

  setStore(
    produce((s) => {
      s.tasks[result.id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(result.id);
      s.activeTaskId = result.id;
      s.activeAgentId = agentId;
      s.lastProjectId = projectId;
    })
  );

  updateWindowTitle(name);
}

export async function addAgentToTask(
  taskId: string,
  agentDef: AgentDef
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const agentId = crypto.randomUUID();
  const agent: Agent = {
    id: agentId,
    taskId,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    planPrompt: null,
  };

  setStore(
    produce((s) => {
      s.agents[agentId] = agent;
      s.tasks[taskId].agentIds.push(agentId);
      s.activeAgentId = agentId;
    })
  );
}

export function markAgentExited(agentId: string, code: number | null): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = "exited";
        s.agents[agentId].exitCode = code;
      }
    })
  );
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const projectRoot = getProjectPath(task.projectId) ?? "";

  // Remove task from UI immediately (unmounts TaskPanel first)
  setStore(
    produce((s) => {
      delete s.tasks[taskId];
      delete s.fontScales[taskId];
      s.taskOrder = s.taskOrder.filter((id) => id !== taskId);

      if (s.activeTaskId === taskId) {
        s.activeTaskId = s.taskOrder[0] ?? null;
        const firstTask = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
        s.activeAgentId = firstTask?.agentIds[0] ?? null;
      }
    })
  );

  // Clean up orphaned agent entries after panel has unmounted
  setStore(
    produce((s) => {
      for (const agentId of agentIds) {
        delete s.agents[agentId];
      }
    })
  );

  // Clean up backend in the background (kill agents, remove worktree + branch)
  for (const agentId of agentIds) {
    invoke("kill_agent", { agentId }).catch(() => {});
  }
  for (const shellId of shellAgentIds) {
    invoke("kill_agent", { agentId: shellId }).catch(() => {});
  }
  invoke("delete_task", {
    taskId,
    branchName,
    deleteBranch: true,
    projectRoot,
  }).catch(() => {});

  // Update window title
  const activeTask = store.activeTaskId ? store.tasks[store.activeTaskId] : null;
  updateWindowTitle(activeTask?.name);
}

export async function mergeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;

  // Kill agents first
  for (const agentId of agentIds) {
    await invoke("kill_agent", { agentId }).catch(() => {});
  }
  for (const shellId of shellAgentIds) {
    await invoke("kill_agent", { agentId: shellId }).catch(() => {});
  }

  // Merge branch into main, remove worktree + branch
  await invoke<string>("merge_task", {
    projectRoot,
    branchName,
  });

  // Remove from UI
  setStore(
    produce((s) => {
      delete s.tasks[taskId];
      s.taskOrder = s.taskOrder.filter((id) => id !== taskId);
      if (s.activeTaskId === taskId) {
        s.activeTaskId = s.taskOrder[0] ?? null;
        const firstTask = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
        s.activeAgentId = firstTask?.agentIds[0] ?? null;
      }
    })
  );
  setStore(
    produce((s) => {
      for (const agentId of agentIds) {
        delete s.agents[agentId];
      }
    })
  );

  // Remove from Rust task state
  invoke("delete_task", {
    taskId,
    branchName,
    deleteBranch: false,
    projectRoot,
  }).catch(() => {});

  updateWindowTitle(store.activeTaskId ? store.tasks[store.activeTaskId]?.name : undefined);
}

export function setActiveTask(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  setStore("activeTaskId", taskId);
  setStore("activeAgentId", task.agentIds[0] ?? null);
  updateWindowTitle(task.name);
}

function updateWindowTitle(taskName?: string): void {
  const title = taskName ? `AI Mush - ${taskName}` : "AI Mush";
  getCurrentWindow().setTitle(title).catch(() => {});
}

export function setActiveAgent(agentId: string): void {
  setStore("activeAgentId", agentId);
}

export function toggleNewTaskDialog(show?: boolean): void {
  setStore("showNewTaskDialog", show ?? !store.showNewTaskDialog);
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

export function moveActiveTask(direction: "up" | "down"): void {
  const { taskOrder, activeTaskId } = store;
  if (!activeTaskId || taskOrder.length < 2) return;
  const idx = taskOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= taskOrder.length) return;
  reorderTask(idx, target);
}

export function navigateTask(direction: "left" | "right"): void {
  const { taskOrder, activeTaskId } = store;
  if (taskOrder.length === 0) return;
  const idx = activeTaskId ? taskOrder.indexOf(activeTaskId) : -1;
  const next =
    direction === "left"
      ? Math.max(0, idx - 1)
      : Math.min(taskOrder.length - 1, idx + 1);
  setActiveTask(taskOrder[next]);
}

export function navigateAgent(direction: "up" | "down"): void {
  const { activeTaskId, activeAgentId } = store;
  if (!activeTaskId) return;
  const task = store.tasks[activeTaskId];
  if (!task) return;
  const idx = activeAgentId ? task.agentIds.indexOf(activeAgentId) : -1;
  const next =
    direction === "up"
      ? Math.max(0, idx - 1)
      : Math.min(task.agentIds.length - 1, idx + 1);
  setStore("activeAgentId", task.agentIds[next]);
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
  await invoke("write_to_agent", { agentId, data: text + "\r" });
  setStore("tasks", taskId, "lastPrompt", text);
}

export function setLastPrompt(taskId: string, text: string): void {
  setStore("tasks", taskId, "lastPrompt", text);
}

export function toggleSidebar(): void {
  setStore("sidebarVisible", !store.sidebarVisible);
}

export function spawnShellForTask(taskId: string): string {
  const shellId = crypto.randomUUID();
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

// --- Persistence ---

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    taskOrder: [...store.taskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: { ...store.fontScales },
  };

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;

    const firstAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : null;

    persisted.tasks[taskId] = {
      id: task.id,
      name: task.name,
      projectId: task.projectId,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      notes: task.notes,
      lastPrompt: task.lastPrompt,
      shellCount: task.shellAgentIds.length,
      agentDef: firstAgent?.def ?? null,
    };
  }

  await invoke("save_app_state", { json: JSON.stringify(persisted) }).catch(
    (e) => console.warn("Failed to save state:", e)
  );
}

interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  taskOrder: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
}

export async function loadState(): Promise<void> {
  const json = await invoke<string | null>("load_app_state").catch(() => null);
  if (!json) return;

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn("Failed to parse persisted state");
    return;
  }

  // Migrate from old format if needed
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;

  // Assign colors to projects that don't have one (backward compat)
  for (const p of projects) {
    if (!p.color) p.color = randomPastelColor();
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split("/");
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [{ id, name, path: raw.projectRoot, color: randomPastelColor() }];
    lastProjectId = id;

    // Assign this project to all existing tasks
    for (const taskId of raw.taskOrder) {
      const pt = raw.tasks[taskId];
      if (pt && !pt.projectId) {
        pt.projectId = id;
      }
    }
  }

  setStore(
    produce((s) => {
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = raw.activeTaskId;
      s.sidebarVisible = raw.sidebarVisible;
      s.fontScales = (raw as unknown as { fontScales?: Record<string, number> }).fontScales ?? {};

      for (const taskId of raw.taskOrder) {
        const pt = raw.tasks[taskId];
        if (!pt) continue;

        const agentId = crypto.randomUUID();
        const agentDef = pt.agentDef;

        // Enrich with resume_args from fresh defaults (handles old state files)
        if (agentDef && !agentDef.resume_args) {
          const fresh = s.availableAgents.find((a) => a.id === agentDef.id);
          if (fresh) agentDef.resume_args = fresh.resume_args;
        }

        const shellAgentIds: string[] = [];
        for (let i = 0; i < pt.shellCount; i++) {
          shellAgentIds.push(crypto.randomUUID());
        }

        const task: Task = {
          id: pt.id,
          name: pt.name,
          projectId: pt.projectId ?? "",
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: agentDef ? [agentId] : [],
          shellAgentIds,
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          pendingPlan: null,
        };

        s.tasks[taskId] = task;

        if (agentDef) {
          const agent: Agent = {
            id: agentId,
            taskId,
            def: agentDef,
            resumed: true,
            status: "running",
            exitCode: null,
            planPrompt: null,
          };
          s.agents[agentId] = agent;
        }
      }

      // Set activeAgentId from the active task
      if (s.activeTaskId && s.tasks[s.activeTaskId]) {
        s.activeAgentId = s.tasks[s.activeTaskId].agentIds[0] ?? null;
      }
    })
  );

  // Update window title
  const activeTask = store.activeTaskId ? store.tasks[store.activeTaskId] : null;
  if (activeTask) {
    getCurrentWindow().setTitle(`AI Mush - ${activeTask.name}`).catch(() => {});
  }
}
