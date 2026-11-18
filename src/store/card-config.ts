/**
 * The renderer side of `card_config_read`, `card_config_save` and
 * `card_config_remove`: an agent changes the card definitions, which are
 * global. A change that switches on an AI card or deletes values tasks hold
 * waits here for one click from the user, as does one that gives a running AI
 * card another model or more to send. See docs/cards.md.
 */

import { createSignal } from 'solid-js';
import {
  addedModelInputs,
  changesModel,
  droppedSlotIds,
  parseCardConfig,
  savedAsSent,
  switchesOnAi,
} from '../lib/card-config';
import { sourceLabel, triggerLabel } from '../lib/card-display';
import { isRecord } from '../lib/card-slots';
import {
  CARD_LIMITS,
  persistCardDefinitions,
  type CardDefinition,
  type CardSource,
} from '../lib/cards';
import { errMessage } from '../lib/log';
import { allProjectChecks } from './card-layout';
import { addCard, moveCard, removeCard, saveCard } from './cards';
import { store } from './core';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import { publishTarget } from './task-diff';

/** A change an agent asked for that the user has not answered yet. */
export interface WaitingCardChange {
  cardId: string;
  /** The task whose agent asked, by name for the notice and by id for the answer. */
  asker: string;
  askerId: string;
  /** In words, after "wants to": `add "Notes", which switches on an AI card`. */
  change: string;
  apply: () => void;
}

/** More than the user can sensibly be asked about; an agent past it is told to wait. */
const MAX_WAITING = 5;
/** Answers kept per task until its agent reads them; older ones are dropped. */
const MAX_ANSWERS = 10;

/** What became of a waiting change, for the agent that asked. */
interface CardChangeAnswer {
  card: string;
  change: string;
  answer: 'applied' | 'dismissed' | 'not applied' | 'replaced';
  reason?: string;
}

// In memory like the waiting list: a restart loses both, and the hold message says so.
const answers = new Map<string, CardChangeAnswer[]>();

function noteAnswer(entry: WaitingCardChange, answer: Omit<CardChangeAnswer, 'card' | 'change'>) {
  const list = answers.get(entry.askerId) ?? [];
  list.push({ card: entry.cardId, change: entry.change, ...answer });
  answers.set(entry.askerId, list.slice(-MAX_ANSWERS));
}

/**
 * Hands a task's agent its answers once: card_config_read reports news, not
 * history. A reply lost on its way to the agent loses them; the cards it reads
 * still show what was applied.
 */
function takeAnswers(taskId: string): CardChangeAnswer[] {
  const list = answers.get(taskId) ?? [];
  answers.delete(taskId);
  return list;
}

// Kept out of the store: the store is saved, and a function cannot be.
const [waiting, setWaiting] = createSignal<WaitingCardChange[]>([]);
/** The changes waiting for the user, oldest first. */
export const waitingCardChanges = waiting;

const drop = (cardId: string) =>
  setWaiting((entries) => entries.filter((entry) => entry.cardId !== cardId));

/** Drops what waits for a card because a newer request took its place; another task's agent is told. */
function supersede(cardId: string, askerId: string): void {
  const older = waiting().find((entry) => entry.cardId === cardId);
  if (older && older.askerId !== askerId) noteAnswer(older, { answer: 'replaced' });
  drop(cardId);
}

/** Applies or drops the change waiting for a card. */
export function answerCardChange(cardId: string, apply: boolean): void {
  const change = waiting().find((entry) => entry.cardId === cardId);
  drop(cardId);
  if (!change) return;
  if (!apply) return noteAnswer(change, { answer: 'dismissed' });
  try {
    change.apply();
    noteAnswer(change, { answer: 'applied' });
  } catch (error) {
    // The cards changed while it waited, e.g. the cap was reached.
    showNotification(errMessage(error), { durationMs: NOTIFICATION_ERROR_MS });
    noteAnswer(change, { answer: 'not applied', reason: errMessage(error) });
  }
}

const existing = (cardId: string) => store.cardDefinitions.find((card) => card.id === cardId);
const tasksText = (count: number) => (count === 1 ? '1 task' : `${count} tasks`);

