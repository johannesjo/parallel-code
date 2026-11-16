/**
 * Card definitions as an agent changes them through `card_config_save`: the
 * check that says what is wrong with a card instead of dropping it, and the
 * kinds of change that wait for the user. See docs/cards.md.
 */

import { CARD_ID_PATTERN } from '../../electron/shared/card-publish';
import { appFactCard } from './app-facts';
import { isRecord, type SlotDefinition } from './card-slots';
import { checkCard } from './check-card';
import {
  CARD_LIMITS,
  cardKind,
  restoreCardDefinitions,
  restoreCardSource,
  type CardDefinition,
  type CardSource,
  type ModelInput,
} from './cards';

/** The one layout the app fills for an app-fact or pass/fail check card; undefined when slots are the card's own. */
function fixedSlots(source: CardSource): SlotDefinition[] | undefined {
  if (source.kind === 'app') return appFactCard(source.fact, false).slots;
  if (source.kind === 'check' && source.mode === 'exit-code')
    return checkCard({ id: source.checkId, name: '' }).slots;
  return undefined;
}

/**
 * A card an agent sent, as the app would save it. Throws, naming the part,
 * when the card would not survive a reload; text over a limit is cut and
 * anything unknown dropped, which `savedAsSent` detects.
 */
export function parseCardConfig(raw: unknown): CardDefinition {
  const sent = isRecord(raw) ? raw : {};
  const id = typeof sent.id === 'string' ? sent.id : '';
  if (id.length > CARD_LIMITS.id || !CARD_ID_PATTERN.test(id))
    throw new Error(
      `A card needs an "id" of lower-case letters, digits and dashes, at most ${CARD_LIMITS.id} characters.`,
    );
  const source = restoreCardSource(sent.source);
  const fixed = source && fixedSlots(source);
  const laidOut = fixed ? { ...sent, slots: fixed } : sent;
  const card = restoreCardDefinitions([laidOut]).find((entry) => entry.id === id);
  if (card) return card;
  if (source) throw new Error(`Card "${id}" needs at least one slot with an id and a known type.`);
  throw new Error(
    `Card "${id}" needs a "source" the app can run: a model, the agent, a project check by id, or an app fact.`,
  );
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

/** Whether a card was saved exactly as the agent sent it, whatever the order of its keys. */
export function savedAsSent(sent: unknown, saved: CardDefinition): boolean {
  return JSON.stringify(sortedKeys(sent)) === JSON.stringify(sortedKeys(saved));
}

/** Whether a card runs as an AI card in a project, or by default when no project is given. */
function aiOn(card: CardDefinition | undefined, projectId?: string): boolean {
  if (!card || cardKind(card.source) !== 'ai') return false;
  return (projectId === undefined ? undefined : card.projects?.[projectId]) ?? card.enabled;
}

/** Whether a card calls a model itself there; an agent card is filled by the task's own agent. */
function modelOn(card: CardDefinition | undefined, projectId?: string): boolean {
  return aiOn(card, projectId) && card?.source.kind === 'model';
}

/**
 * Whether saving `next` over `previous` lets an AI card run somewhere it did
 * not, or lets it call a model where it called none: by default or in one of
 * the projects. Model calls cost money and send task content to a provider,
 * so that is the user's call.
 */
export function switchesOnAi(
  next: CardDefinition,
  previous: CardDefinition | undefined,
  projectIds: readonly string[],
): boolean {
  return [undefined, ...projectIds].some(
    (id) =>
      (aiOn(next, id) && !aiOn(previous, id)) || (modelOn(next, id) && !modelOn(previous, id)),
  );
}

type ModelSource = Extract<CardSource, { kind: 'model' }>;

/**
 * Both model sources when saving `next` over `previous` keeps a model card
 * calling its model somewhere it already did; undefined otherwise. A card
 * that is off can be edited freely, since switching it on asks.
 */
function keptModelSources(
  next: CardDefinition,
  previous: CardDefinition | undefined,
  projectIds: readonly string[],
): [ModelSource, ModelSource] | undefined {
  if (next.source.kind !== 'model' || previous?.source.kind !== 'model') return undefined;
  const stayedOn = (id?: string) => modelOn(next, id) && modelOn(previous, id);
  if (![undefined, ...projectIds].some(stayedOn)) return undefined;
  return [next.source, previous.source];
}

/** Whether a model card that is on gets another model: task content may go to another provider. */
export function changesModel(
  next: CardDefinition,
  previous: CardDefinition | undefined,
  projectIds: readonly string[],
): boolean {
  const kept = keptModelSources(next, previous, projectIds);
  return !!kept && kept[0].model !== kept[1].model;
}

/** What a model card that is on newly sends to its model; `check` is the output of a check run first. */
export function addedModelInputs(
  next: CardDefinition,
  previous: CardDefinition | undefined,
  projectIds: readonly string[],
): (ModelInput | 'check')[] {
  const kept = keptModelSources(next, previous, projectIds);
  if (!kept) return [];
  const [now, before] = kept;
  const inputs = now.inputs.filter((input) => !before.inputs.includes(input));
  return now.checkId && now.checkId !== before.checkId ? [...inputs, 'check'] : inputs;
}

/** The slots of `previous` that `next` no longer has; saving deletes their values on every task. */
export function droppedSlotIds(
  next: CardDefinition,
  previous: CardDefinition | undefined,
): string[] {
  const kept = new Set(next.slots.map((slot) => slot.id));
  return (previous?.slots ?? []).map((slot) => slot.id).filter((id) => !kept.has(id));
}
