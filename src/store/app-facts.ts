/**
 * App-fact cards in the store: gathering the branch facts the tracker reads
 * after a turn, and the card state the views show, with app-fact values
 * derived from what the store already knows.
 */

import { IPC } from '../../electron/ipc/channels';
import type { CardTaskState } from '../lib/card-display';
import { appFactValues, type AppFactInput } from '../lib/app-facts';
import type { AppFactId, CardValues } from '../lib/cards';
import { invoke } from '../lib/ipc';
import { taskGoal } from '../lib/task-plan';
import { errMessage, warn as logWarn } from '../lib/log';
import type { CommitInfo, MergeStatus } from '../ipc/types';
import { getAgentHookStatus } from './agentHookStatus';
import { enabledCards } from './cards';
import { store } from './core';
import { getPrChecks } from './pr-checks-state';
import { isLiveTask, noteTaskFacts } from './task-diff';
import { taskPlanView } from './task-plan';
import { taskLeadWatchId } from './task-prs';
import { getTaskOpenQuestions } from './taskStatus';
import type { Task } from './types';

function wantsFact(task: Task, fact: AppFactId): boolean {
  return enabledCards(task.projectId).some(
    (card) => card.source.kind === 'app' && card.source.fact === fact,
  );
}

function readOrSkip<T>(read: () => Promise<T>): Promise<T | undefined> {
  return read().catch((error: unknown) => {
    logWarn('appFacts', 'Could not read a branch fact', { error: errMessage(error) });
    return undefined;
  });
}

/**
 * Reads merge status and commit count, only while a card shows them. Only a
 * worktree branch has a base to compare with; a direct task works on it.
 */
export async function refreshBranchFacts(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!isLiveTask(task) || task.gitIsolation !== 'worktree' || !task.baseBranch) return;
  // Where origin stands comes with the merge status, at no extra git read.
  const wantsMerge = wantsFact(task, 'branch-health') || wantsFact(task, 'remote-branch');
  const wantsCommits = wantsFact(task, 'commits');
  if (!wantsMerge && !wantsCommits) return;
  const at = Date.now();
  const args = { worktreePath: task.worktreePath, baseBranch: task.baseBranch };
  const [merge, commits] = await Promise.all([
    wantsMerge ? readOrSkip(() => invoke<MergeStatus>(IPC.CheckMergeStatus, args)) : undefined,
    wantsCommits ? readOrSkip(() => invoke<CommitInfo[]>(IPC.GetBranchCommits, args)) : undefined,
  ]);
  // A failed read keeps the old fact and its time rather than vouch for it anew.
  if (!merge && !commits) return;
  noteTaskFacts(taskId, {
    ...(merge && {
      merge: {
        behind: merge.main_ahead_count,
        conflicts: merge.conflicting_files,
        base: merge.base_branch,
        ...(merge.remote && { remote: merge.remote }),
        ...(merge.remote_divergence && { remoteDivergence: merge.remote_divergence }),
        ...(merge.remote_seen_at !== undefined && { remoteSeenAt: merge.remote_seen_at }),
        at,
      },
    }),
    ...(commits && { commits: { count: commits.length, at } }),
  });
}

/** The agent's current stretch: waiting on an open question, else the lead's hook state. */
function currentStretch(task: Task): AppFactInput['state'] {
  const oldest = getTaskOpenQuestions(task.id).at(-1);
  if (oldest) return { kind: 'waiting', since: oldest.since };
  const lead = task.agentIds[0] ? getAgentHookStatus(task.agentIds[0]) : null;
  if (lead?.state === 'working' || lead?.state === 'waiting')
    return { kind: lead.state, since: lead.since };
  return undefined;
}

function ciInput(taskId: string): AppFactInput['ci'] {
  const checks = getPrChecks(taskLeadWatchId(taskId));
  // A merged PR's last run no longer matters, and "none" means it has no checks.
  if (!checks || checks.merged || checks.overall === 'none') return undefined;
  return { ...checks, checkedAt: Date.parse(checks.checkedAt) || 0 };
}

function appFactInput(task: Task, now: number): AppFactInput {
  const history = task.promptHistory ?? [];
  return {
    facts: task.facts,
    uncommitted: store.taskGitStatus[task.id]?.has_uncommitted_changes,
    turns: history.length,
    lastTurnAt: history.at(-1)?.sentAt,
    state: currentStretch(task),
    ci: ciInput(task.id),
    goal: taskGoal(task),
    plan: { ...taskPlanView(task.id), at: task.agentPlan?.updatedAt },
    now,
  };
}

/**
 * What the task's cards read: its own card values, with each enabled app-fact
 * card's values derived now. Reactive in the facts each card reads.
 */
export function cardTaskState(task: Task, now = Date.now()): CardTaskState {
  const appCards = enabledCards(task.projectId).flatMap((card) =>
    card.source.kind === 'app' ? [{ id: card.id, fact: card.source.fact }] : [],
  );
  if (!appCards.length) return task;
  const input = appFactInput(task, now);
  const cards: Record<string, CardValues> = { ...task.cards };
  for (const { id, fact } of appCards) {
    const values = appFactValues(fact, input);
    if (values) cards[id] = values;
    else delete cards[id];
  }
  return { cards, codeFingerprint: task.codeFingerprint };
}