/** How many tasks hold a value in one of a card's slots; every slot when none is named. */
function tasksHolding(cardId: string, slotIds?: readonly string[]): number {
  return Object.values(store.tasks).filter((task) => {
    const held = Object.keys(task.cards?.[cardId]?.values ?? {});
    return slotIds ? held.some((id) => slotIds.includes(id)) : held.length > 0;
  }).length;
}

/** Holds a change for the user; a newer one for the same card takes the older one's place. */
function hold(entry: WaitingCardChange) {
  const others = waiting().filter((other) => other.cardId !== entry.cardId);
  if (others.length >= MAX_WAITING)
    throw new Error(
      `${MAX_WAITING} card changes are waiting for a click in the app. Ask the user to answer them first.`,
    );
  supersede(entry.cardId, entry.askerId);
  setWaiting([...others, entry]);
  return {
    status: 'waiting' as const,
    card: entry.cardId,
    message:
      `Nothing changed yet. To ${entry.change}, the user has to click Apply in the app. ` +
      'card_config_read reports the answer once, under "answers". A restart of the app drops ' +
      'waiting changes: one neither waiting nor answered was lost and can be asked again.',
  };
}

function applySave(card: CardDefinition, position: number | undefined): void {
  if (existing(card.id)) saveCard(card);
  else if (!addCard(card))
    throw new Error(`There are already ${CARD_LIMITS.cards} cards. Remove one first.`);
  if (position !== undefined) moveCard(card.id, position);
}

/** What a model can be sent, in the notice's words. */
const SENT = {
  'task-name': 'the task name',
  prompts: 'your prompts',
  'agent-message': "the agent's last message",
  diff: 'the diff',
  check: "a check's output",
};
const sentText = (inputs: readonly (keyof typeof SENT)[]) =>
  inputs.map((input) => SENT[input]).join(', ');

/** A card's source for the switch-on question: who fills it, when, and what a model is sent. */
function sourceInWords(source: CardSource): string {
  const words = [sourceLabel(source, store.briefModel), triggerLabel(source)];
  if (source.kind !== 'model') return words.join(', ');
  const sent = sentText([...source.inputs, ...(source.checkId ? (['check'] as const) : [])]);
  return [...words, ...(sent ? [`sends ${sent}`] : [])].join(', ');
}

/** Why a save needs the user's click for what it does with AI, in words. */
function aiReasons(card: CardDefinition, previous: CardDefinition | undefined): string[] {
  const projectIds = store.projects.map((project) => project.id);
  // Switching on names the model and all it is sent, so those need no second mention.
  if (switchesOnAi(card, previous, projectIds))
    return [`switches on an AI card (${sourceInWords(card.source)})`];
  const reasons: string[] = [];
  if (changesModel(card, previous, projectIds)) {
    const model = sourceLabel(card.source, store.briefModel);
    reasons.push(`changes the model of an AI card that is on (to ${model})`);
  }
  const sent = sentText(addedModelInputs(card, previous, projectIds));
  if (sent) reasons.push(`sends more to the model of an AI card that is on (${sent})`);
  return reasons;
}

/** Why saving a card needs the user's click, in words; empty when it does not. */
function saveReasons(card: CardDefinition, previous: CardDefinition | undefined): string[] {
  const reasons = aiReasons(card, previous);
  const holding = tasksHolding(card.id, droppedSlotIds(card, previous));
  if (holding) reasons.push(`deletes values it shows on ${tasksText(holding)}`);
  return reasons;
}

/** A save that needs the user's click, in words after "wants to"; undefined when it needs none. */
function saveInWords(card: CardDefinition, previous: CardDefinition | undefined) {
  const reasons = saveReasons(card, previous);
  if (!reasons.length) return undefined;
  return `${previous ? 'change' : 'add'} "${card.name}", which ${reasons.join(' and ')}`;
}

/** A removal that needs the user's click, in words; undefined when the card holds no values. */
function removeInWords(card: CardDefinition) {
  const holding = tasksHolding(card.id);
  if (!holding) return undefined;
  return `remove "${card.name}", which deletes the values it shows on ${tasksText(holding)}`;
}

