import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentDef, CreateTaskResult } from "../ipc/types";
import type { AppStore, Agent, Task, PersistedState, PersistedTask } from "./types";

const [store, setStore] = createStore<AppStore>({
  projectRoot: null,
  taskOrder: [],
  tasks: {},
  agents: {},
  activeTaskId: null,
  activeAgentId: null,
  availableAgents: [],
  showNewTaskDialog: false,
  sidebarVisible: true,
});

export { store };

export async function loadAgents(): Promise<void> {
  const agents = await invoke<AgentDef[]>("list_agents");
  setStore("availableAgents", agents);
}

export async function setProjectRoot(path: string): Promise<void> {
  await invoke("set_project_root", { path });
  setStore("projectRoot", path);
}

export async function createTask(
  name: string,
  agentDef: AgentDef
): Promise<void> {
  const result = await invoke<CreateTaskResult>("create_task", { name });

  const agentId = crypto.randomUUID();
  const task: Task = {
    id: result.id,
    name,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: "",
    lastPrompt: "",
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
  };

  setStore(
    produce((s) => {
      s.tasks[result.id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(result.id);
      s.activeTaskId = result.id;
      s.activeAgentId = agentId;
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

  // Capture what we need before removing from store
  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;

  // Remove task from UI immediately (unmounts TaskPanel first)
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
  }).catch(() => {});

  // Update window title
  const activeTask = store.activeTaskId ? store.tasks[store.activeTaskId] : null;
  updateWindowTitle(activeTask?.name);
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

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    projectRoot: store.projectRoot,
    taskOrder: [...store.taskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
  };

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;

    const firstAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : null;

    persisted.tasks[taskId] = {
      id: task.id,
      name: task.name,
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

export async function loadState(): Promise<void> {
  const json = await invoke<string | null>("load_app_state").catch(() => null);
  if (!json) return;

  let persisted: PersistedState;
  try {
    persisted = JSON.parse(json);
  } catch {
    console.warn("Failed to parse persisted state");
    return;
  }

  setStore(
    produce((s) => {
      s.taskOrder = persisted.taskOrder;
      s.activeTaskId = persisted.activeTaskId;
      s.sidebarVisible = persisted.sidebarVisible;

      for (const taskId of persisted.taskOrder) {
        const pt: PersistedTask | undefined = persisted.tasks[taskId];
        if (!pt) continue;

        const agentId = crypto.randomUUID();
        const agentDef = pt.agentDef;

        const shellAgentIds: string[] = [];
        for (let i = 0; i < pt.shellCount; i++) {
          shellAgentIds.push(crypto.randomUUID());
        }

        const task: Task = {
          id: pt.id,
          name: pt.name,
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: agentDef ? [agentId] : [],
          shellAgentIds,
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
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
