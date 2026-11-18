/**
 * A task's rating, held by the built-in Confidence card: written by the agent
 * (`confidence_publish`, or `card_publish` with card "confidence") and by the
 * app's own reviewer, and read back as a rating by the Finish review, merge
 * readiness and task visits. See docs/cards.md.
 */

import { CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import {
  parseConfidencePayload,
  type ConfidencePayload,
} from '../../electron/shared/task-confidence';
import { parseCardValues } from '../lib/card-publish';
import type { SlotValue } from '../lib/card-slots';
import { confidenceCard, type CardDefinition } from '../lib/cards';
import {
  cardConfidence,
  holdsMergeEvidence,
  isClassicRating,
  ratingCardValues,
  type RatingOrigin,
} from '../lib/confidence-card';
import type { TaskConfidence } from '../lib/task-confidence';
import { storeCardRun } from './card-values';
import { store, setStore } from './core';
import { fingerprintAfterPublish, publishTarget } from './task-diff';
import type { Task } from './types';

/** The Confidence card as the user laid it out; restore always adds it, the fallback is for safety. */
export function confidenceCardDefinition(): CardDefinition {
  return (
    store.cardDefinitions.find((card) => card.builtIn === 'confidence') ?? confidenceCard(false)
  );
}

/** The task's rating as its Confidence card holds it; undefined until rated. */
export function taskConfidence(task: Pick<Task, 'cards'>): TaskConfidence | undefined {
  return cardConfidence(confidenceCardDefinition(), task.cards?.[CONFIDENCE_CARD_ID]);
}

/**
 * The rating the merge check may weigh: none when the card's layout lost the
 * score list or the findings, so such a task never looks ready to merge.
 */
export function mergeConfidence(task: Pick<Task, 'cards'>): TaskConfidence | undefined {
  const card = confidenceCardDefinition();
  const values = task.cards?.[CONFIDENCE_CARD_ID];
  // A findings slot added back after the review is empty, which must not read as "nothing found".
  const held = values?.values.scores?.type === 'scores' && values.values.findings?.type === 'items';
  return holdsMergeEvidence(card) && held ? cardConfidence(card, values) : undefined;
}

/** Values the layout no longer holds, or holds with another type, are left out. */
function inLayout(card: CardDefinition, values: Record<string, SlotValue>) {
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) =>
      card.slots.some((slot) => slot.id === id && slot.type === value.type),
    ),
  );
}

/**
 * Stores a rating in the task's Confidence card, replacing the previous one:
 * a part the new rating leaves out must not survive from the old one. Parts
 * whose slot the user removed are dropped. `extra` fills slots of the user's
 * own, already checked.
 */
export function storeRating(
  taskId: string,
  payload: ConfidencePayload,
  meta: RatingOrigin,
  extra: Record<string, SlotValue> = {},
): void {
  const card = confidenceCardDefinition();
  const run = ratingCardValues(payload, meta);
  storeCardRun(taskId, card, { ...run, values: { ...inLayout(card, run.values), ...extra } });
}

function fingerprintRating(task: Task, at: number): void {
  fingerprintAfterPublish(task, (fingerprint) => {
    if (store.tasks[task.id]?.cards?.[CONFIDENCE_CARD_ID]?.at !== at) return;
    setStore('tasks', task.id, 'cards', CONFIDENCE_CARD_ID, 'fingerprint', fingerprint);
  });
}

/** Stores a rating the agent published through `confidence_publish`. */
export function publishTaskConfidence(taskId: string, input: unknown): void {
  const payload = parseConfidencePayload(input);
  const task = publishTarget(taskId);
  const at = Date.now();
  storeRating(taskId, payload, { at });
  fingerprintRating(task, at);
}

const CLASSIC_KEYS = new Set(['scores', 'findings', 'source', 'asked', 'changes', 'keyLine']);

/**
 * `card_publish` to the Confidence card. A classic confidence_publish payload
 * is checked as before, so skills that send it keep working; any other key
 * must name a slot of the card. Slot-keyed values without a classic rating
 * are checked against the layout like any agent card's.
 */
export function publishConfidenceCard(taskId: string, input: unknown): void {
  const task = publishTarget(taskId);
  const card = confidenceCardDefinition();
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const at = Date.now();
  // Without scores it is checked as a classic rating, which says that scores are missing.
  if ('scores' in raw && !isClassicRating(raw as Record<string, unknown>)) {
    storeCardRun(taskId, card, { values: parseCardValues(card, raw), at });
  } else {
    const payload = parseConfidencePayload(raw);
    const rest = Object.entries(raw).filter(([key]) => !CLASSIC_KEYS.has(key));
    const extra = rest.length ? parseCardValues(card, Object.fromEntries(rest)) : {};
    storeRating(taskId, payload, { at }, extra);
  }
  fingerprintRating(task, at);
}
