/**
 * App-fact cards: facts Parallel Code already has about a task, shown as
 * cards. Free and local; values are derived when shown, never stored. See the
 * `app` source in docs/cards.md.
 */

import type { PlanStep, PlanStepStatus } from '../../electron/shared/agent-plan';
import type { RemoteBranchState, RemoteDivergence } from '../ipc/types';
import type { ChecklistState, SlotDefinition, SlotValue, StatusRow } from './card-slots';
import { confidenceCard, type AppFactId, type CardDefinition, type CardValues } from './cards';
import { formatRelativeAge } from './relativeAge';

/** Diff counts, as read from a raw diff. */
export interface DiffStats {
  added: number;
  removed: number;
  files: number;
}

/**
 * What the fingerprint tracker gathered after a settled turn. Runtime only.
 * Each fact keeps the time of its own read, so a failed read never makes an
 * older value look fresh.
 */
export interface TaskFacts {
  diff?: DiffStats & { at: number };
  /** Commits the base has that the branch lacks, and files a merge would conflict in. */
  merge?: {
    behind: number;
    conflicts: string[];
    base: string;
    /** Where origin's copy of the branch stands, as of the last fetch or push; absent without one. */
    remote?: RemoteBranchState;
    /** How far the two are apart while they differ; absent when it could not be counted. */
    remoteDivergence?: RemoteDivergence;
    /** When origin's copy was last fetched or pushed to; the card reads no fresher than that. */
    remoteSeenAt?: number;
    at: number;
  };
  commits?: { count: number; at: number };
}

/** Everything app facts are derived from, gathered by the store. */
export interface AppFactInput {
  facts?: TaskFacts;
  /** From the git status poll. */
  uncommitted?: boolean;
  turns: number;
  lastTurnAt?: number;
  /** The agent's current stretch, from its hooks or an open question. */
  state?: { kind: 'working' | 'waiting'; since: number };
  ci?: {
    passing: number;
    pending: number;
    failing: number;
    checks: { name: string; bucket: string }[];
    checkedAt: number;
  };
  /** The first line of what the user asked for. */
  goal?: string;
  /** The lead agent's to-do list; `at` is when a terminal agent last wrote it. */
  plan?: { steps: PlanStep[]; failedCommand?: string; at?: number };
  now: number;
}

/** A diff past this many changed lines is worth a look before it grows further. */
export const DIFF_SIZE_LIMIT = 1_000;

interface Preset {
  name: string;
  description: string;
  slots: SlotDefinition[];
  /** What fills the card before it has a value, for its top line. */
  pending: string;
}

const PRESETS: Record<AppFactId, Preset> = {
  plan: {
    name: 'Plan',
    description: "The task's goal and the agent's to-do list",
    slots: [
      { id: 'goal', type: 'line', label: 'Goal' },
      { id: 'steps', type: 'checklist', label: 'Steps' },
    ],
    pending: 'after the first prompt',
  },
  'diff-size': {
    name: 'Diff size',
    description: 'Lines added and removed, files touched',
    slots: [
      { id: 'lines', type: 'line', label: 'Lines' },
      { id: 'files', type: 'stat', label: 'Files' },
      { id: 'changed', type: 'stat', label: 'Changed', limit: DIFF_SIZE_LIMIT },
    ],
    pending: 'after the next turn',
  },
  'branch-health': {
    name: 'Branch health',
    description: 'Conflicts with the base branch, commits behind, uncommitted changes',
    slots: [{ id: 'status', type: 'status', label: 'Status' }],
    // Read only on a worktree branch: a direct task works on its base, so there's nothing to compare.
    pending: 'after the next turn, on worktree tasks',
  },
  activity: {
    name: 'Activity',
    description: 'Turns, time working, time waiting on you, time since the last turn',
    slots: [
      { id: 'turns', type: 'stat', label: 'Turns' },
      { id: 'now', type: 'line', label: 'Now' },
      { id: 'last', type: 'line', label: 'Last turn' },
    ],
    pending: 'after the first prompt',
  },
  commits: {
    name: 'Commits',
    description: 'Commits on the branch',
    slots: [{ id: 'commits', type: 'stat', label: 'Commits' }],
    pending: 'after the next turn, on worktree tasks',
  },
  'remote-branch': {
    name: 'Remote branch',
    description: 'Commits not pushed, commits only origin has, uncommitted changes',
    slots: [{ id: 'status', type: 'status', label: 'Status' }],
    pending: 'after the next turn, on worktree tasks with an origin remote',
  },
  ci: {
    name: 'CI',
    description: "The pull request's check results",
    slots: [{ id: 'runs', type: 'status', label: 'Checks' }],
    pending: 'when the task has a pull request',
  },
};

