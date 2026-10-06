import { createEffect, createResource, createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { isAdoptableBranch } from '../lib/branch-divergence';
import type { CoverageComparison } from '../lib/coverage-comparison';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import {
  buildEvidence,
  getEvidenceConfidence,
  getPrChecks,
  getProject,
  getVerifyCommand,
  mergeTask,
  store,
} from '../store/store';
import type { Task } from '../store/types';
import type { MergeStatus, WorktreeStatus } from '../ipc/types';
import { buildMergeReadiness } from './merge-readiness';

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
  const [squashMessage, setSquashMessage] = createSignal('');
  // Rebase and merge-base share one slot: both rewrite the same worktree.
  const [syncing, setSyncing] = createSignal<BaseSync | null>(null);
  const [syncError, setSyncError] = createSignal('');
  const [syncDone, setSyncDone] = createSignal<BaseSync | null>(null);
  const [coverageComparison, setCoverageComparison] = createSignal<CoverageComparison | null>(null);
  const requiresSeparateClose = () =>
    Boolean(props.task.delegationParent || props.task.coordinatorMode);

  const resourceSource = () =>
    props.open ? { path: props.task.worktreePath, baseBranch: props.task.baseBranch } : null;
  const [branchLog, { refetch: refetchBranchLog, mutate: mutateBranchLog }] = createResource(
    resourceSource,
    (src) =>
      invoke<string>(IPC.GetBranchLog, { worktreePath: src.path, baseBranch: src.baseBranch }),
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
      }),
  );
  const refetchAll = () => {
    refetchBranchLog();
    refetchMergeStatus();
    refetchWorktreeStatus();
  };

  const commitCount = () => (branchLog() ?? '').split('\n').filter((line) => line.trim()).length;
  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
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
      evidence: getEvidenceConfidence(props.task, worktreeStatus()),
    });
  /** Why Merge is unavailable, in the order the notices above it explain. */
  const mergeBlocker = (): string | undefined => {
    if (!worktreeStatus()) return 'Checking the branch…';
    if (hasBranchMismatch()) return "The worktree is not on this task's branch.";
    if (!hasCommittedChangesToMerge()) return 'Nothing to merge yet.';
    if (hasConflicts()) return `Resolve the conflicts with ${baseBranchName()} first.`;
    return undefined;
  };
  const canMerge = () => !merging() && !mergeBlocker();

  createEffect(() => {
    if (props.open) {
      setCleanupAfterMerge(props.initialCleanup);
      setSquash(false);
      setSquashMessage('');
      setMergeError('');
      setSyncError('');
      setSyncDone(null);
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
    try {
      await invoke(kind === 'merge' ? IPC.MergeBaseIntoTask : IPC.RebaseTask, {
        worktreePath: props.task.worktreePath,
        baseBranch: props.task.baseBranch,
      });
      setSyncDone(kind);
      refetchAll();
      // New commits outdate the checks; rebuild where the project builds on its own.
      if (getProject(props.task.projectId)?.evidenceAutoBuild)
        buildEvidence(props.task.id, { trigger: 'auto' }).catch((err) => {
          console.error('Evidence build after base sync failed:', err);
        });
    } catch (err) {
      setSyncError(errMessage(err));
    } finally {
      setSyncing(null);
    }
  }

  function enableSquash(checked: boolean): void {
    setSquash(checked);
    if (checked && !squashMessage()) {
      const log = branchLog() ?? '';
      setSquashMessage(
        log
          .split('\n')
          .map((l) => l.replace(/^- [a-f0-9]+ /, '- '))
          .join('\n'),
      );
    }
  }

  /** Resolves true when the merge went through; errors land in `mergeError`. */
  async function merge(): Promise<boolean> {
    setMergeError('');
    setMerging(true);
    try {
      await mergeTask(props.task.id, {
        squash: squash(),
        message: squash() ? squashMessage() || undefined : undefined,
        cleanup: !requiresSeparateClose() && cleanupAfterMerge(),
      });
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
    mergeStatus,
    refetchAll,
    commitCount,
    hasConflicts,
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
    enableSquash,
    squashMessage,
    setSquashMessage,
    cleanupAfterMerge,
    setCleanupAfterMerge,
    syncing,
    syncError,
    syncDone,
    syncWithBase,
    setCoverageComparison,
    merge,
  };
}

export type MergeState = ReturnType<typeof createMergeState>;
