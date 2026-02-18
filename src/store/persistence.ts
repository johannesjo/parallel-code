import { produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, setStore } from "./core";
import { randomPastelColor } from "./projects";
import type { Agent, Task, PersistedState, PersistedTask, Project } from "./types";

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: [...store.taskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: { ...store.fontScales },
    panelSizes: { ...store.panelSizes },
    globalScale: store.globalScale,
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

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
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

  // Validate essential structure
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.taskOrder) || typeof raw.tasks !== "object") {
    console.warn("Invalid persisted state structure, skipping load");
    return;
  }

  // Migrate from old format if needed
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;
  const lastAgentId: string | null = raw.lastAgentId ?? null;

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
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = raw.activeTaskId;
      s.sidebarVisible = raw.sidebarVisible;
      const rawAny = raw as unknown as Record<string, unknown>;
      s.fontScales = isStringNumberRecord(rawAny.fontScales) ? rawAny.fontScales : {};
      s.panelSizes = isStringNumberRecord(rawAny.panelSizes) ? rawAny.panelSizes : {};
      s.globalScale = typeof rawAny.globalScale === "number" ? rawAny.globalScale : 1;

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
            signal: null,
            lastOutput: [],
            generation: 0,
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
    getCurrentWindow().setTitle(`Parallel Code - ${activeTask.name}`).catch(() => {});
  }
}
