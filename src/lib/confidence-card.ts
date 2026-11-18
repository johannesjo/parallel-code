/**
 * The Confidence card holds a task's rating as ordinary card values. This
 * module maps the classic rating (a confidence_publish payload, the app
 * reviewer's output, or a rating saved before the card held it) onto the
 * card's slots, and reads the card back as a rating for the Finish review,
 * merge readiness and task visits. See docs/cards.md.
 */

import type {
  ConfidenceChange,
  ConfidenceFinding,
  ConfidenceFindingKind,
  ConfidenceKeyLine,
  ConfidencePayload,
} from '../../electron/shared/task-confidence';
import { CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import { valueFor } from './card-display';
import type { CardItem, ItemSeverity, SlotDefinition, SlotValue } from './card-slots';
import { restoreTaskCards, type CardDefinition, type CardValues } from './cards';
import {
  LOW_CONFIDENCE_SCORE,
  restoreTaskConfidence,
  type TaskConfidence,
} from './task-confidence';

/** Who wrote a rating, beyond its payload. */
export interface RatingOrigin {
  at: number;
  fingerprint?: string;
  origin?: 'review';
  headSha?: string;
}

// Gap and risk both hold a merge, so they share `block`; the card does not keep them apart.
const SEVERITY_OF: Record<ConfidenceFindingKind, ItemSeverity> = {
  gap: 'block',
  risk: 'block',
  unverified: 'warn',
  extra: 'info',
};
const KIND_OF: Record<ItemSeverity, ConfidenceFindingKind> = {
  block: 'risk',
  warn: 'unverified',
  info: 'extra',
};

function findingItem(finding: ConfidenceFinding): CardItem {
  return {
    text: finding.text,
    severity: SEVERITY_OF[finding.kind],
    ...(finding.file && { file: finding.file }),
    ...(finding.axis && { tag: finding.axis }),
  };
}

function changeItem(change: ConfidenceChange): CardItem {
  return {
    text: change.now,
    severity: 'info',
    ...(change.before && { detail: change.before }),
    ...(change.tested && { tag: change.tested }),
  };
}

function keyLineItem(keyLine: ConfidenceKeyLine): CardItem {
  const file = keyLine.line ? `${keyLine.file}:${keyLine.line}` : keyLine.file;
  return { text: keyLine.why, severity: 'info', file };
}

/**
 * A classic rating as Confidence card values, keyed by the default slot ids.
 * Findings are always written, an empty list included, since "nothing found"
 * is what lets a review pass.
 */
export function ratingValues(payload: ConfidencePayload): Record<string, SlotValue> {
  return {
    scores: { type: 'scores', scores: payload.scores },
    findings: { type: 'items', items: payload.findings.map(findingItem) },
    ...(payload.changes && {
      changes: { type: 'items', items: payload.changes.map(changeItem) },
    }),
    ...(payload.keyLine && { keyLine: { type: 'items', items: [keyLineItem(payload.keyLine)] } }),
    ...(payload.asked && { asked: { type: 'line', text: payload.asked } }),
  };
}

/** A classic rating with who wrote it, as the card values a run stores. */
export function ratingCardValues(payload: ConfidencePayload, meta: RatingOrigin): CardValues {
  return {
    values: ratingValues(payload),
    at: meta.at,
    ...(meta.fingerprint && { fingerprint: meta.fingerprint }),
    ...(payload.source && { source: payload.source }),
    ...(meta.origin && { origin: meta.origin }),
    ...(meta.headSha && { headSha: meta.headSha }),
  };
}

/** A rating saved before the card held it, as card values; nothing is lost. */
export function legacyRatingValues(rating: TaskConfidence): CardValues {
  return ratingCardValues(rating, {
    at: rating.publishedAt,
    ...(rating.fingerprint && { fingerprint: rating.fingerprint }),
    ...(rating.origin && { origin: rating.origin }),
    ...(rating.headSha && { headSha: rating.headSha }),
  });
}

/**
 * A task's saved card values. A rating saved before the card held it
 * (`task.confidence`) moves into the card, unless the card already has values.
 */
export function restoreRatedTaskCards(
  cards: unknown,
  confidence: unknown,
): Record<string, CardValues> | undefined {
  const restored = restoreTaskCards(cards);
  if (restored?.[CONFIDENCE_CARD_ID]) return restored;
  const rating = restoreTaskConfidence(confidence);
  return rating ? { ...restored, [CONFIDENCE_CARD_ID]: legacyRatingValues(rating) } : restored;
}

/** The card's slot for one of the rating's parts, when its layout still has it with that type. */
function ratingSlot(
  card: CardDefinition,
  id: string,
  type: SlotDefinition['type'],
): SlotDefinition | undefined {
  return card.slots.find((slot) => slot.id === id && slot.type === type);
}

function itemsOf(card: CardDefinition, id: string, values: CardValues): CardItem[] | undefined {
  const slot = ratingSlot(card, id, 'items');
  const value = slot && valueFor(slot, values);
  return value?.type === 'items' ? value.items : undefined;
}

function keyLineOf(item: CardItem | undefined): ConfidenceKeyLine | undefined {
  if (!item?.file) return undefined;
  const match = /^(.*):(\d+)$/.exec(item.file);
  const line = match ? Number(match[2]) : undefined;
  return { file: match ? match[1] : item.file, ...(line && { line }), why: item.text };
}

/** The low bar the card's score list sets, or the shipped one. */
export function confidenceThreshold(card: CardDefinition): number {
  return ratingSlot(card, 'scores', 'scores')?.warnBelow ?? LOW_CONFIDENCE_SCORE;
}

/**
 * The card's values read back as a rating, for the readers that weigh it.
 * Parts whose slot the user removed or retyped read as missing. Undefined
 * while the task has no values for the card.
 */
export function cardConfidence(
  card: CardDefinition,
  values: CardValues | undefined,
): TaskConfidence | undefined {
  if (!values) return undefined;
  const scoresSlot = ratingSlot(card, 'scores', 'scores');
  const scores = scoresSlot && valueFor(scoresSlot, values);
  const askedSlot = ratingSlot(card, 'asked', 'line');
  const asked = askedSlot && valueFor(askedSlot, values);
  const changes = itemsOf(card, 'changes', values)?.map((item) => ({
    now: item.text,
    ...(item.detail && { before: item.detail }),
    ...(item.tag && { tested: item.tag }),
  }));
  const keyLine = keyLineOf(itemsOf(card, 'keyLine', values)?.[0]);
  return {
    scores: scores?.type === 'scores' ? scores.scores : [],
    findings: (itemsOf(card, 'findings', values) ?? []).map((item) => ({
      kind: KIND_OF[item.severity],
      text: item.text,
      ...(item.file && { file: item.file }),
      ...(item.tag && { axis: item.tag }),
    })),
    ...(values.source && { source: values.source }),
    ...(asked?.type === 'line' && { asked: asked.text }),
    ...(changes?.length && { changes }),
    ...(keyLine && { keyLine }),
    publishedAt: values.at,
    ...(values.fingerprint && { fingerprint: values.fingerprint }),
    ...(values.origin && { origin: values.origin }),
    ...(values.headSha && { headSha: values.headSha }),
    warnBelow: confidenceThreshold(card),
  };
}

/**
 * Whether the card's layout keeps what the merge check weighs: the score list
 * and the findings. Without either a review cannot vouch for the code, so the
 * task never looks ready to merge.
 */
export function holdsMergeEvidence(card: CardDefinition): boolean {
  return !!ratingSlot(card, 'scores', 'scores') && !!ratingSlot(card, 'findings', 'items');
}

/** The keys a classic confidence_publish payload has that slot-keyed values never need. */
export function isClassicRating(values: Record<string, unknown>): boolean {
  const findings = Array.isArray(values.findings) ? (values.findings as unknown[]) : [];
  const has = (key: string) =>
    findings.some((entry) => !!entry && typeof entry === 'object' && key in entry);
  // Findings with a severity are items, as card_list describes them, even beside a bare score list.
  if (has('severity') && !has('kind')) return false;
  return Array.isArray(values.scores) || 'source' in values || has('kind');
}
