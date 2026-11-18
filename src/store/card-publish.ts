/**
 * The renderer side of `card_list` and `card_publish`: card definitions live
 * here, so main asks over IPC which cards an agent may fill and hands it
 * the payload to check. See docs/cards.md.
 */

import { describeAgentCard, parseCardValues } from '../lib/card-publish';
import { CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import { isCardEnabled } from './cards';
import { storeCardRun } from './card-values';
import { confidenceCardDefinition, publishConfidenceCard } from './confidence';
import { store, setStore } from './core';
import { fingerprintAfterPublish, publishTarget } from './task-diff';

/** The Confidence card's slots, and the classic payload it takes as well. */
function confidenceEntry() {
  return {
    ...describeAgentCard(confidenceCardDefinition()),
    accepts:
      'Values keyed by these slots, or the confidence_publish payload (scores, findings, source, asked, changes, keyLine); parts whose slot is gone are dropped.',
  };
}

/** The cards the task's agent may fill: Confidence, then its project's agent cards. */
export function listAgentCards(taskId: string) {
  const task = publishTarget(taskId);
  const cards = store.cardDefinitions
    .filter((card) => !card.builtIn && card.source.kind === 'agent')
    .filter((card) => isCardEnabled(card, task.projectId))
    .map(describeAgentCard);
  return { cards: [confidenceEntry(), ...cards] };
}

/**
 * Replaces a user card's values with what the agent published. A payload that
 * does not fit leaves the card as it was, and the error names the slot.
 */
export function publishCardValues(taskId: string, cardId: string, input: unknown): void {
  // Like confidence_publish, it lands whether the card is on or not: the merge check reads it.
  if (cardId === CONFIDENCE_CARD_ID) return publishConfidenceCard(taskId, input);
  const task = publishTarget(taskId);
  const card = store.cardDefinitions.find((entry) => entry.id === cardId);
  if (!card || card.builtIn) throw new Error(`There is no card "${cardId}". Call card_list.`);
  if (card.source.kind !== 'agent')
    throw new Error(`Card "${cardId}" is filled by the app, not by the agent.`);
  if (!isCardEnabled(card, task.projectId))
    throw new Error(`Card "${cardId}" is off for this task's project.`);
  const values = parseCardValues(card, input);
  const at = Date.now();
  storeCardRun(taskId, card, { values, at });
  fingerprintAfterPublish(task, (fingerprint) => {
    if (store.tasks[taskId]?.cards?.[cardId]?.at !== at) return;
    setStore('tasks', taskId, 'cards', cardId, 'fingerprint', fingerprint);
  });
}
