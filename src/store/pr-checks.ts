import { createEffect, onCleanup } from 'solid-js';
import { setStore, store } from './core';
import { fireAndForget, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { parseGitHubUrl } from '../lib/github-url';
import { recordRemotePrMerged } from './completion';
import { saveState } from './persistence';
import { removePrChecks, setPrChecks } from './pr-checks-state';
import type {
  BranchPrDetectionResult,
  PrChecksOverall,
  PrChecksUpdatePayload,
  PrCheckRun,
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

function taskPrUrl(task: Task): string | null {
  return parsePrUrl(task.prUrl) ?? parsePrUrl(task.githubUrl);
}

interface BranchPrCandidate {
  worktreePath: string;
  branchName: string;
  key: string;
}

function branchPrCandidateFor(task: Task): BranchPrCandidate | null {
  if (taskPrUrl(task)) return null;
  if (task.gitIsolation !== 'worktree') return null;
  if (!task.worktreePath || !task.branchName) return null;
  return {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    key: `${task.worktreePath}\0${task.branchName}`,
  };
}

export function startPrChecksSubscription(): () => void {
  // Track which tasks we currently have a watcher registered for. Stores both
  // the PR URL and task name so a rename-only change triggers a refresh of
  // the watcher's display name.
  const activeByTaskId = new Map<string, { prUrl: string; taskName: string }>();
  const branchProbeByTaskId = new Map<string, { key: string; attemptedAt: number }>();
  const pendingBranchProbes = new Set<string>();
  let branchPrDetectionDisabled = false;
  let disposed = false;

  const startWatcher = (taskId: string, task: Task, prUrl: string): void => {
    const prev = activeByTaskId.get(taskId);
    if (prev && prev.prUrl === prUrl && prev.taskName === task.name) return;
    activeByTaskId.set(taskId, { prUrl, taskName: task.name });
    fireAndForget(IPC.StartPrChecksWatcher, {
      taskId,
      prUrl,
      taskName: task.name,
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
        if (disposed) return;
        if (result?.unavailable) {
          branchPrDetectionDisabled = true;
          branchProbeByTaskId.clear();
          return;
        }
        const url = result?.url;
        if (!url) return;
        const task = store.tasks[taskId];
        if (!task || taskPrUrl(task)) return;
        if (
          task.worktreePath !== candidate.worktreePath ||
          task.branchName !== candidate.branchName
        ) {
          return;
        }
        setStore('tasks', taskId, 'prUrl', url);
        startWatcher(taskId, task, url);
        void saveState();
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
  };

  const offUpdate = window.electron.ipcRenderer.on(IPC.PrChecksUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<PrChecksUpdatePayload>;
    if (typeof msg.taskId !== 'string') return;
    if (!store.tasks[msg.taskId]) return;
    if (typeof msg.overall !== 'string') return;
    // A merged PR is final, so keep its bookkeeping: the effect then neither
    // re-polls it nor misses a later URL change or task removal.
    if (msg.cleared && msg.merged) {
      if (
        typeof msg.prUrl === 'string' &&
        typeof msg.mergedAt === 'string' &&
        recordRemotePrMerged(msg.prUrl, msg.mergedAt)
      ) {
        void saveState();
      }
      setPrChecks(msg.taskId, {
        overall: 'none',
        merged: true,
        passing: 0,
        pending: 0,
        failing: 0,
        checks: [],
        checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
      });
      return;
    }
    // On a `cleared` update the main process has stopped watching — drop our
    // bookkeeping so a later reopen-and-restart goes through.
    if (msg.cleared) {
      activeByTaskId.delete(msg.taskId);
      removePrChecks(msg.taskId);
      return;
    }
    setPrChecks(msg.taskId, {
      overall: msg.overall as PrChecksOverall,
      // Explicit: store writes shallow-merge, so an omitted flag would keep a
      // previous PR's `merged: true`.
      merged: false,
      isDraft: msg.isDraft === true,
      reviewDecision:
        msg.reviewDecision === 'APPROVED' ||
        msg.reviewDecision === 'CHANGES_REQUESTED' ||
        msg.reviewDecision === 'REVIEW_REQUIRED'
          ? msg.reviewDecision
          : null,
      mergeable:
        msg.mergeable === 'MERGEABLE' || msg.mergeable === 'CONFLICTING'
          ? msg.mergeable
          : 'UNKNOWN',
      passing: typeof msg.passing === 'number' ? msg.passing : 0,
      pending: typeof msg.pending === 'number' ? msg.pending : 0,
      failing: typeof msg.failing === 'number' ? msg.failing : 0,
      checks: Array.isArray(msg.checks) ? (msg.checks as PrCheckRun[]) : [],
      checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
    });
  });

  createEffect(() => {
    const seen = new Set<string>();
    const allIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    for (const taskId of allIds) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const prUrl = taskPrUrl(task);
      if (!prUrl) continue;
      seen.add(taskId);
      startWatcher(taskId, task, prUrl);
    }
    for (const taskId of [...activeByTaskId.keys()]) {
      if (!seen.has(taskId)) {
        activeByTaskId.delete(taskId);
        removePrChecks(taskId);
        fireAndForget(IPC.StopPrChecksWatcher, { taskId });
      }
    }
    scanForBranchPrs();
  });

  const branchPrDetectTimer = window.setInterval(scanForBranchPrs, BRANCH_PR_DETECT_INTERVAL_MS);
  scanForBranchPrs();

  const cleanup = (): void => {
    disposed = true;
    clearInterval(branchPrDetectTimer);
    offUpdate();
    for (const taskId of activeByTaskId.keys()) {
      fireAndForget(IPC.StopPrChecksWatcher, { taskId });
    }
    activeByTaskId.clear();
  };

  onCleanup(cleanup);
  return cleanup;
}
