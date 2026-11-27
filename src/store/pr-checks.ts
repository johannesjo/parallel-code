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
  closedPrimaryPrUrl,
  extraPrWatchId,
  forgetClosedPrimaryPrs,
  forgetTaskPrsDetected,
  markPrDetectionUnavailable,
  markTaskPrsDetected,
  markTaskPrsListed,
  taskPrsDetected,
  taskPrsListed,
  getPrChecks,
  getTaskExtraPrs,
  markPrimaryPrClosed,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  taskIdsWithExtraPrs,
} from './pr-checks-state';
import type { PrChecksState } from './pr-checks-state';
import { taskPrUrl } from './task-prs';
import type {
  BranchPrDetectionResult,
  PrChecksUpdatePayload,
  PullRequestDetails,
  TaskExtraPr,
} from '../ipc/types';
import type { Task } from './types';

export { getPrChecks, type PrChecksState } from './pr-checks-state';

/** A PR search on demand: `done` once the task's PR link is current, `failed` when GitHub could not be asked. */
export type TaskPrSearch = 'done' | 'failed';
let searchTaskPrsNow: ((taskId: string) => Promise<TaskPrSearch>) | undefined;

/**
 * Looks up the task branch's PRs now, after any probe already running. Finish
 * awaits it before offering a local merge, which would otherwise bypass a PR
 * opened since the last probe. Without PR watching there is nothing to ask.
 */
export function searchTaskPrs(taskId: string): Promise<TaskPrSearch> {
  return searchTaskPrsNow?.(taskId) ?? Promise.resolve('done');
}
const BRANCH_PR_DETECT_INTERVAL_MS = 60_000;
const BRANCH_PR_DETECT_RETRY_MS = 2 * 60_000;
// Each probe spawns `git remote` + `gh pr list`; cap them so a startup scan
// over many tasks doesn't burst dozens of processes and GitHub API calls.
const MAX_CONCURRENT_BRANCH_PROBES = 4;
// Lookups of a printed PR link that may fail before it is dropped.
const MAX_PRINTED_PR_LOOKUPS = 3;

/** Whether all of a task's PRs are known: tasks without a branch to probe have
 *  only their primary PR; others wait for the first probe after startup. */
export function taskPrsKnown(task: Task): boolean {
  return !branchPrCandidateFor(task) || taskPrsDetected(task.id);
}

/** Whether a probe has listed a task's PRs, if only in part, so that a PR found
 *  later is a new one rather than one known before a restart. */
