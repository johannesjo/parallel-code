import { createEffect, onCleanup, untrack } from 'solid-js';
import { setStore, store } from './core';
import { fireAndForget, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { parseGitHubUrl, sameGitHubIssue } from '../lib/github-url';
import { recordRemotePrMerged } from './completion';
import { saveState } from './persistence';
import { isTaskWorking } from './taskStatus';
import { printedPrLink } from './printed-pr-links';
import {
  checksFromUpdate,
  extraPrWatchId,
  getPrChecks,
  getTaskExtraPrs,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  taskIdsWithExtraPrs,
} from './pr-checks-state';
import type { PrChecksState } from './pr-checks-state';
import type {
  BranchPrDetectionResult,
  PrChecksUpdatePayload,
  PullRequestDetails,
  TaskExtraPr,
} from '../ipc/types';
import type { Task } from './types';

export { getPrChecks, type PrChecksState } from './pr-checks-state';
const BRANCH_PR_DETECT_INTERVAL_MS = 60_000;
const BRANCH_PR_DETECT_RETRY_MS = 2 * 60_000;
// Each probe spawns `git remote` + `gh pr list`; cap them so a startup scan
// over many tasks doesn't burst dozens of processes and GitHub API calls.
const MAX_CONCURRENT_BRANCH_PROBES = 4;

function parsePrUrl(url: string | undefined): string | null {
  if (!url) return null;
  const parsed = parseGitHubUrl(url);
  if (!parsed || parsed.type !== 'pull' || !parsed.number) return null;
  return url;
}

export function taskPrUrl(task: Task): string | null {
  return parsePrUrl(task.prUrl) ?? parsePrUrl(task.githubUrl);
}

interface BranchPrCandidate {
  worktreePath: string;
  branchName: string;
  key: string;
}

// Tasks that already have a primary PR are probed too: their branch can have
// further PRs, and their nested repositories can have their own.
function branchPrCandidateFor(task: Task): BranchPrCandidate | null {
  if (task.gitIsolation !== 'worktree') return null;
  if (!task.worktreePath || !task.branchName) return null;
  return {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    key: `${task.worktreePath}\0${task.branchName}`,
  };
}

/**
 * The task's additional PRs after a probe. Merged ones stay, like a merged
 * primary PR does, and so do those of repositories the probe could not list.
 */
function nextExtraPrs(taskId: string, primaryUrl: string | null, result: BranchPrDetectionResult) {
  const failed = new Set(result.failedRepos);
  const kept = getTaskExtraPrs(taskId).filter(
    (pr) =>
      getPrChecks(extraPrWatchId(taskId, pr.url))?.merged === true ||
      // `.` names the task's own repository, whose extras carry no `repo`.
      failed.has(pr.repo ?? '.'),
  );
  const found = [...(result.url ? [{ url: result.url }] : []), ...(result.extras ?? [])];
  const seen = new Set<string>();
  return [...kept, ...found].filter((pr) => {
    // The task may link its primary PR decorated, e.g. with `/files`.
    if (seen.has(pr.url) || sameGitHubIssue(primaryUrl ?? undefined, pr.url)) return false;
    seen.add(pr.url);
    return true;
  });
}

function mergedChecks(checkedAt: string): PrChecksState {
  return {
    overall: 'none',
    merged: true,
    passing: 0,
    pending: 0,
    failing: 0,
    checks: [],
    checkedAt,
  };
}

function extraPrLabel(pr: TaskExtraPr): string {
  const number = parseGitHubUrl(pr.url)?.number;
  return [pr.repo, number ? `#${number}` : null].filter(Boolean).join(' ');
}

interface ActiveWatcher {
  taskId: string;
  prUrl: string;
  taskName: string;
  /** Asks the main process to keep polling while the window is hidden. */
  babysit: boolean;
  /** Lets the main process notice pushes made outside the app, e.g. by the agent. */
  branch: { worktreePath: string; branchName: string } | null;
}

export function startPrChecksSubscription(): () => void {
  // Track which PRs we currently have a watcher registered for, by watcher ID
  // (the task ID for a task's primary PR). Stores both the PR URL and the
  // notification name so a rename-only change refreshes the watcher's name,
  // and the babysit flag so toggling it reaches the main process.
  const activeByWatchId = new Map<string, ActiveWatcher>();
  const branchProbeByTaskId = new Map<string, { key: string; attemptedAt: number }>();
  const pendingBranchProbes = new Set<string>();
  // Closed primary PRs by task, so a sync doesn't restart their watcher after
  // every probe; a probe that finds the branch's PR open again replaces this.
  const closedPrimaryByTaskId = new Map<string, string>();
  let branchPrDetectionDisabled = false;
  let disposed = false;

  const startWatcher = (watchId: string, watcher: ActiveWatcher): void => {
    const prev = activeByWatchId.get(watchId);
    if (
      prev &&
      prev.prUrl === watcher.prUrl &&
      prev.taskName === watcher.taskName &&
      prev.babysit === watcher.babysit &&
      prev.branch?.worktreePath === watcher.branch?.worktreePath &&
      prev.branch?.branchName === watcher.branch?.branchName
    )
      return;
    activeByWatchId.set(watchId, watcher);
    fireAndForget(IPC.StartPrChecksWatcher, { ...watcher, watchId });
  };

  const stopWatcher = (watchId: string): void => {
    activeByWatchId.delete(watchId);
    removePrChecks(watchId);
    fireAndForget(IPC.StopPrChecksWatcher, { watchId });
  };

  const applyDetectedPrs = (taskId: string, result: BranchPrDetectionResult): void => {
    const task = store.tasks[taskId];
    if (!task) return;
    const current = taskPrUrl(task);
    if (result.url && (!current || closedPrimaryByTaskId.get(taskId) === current)) {
      closedPrimaryByTaskId.delete(taskId);
      if (result.url !== current) {
        setStore('tasks', taskId, 'prUrl', result.url);
        void saveState();
      }
    }
    // A failed probe reports no extras; keep the previous ones until one succeeds.
    if (result.extras) {
      const primaryUrl = taskPrUrl(task);
      const next = nextExtraPrs(taskId, primaryUrl, result);
      const gone = getTaskExtraPrs(taskId).filter(
        (pr) =>
          !sameGitHubIssue(primaryUrl ?? undefined, pr.url) && !next.some((n) => n.url === pr.url),
      );
      setTaskExtraPrs(taskId, [...next, ...gone]);
      for (const pr of gone) settleGoneExtra(taskId, pr);
    }
    syncWatchers();
  };

  // The probe lists open PRs only, so a merged PR drops out of it, usually before
  // its settled watcher reports the merge. It stays listed until GitHub says
  // whether it merged, so its chip shows "Merged" instead of vanishing.
  const settleGoneExtra = (taskId: string, pr: TaskExtraPr): void => {
    invoke<PullRequestDetails>(IPC.GetPullRequestDetails, { prUrl: pr.url })
      .then((details) => {
        const extras = getTaskExtraPrs(taskId);
        // The task was removed or left its worktree meanwhile.
        if (disposed || !extras.some((p) => p.url === pr.url)) return;
        const watchId = extraPrWatchId(taskId, pr.url);
        if (details?.state === 'MERGED') {
          setPrChecks(watchId, mergedChecks(new Date().toISOString()));
          return;
        }
        setTaskExtraPrs(
          taskId,
          extras.filter((p) => p.url !== pr.url),
        );
        syncWatchers();
      })
      .catch((err: unknown) => {
        console.warn('[pr-checks] merged PR lookup failed:', err);
      });
  };

  const detectBranchPr = (taskId: string, candidate: BranchPrCandidate): void => {
    if (disposed || branchPrDetectionDisabled || pendingBranchProbes.has(taskId)) return;
    pendingBranchProbes.add(taskId);
    invoke<BranchPrDetectionResult>(IPC.DetectPrForBranch, {
      worktreePath: candidate.worktreePath,
      branchName: candidate.branchName,
    })
      .then((result) => {
        if (disposed || !result) return;
        if (result.unavailable) {
          branchPrDetectionDisabled = true;
          branchProbeByTaskId.clear();
          return;
        }
        const task = store.tasks[taskId];
        if (
          task?.worktreePath !== candidate.worktreePath ||
          task.branchName !== candidate.branchName
        ) {
          return;
        }
        applyDetectedPrs(taskId, result);
      })
      .catch((err: unknown) => {
        console.warn('[pr-checks] branch PR detection failed:', err);
      })
      .finally(() => {
        pendingBranchProbes.delete(taskId);
        // Hand the freed slot to a task the capped scan skipped.
        scanForBranchPrs();
      });
  };

  const scanForBranchPrs = (): void => {
    if (disposed || branchPrDetectionDisabled) return;
    const seen = new Set<string>();
    const now = Date.now();
    const allIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    for (const taskId of allIds) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const candidate = branchPrCandidateFor(task);
      if (!candidate) continue;
      seen.add(taskId);
      if (pendingBranchProbes.has(taskId)) continue;
      const prev = branchProbeByTaskId.get(taskId);
      if (
        prev &&
        prev.key === candidate.key &&
        now - prev.attemptedAt < BRANCH_PR_DETECT_RETRY_MS
      ) {
        continue;
      }
      if (pendingBranchProbes.size >= MAX_CONCURRENT_BRANCH_PROBES) continue;
      branchProbeByTaskId.set(taskId, { key: candidate.key, attemptedAt: now });
      detectBranchPr(taskId, candidate);
    }
    for (const taskId of [...branchProbeByTaskId.keys()]) {
      if (!seen.has(taskId)) branchProbeByTaskId.delete(taskId);
    }
    for (const taskId of taskIdsWithExtraPrs()) {
      if (!seen.has(taskId)) setTaskExtraPrs(taskId, []);
    }
  };

  const offUpdate = window.electron.ipcRenderer.on(IPC.PrChecksUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<PrChecksUpdatePayload>;
    if (typeof msg.taskId !== 'string') return;
    if (!store.tasks[msg.taskId]) return;
    if (typeof msg.overall !== 'string' || typeof msg.watchId !== 'string') return;
    const watchId = msg.watchId;
    const isPrimary = watchId === msg.taskId;
    // A late update for a stopped additional PR would leave an orphaned entry.
    if (!isPrimary && !activeByWatchId.has(watchId)) return;
    // A merged PR is final, so keep its bookkeeping: the effect then neither
    // re-polls it nor misses a later URL change or task removal.
    if (msg.cleared && msg.merged) {
      if (
        isPrimary &&
        typeof msg.prUrl === 'string' &&
        typeof msg.mergedAt === 'string' &&
        recordRemotePrMerged(msg.prUrl, msg.mergedAt)
      ) {
        void saveState();
      }
      setPrChecks(
        watchId,
        mergedChecks(typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString()),
      );
      return;
    }
    // On a `cleared` update the main process has stopped watching — drop our
    // bookkeeping so a later reopen-and-restart goes through.
    if (msg.cleared) {
      activeByWatchId.delete(watchId);
      removePrChecks(watchId);
      if (isPrimary && typeof msg.prUrl === 'string') {
        closedPrimaryByTaskId.set(msg.taskId, msg.prUrl);
        // Closed unmerged (a merge returned above): the Babysit toggle hides with
        // the PR, so turn it off here rather than leave it on where nothing shows it.
        if (store.tasks[msg.taskId]?.prBabysit) {
          setStore('tasks', msg.taskId, 'prBabysit', undefined);
          void saveState();
        }
      } else if (!isPrimary) {
        // A closed additional PR is done; left listed, the next sync would watch it again.
        const taskId = msg.taskId;
        setTaskExtraPrs(
          taskId,
          getTaskExtraPrs(taskId).filter((pr) => extraPrWatchId(taskId, pr.url) !== watchId),
        );
      }
      return;
    }
    setPrChecks(watchId, checksFromUpdate(msg));
  });

  // Idempotent, so detection can also call it directly instead of waiting for the effect.
  function syncWatchers(): void {
    const seen = new Set<string>();
    const allIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    for (const taskId of allIds) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const prUrl = taskPrUrl(task);
      if (prUrl && closedPrimaryByTaskId.get(taskId) !== prUrl) {
        seen.add(taskId);
        const candidate = branchPrCandidateFor(task);
        startWatcher(taskId, {
          taskId,
          prUrl,
          taskName: task.name,
          babysit: task.prBabysit !== undefined,
          branch: candidate && {
            worktreePath: candidate.worktreePath,
            branchName: candidate.branchName,
          },
        });
      }
      for (const pr of getTaskExtraPrs(taskId)) {
        const watchId = extraPrWatchId(taskId, pr.url);
        seen.add(watchId);
        startWatcher(watchId, {
          taskId,
          prUrl: pr.url,
          taskName: `${task.name} · ${extraPrLabel(pr)}`,
          // Babysitting follows the primary PR only.
          babysit: false,
          // Pushes reach these through the primary PR's shared head.
          branch: null,
        });
      }
    }
    for (const watchId of [...activeByWatchId.keys()]) {
      if (!seen.has(watchId)) stopWatcher(watchId);
    }
  }

  createEffect(() => {
    syncWatchers();
    scanForBranchPrs();
  });

  // New PRs show up at once instead of after the retry window: agents usually
  // open them during a turn, and `gh pr create` prints the link, which also
  // covers `!` commands that run outside any agent hook.
  const workingTaskIds = new Set<string>();
  createEffect(() => {
    let probeDue = false;
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      if (isTaskWorking(taskId)) {
        workingTaskIds.add(taskId);
      } else if (workingTaskIds.delete(taskId)) {
        branchProbeByTaskId.delete(taskId);
        probeDue = true;
      }
    }
    if (probeDue) untrack(scanForBranchPrs);
  });
  createEffect(() => {
    const link = printedPrLink();
    if (!link) return;
    branchProbeByTaskId.delete(link.taskId);
    untrack(scanForBranchPrs);
  });

  const branchPrDetectTimer = window.setInterval(scanForBranchPrs, BRANCH_PR_DETECT_INTERVAL_MS);
  scanForBranchPrs();

  const cleanup = (): void => {
    disposed = true;
    clearInterval(branchPrDetectTimer);
    offUpdate();
    for (const watchId of activeByWatchId.keys()) {
      fireAndForget(IPC.StopPrChecksWatcher, { watchId });
    }
    activeByWatchId.clear();
  };

  onCleanup(cleanup);
  return cleanup;
}
