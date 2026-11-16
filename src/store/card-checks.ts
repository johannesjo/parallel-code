/**
 * Running check cards: on demand, when Finish opens, or after each turn. Values land in the task's cards like any
 * other card's; the run's state (running, its error, whether the code changed
 * under it, the output tail) is transient and never saved.
 */

import { createStore, produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { CARD_PUBLISH_MAX_BYTES } from '../../electron/shared/card-publish';
import { checkCardOutcome, codeChangedDuringRun } from '../lib/check-card';
import { diffFingerprint } from '../lib/diff-excerpt';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import type { ProjectCheck } from '../../electron/shared/checks';
import type { CardDefinition, CheckTrigger } from '../lib/cards';
import type { CardCheckResult } from '../ipc/types';
import { getTaskChecks } from './check-suite-state';
import { storeCardRun } from './card-values';
import { enabledCards } from './cards';
import { store } from './core';
import { isLiveTask, noteCodeFingerprint, readTaskDiff } from './task-diff';
import type { Task } from './types';

/** Enough of a run's output to see why it failed; the card keeps no more. */
const OUTPUT_TAIL_CHARS = 4_000;

interface CheckCardRun {
  running?: boolean;
  /** Why the last run left the previous values, shown on the card's top line. */
  error?: string;
  /** The code changed while the last run went, so its result covers neither. */
  changed?: boolean;
  outputTail?: string;
}

const [runs, setRuns] = createStore<Record<string, CheckCardRun>>({});
// A newer run supersedes an older one, whose late result must not land.
const generations = new Map<string, number>();
// What each stored result ran, so pointing a card at another check, or editing the check's
// command, never passes off the old result as current. Memory only: after a restart an
// automatic run repeats once. shortcut: per session — store it with the values if that costs.
const ranCommand = new Map<string, string>();

const runKey = (taskId: string, cardId: string) => `${taskId}\n${cardId}`;

// Replaced, not merged: a store setter would keep `running` or an old error.
function setRun(key: string, next: CheckCardRun): void {
  setRuns(
    produce((all) => {
      all[key] = next;
    }),
  );
}

export function getCheckCardRun(taskId: string, cardId: string): CheckCardRun {
  return runs[runKey(taskId, cardId)] ?? {};
}

/** The project check a card runs on this task, if its project has it. */
export function cardCheck(taskId: string, cardId: string) {
  const card = store.cardDefinitions.find((entry) => entry.id === cardId);
  if (card?.source.kind !== 'check') return undefined;
  const { checkId } = card.source;
  return getTaskChecks(taskId).find((check) => check.id === checkId);
}

function previousJson(taskId: string, cardId: string): string | undefined {
  const values = store.tasks[taskId]?.cards?.[cardId]?.values;
  const json = values && JSON.stringify(values);
  return json && json.length <= CARD_PUBLISH_MAX_BYTES ? json : undefined;
}

function invokedMode(card: CardDefinition) {
  return card.source.kind === 'check' ? card.source.mode : 'exit-code';
}

/** Runs a project check for a card in the task's worktree, through the card runner. */
export function invokeCheck(task: Task, card: CardDefinition, check: ProjectCheck, diff: string) {
  return invoke<CardCheckResult>(IPC.RunCardCheck, {
    taskId: task.id,
    cardId: card.id,
    worktreePath: task.worktreePath,
    command: check.command,
    mode: invokedMode(card),
    branchName: task.branchName,
    baseBranch: task.baseBranch,
    taskName: task.name,
    previous: previousJson(task.id, card.id),
    diff,
  });
}

/**
 * Runs a card's check in the task's worktree and shows the result. The code
 * fingerprint is read before the run, so a change during it makes the values
 * outdated once the tracker sees it; the run's own git snapshot marks it now.
 */
export async function runCheckCard(
  taskId: string,
  cardId: string,
  /** The diff already read for this run; read here when absent. */
  readDiff?: string,
): Promise<void> {
  const task = store.tasks[taskId];
  const card = store.cardDefinitions.find((entry) => entry.id === cardId);
  const check = cardCheck(taskId, cardId);
  if (!isLiveTask(task) || !card || !check) return;
  const key = runKey(taskId, cardId);
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const current = () => generations.get(key) === generation;
  setRun(key, { ...runs[key], running: true });
  const at = Date.now();
  const diff = readDiff ?? (await readTaskDiff(task));
  const result = await invokeCheck(task, card, check, diff ?? '').catch((error: unknown) => {
    if (current()) setRun(key, { error: errMessage(error) });
    return undefined;
  });
  if (!result || !current()) return;
  // Saving the card replaces its definition; the result was made for a layout that may be gone.
  const saved = store.cardDefinitions.find((entry) => entry.id === cardId) !== card;
  if (saved) return void setRun(key, {});
  const outcome = checkCardOutcome(card, result);
  const outputTail = result.run.outputTail.slice(-OUTPUT_TAIL_CHARS);
  if ('error' in outcome) return void setRun(key, { error: outcome.error, outputTail });
  const fingerprint = diff === undefined ? undefined : diffFingerprint(diff);
  storeCardRun(taskId, card, { values: outcome.values, at, ...(fingerprint && { fingerprint }) });
  ranCommand.set(key, `${invokedMode(card)}\n${check.command}`);
  // Stamped with its start, as the fingerprint tracker stamps its reads, so a newer read wins.
  const afterAt = Date.now();
  // HEAD and the dirty flag miss an edit to a tree that was dirty already, so compare the diff too.
  const after = await readTaskDiff(task);
  const edited = diff !== undefined && after !== undefined && after !== diff;
  // Tell the tracker now, not after the next turn, so pins and summaries read this result as
  // outdated too. The edit came after the run started, even within the same millisecond.
  if (edited) noteCodeFingerprint(taskId, diffFingerprint(after), Math.max(afterAt, at + 1));
  if (!current()) return;
  setRun(key, { changed: edited || codeChangedDuringRun(result.run), outputTail });
}

/**
 * Runs a card's check unless a run is going or its last result was made from
 * this diff and nothing changed under it: checks can take minutes, so an
 * automatic run repeats none of that work.
 */
async function runUnlessCurrent(taskId: string, cardId: string, rawDiff?: string): Promise<void> {
  const task = store.tasks[taskId];
  const card = store.cardDefinitions.find((entry) => entry.id === cardId);
  const check = cardCheck(taskId, cardId);
  if (!isLiveTask(task) || !card || !check || getCheckCardRun(taskId, cardId).running) return;
  const diff = rawDiff ?? (await readTaskDiff(task));
  if (diff === undefined) return;
  const run = getCheckCardRun(taskId, cardId);
  // Only a worktree's branch diff shows every edit: without git it reads as '', and in a
  // direct task it holds only uncommitted changes, so a committed edit would not show.
  const dated = task.gitIsolation === 'worktree';
  const covered =
    dated &&
    ranCommand.get(runKey(taskId, cardId)) === `${invokedMode(card)}\n${check.command}` &&
    task.cards?.[cardId]?.fingerprint === diffFingerprint(diff) &&
    !run.changed &&
    !run.error;
  if (covered || run.running) return;
  await runCheckCard(taskId, cardId, diff);
}

function checkCardsFor(taskId: string, triggers: readonly CheckTrigger[]): string[] {
  const task = store.tasks[taskId];
  if (!task) return [];
  return enabledCards(task.projectId).flatMap((card) =>
    card.source.kind === 'check' && triggers.includes(card.source.trigger) ? [card.id] : [],
  );
}

/** When Finish opens: cards set to run then, and those that run after each turn as well. */
export async function runFinishCheckCards(taskId: string): Promise<void> {
  const ids = checkCardsFor(taskId, ['finish', 'after-turn']);
  await Promise.all(ids.map((cardId) => runUnlessCurrent(taskId, cardId)));
}

/** After a settled turn, from the diff the fingerprint tracker read for it. */
export async function runAfterTurnCheckCards(taskId: string, rawDiff?: string): Promise<void> {
  const ids = checkCardsFor(taskId, ['after-turn']);
  await Promise.all(ids.map((cardId) => runUnlessCurrent(taskId, cardId, rawDiff)));
}
