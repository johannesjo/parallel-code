import { produce } from 'solid-js/store';
import { openDialog } from '../lib/dialog';
import { store, setStore } from './core';
import { closeTask } from './tasks';
import type { Project } from './types';
import { sanitizeBranchPrefix } from '../lib/branch-name';

export const PASTEL_HUES = [0, 30, 60, 120, 180, 210, 260, 300, 330];

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
    }),
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
    }),
  );
}

export function updateProject(
  projectId: string,
  updates: Partial<
    Pick<
      Project,
      | 'name'
      | 'color'
      | 'branchPrefix'
      | 'deleteBranchOnClose'
      | 'defaultDirectMode'
      | 'terminalBookmarks'
    >
  >,
): void {
  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      if (updates.name !== undefined) s.projects[idx].name = updates.name;
      if (updates.color !== undefined) s.projects[idx].color = updates.color;
      if (updates.branchPrefix !== undefined)
        s.projects[idx].branchPrefix = sanitizeBranchPrefix(updates.branchPrefix);
      if (updates.deleteBranchOnClose !== undefined)
        s.projects[idx].deleteBranchOnClose = updates.deleteBranchOnClose;
      if (updates.defaultDirectMode !== undefined)
        s.projects[idx].defaultDirectMode = updates.defaultDirectMode;
      if (updates.terminalBookmarks !== undefined)
        s.projects[idx].terminalBookmarks = updates.terminalBookmarks;
    }),
  );
}

export function getProjectBranchPrefix(projectId: string): string {
  const raw = store.projects.find((p) => p.id === projectId)?.branchPrefix ?? 'task';
  return sanitizeBranchPrefix(raw);
}

export function getProjectPath(projectId: string): string | undefined {
  return store.projects.find((p) => p.id === projectId)?.path;
}

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  // Collect task IDs belonging to this project BEFORE removing anything
  const taskIds = store.taskOrder.filter((tid) => store.tasks[tid]?.projectId === projectId);

  // Close tasks sequentially to avoid concurrent git operations on the same repo.
  // Must happen before removeProject() since closeTask needs the project path.
  for (const tid of taskIds) {
    // closeTask handles and stores its own errors, so this should not throw.
    await closeTask(tid);
  }

  // If any tasks failed to close, keep the project so users can retry.
  const hasRemainingTasks = taskIds.some((tid) => store.tasks[tid]?.projectId === projectId);
  if (hasRemainingTasks) return;

  // Now remove the project itself
  removeProject(projectId);
}

export async function pickAndAddProject(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return null;
  const path = selected as string;
  const segments = path.split('/');
  const name = segments[segments.length - 1] || path;
  return addProject(name, path);
}