/**
 * Runs a waiting change only while it still reads as the user was told: the
 * cards and the values tasks hold can change between the question and the click.
 */
function asRead(change: string, inWords: () => string | undefined, run: () => void) {
  return () => {
    if (inWords() !== change)
      throw new Error(
        'The cards changed since the agent asked. Nothing was applied; the agent can ask again.',
      );
    run();
  };
}

interface Asker {
  name: string;
  id: string;
}

/** Confidence sent without slots, as before its layout was editable, keeps the layout it has. */
function keptLayout(card: CardDefinition, raw: unknown, previous?: CardDefinition) {
  const sentSlots = !!raw && typeof raw === 'object' && 'slots' in raw;
  return card.builtIn && previous && !sentSlots ? { ...card, slots: previous.slots } : card;
}

function save(asker: Asker, raw: unknown, position: number | undefined) {
  const parsed = parseCardConfig(raw);
  const previous = existing(parsed.id);
  const card = keptLayout(parsed, raw, previous);
  if (!previous && store.cardDefinitions.length >= CARD_LIMITS.cards)
    throw new Error(`There are already ${CARD_LIMITS.cards} cards. Remove one first.`);
  const change = saveInWords(card, previous);
  if (change) {
    const before = JSON.stringify(previous);
    const inWords = () => {
      const now = existing(card.id);
      return JSON.stringify(now) === before ? saveInWords(card, now) : undefined;
    };
    const apply = asRead(change, inWords, () => applySave(card, position));
    return hold({ cardId: card.id, asker: asker.name, askerId: asker.id, change, apply });
  }
  applySave(card, position);
  // The agent's newest word on this card; an older one still waiting would undo it.
  supersede(card.id, asker.id);
  return {
    status: 'saved' as const,
    card,
    ...(!savedAsSent(raw, card) && {
      note: 'Saved, but not exactly as sent: text over a limit is cut and anything unknown is dropped. "card" is what was saved.',
    }),
  };
}

function remove(asker: Asker, cardId: string) {
  const card = existing(cardId);
  if (!card) throw new Error(`There is no card "${cardId}". Call card_config_read.`);
  if (card.builtIn) throw new Error(`Card "${cardId}" is built in. Switch it off instead.`);
  const change = removeInWords(card);
  if (change) {
    const inWords = () => {
      const now = existing(cardId);
      return now && removeInWords(now);
    };
    return hold({
      cardId,
      asker: asker.name,
      askerId: asker.id,
      change,
      apply: asRead(change, inWords, () => removeCard(cardId)),
    });
  }
  removeCard(cardId);
  supersede(cardId, asker.id);
  return { status: 'removed' as const, card: cardId };
}

/** Every card definition as saved, and what an agent needs to write one. */
export function readCardConfig(taskId: string) {
  const { projectId } = publishTarget(taskId);
  const project = store.projects.find((entry) => entry.id === projectId);
  return {
    showCards: store.showCards,
    defaultModel: store.briefModel,
    project: { id: projectId, name: project?.name ?? '' },
    checks: allProjectChecks().map(({ id, name }) => ({ id, name })),
    cards: persistCardDefinitions(store.cardDefinitions),
    waiting: waiting().map(({ cardId, change }) => ({ card: cardId, change })),
    answers: takeAnswers(taskId),
  };
}

/**
 * Saves or removes one card for a task's agent. Returns what was saved or
 * removed, or that the change waits for the user; throws with a message for
 * the agent when the request cannot be carried out.
 */
export function changeCardConfig(taskId: string, request: unknown) {
  const asker = { name: publishTarget(taskId).name, id: taskId };
  if (isRecord(request) && request.action === 'remove' && typeof request.card === 'string')
    return remove(asker, request.card);
  if (isRecord(request) && request.action === 'save') {
    const position = typeof request.position === 'number' ? request.position : undefined;
    return save(asker, request.card, position);
  }
  throw new Error('A card_config change is {action: "save", card} or {action: "remove", card}.');
}
