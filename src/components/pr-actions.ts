import { createEffect, createResource, createSignal, on } from 'solid-js';
import { parseGitHubUrl } from '../lib/github-url';
import { errMessage } from '../lib/log';
import {
  getPullRequestDetails,
  mergePullRequestForTask,
  stageFailedChecksPrompt,
  stageReviewFeedbackPrompt,
} from '../store/github';
import { getPrChecks } from '../store/store';
import type { PrMergeMethod, PullRequestDetails } from '../ipc/types';
import type { Task } from '../store/types';

export type PrBusy = 'fix-ci' | 'review' | 'merge' | null;
export type PrMergeOutcome = 'merged' | 'queued' | 'failed';

export const PR_METHOD_LABELS: Record<PrMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

/** Footer wording: the action on the PR, where the select wording would read oddly. */
export const PR_MERGE_ACTIONS: Record<PrMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Merge',
  rebase: 'Rebase and merge',
};

/** The task's pull request URL, from its own PR link or a PR it was started from. */
export function taskPrUrl(task: Task): string | undefined {
  return [task.prUrl, task.githubUrl].find((url) => {
    const parsed = url ? parseGitHubUrl(url) : null;
    return parsed?.type === 'pull' && !!parsed.number;
  });
}

/** Why merging is not offered, or null when GitHub may accept it. */
export function prMergeBlocker(pr: PullRequestDetails): string | null {
  if (pr.state === 'MERGED') return 'Already merged.';
  if (pr.state === 'CLOSED') return 'The pull request is closed.';
  if (pr.isDraft) return 'Draft pull requests cannot be merged. Mark it ready on GitHub first.';
  if (pr.mergeable === 'CONFLICTING') return 'The branch has conflicts with its base branch.';
  if (pr.mergeStateStatus === 'BEHIND')
    return 'The branch must be updated with its base branch first.';
  if (pr.mergeStateStatus === 'BLOCKED') {
    return 'GitHub blocks merging until required reviews or checks pass.';
  }
  if (pr.mergeMethods.length === 0) return 'The repository allows no merge method you can use.';
  if (!pr.headRefOid) return 'GitHub did not report the head commit; reopen to retry.';
  return null;
}

interface PrActionsProps {
  open: boolean;
  task: Task;
  prUrl: string | undefined;
}

