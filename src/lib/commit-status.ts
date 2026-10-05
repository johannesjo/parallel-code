import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile } from '../ipc/types';

/** An uncommitted file and whether the index already holds a change to it. */
export interface CommitFile {
  path: string;
  status: string;
  staged: boolean;
}

/** The uncommitted files a commit dialog lists, desktop or phone. */
export async function loadCommitFiles(worktreePath: string): Promise<CommitFile[]> {
  const [files, staged] = await Promise.all([
    invoke<ChangedFile[]>(IPC.GetUncommittedChangedFiles, { worktreePath }),
    invoke<string[]>(IPC.GetStagedFiles, { worktreePath }),
  ]);
  const stagedPaths = new Set(staged);
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    staged: stagedPaths.has(file.path),
  }));
}
