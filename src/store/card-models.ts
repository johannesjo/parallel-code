/**
 * Running model cards: one structured request per card per task at a time,
 * skipped when nothing changed since the card's last values. Values land in
 * the task's cards; the run's state (updating, its error) is never saved.
 */

import { createStore, produce } from 'solid-js/store';
import { BRIEF_MODELS } from '../../electron/shared/task-name-model';
import { buildCardPrompt, parseCardResponse } from '../lib/card-model';
import type { CardDefinition, CardValues, ModelInput } from '../lib/cards';
import { diffFingerprint } from '../lib/diff-excerpt';
import { errMessage, warn as logWarn } from '../lib/log';
import { createLimiter } from '../lib/limiter';
import { startModelRequest } from '../lib/model-request';
import { latestAgentMessage } from './agent-message';
import { invokeCheck } from './card-checks';
import { enabledCards, isCardEnabled } from './cards';
import { getTaskChecks } from './check-suite-state';
import { storeCardRun } from './card-values';
import { store } from './core';
import { isLiveTask, promptsSince, readTaskDiff } from './task-diff';
import type { Task } from './types';

interface ModelCardRun {
  running?: boolean;
  /** Why the last run left the previous values, shown on the card's top line. */
  error?: string;
}

interface RunOptions {
  /** Run even when nothing changed: Refresh and Retry. Finish does not force. */
  force?: boolean;
  /** The diff the caller already read (undefined: unreadable), so a turn reads it once for every card. */
  read?: { rawDiff: string | undefined };
}

const [runs, setRuns] = createStore<Record<string, ModelCardRun>>({});
const inFlight = new Set<string>();
/** Runs asked for while one was going, with whether any of them forced it. */
const rerun = new Map<string, boolean>();

const runKey = (taskId: string, cardId: string) => `${taskId}\n${cardId}`;

// The backend runs five model requests at once across every feature (ASK_CODE_MAX_CONCURRENT);
// cards take three, so a burst of card runs never makes Ask code or a brief fail.
const cardRequests = createLimiter(3);

// Replaced, not merged: a store setter would keep `running` or an old error.
function setRun(key: string, next: ModelCardRun): void {
  setRuns(
    produce((all) => {
      all[key] = next;
    }),
  );
}

export function getModelCardRun(taskId: string, cardId: string): ModelCardRun {
  return runs[runKey(taskId, cardId)] ?? {};
}

function modelCard(cardId: string): CardDefinition | undefined {
  const card = store.cardDefinitions.find((entry) => entry.id === cardId);
  return card?.source.kind === 'model' ? card : undefined;
}

/** The run is still wanted: task open, cards on for its project, the card not saved or removed. */
function isStillWanted(taskId: string, card: CardDefinition): boolean {
  const task = store.tasks[taskId];
  return isLiveTask(task) && modelCard(card.id) === card && isCardEnabled(card, task.projectId);
}

/** The card's check, run first so the model can explain its output. */
async function checkInput(task: Task, card: CardDefinition, rawDiff: string | undefined) {
  if (card.source.kind !== 'model' || !card.source.checkId) return undefined;
  const { checkId } = card.source;
  const check = getTaskChecks(task.id).find((entry) => entry.id === checkId);
  if (!check) throw new Error(`This project has no check "${checkId}".`);
  const { run } = await invokeCheck(task, card, check, rawDiff ?? '');
  return { name: check.name, status: run.status, output: run.outputTail };
}

interface Captured {
  at: number;
  previous: CardValues | undefined;
  prompts: string[];
  message: string;
  replyFingerprint: string | undefined;
  rawDiff: string | undefined;
  fingerprint: string | undefined;
}

async function capture(task: Task, cardId: string, options: RunOptions): Promise<Captured> {
  const previous = task.cards?.[cardId];
  // Read before the diff is awaited, so a prompt sent meanwhile is left for the next run.
  const prompts = promptsSince(task, previous?.at ?? 0);
  const message = latestAgentMessage(task);
  const at = Date.now();
  const rawDiff = options.read ? options.read.rawDiff : await readTaskDiff(task);
  return {
    at,
    previous,
    prompts,
    message: message.text,
    // Screen snapshots change constantly, so only a real reply counts as news.
    replyFingerprint: message.isReply ? diffFingerprint(message.text) : undefined,
    rawDiff,
    fingerprint: rawDiff === undefined ? undefined : diffFingerprint(rawDiff),
  };
}

