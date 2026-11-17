/**
 * Cards: named definitions of a fixed slot layout, filled by one source (a
 * model, the agent, a project check or facts the app has). Pure helpers for
 * the definitions and restoring persisted data. See docs/cards.md.
 */

import { CARD_ID_PATTERN, CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import { BRIEF_MODELS, type BriefModelId } from '../../electron/shared/task-name-model';
import {
  SLOT_TYPES,
  clipLine,
  isRecord,
  restoreSlotValue,
  restoreSlots,
  type SlotDefinition,
  type SlotValue,
} from './card-slots';

export type CardModelId = BriefModelId;
export type ModelInput = 'task-name' | 'prompts' | 'agent-message' | 'diff';
export type ModelTrigger = 'after-turn' | 'manual' | 'finish';
export type CheckTrigger = 'manual' | 'finish' | 'after-turn';
export const APP_FACTS = [
  'plan',
  'diff-size',
  'branch-health',
  'activity',
  'commits',
  'remote-branch',
  'ci',
] as const;
export type AppFactId = (typeof APP_FACTS)[number];

export type CardSource =
  | {
      kind: 'model';
      model: CardModelId | 'default';
      prompt: string;
      inputs: ModelInput[];
      /** Also run this project check and let the model read its output. */
      checkId?: string;
      trigger: ModelTrigger;
    }
  | { kind: 'agent' }
  | { kind: 'check'; checkId: string; mode: 'exit-code' | 'json'; trigger: CheckTrigger }
  | { kind: 'app'; fact: AppFactId };

export interface CardDefinition {
  /** Stable, [a-z0-9-]. */
  id: string;
  name: string;
  /** The user's own words; regenerates the layout when edited. */
  description: string;
  /** Built-in: values live in the task's own storage, not `task.cards`; never deleted. */
  builtIn?: 'confidence';
  source: CardSource;
  /** Ordered, at most eight. */
  slots: SlotDefinition[];
  /** Global default. */
  enabled: boolean;
  /** Per-project override of `enabled`, keyed by project id. */
  projects?: Record<string, boolean>;
  /** Slot ids shown in the pin row (global, not per project). */
  pinned?: string[];
  /** Shows the card's one-line summary in the pin row, below the task title bar. Not for Confidence, whose pin already is one. */
  mini?: boolean;
  showAtFinish?: boolean;
  /** Leaves the card out of the cards pane and popover until it has values. Opt in; not for cards that fill only when run. Confidence always hides until rated. */
  hideEmpty?: boolean;
}

/** One run's output for a card on a task. */
export interface CardValues {
  values: Record<string, SlotValue>;
  /** When the run captured its inputs. */
  at: number;
  /** Code fingerprint the values were made from, so they can go outdated. */
  fingerprint?: string;
  /** Model cards: the agent reply the run read, so a new reply counts as news. */
  replyFingerprint?: string;
}

/**
 * Whether a card fills without the user pressing Run, so hiding it until it
 * has values cannot leave it hidden for good.
 */
export function fillsOnItsOwn(source: CardSource): boolean {
  return !('trigger' in source) || source.trigger !== 'manual';
}

/** AI cards send task content to a provider; non-AI ones stay on this machine. */
export function cardKind(source: CardSource): 'ai' | 'non-ai' {
  return source.kind === 'model' || source.kind === 'agent' ? 'ai' : 'non-ai';
}

export const CARD_LIMITS = {
  name: 40,
  description: 1_000,
  prompt: 4_000,
  id: 40,
  cards: 40,
} as const;

/**
 * The built-in Confidence card. Its ratings stay in `task.confidence`, shown as
 * they are today, so it has no generic slots.
 */
export function confidenceCard(enabled: boolean): CardDefinition {
  return {
    id: CONFIDENCE_CARD_ID,
    name: 'Confidence',
    description: 'Ratings from the agent or the Finish review.',
    builtIn: 'confidence',
    source: { kind: 'agent' },
    slots: [],
    enabled,
  };
}

/** What the Confidence card pins: its scores, as the pin row's first group. */
export const CONFIDENCE_PIN = 'scores';

/** Slots a card can pin; Confidence pins its scores as one group. */
export function pinnableSlots(card: CardDefinition): { id: string; label: string }[] {
  if (card.builtIn === 'confidence') return [{ id: CONFIDENCE_PIN, label: 'Scores' }];
  return card.slots.map(({ id, label }) => ({ id, label }));
}

/**
 * A free card id made from `base` (a name or check id): lower-case, dashes,
 * at most CARD_LIMITS.id characters, numbered when taken. Never `confidence`,
 * which restore treats as the built-in card.
 */
export function freeCardId(base: string, taken: ReadonlySet<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'card';
  const used = (id: string) => taken.has(id) || id === CONFIDENCE_CARD_ID;
  let id = slug.slice(0, CARD_LIMITS.id).replace(/-+$/, '');
  for (let n = 2; used(id); n++) {
    const suffix = `-${n}`;
    id = `${slug.slice(0, CARD_LIMITS.id - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  return id;
}

/** A card's per-project overrides with one project set; matching the global default drops it. */
export function withProjectSetting(
  card: Pick<CardDefinition, 'enabled' | 'projects'>,
  projectId: string,
  on: boolean,
): Record<string, boolean> | undefined {
  const rest = Object.entries(card.projects ?? {}).filter(([id]) => id !== projectId);
  if (on !== card.enabled) rest.push([projectId, on]);
  return rest.length ? Object.fromEntries(rest) : undefined;
}

/** Card settings as saved. */
export function persistCardDefinitions(cards: readonly CardDefinition[]): unknown[] {
  // A JSON copy, since the store hands out proxies that structuredClone rejects.
  return cards.map((card) => JSON.parse(JSON.stringify(card)) as unknown);
}

function restoreProjects(raw: unknown): Record<string, boolean> | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function restorePinned(raw: unknown, slotIds: readonly string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pinned = [...new Set(raw.filter((id): id is string => typeof id === 'string'))].filter(
    (id) => slotIds.includes(id),
  );
  return pinned.length ? pinned : undefined;
}

const MODEL_INPUTS: readonly ModelInput[] = ['task-name', 'prompts', 'agent-message', 'diff'];
const TRIGGERS: readonly ModelTrigger[] = ['after-turn', 'manual', 'finish'];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((entry) => entry === value);
}

function restoreCheckId(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, 200) : '';
}

/** Restores a card's source; undefined when it names nothing this app can run. */
export function restoreCardSource(raw: unknown): CardSource | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'agent':
      return { kind: 'agent' };
    case 'app': {
      const fact = pick(raw.fact, APP_FACTS);
      return fact && { kind: 'app', fact };
    }
    case 'check': {
      const checkId = restoreCheckId(raw.checkId);
      if (!checkId) return undefined;
      const mode = raw.mode === 'json' ? 'json' : 'exit-code';
      return { kind: 'check', checkId, mode, trigger: pick(raw.trigger, TRIGGERS) ?? 'manual' };
    }
    case 'model': {
      const model =
        raw.model === 'default' || !Object.hasOwn(BRIEF_MODELS, String(raw.model))
          ? 'default'
          : (raw.model as CardModelId);
      const inputs = Array.isArray(raw.inputs)
        ? MODEL_INPUTS.filter((input) => (raw.inputs as unknown[]).includes(input))
        : [];
      const checkId = restoreCheckId(raw.checkId);
      return {
        kind: 'model',
        model,
        prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, CARD_LIMITS.prompt) : '',
        inputs,
        ...(checkId && { checkId }),
        trigger: pick(raw.trigger, TRIGGERS) ?? 'after-turn',
      };
    }
    default:
      return undefined;
  }
}

function restoreCard(raw: Record<string, unknown>, id: string): CardDefinition | undefined {
  if (id === CONFIDENCE_CARD_ID) {
    const projects = restoreProjects(raw.projects);
    const pinned = restorePinned(raw.pinned, [CONFIDENCE_PIN]);
    return {
      ...confidenceCard(raw.enabled === true),
      ...(projects && { projects }),
      ...(pinned && { pinned }),
    };
  }
  const source = restoreCardSource(raw.source);
  const slots = restoreSlots(raw.slots);
  if (!source || slots.length === 0) return undefined;
  const projects = restoreProjects(raw.projects);
  const pinned = restorePinned(
    raw.pinned,
    slots.map((slot) => slot.id),
  );
  return {
    id,
    name: clipLine(raw.name, CARD_LIMITS.name) || id,
    description:
      typeof raw.description === 'string' ? raw.description.slice(0, CARD_LIMITS.description) : '',
    source,
    slots,
    enabled: raw.enabled === true,
    ...(projects && { projects }),
    ...(pinned && { pinned }),
    ...(raw.mini === true && { mini: true }),
    ...(raw.showAtFinish === true && { showAtFinish: true }),
    ...(raw.hideEmpty === true && { hideEmpty: true }),
  };
}

/**
 * Restores card definitions in their saved order; malformed and duplicate
 * entries are dropped. A missing Confidence card is added switched off, so
 * an existing install's header only changes when the user turns it on.
 */
export function restoreCardDefinitions(raw: unknown): CardDefinition[] {
  const cards: CardDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw.slice(0, CARD_LIMITS.cards) : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.slice(0, CARD_LIMITS.id);
    if (!CARD_ID_PATTERN.test(id) || seen.has(id)) continue;
    const card = restoreCard(entry, id);
    if (!card) continue;
    seen.add(id);
    cards.push(card);
  }
  return seen.has(CONFIDENCE_CARD_ID) ? cards : [confidenceCard(false), ...cards];
}

/**
 * Restores a task's card values. Each value is checked against the type it
 * was stored with; whether it still fits the card's current layout is decided
 * when it is shown, so restore does not depend on settings loading first.
 */
export function restoreTaskCards(raw: unknown): Record<string, CardValues> | undefined {
  if (!isRecord(raw)) return undefined;
  const cards: Record<string, CardValues> = {};
  for (const [cardId, entry] of Object.entries(raw).slice(0, CARD_LIMITS.cards)) {
    if (!CARD_ID_PATTERN.test(cardId) || !isRecord(entry) || !isRecord(entry.values)) continue;
    const values: Record<string, SlotValue> = {};
    for (const [slotId, value] of Object.entries(entry.values)) {
      const type = isRecord(value) ? pick(value.type, SLOT_TYPES) : undefined;
      const restored =
        type && restoreSlotValue({ id: slotId, type, label: '', addUp: true }, value);
      if (restored) values[slotId] = restored;
    }
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0;
    cards[cardId] = {
      values,
      at,
      ...(typeof entry.fingerprint === 'string' && { fingerprint: entry.fingerprint.slice(0, 64) }),
      ...(typeof entry.replyFingerprint === 'string' && {
        replyFingerprint: entry.replyFingerprint.slice(0, 64),
      }),
    };
  }
  return Object.keys(cards).length ? cards : undefined;
}
