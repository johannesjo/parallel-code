import { createEffect, createResource, createSignal, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { isAdoptableBranch } from '../lib/branch-divergence';
import type { CoverageComparison } from '../lib/coverage-comparison';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import {
  backgroundVerifyEnabled,
  getPrChecks,
  getProjectPath,
  getTaskDotStatus,
  getVerifyCommand,
  mergeTask,
  runBackgroundVerify,
  store,
} from '../store/store';
import type { Task } from '../store/types';
import { advanceKanbanCard } from '../store/kanban';
import type { CommitInfo, MergeStatus, WorktreeStatus } from '../ipc/types';
import { buildMergeReadiness } from './merge-readiness';
import { buildSquashMessage, formatSquashMessage } from './squash-message';

interface MergeStateProps {
  open: boolean;
  task: Task;
  initialCleanup: boolean;
}

export type BaseSync = 'rebase' | 'merge';

/** Git facts and form state behind the merge option of the finish dialog. */
export function createMergeState(props: MergeStateProps) {
  const [mergeError, setMergeError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashTitle, setSquashTitle] = createSignal('');
  const [squashBody, setSquashBody] = createSignal('');
  // Rebase and merge-base share one slot: both rewrite the same worktree.
  const [syncing, setSyncing] = createSignal<BaseSync | null>(null);
  const [syncError, setSyncError] = createSignal('');
  const [syncDone, setSyncDone] = createSignal<BaseSync | null>(null);
  // Which sync stopped on conflicts, for the banner to offer another route.
  const [syncConflict, setSyncConflict] = createSignal<BaseSync | null>(null);
  const [coverageComparison, setCoverageComparison] = createSignal<CoverageComparison | null>(null);
  const requiresSeparateClose = () =>
    Boolean(props.task.delegationParent || props.task.coordinatorMode);

  const resourceSource = () =>
    props.open
      ? {
          path: props.task.worktreePath,
          baseBranch: props.task.baseBranch,
          projectRoot: getProjectPath(props.task.projectId),
        }
      : null;
  const [branchLog, { refetch: refetchBranchLog, mutate: mutateBranchLog }] = createResource(
    resourceSource,
    (src) =>
      invoke<string>(IPC.GetBranchLog, { worktreePath: src.path, baseBranch: src.baseBranch }),
  );
  const [branchCommits, { refetch: refetchBranchCommits, mutate: mutateBranchCommits }] =
    createResource(resourceSource, (src) =>
      invoke<CommitInfo[]>(IPC.GetBranchCommits, {
        worktreePath: src.path,
        baseBranch: src.baseBranch,
        withBody: true,
      }),
    );
  const [worktreeStatus, { refetch: refetchWorktreeStatus, mutate: mutateWorktreeStatus }] =
    createResource(resourceSource, (src) =>
      invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
        worktreePath: src.path,
        baseBranch: src.baseBranch,
      }),
    );
  const [mergeStatus, { refetch: refetchMergeStatus, mutate: mutateMergeStatus }] = createResource(
    resourceSource,
    (src) =>
      invoke<MergeStatus>(IPC.CheckMergeStatus, {
        worktreePath: src.path,
        baseBranch: src.baseBranch,
        // Also reports uncommitted changes where the merge would land.
        projectRoot: src.projectRoot,
      }),
  );
  const refetchAll = () => {
    refetchBranchLog();
    refetchBranchCommits();
    refetchMergeStatus();
    refetchWorktreeStatus();
  };

  const commitCount = () => (branchLog() ?? '').split('\n').filter((line) => line.trim()).length;
  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  /** Uncommitted changes in the base checkout; the merge sets them aside. */
  const targetUncommitted = () => mergeStatus()?.target_uncommitted;
  /** The task's uncommitted files the base changed too: they block bringing it in. */
  const uncommittedOverlap = () => mergeStatus()?.uncommitted_overlap ?? [];
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;
  const baseBranchName = () => props.task.baseBranch ?? mergeStatus()?.base_branch ?? 'main';
  const selectedAgentId = () => {
    const selected = props.task.selectedAgentId;
    if (
      props.task.id !== store.activeTaskId &&
      selected &&
      props.task.agentIds.includes(selected)
    ) {
      return selected;
    }
    const active = store.activeAgentId;
    if (active && props.task.agentIds.includes(active)) return active;
    if (selected && props.task.agentIds.includes(selected)) return selected;
    return props.task.agentIds[0];
  };
  const hasBranchMismatch = () => {
    const status = worktreeStatus();
    if (!status) return false;
    const current = status.current_branch;
    // null means detached HEAD — also a mismatch
    return current === null || current !== props.task.branchName;
  };
  // Never offer adopting the base branch: merge would become a self-merge and
  // close-time cleanup would try to delete the base.
  const adoptableWorktreeBranch = () => {
    const status = worktreeStatus();
    const current = status?.current_branch;
    if (!current || current === props.task.branchName) return null;
    return isAdoptableBranch(current, props.task.baseBranch ?? status?.base_branch)
      ? current
      : null;
  };
  const mergeReadiness = () =>
    buildMergeReadiness({
      expectedBranch: props.task.branchName,
      mergeStatus: mergeStatus(),
      mergeStatusLoading: mergeStatus.loading,
      worktreeStatus: worktreeStatus(),
      worktreeStatusLoading: worktreeStatus.loading,
      verification: props.task.verification,
      verificationRun: props.task.verificationRun,
      verifyCommandConfigured: Boolean(getVerifyCommand(props.task.id)),
      prChecks: getPrChecks(props.task.id),
      coverage: coverageComparison(),
    });
  /** Why Merge is unavailable, in the order the notices above it explain. */
  const mergeBlocker = (): string | undefined => {
    if (!worktreeStatus()) return 'Checking the branch…';
    if (hasBranchMismatch()) return "The worktree is not on this task's branch.";
    if (!hasCommittedChangesToMerge())
      return worktreeStatus()?.has_uncommitted_changes
        ? 'Commit the changes to merge them.'
        : 'No commits on this branch yet.';
    if (hasConflicts()) return `Resolve the conflicts with ${baseBranchName()} first.`;
    if (targetUncommitted()?.overlap.length)
      return `Commit or stash the changes in ${baseBranchName()} that this merge touches.`;
    if (squash() && !squashTitle().trim()) return 'Add a commit title.';
    return undefined;
  };
  const canMerge = () => !merging() && !mergeBlocker();

  createEffect(() => {
    if (props.open) {
      setCleanupAfterMerge(props.initialCleanup);
      setSquash(false);
      setSquashTitle('');
      setSquashBody('');
      setMergeError('');
      setSyncError('');
      setSyncDone(null);
      setSyncConflict(null);
      setMerging(false);
      setSyncing(null);
      setCoverageComparison(null);
      // Drop the previous open's cached data so accessors return undefined
      // during refetch — otherwise unguarded reads (uncommitted-changes
      // warning, branch-mismatch banner) flash the stale snapshot until the
      // new fetch resolves. Then trigger refetch as a safety net for cases
      // where source tracking alone misses (e.g. external rebase by AI
      // agent while dialog was closed).
      mutateBranchLog(undefined);
      mutateBranchCommits(undefined);
      mutateMergeStatus(undefined);
      mutateWorktreeStatus(undefined);
      refetchAll();
    }
  });

  /** Brings the base into the branch by rebase or by a merge commit. */
  async function syncWithBase(kind: BaseSync): Promise<void> {
    if (syncing()) return;
    setSyncing(kind);
    setSyncError('');
    setSyncDone(null);
    setSyncConflict(null);
    try {
      await invoke(kind === 'merge' ? IPC.MergeBaseIntoTask : IPC.RebaseTask, {
        worktreePath: props.task.worktreePath,
        baseBranch: props.task.baseBranch,
      });
      setSyncDone(kind);
      refetchAll();
      // New commits outdate the checks; re-run where the project runs them on its own.
      if (backgroundVerifyEnabled(props.task.id)) {
        const taskId = props.task.id;
        runBackgroundVerify(taskId, () => getTaskDotStatus(taskId) !== 'busy').catch((err) => {
          console.error('Verify after base sync failed:', err);
        });
      }
    } catch (err) {
      const message = errMessage(err).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      );
      setSyncError(message);
      // Worded by `syncWithBase` in electron/ipc/git.ts; other failures are not conflicts.
      if (message.includes('stopped on conflicts')) setSyncConflict(kind);
    } finally {
      setSyncing(null);
    }
  }

  // Squash may be ticked before the commits load; prefill once they do, unless typed in.
  createEffect(() => {
    const commits = branchCommits();
    if (!squash() || !commits || untrack(squashTitle) || untrack(squashBody)) return;
    const message = buildSquashMessage(
      commits,
      untrack(() => props.task.name),
    );
    setSquashTitle(message.title);
    setSquashBody(message.body);
  });

  /** Resolves true when the merge went through; errors land in `mergeError`. */
  async function merge(): Promise<boolean> {
    setMergeError('');
    setMerging(true);
    // Read before merging: cleanup removes the task from the store.
    const { projectId, branchName } = props.task;
    try {
      await mergeTask(props.task.id, {
        squash: squash(),
        message: squash()
          ? formatSquashMessage({ title: squashTitle(), body: squashBody() })
          : undefined,
        cleanup: !requiresSeparateClose() && cleanupAfterMerge(),
        // The dialog warned about them; the backend refuses if the merge touches them.
        allowDirtyTarget: true,
      });
      void advanceKanbanCard(projectId, branchName, 'done');
      return true;
    } catch (err) {
      setMergeError(errMessage(err));
      return false;
    } finally {
      setMerging(false);
    }
  }

  return {
    branchLog,
    worktreeStatus,
    branchCommits,
    mergeStatus,
    refetchAll,
    commitCount,
    hasConflicts,
    targetUncommitted,
    uncommittedOverlap,
    hasCommittedChangesToMerge,
    baseBranchName,
    selectedAgentId,
    hasBranchMismatch,
    adoptableWorktreeBranch,
    mergeReadiness,
    canMerge,
    mergeBlocker,
    requiresSeparateClose,
    mergeError,
    merging,
    squash,
    setSquash,
    squashTitle,
    setSquashTitle,
    squashBody,
    setSquashBody,
    cleanupAfterMerge,
    setCleanupAfterMerge,
    syncing,
    syncError,
    syncConflict,
    syncDone,
    syncWithBase,
    setCoverageComparison,
    merge,
  };
}

export type MergeState = ReturnType<typeof createMergeState>;
