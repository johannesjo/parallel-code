import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';
import { errMessage } from './log';
import {
  isCommitHashSelection,
  isUncommittedSelection,
  type CommitSelection,
} from '../components/CommitNavBar';

export interface TaskDiffInput {
  worktreePath: string;
  projectRoot?: string;
  branchName?: string | null;
  baseBranch?: string;
  selectedCommit?: CommitSelection;
}

/** Direct tasks work on their base branch, so naming that branch as the diff base
 * would compare HEAD to itself and hide committed work from the All view. */
export function getTaskDiffBaseBranch(
  gitIsolation: 'worktree' | 'direct' | 'none',
  baseBranch?: string,
): string | undefined {
  return gitIsolation === 'direct' ? undefined : baseBranch;
}

/** Return the repository that supplied the diff so follow-up requests use a valid cwd. */
export async function loadTaskDiff(
  input: TaskDiffInput,
): Promise<{ rawDiff: string; cwd: string }> {
  const { worktreePath, projectRoot, branchName, baseBranch, selectedCommit } = input;
  if (isCommitHashSelection(selectedCommit) && worktreePath) {
    const rawDiff = await invoke<string>(IPC.GetCommitDiffs, {
      worktreePath,
      commitHash: selectedCommit,
    });
    return { rawDiff, cwd: worktreePath };
  }
  if (isUncommittedSelection(selectedCommit)) {
    if (!worktreePath) throw new Error('A worktree is required to read uncommitted changes.');
    const rawDiff = await invoke<string>(IPC.GetUncommittedFileDiffs, { worktreePath });
    return { rawDiff, cwd: worktreePath };
  }
  try {
    if (!worktreePath) throw new Error('no worktree');
    const rawDiff = await invoke<string>(IPC.GetAllFileDiffs, { worktreePath, baseBranch });
    return { rawDiff, cwd: worktreePath };
  } catch (error) {
    if (projectRoot && branchName) {
      const rawDiff = await invoke<string>(IPC.GetAllFileDiffsFromBranch, {
        projectRoot,
        branchName,
        baseBranch,
      });
      return { rawDiff, cwd: projectRoot };
    }
    throw new Error(`Could not load diffs: ${errMessage(error)}`);
  }
}
