import { resolveIncludeSelection, splitIncludeSelection } from '../lib/worktree-includes';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getProjectBaseBranch } from './projects';
import type { CreateTaskOptions } from './tasks';
import type { GitIgnoredEntry } from '../ipc/types';
import type { Project } from './types';

/** The Git settings the New Task dialog defaults to, for tasks created without it. */
export async function newTaskGitDefaults(
  project: Project,
): Promise<Pick<CreateTaskOptions, 'gitIsolation' | 'baseBranch' | 'symlinkDirs' | 'copyDirs'>> {
  // Non-git projects can't use worktree isolation; fall back to working
  // directly in the project folder.
  if (project.isGitRepo === false) return { gitIsolation: 'none', baseBranch: '', symlinkDirs: [] };
  const baseBranch = await getProjectBaseBranch(project);
  // Match the desktop New Task default without opting remote users into
  // newly discovered entries that have no confirmation UI. A saved project
  // include list is that confirmation, so it applies here too.
  const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
    projectRoot: project.path,
  });
  const initial = resolveIncludeSelection(ignoredEntries, project.worktreeIncludes);
  const { symlinkDirs, copyDirs } = splitIncludeSelection(initial.selected, initial.copy);
  return { gitIsolation: 'worktree', baseBranch, symlinkDirs, copyDirs };
}
