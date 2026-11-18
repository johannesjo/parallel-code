/**
 * How cards read at a glance: which values need attention, the one-line
 * summary the card line and the bar show, and the source label on its top line.
 */

import { BRIEF_MODELS, type BriefModelId } from '../../electron/shared/task-name-model';
import { SLOT_LIMITS, parseSlotValue, type SlotDefinition, type SlotValue } from './card-slots';
import { appFactPending } from './app-facts';
import { fillsOnItsOwn, type CardDefinition, type CardSource, type CardValues } from './cards';
import { inConfidenceOrder } from './task-confidence';

/** Whether a value is past the threshold its slot sets: the only reason for colour. */
export function slotWarns(slot: SlotDefinition, value: SlotValue): boolean {
  switch (value.type) {
    case 'score':
      return slot.warnBelow !== undefined && value.score < slot.warnBelow;
    case 'scores':
      return value.scores.some((entry) => scoreWarns(slot, entry.score));
    case 'stat':
      return slot.limit !== undefined && value.value > slot.limit;
    case 'items':
      return value.items.some((item) => item.severity === 'block');
    case 'status':
      return value.rows.some((row) => row.state === 'fail');
    default:
      return false;
  }
}

/** Whether one score of a score list is below its slot's bar. */
export function scoreWarns(slot: SlotDefinition, score: number): boolean {
  return slot.warnBelow !== undefined && score < slot.warnBelow;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Slot types whose label, on a card's only slot, repeats the card's name. */
const UNLABELLED_ALONE: ReadonlySet<SlotDefinition['type']> = new Set([
  'scores',
  'items',
  'checklist',
  'status',
  'text',
]);

/** The slots the card itself draws; hidden ones are only stored, pinned and read elsewhere. */
export function shownSlots(card: CardDefinition): SlotDefinition[] {
  return card.slots.filter((slot) => !slot.hidden);
}

/**
 * Whether a slot's label shows above it in the card. A card's only list or text
 * block repeats the card's name ("Decisions" over "Decisions"); a lone line or
 * number keeps its label, which says what the short value is.
 */
export function showsSlotLabel(card: CardDefinition, slot: SlotDefinition): boolean {
  return shownSlots(card).length > 1 || !UNLABELLED_ALONE.has(slot.type);
}

/** A list slot whose source answered "nothing found". */
export function isEmptyList(value: SlotValue): boolean {
  if (value.type === 'items' || value.type === 'checklist') return !value.items.length;
  return value.type === 'status' && !value.rows.length;
}

/** A slot's value in a few words, for collapsed cards, the card line and pins. */
export function slotSummary(slot: SlotDefinition, value: SlotValue): string {
  if (isEmptyList(value)) return 'None';
  switch (value.type) {
    case 'line':
      return value.text;
    case 'text':
      return value.text.split('\n').find((line) => line.trim()) ?? '';
    case 'score':
      return `${slot.label} ${value.score}`;
    case 'scores':
      return inConfidenceOrder(value.scores)
        .map((entry) => `${entry.label} ${entry.score}`)
        .join(' · ');
    case 'stat':
      return `${formatNumber(value.value)}${value.unit ? ` ${value.unit}` : ''}`;
    case 'items': {
      const blocking = value.items.filter((item) => item.severity === 'block').length;
      if (blocking) return `${blocking} blocking`;
      return `${value.items.length} ${value.items.length === 1 ? 'item' : 'items'}`;
    }
    case 'checklist': {
      const done = value.items.filter((item) => item.state === 'done').length;
      const next = value.items.find((item) => item.state !== 'done');
      return `${done}/${value.items.length}${next ? ` · next: ${next.text}` : ''}`;
    }
    case 'status': {
      const failed = value.rows.find((row) => row.state === 'fail');
      return failed ? `${failed.text}` : (value.rows[0]?.text ?? '');
    }
  }
}

/** The card's value for a slot, when it still fits the slot's current type. */
export function valueFor(
  slot: SlotDefinition,
  values: CardValues | undefined,
): SlotValue | undefined {
  const value = values?.values[slot.id];
  if (value?.type !== slot.type) return undefined;
  // Items stored while the slot added up keep 20 and their turn tags; once it no longer adds up they read as a plain list.
  const addedUp =
    value.type === 'items' &&
    !slot.addUp &&
    (value.items.length > SLOT_LIMITS.items || value.items.some((item) => item.turn !== undefined));
  return addedUp ? parseSlotValue(slot, value.items) : value;
}

/** Values made from code that has since changed: shown faded, without warning colour. */
export function areCardValuesOutdated(
  values: Pick<CardValues, 'at' | 'fingerprint'> | undefined,
  code: { fingerprint: string; at: number } | undefined,
): boolean {
  if (!values?.fingerprint || !code) return false;
  return code.at > values.at && code.fingerprint !== values.fingerprint;
}

/** Whether a card belongs at the top of the popover: a current value past its threshold. */
export function cardNeedsAttention(
  card: CardDefinition,
  values: CardValues | undefined,
  outdated: boolean,
): boolean {
  if (outdated) return false;
  return shownSlots(card).some((slot) => {
    const value = valueFor(slot, values);
    return !!value && slotWarns(slot, value);
  });
}

/** One line for a collapsed card: what needs attention first, else its first values. */
export function cardSummary(card: CardDefinition, values: CardValues | undefined): string {
  const filled = shownSlots(card).flatMap((slot) => {
    const value = valueFor(slot, values);
    return value ? [{ slot, value }] : [];
  });
  const urgent = filled.filter(({ slot, value }) => slotWarns(slot, value));
  const shown = urgent.length ? urgent : filled;
  return shown
    .slice(0, 2)
    .map(({ slot, value }) => slotSummary(slot, value))
    .filter(Boolean)
    .join(' · ');
}

/** "Sonnet" from "Claude Sonnet (claude CLI)": the top line has little room. */
function shortModelLabel(model: BriefModelId): string {
  return BRIEF_MODELS[model].label.replace(/ \(.*\)$/, '').replace(/^Claude /, '');
}

/** What fills a card, for its top line: a model, "agent", "check" or "app". */
export function sourceLabel(source: CardSource, defaultModel: BriefModelId): string {
  switch (source.kind) {
    case 'model':
      return shortModelLabel(source.model === 'default' ? defaultModel : source.model);
    case 'agent':
      return 'agent';
    case 'check':
      return 'check';
    case 'app':
      return 'app';
  }
}

/** What fills a card that has no values yet, for its top line. */
export function fillHint(source: CardSource): string {
  switch (source.kind) {
    case 'model':
      return source.trigger === 'after-turn' ? 'after the next turn' : triggerLabel(source);
    case 'agent':
      return 'waiting for the agent';
    case 'check':
      return 'not run yet';
    case 'app':
      return appFactPending(source.fact);
  }
}

/** When a card is filled, in the Cards tab's words. */
export function triggerLabel(source: CardSource): string {
  switch (source.kind) {
    case 'model':
      return { 'after-turn': 'after each turn', manual: 'on demand', finish: 'at Finish' }[
        source.trigger
      ];
    case 'agent':
      return 'when published';
    case 'check':
      return {
        manual: 'on demand',
        finish: 'at Finish',
        'after-turn': 'after each turn',
      }[source.trigger];
    case 'app':
      return 'live';
  }
}

/** What a task holds that its cards read: card values and the newest code. */
export interface CardTaskState {
  cards?: Record<string, CardValues>;
  codeFingerprint?: { fingerprint: string; at: number };
}

/** A card as it reads on one task, for the card line, the popover and its top line. */
export interface CardReading {
  /** When its values were made; unset while it has none. */
  at?: number;
  outdated: boolean;
  urgent: boolean;
  summary: string;
  /** Who filled it, or fills it. */
  source: string;
  /** What fills it, while it has no values. */
  pending: string;
}

/** Who filled the values: the publisher's own name, the app's review, else the card's source. */
function filledBy(
  card: CardDefinition,
  values: CardValues | undefined,
  defaultModel: BriefModelId,
) {
  if (values?.source) return values.source;
  return values?.origin === 'review' ? 'review' : sourceLabel(card.source, defaultModel);
}

/** Reads a card on a task. */
export function readCard(
  card: CardDefinition,
  task: CardTaskState,
  defaultModel: BriefModelId,
): CardReading {
  const values = task.cards?.[card.id];
  const outdated = areCardValuesOutdated(values, task.codeFingerprint);
  return {
    ...(values && { at: values.at }),
    outdated,
    urgent: cardNeedsAttention(card, values, outdated),
    summary: cardSummary(card, values),
    source: filledBy(card, values, defaultModel),
    pending: card.builtIn === 'confidence' ? 'waiting for a rating' : fillHint(card.source),
  };
}

/**
 * The cards to draw on a task, leaving out Confidence until the task has a
 * rating, and cards set to hide until they have values while they have none.
 * `inRun` keeps a card whose run is going or failed, so a first run's progress
 * or error is not hidden with it. Returns the same objects, so <For> keeps
 * each view.
 */
export function shownCards(
  cards: CardDefinition[],
  task: CardTaskState,
  inRun: (card: CardDefinition) => boolean = () => false,
): CardDefinition[] {
  return cards.filter((card) => {
    if (card.builtIn === 'confidence') return !!task.cards?.[card.id];
    return !card.hideEmpty || !fillsOnItsOwn(card.source) || !!task.cards?.[card.id] || inRun(card);
  });
}

/** One pinned value in the pin row. */
export interface Pin {
  key: string;
  /** The slot's label; a line or text slot speaks for itself. */
  label: string;
  /** The value, or "–" before there is one. */
  text: string;
  warn: boolean;
  faded: boolean;
  /** A card's mini view rather than one slot. */
  mini?: boolean;
}

/** The pin row's pins of one card, in slot order. */
export interface PinGroup {
  card: CardDefinition;
  pins: Pin[];
}

/** The slots a card pins that still exist, from settings alone. */
export function pinnedSlotIds(card: CardDefinition): string[] {
  return card.slots.map((slot) => slot.id).filter((id) => card.pinned?.includes(id));
}

/** Whether a card shows in the pin row: its mini view or a pinned slot. Settings only, like the pins. */
export function showsInPinRow(card: CardDefinition): boolean {
  return (card.mini === true && !card.builtIn) || pinnedSlotIds(card).length > 0;
}

/**
 * Whether a card shows in the pin row on a task: by settings, except that
 * Confidence waits for a rating, like its card.
 */
export function showsInPinRowOn(task: Pick<CardTaskState, 'cards'>) {
  return (card: CardDefinition): boolean =>
    showsInPinRow(card) && (card.builtIn !== 'confidence' || !!task.cards?.[card.id]);
}

/** The mini view: the card's name and the summary its card line would show. */
function miniPin(card: CardDefinition, task: CardTaskState): Pin {
  const values = task.cards?.[card.id];
  const faded = areCardValuesOutdated(values, task.codeFingerprint);
  return {
    key: `${card.id}:mini`,
    label: card.name,
    text: cardSummary(card, values) || '–',
    warn: cardNeedsAttention(card, values, faded),
    faded,
    mini: true,
  };
}

function pinText(slot: SlotDefinition, value: SlotValue): string {
  if (value.type === 'score') return String(value.score);
  if (value.type === 'stat') return formatNumber(value.value);
  return slotSummary(slot, value);
}

function slotPins(card: CardDefinition, task: CardTaskState): Pin[] {
  const values = task.cards?.[card.id];
  const faded = areCardValuesOutdated(values, task.codeFingerprint);
  const pinned = pinnedSlotIds(card);
  return card.slots
    .filter((slot) => pinned.includes(slot.id))
    .flatMap((slot): Pin[] => {
      const value = valueFor(slot, values);
      // A score list pins each of its scores, in the order its card shows them.
      if (value?.type === 'scores')
        return inConfidenceOrder(value.scores).map((entry, index) => ({
          key: `${card.id}:${slot.id}:${index}`,
          label: entry.label,
          text: String(entry.score),
          warn: !faded && scoreWarns(slot, entry.score),
          faded,
        }));
      return [
        {
          key: `${card.id}:${slot.id}`,
          label: slot.type === 'line' || slot.type === 'text' ? '' : slot.label,
          text: value ? pinText(slot, value) : '–',
          warn: !faded && !!value && slotWarns(slot, value),
          faded,
        },
      ];
    });
}

/**
 * Each card's pinned values, for the pin row. Confidence is left out until the
 * task has a rating, like its card; other cards show "–" while empty.
 */
export function pinGroups(cards: readonly CardDefinition[], task: CardTaskState): PinGroup[] {
  return cards.filter(showsInPinRowOn(task)).map((card) => ({
    card,
    pins: [...(card.mini && !card.builtIn ? [miniPin(card, task)] : []), ...slotPins(card, task)],
  }));
}