/** An app-fact card as the gallery and new installs add it. */
export function appFactCard(fact: AppFactId, enabled: boolean): CardDefinition {
  const { name, description, slots } = PRESETS[fact];
  return { id: fact, name, description, source: { kind: 'app', fact }, slots, enabled };
}

/**
 * The free, local cards: on for a new install. An install from before cards
 * gets them switched off and is offered them once, so its header only changes
 * when the user says so.
 */
export function defaultCards(enabled: boolean): CardDefinition[] {
  return [
    confidenceCard(enabled),
    appFactCard('branch-health', enabled),
    appFactCard('diff-size', enabled),
  ];
}

/** What fills an app-fact card before it has a value. */
export function appFactPending(fact: AppFactId): string {
  return PRESETS[fact].pending;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function branchRows(merge: NonNullable<TaskFacts['merge']>, uncommitted?: boolean): StatusRow[] {
  const [first] = merge.conflicts;
  const rows: StatusRow[] = [
    first
      ? {
          state: 'fail',
          text: `Conflicts with ${merge.base} in ${plural(merge.conflicts.length, 'file')}`,
          value: first,
        }
      : { state: 'ok', text: `No conflicts with ${merge.base}` },
    merge.behind
      ? { state: 'unknown', text: `Behind ${merge.base} by ${plural(merge.behind, 'commit')}` }
      : { state: 'ok', text: `Up to date with ${merge.base}` },
  ];
  if (uncommitted) rows.push({ state: 'unknown', text: 'Uncommitted changes' });
  return rows;
}

const REMOTE_ROW: Record<RemoteBranchState, StatusRow> = {
  pushed: { state: 'ok', text: 'Origin has the latest commit' },
  // Only when the commits could not be counted.
  differs: { state: 'unknown', text: 'Origin is at another commit' },
  unpushed: { state: 'unknown', text: 'Not on origin yet' },
};

/** One row per side that has commits the other lacks. */
function divergenceRows({ ahead, behind }: RemoteDivergence): StatusRow[] {
  // With both, "behind" would invite a pull that undoes a rebase; say only what origin holds.
  const onOrigin = ahead
    ? `${plural(behind, 'commit')} only on origin`
    : `Behind origin by ${plural(behind, 'commit')}`;
  return [
    ...(ahead ? [`${plural(ahead, 'commit')} not pushed`] : []),
    ...(behind ? [onOrigin] : []),
  ].map((text): StatusRow => ({ state: 'unknown', text }));
}

function remoteRows(merge: NonNullable<TaskFacts['merge']>, input: AppFactInput): StatusRow[] {
  const { remote, remoteDivergence: divergence, remoteSeenAt: seenAt } = merge;
  if (!remote) return [];
  const rows = remote === 'differs' && divergence ? divergenceRows(divergence) : [];
  if (!rows.length) rows.push(REMOTE_ROW[remote]);
  // No push carries these, so origin is not up to date with them either.
  if (input.uncommitted) rows.push({ state: 'unknown', text: 'Uncommitted changes' });
  // The app never fetches, so say how old origin's side is: the card's own age is only the read's.
  if (seenAt !== undefined) {
    const age = formatRelativeAge(seenAt, input.now);
    const value = age === 'just now' ? age : `${age} ago`;
    rows.push({ state: 'unknown', text: 'Last fetch or push', value });
  }
  return rows;
}

function ciRows(ci: NonNullable<AppFactInput['ci']>): StatusRow[] {
  const failing = ci.checks
    .filter((check) => check.bucket === 'fail')
    .map((check): StatusRow => ({ state: 'fail', text: check.name }));
  const total = ci.passing + ci.pending + ci.failing;
  const summary: StatusRow = {
    state: ci.failing ? 'fail' : ci.pending ? 'running' : 'ok',
    text: `${ci.passing}/${total} passed`,
    ...(ci.pending && { value: `${ci.pending} running` }),
  };
  // The summary row first, failing when any check fails, so collapsed cards and pins show the count.
  return [summary, ...failing].slice(0, 8);
}

const STEP_STATE: Record<PlanStepStatus, ChecklistState> = {
  completed: 'done',
  in_progress: 'current',
  pending: 'todo',
};

function planValues(input: AppFactInput): CardValues | undefined {
  const { goal, plan } = input;
  const steps = plan?.steps ?? [];
  if (!goal && !steps.length) return undefined;
  // Every step, past the checklist limit too: these values are derived, never stored, and a clipped list would miscount.
  const items = steps.map(({ step, status }) => ({
    text:
      status === 'in_progress' && plan?.failedCommand
        ? `${step} (${plan.failedCommand} failed)`
        : step,
    state: STEP_STATE[status],
  }));
  return {
    at: plan?.at ?? input.lastTurnAt ?? input.now,
    values: {
      ...(goal && { goal: { type: 'line', text: goal } }),
      ...(items.length && { steps: { type: 'checklist', items } }),
    },
  };
}

function activityValues(input: AppFactInput): Record<string, SlotValue> {
  const { state, now } = input;
  const stretch = state && formatRelativeAge(state.since, now);
  const nowText = !state
    ? 'Idle'
    : state.kind === 'working'
      ? `Working, ${stretch === 'just now' ? 'just started' : `for ${stretch}`}`
      : `Waiting on you${stretch === 'just now' ? '' : ` for ${stretch}`}`;
  return {
    turns: { type: 'stat', value: input.turns, unit: input.turns === 1 ? 'turn' : 'turns' },
    now: { type: 'line', text: nowText },
    ...(input.lastTurnAt !== undefined && {
      last: { type: 'line', text: `Last prompt ${formatRelativeAge(input.lastTurnAt, now)}` },
    }),
  };
}

/** The values of an app-fact card on a task, or undefined until there is something to show. */
export function appFactValues(fact: AppFactId, input: AppFactInput): CardValues | undefined {
  const { facts } = input;
  switch (fact) {
    case 'plan':
      return planValues(input);
    case 'diff-size': {
      const diff = facts?.diff;
      if (!diff) return undefined;
      return {
        at: diff.at,
        values: {
          lines: { type: 'line', text: `+${diff.added} −${diff.removed}` },
          files: { type: 'stat', value: diff.files, unit: diff.files === 1 ? 'file' : 'files' },
          changed: { type: 'stat', value: diff.added + diff.removed, unit: 'lines' },
        },
      };
    }
    case 'branch-health':
      if (!facts?.merge) return undefined;
      return {
        at: facts.merge.at,
        values: { status: { type: 'status', rows: branchRows(facts.merge, input.uncommitted) } },
      };
    case 'activity':
      if (!input.turns) return undefined;
      return { at: input.lastTurnAt ?? input.now, values: activityValues(input) };
    case 'commits':
      if (!facts?.commits) return undefined;
      return {
        at: facts.commits.at,
        values: { commits: { type: 'stat', value: facts.commits.count, unit: '' } },
      };
    case 'remote-branch':
      if (!facts?.merge?.remote) return undefined;
      return {
        at: facts.merge.at,
        values: {
          status: {
            type: 'status',
            rows: remoteRows(facts.merge, input),
          },
        },
      };
    case 'ci':
      if (!input.ci) return undefined;
      return {
        at: input.ci.checkedAt,
        values: { runs: { type: 'status', rows: ciRows(input.ci) } },
      };
  }
}

/** +added −removed and files touched in a unified diff. */
export function diffStats(rawDiff: string): DiffStats {
  let added = 0;
  let removed = 0;
  let files = 0;
  // Between "diff --git" and the first hunk, "--- a/x" and "+++ b/x" name files, not lines.
  let inHeader = false;
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files++;
      inHeader = true;
    } else if (line.startsWith('@@')) inHeader = false;
    else if (inHeader) continue;
    else if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed, files };
}
