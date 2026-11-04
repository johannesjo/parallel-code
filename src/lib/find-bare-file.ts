import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile } from '../ipc/types';
import { invoke } from './ipc';
import { errMessage, warn as logWarn } from './log';

// shortcut: a newly changed file links only once this expires — drop the entry
// on the task's diff refresh if the lag shows.
const CHANGED_FILES_TTL_MS = 5_000;
const changedFilesCache = new Map<string, { at: number; files: Promise<ChangedFile[]> }>();

/** The task's changed files; hovering asks often and each listing runs git diff. */
function changedFiles(
  worktreePath: string,
  baseBranch: string | undefined,
): Promise<ChangedFile[]> {
  const key = `${worktreePath}\n${baseBranch ?? ''}`;
  const cached = changedFilesCache.get(key);
  if (cached && Date.now() - cached.at < CHANGED_FILES_TTL_MS) return cached.files;
  const files = invoke<ChangedFile[]>(IPC.GetChangedFiles, { worktreePath, baseBranch });
  changedFilesCache.set(key, { at: Date.now(), files });
  // The caller sees the failure; dropping the entry lets the next hover retry.
  files.catch(() => changedFilesCache.delete(key));
  return files;
}

/**
 * Finds the file a name printed without a folder, such as `notes.md`, means: the one
 * in the worktree root, else the task's only changed file of that name. Resolves
 * undefined rather than guess, so the name stays plain text.
 */
export async function findBareFile(
  name: string,
  task: { worktreePath: string; baseBranch?: string },
): Promise<string | undefined> {
  const { worktreePath, baseBranch } = task;
  try {
    const inRoot = `${worktreePath}/${name}`;
    if (await invoke<boolean>(IPC.CheckPathExists, { path: inRoot })) return inRoot;
    const [only, ...others] = (await changedFiles(worktreePath, baseBranch)).filter(
      (file) => file.status !== 'D' && file.path.split('/').pop() === name,
    );
    return only && others.length === 0 ? `${worktreePath}/${only.path}` : undefined;
  } catch (err) {
    logWarn('terminal.links', `Could not look up ${name}`, { error: errMessage(err) });
    return undefined;
  }
}
