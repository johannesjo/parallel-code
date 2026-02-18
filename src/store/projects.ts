import { produce } from "solid-js/store";
import { store, setStore } from "./core";
import { closeTask } from "./tasks";
import type { Project } from "./types";

const PASTEL_HUES = [0, 30, 60, 120, 180, 210, 260, 300, 330];

export function randomPastelColor(): string {
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

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  // Collect task IDs belonging to this project BEFORE removing anything
  const taskIds = store.taskOrder.filter(
    (tid) => store.tasks[tid]?.projectId === projectId
  );

  // Close all tasks first (kills agents, removes worktrees/branches)
  // Must happen before removeProject() since closeTask needs the project path
  await Promise.all(taskIds.map((tid) => closeTask(tid)));

  // Now remove the project itself
  removeProject(projectId);
}