/** A task's PR details plus the actions that merge it or feed GitHub feedback to the agent. */
export function createPrActions(props: PrActionsProps) {
  const [busy, setBusy] = createSignal<PrBusy>(null);
  const [error, setError] = createSignal('');
  const [info, setInfo] = createSignal('');
  const [method, setMethod] = createSignal<PrMergeMethod | null>(null);
  const [details, { refetch }] = createResource(
    () => (props.open ? props.prUrl : undefined),
    (url) => getPullRequestDetails(url),
  );
  // Reading an errored resource throws; callers show `details.error` instead.
  const pr = () => (details.error ? undefined : details());
  const chosenMethod = () => method() ?? pr()?.mergeMethods[0];

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setError('');
        setInfo('');
        setMethod(null);
      },
    ),
  );

  function begin(kind: Exclude<PrBusy, null>) {
    setBusy(kind);
    setError('');
    setInfo('');
  }

  /** Resolves true when a prompt was staged in the task input. */
  async function stage(kind: 'fix-ci' | 'review'): Promise<boolean> {
    const url = props.prUrl;
    if (!url) return false;
    begin(kind);
    try {
      const stageFn = kind === 'fix-ci' ? stageFailedChecksPrompt : stageReviewFeedbackPrompt;
      const number = pr()?.number ?? Number(parseGitHubUrl(url)?.number ?? 0);
      if (await stageFn(props.task.id, { number, url })) return true;
      setInfo(kind === 'fix-ci' ? 'No failed checks found.' : 'No open review feedback found.');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function merge(): Promise<PrMergeOutcome> {
    const chosen = chosenMethod();
    const current = pr();
    if (!chosen || !current || !props.prUrl) return 'failed';
    begin('merge');
    try {
      const merged = await mergePullRequestForTask(props.task.id, {
        prUrl: props.prUrl,
        method: chosen,
        headSha: current.headRefOid,
      });
      return merged ? 'merged' : 'queued';
    } catch (err) {
      setError(errMessage(err));
      return 'failed';
    } finally {
      setBusy(null);
    }
  }

  return { details, pr, refetch, busy, error, info, method: chosenMethod, setMethod, stage, merge };
}

interface FinishPrProps {
  open: boolean;
  task: Task;
  /** Worktree HEAD: undefined while loading, null when unreadable. */
  headSha: () => string | null | undefined;
}

/**
 * Decides whether Finish merges locally or through the task's open PR, and
 * why the PR merge is unavailable. A PR the task has is the default path, so
 * a local merge never silently bypasses it.
 */
export function createFinishPr(props: FinishPrProps) {
  const actions = createPrActions({
    get open() {
      return props.open;
    },
    get task() {
      return props.task;
    },
    get prUrl() {
      return taskPrUrl(props.task);
    },
  });
  const [mergeLocally, setMergeLocally] = createSignal(false);
  // GitHub confirmed the merge; a refetch that fails or lags must not reopen
  // the local merge path for an already merged branch.
  const [mergedHere, setMergedHere] = createSignal(false);
  createEffect(() => {
    if (!props.open) return;
    setMergeLocally(false);
    setMergedHere(false);
  });

  const number = () => {
    const url = taskPrUrl(props.task);
    return actions.pr()?.number ?? (url ? Number(parseGitHubUrl(url)?.number) : undefined);
  };
  const merged = () =>
    mergedHere() || actions.pr()?.state === 'MERGED' || Boolean(getPrChecks(props.task.id)?.merged);
  /** Why the PR cannot carry this task's work, so Finish merges locally. */
  const localReason = (): string | undefined => {
    const pr = actions.pr();
    if (pr?.state === 'CLOSED') return `PR #${pr.number} is closed, so this merges locally.`;
    // A task started from someone else's PR does not push to it.
    if (pr?.headRefName && pr.headRefName !== props.task.branchName) {
      return `PR #${pr.number} is on ${pr.headRefName}, not this task's branch, so this merges locally.`;
    }
    return undefined;
  };
  /** Which flow the Finish footer runs. */
  const mode = (): 'local' | 'pr' | 'merged' => {
    if (!taskPrUrl(props.task)) return 'local';
    // Another branch's PR merging says nothing about this task's own commits.
    if (localReason() || mergeLocally()) return 'local';
    if (merged()) return 'merged';
    if (actions.details.error) return 'local';
    return 'pr';
  };

  /** The PR head is not the worktree HEAD, so CI and a merge would miss local commits. */
  const headDiffers = (): boolean => {
    const head = props.headSha();
    const pr = actions.pr();
    return Boolean(head && pr && head !== pr.headRefOid);
  };

  const blocker = (): string | undefined => {
    const pr = actions.pr();
    if (!pr) return 'Checking the pull request…';
    const github = prMergeBlocker(pr);
    if (github) return github;
    if (props.headSha() === undefined) return 'Checking the branch…';
    // Merging is pinned to the PR head, so local commits would be left behind.
    if (headDiffers()) {
      return "The PR is not at this worktree's latest commit. Push the branch first.";
    }
    return undefined;
  };

  async function merge(): Promise<PrMergeOutcome> {
    const outcome = await actions.merge();
    if (outcome === 'merged') setMergedHere(true);
    return outcome;
  }

  return {
    ...actions,
    merge,
    number,
    mode,
    localReason,
    headDiffers,
    blocker,
    mergeLocally,
    setMergeLocally,
  };
}

export type FinishPr = ReturnType<typeof createFinishPr>;