/** Nothing the card sends changed since its last values, so a run would only repeat them. */
function isUnchanged(input: Captured, source: { inputs: ModelInput[]; checkId?: string }) {
  const { previous, prompts, fingerprint, replyFingerprint, rawDiff } = input;
  if (!previous) return !prompts.length && !rawDiff;
  const uses = new Set(source.inputs);
  // The card's check runs on the code, so a code change is news even without the diff.
  if (source.checkId) uses.add('diff');
  return (
    (!uses.has('prompts') || prompts.length === 0) &&
    (!uses.has('diff') || fingerprint === undefined || fingerprint === previous.fingerprint) &&
    (!uses.has('agent-message') ||
      !replyFingerprint ||
      replyFingerprint === previous.replyFingerprint)
  );
}

async function requestValues(task: Task, card: CardDefinition, input: Captured) {
  if (card.source.kind !== 'model') throw new Error('Not a model card.');
  const { source } = card;
  const check = await checkInput(task, card, input.rawDiff);
  return cardRequests(async () => {
    // The diff read, the check and the queue took a while; what changed meanwhile must not start a paid request.
    if (!isStillWanted(task.id, card)) return undefined;
    const request = startModelRequest({
      prompt: buildCardPrompt({
        prompt: source.prompt,
        slots: card.slots,
        inputs: source.inputs,
        taskName: task.name,
        prompts: input.prompts,
        agentMessage: input.message,
        rawDiff: input.rawDiff,
        check,
        previous: input.previous?.values,
      }),
      cwd: task.worktreePath,
      settings: BRIEF_MODELS[source.model === 'default' ? store.briefModel : source.model],
      agentEnvFiles: store.agentEnvFiles,
      projectId: task.projectId,
      purpose: 'card',
    });
    return parseCardResponse(card.slots, await request.result);
  });
}

function storeValues(
  taskId: string,
  card: CardDefinition,
  input: Captured,
  fresh: CardValues['values'],
) {
  // A card removed or saved (`saveCard` replaces the definition) or a task closed meanwhile
  // takes no values: they were made for a layout that may be gone.
  if (!isStillWanted(taskId, card)) return;
  // A run that saw only the screen keeps the last reply, so that reply is not news again.
  const replyFingerprint = input.replyFingerprint ?? input.previous?.replyFingerprint;
  storeCardRun(taskId, card, {
    values: fresh,
    at: input.at,
    ...(input.fingerprint && { fingerprint: input.fingerprint }),
    ...(replyFingerprint && { replyFingerprint }),
  });
}

/**
 * Fills a model card on a task from what changed since its last values. One
 * run per card per task at a time; asking again meanwhile queues one more.
 */
export async function runModelCard(
  taskId: string,
  cardId: string,
  options: RunOptions = {},
): Promise<void> {
  const task = store.tasks[taskId];
  const card = modelCard(cardId);
  if (!isLiveTask(task) || !card || !isCardEnabled(card, task.projectId)) return;
  const key = runKey(taskId, cardId);
  if (inFlight.has(key)) {
    rerun.set(key, !!rerun.get(key) || !!options.force);
    return;
  }
  inFlight.add(key);
  try {
    const input = await capture(task, cardId, options);
    if (!options.force && card.source.kind === 'model' && isUnchanged(input, card.source)) return;
    setRun(key, { running: true });
    const fresh = await requestValues(task, card, input);
    if (fresh) storeValues(taskId, card, input, fresh);
    setRun(key, {});
  } catch (error) {
    const message = errMessage(error);
    logWarn('cards', 'Model card run failed', { taskId, cardId, error: message });
    setRun(key, { error: message });
  } finally {
    inFlight.delete(key);
    const queued = rerun.get(key);
    rerun.delete(key);
    if (queued !== undefined) void runModelCard(taskId, cardId, { force: queued });
  }
}

/** Fills every model card on after-turn for the task's project, from one diff read. */
export function runAfterTurnCards(taskId: string, rawDiff: string | undefined): void {
  const task = store.tasks[taskId];
  if (!task) return;
  for (const card of enabledCards(task.projectId)) {
    if (card.source.kind !== 'model' || card.source.trigger !== 'after-turn') continue;
    void runModelCard(taskId, card.id, { read: { rawDiff } });
  }
}

/** Update now in the cards popover: every model card on the task, whatever its trigger. */
export function updateModelCards(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  for (const card of enabledCards(task.projectId)) {
    if (card.source.kind === 'model') void runModelCard(taskId, card.id, { force: true });
  }
}

/** Fills the task's Finish-triggered model cards; each skips itself when nothing changed. */
export function runFinishCards(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  for (const card of enabledCards(task.projectId)) {
    if (card.source.kind === 'model' && card.source.trigger === 'finish')
      void runModelCard(taskId, card.id);
  }
}
