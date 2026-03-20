import { produce } from 'solid-js/store';
import { confirm, openDialog } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
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
  // Guard: skip removal if any tasks still reference this project
  const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  const hasLinkedTasks = allTaskIds.some((tid) => store.tasks[tid]?.projectId === projectId);
  if (hasLinkedTasks) {
    console.warn(
      'removeProject: skipped — tasks still reference this project. Use removeProjectWithTasks.',
    );
    return;
  }

  setStore(
    produce((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      if (s.lastProjectId === projectId) {
        s.lastProjectId = s.projects[0]?.id ?? null;
      }
      delete s.missingProjectIds[projectId];
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
  const collapsedTaskIds = store.collapsedTaskOrder.filter(
    (tid) => store.tasks[tid]?.projectId === projectId,
  );

  // Close tasks sequentially to avoid concurrent git operations on the same repo.
  // Must happen before removeProject() since closeTask needs the project path.
  for (const tid of taskIds) {
    // closeTask handles and stores its own errors, so this should not throw.
    await closeTask(tid);
  }
  for (const tid of collapsedTaskIds) {
    await closeTask(tid);
  }

  // If any tasks failed to close, keep the project so users can retry.
  const allTaskIds = [...taskIds, ...collapsedTaskIds];
  const hasRemainingTasks = allTaskIds.some((tid) => store.tasks[tid]?.projectId === projectId);
  if (hasRemainingTasks) return;

  // Now remove the project itself
  removeProject(projectId);
}

/** Returns true if the path is not a git repo root (and shows a warning dialog). */
async function rejectNonGitFolder(dirPath: string): Promise<boolean> {
  const isGit = await invoke<boolean>(IPC.CheckIsGitRepo, { path: dirPath });
  if (isGit) return false;
  await confirm(
    'Parallel Code requires each project to be a git repository. It uses branches and worktrees to let AI agents work in isolation.\n\nTo initialize git, run "git init" in your project folder, then try again.',
    { title: 'Not a Git Repository', kind: 'warning', okLabel: 'OK' },
  );
  return true;
}

export async function pickAndAddProject(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return null;
  const path = selected as string;

  if (await rejectNonGitFolder(path)) return null;

  const segments = path.split('/');
  const name = segments[segments.length - 1] || path;
  return addProject(name, path);
}

/** Check each project path and record which ones are missing. */
export async function validateProjectPaths(): Promise<void> {
  const missing: Record<string, true> = {};
  for (const project of store.projects) {
    try {
      const exists = await invoke<boolean>(IPC.CheckPathExists, { path: project.path });
      if (!exists) missing[project.id] = true;
    } catch {
      missing[project.id] = true;
    }
  }
  setStore('missingProjectIds', missing);
}

/** Let the user pick a new folder for a project whose path is missing. */
export async function relinkProject(projectId: string): Promise<boolean> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return false;
  const newPath = selected as string;

  if (await rejectNonGitFolder(newPath)) return false;

  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      s.projects[idx].path = newPath;
    }),
  );

  const exists = await invoke<boolean>(IPC.CheckPathExists, { path: newPath });
  if (exists) {
    setStore('missingProjectIds', (prev: Record<string, true>) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }
  return exists;
}

export function isProjectMissing(projectId: string): boolean {
  return projectId in store.missingProjectIds;
}