export function taskPrsProbed(task: Task): boolean {
  return !branchPrCandidateFor(task) || taskPrsListed(task.id);
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

/** Without a reported head the store keeps the last one it saw, since writes shallow-merge. */
function mergedChecks(checkedAt: string, headSha?: unknown): PrChecksState {
  return {
    overall: 'none',
    merged: true,
    passing: 0,
    pending: 0,
    failing: 0,
    checks: [],
    checkedAt,
    ...(typeof headSha === 'string' && headSha && { headSha }),
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
  const pendingBranchProbes = new Map<string, Promise<TaskPrSearch>>();
  // PR links a task's agent printed while the task had no PR, for its next probe
  // to check: a PR pushed under another branch name has no other way in.
  const printedPrByTaskId = new Map<string, { url: string; failedLookups: number }>();
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
    // A probe that finds the branch's PR open again replaces a closed one.
    if (result.url && (!current || closedPrimaryPrUrl(taskId) === current)) {
      markPrimaryPrClosed(taskId, undefined);
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
      // A repository that could not be listed may hold an open PR. Marked after
      // the PRs are stored, so the kanban takes them as known PRs, not new ones.
      if (!result.failedRepos?.length) markTaskPrsDetected(taskId);
      else markTaskPrsListed(taskId);
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

  /** `force` probes even after gh was found unusable: the user may have logged in since. */
  const detectBranchPr = (
    taskId: string,
    candidate: BranchPrCandidate,
    force = false,
  ): Promise<TaskPrSearch> => {
    const pending = pendingBranchProbes.get(taskId);
    if (pending) return pending;
    if (disposed || (branchPrDetectionDisabled && !force)) return Promise.resolve('done');
    const printed = printedPrByTaskId.get(taskId);
    const printedPrUrl = printed?.url;
    printedPrByTaskId.delete(taskId);
    // Its PRs are never the task's, though the task holds its commits and may track it.
    const baseBranch = store.tasks[taskId]?.baseBranch;
    // A probe that could not check the link leaves it to the next one, unless a newer link came.
    // Capped: until the link is checked the task's PRs count as unknown, holding up Babysit.
    const keepPrintedPr = (): void => {
      if (!printed || printedPrByTaskId.has(taskId)) return;
      const failedLookups = printed.failedLookups + 1;
      if (failedLookups < MAX_PRINTED_PR_LOOKUPS) {
        printedPrByTaskId.set(taskId, { url: printed.url, failedLookups });
      } else {
        console.warn('[pr-checks] giving up on printed PR link:', printed.url);
      }
    };
    const probe = invoke<BranchPrDetectionResult>(IPC.DetectPrForBranch, {
      worktreePath: candidate.worktreePath,
      branchName: candidate.branchName,
      ...(printedPrUrl ? { printedPrUrl } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    })
      .then((result): TaskPrSearch => {
        if (disposed || !result) return 'failed';
        if (result.unavailable) {
          branchPrDetectionDisabled = true;
          markPrDetectionUnavailable();
          branchProbeByTaskId.clear();
          // Without gh no PR flow exists; logged out, an open PR may still exist.
          return result.unavailable === 'missing' ? 'done' : 'failed';
        }
        const task = store.tasks[taskId];
        if (
          task?.worktreePath !== candidate.worktreePath ||
          task.branchName !== candidate.branchName
        ) {
          return 'failed';
        }
        const ownFailed = result.failedRepos?.includes('.');
        if (ownFailed) keepPrintedPr();
        applyDetectedPrs(taskId, result);
        return ownFailed ? 'failed' : 'done';
      })
      .catch((err: unknown): TaskPrSearch => {
        keepPrintedPr();
        console.warn('[pr-checks] branch PR detection failed:', err);
        return 'failed';
      })
      .finally(() => {
        pendingBranchProbes.delete(taskId);
        // Hand the freed slot to a task the capped scan skipped.
        scanForBranchPrs();
      });
    pendingBranchProbes.set(taskId, probe);
    return probe;
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
      void detectBranchPr(taskId, candidate);
    }
    for (const taskId of [...branchProbeByTaskId.keys(), ...printedPrByTaskId.keys()]) {
      if (seen.has(taskId)) continue;
      branchProbeByTaskId.delete(taskId);
      printedPrByTaskId.delete(taskId);
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
        mergedChecks(
          typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
          msg.headSha,
        ),
      );
      return;
    }
    // On a `cleared` update the main process has stopped watching — drop our
    // bookkeeping so a later reopen-and-restart goes through.
    if (msg.cleared) {
      activeByWatchId.delete(watchId);
      removePrChecks(watchId);
      if (isPrimary && typeof msg.prUrl === 'string') {
        // Closed unmerged (a merge returned above). The Babysit watcher turns
        // Babysit off once the task's other PRs are known and none is open.
        markPrimaryPrClosed(msg.taskId, msg.prUrl);
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
      if (prUrl && closedPrimaryPrUrl(taskId) !== prUrl) {
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
          babysit: task.prBabysit !== undefined,
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

  // A turn may also have merged the task's PRs with `gh pr merge`, which moves
  // no ref the main process could notice, so they are polled at once too.
  const pollTaskPrs = (taskId: string): void => {
    if (![...activeByWatchId.values()].some((w) => w.taskId === taskId)) return;
    invoke(IPC.RefreshPrChecksWatcher, { taskId, pushed: false }).catch((err: unknown) => {
      console.warn('[pr-checks] polling PRs after a turn failed:', err);
    });
  };

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
        untrack(() => pollTaskPrs(taskId));
        probeDue = true;
      }
    }
    if (probeDue) untrack(scanForBranchPrs);
  });
  createEffect(() => {
    const link = printedPrLink();
    if (!link) return;
    untrack(() => {
      const task = store.tasks[link.taskId];
      const current = task && taskPrUrl(task);
      if (task && (!current || closedPrimaryPrUrl(link.taskId) === current)) {
        printedPrByTaskId.set(link.taskId, { url: link.url, failedLookups: 0 });
      }
    });
    branchProbeByTaskId.delete(link.taskId);
    untrack(scanForBranchPrs);
  });

  // Skips the retry window and the concurrency cap: the user is waiting on it.
  const searchNow = (taskId: string): Promise<TaskPrSearch> => {
    const task = store.tasks[taskId];
    const candidate = task && branchPrCandidateFor(task);
    if (!candidate) return Promise.resolve('done');
    // A running probe may predate a PR opened just now, so a fresh one follows it.
    const running = pendingBranchProbes.get(taskId);
    if (running) return running.then(() => searchNow(taskId));
    branchProbeByTaskId.set(taskId, { key: candidate.key, attemptedAt: Date.now() });
    return detectBranchPr(taskId, candidate, true);
  };
  searchTaskPrsNow = searchNow;

  const branchPrDetectTimer = window.setInterval(scanForBranchPrs, BRANCH_PR_DETECT_INTERVAL_MS);
  scanForBranchPrs();

  const cleanup = (): void => {
    disposed = true;
    // A later subscription (tests, hot reload) owns the hook by now.
    if (searchTaskPrsNow === searchNow) searchTaskPrsNow = undefined;
    clearInterval(branchPrDetectTimer);
    offUpdate();
    for (const watchId of activeByWatchId.keys()) {
      fireAndForget(IPC.StopPrChecksWatcher, { watchId });
    }
    activeByWatchId.clear();
    forgetClosedPrimaryPrs();
    forgetTaskPrsDetected();
  };

  onCleanup(cleanup);
  return cleanup;
}
