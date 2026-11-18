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
import { LOW_CONFIDENCE_SCORE } from './task-confidence';

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
  /** Built-in: never deleted, its source stays the agent, and the app's reviewer fills it too. */
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
  /** Who filled it, when the publisher named itself, e.g. a skill name. */
  source?: string;
  /** `review`: the app's own reviewer wrote it, not the task's agent rating itself. */
  origin?: 'review';
  /** The commit a review read, set only when the worktree had no uncommitted changes. */
  headSha?: string;
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
 * The Confidence card's layout as shipped. Slot ids are the field names of a
 * confidence_publish payload, so that payload maps onto them one to one. Only
 * the scores show in the card; the rest feed the Finish review and the merge
 * check, and the user can show, move, relabel or remove any of them.
 */
export function defaultConfidenceSlots(): SlotDefinition[] {
  return [
    {
      id: 'scores',
      type: 'scores',
      label: 'Scores',
      warnBelow: LOW_CONFIDENCE_SCORE,
      hint: 'Name each score as your rating defines it; why: what keeps it from being higher; verified: what you checked.',
    },
    {
      id: 'findings',
      type: 'items',
      label: 'Findings',
      hidden: true,
      hint: 'block: a confirmed gap or risk; warn: a doubt you did not confirm; info: a change nobody asked for. tag: the score it lowers.',
    },
    {
      id: 'changes',
      type: 'items',
      label: 'What changed',
      hidden: true,
      hint: 'text: what a user notices now; detail: what happened before; tag: the kinds of tests that cover it.',
    },
    {
      id: 'keyLine',
      type: 'items',
      label: 'Read first',
      hidden: true,
      hint: 'One item: why this line matters most, with file as path:line.',
    },
    {
      id: 'asked',
      type: 'line',
      label: 'Asked',
      hidden: true,
      hint: 'What the user asked for, in one sentence.',
    },
  ];
}

/**
 * The built-in Confidence card: an agent card the app's reviewer fills too.
 * Its layout is the user's to edit; `slots` replaces the default one.
 */
export function confidenceCard(enabled: boolean, slots = defaultConfidenceSlots()): CardDefinition {
  return {
    id: CONFIDENCE_CARD_ID,
    name: 'Confidence',
    description: 'Ratings from the agent or the Finish review.',
    builtIn: 'confidence',
    source: { kind: 'agent' },
    slots,
    enabled,
  };
}

/** Slots a card can pin. */
export function pinnableSlots(card: CardDefinition): { id: string; label: string }[] {
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

/**
 * A rating replaces the last one, so its lists never add up; and the merge
 * check never takes a score under 60, so the card warns from there too.
 */
function confidenceSlot(slot: SlotDefinition): SlotDefinition {
  const { addUp: _addUp, ...rest } = slot;
  if (slot.type !== 'scores') return rest;
  return { ...rest, warnBelow: Math.max(LOW_CONFIDENCE_SCORE, slot.warnBelow ?? 0) };
}

function restoreCard(raw: Record<string, unknown>, id: string): CardDefinition | undefined {
  if (id === CONFIDENCE_CARD_ID) {
    // Saved before its layout was editable, it has no slots: it gets the default one.
    const saved = restoreSlots(raw.slots).map(confidenceSlot);
    const card = confidenceCard(raw.enabled === true, saved.length ? saved : undefined);
    const projects = restoreProjects(raw.projects);
    const pinned = restorePinned(
      raw.pinned,
      card.slots.map((slot) => slot.id),
    );
    return {
      ...card,
      name: clipLine(raw.name, CARD_LIMITS.name) || card.name,
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

/** Who filled a card's values, as `CardValues` keeps it; anything malformed is dropped. */
export function restoreValuesOrigin(
  entry: Record<string, unknown>,
): Pick<CardValues, 'source' | 'origin' | 'headSha'> {
  const source = clipLine(entry.source, 60);
  return {
    ...(source && { source }),
    ...(entry.origin === 'review' && { origin: 'review' as const }),
    ...(typeof entry.headSha === 'string' && { headSha: entry.headSha.slice(0, 64) }),
  };
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
      ...restoreValuesOrigin(entry),
    };
  }
  return Object.keys(cards).length ? cards : undefined;
}
