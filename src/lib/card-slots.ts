/**
 * Card slots: the typed elements a card's layout is made of, and validation of
 * the values that fill them. Every value is checked against its slot and
 * clipped; malformed values are dropped rather than shown. See docs/cards.md.
 */

export const SLOT_TYPES = [
  'line',
  'text',
  'score',
  'scores',
  'stat',
  'items',
  'checklist',
  'status',
] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export interface SlotDefinition {
  /** What model, agent or script output keys refer to. */
  id: string;
  type: SlotType;
  label: string;
  /** Per-slot instruction for model cards. */
  hint?: string;
  /** score, scores: warning colour only below this. */
  warnBelow?: number;
  /** stat: warning colour only above this. */
  limit?: number;
  /** items: each run's items are added to the earlier ones instead of replacing them. */
  addUp?: boolean;
  /**
   * Left out of the card itself (its body, summary and attention) but still
   * filled, stored and pinnable; the Confidence card keeps its findings here
   * for the Finish review and the merge check.
   */
  hidden?: boolean;
}

export type ItemSeverity = 'info' | 'warn' | 'block';
export type ChecklistState = 'done' | 'current' | 'todo';
export type StatusState = 'ok' | 'warn' | 'fail' | 'running' | 'unknown';

export interface CardItem {
  text: string;
  severity: ItemSeverity;
  file?: string;
  /** A short label at the end of the row, e.g. the score a finding lowers. */
  tag?: string;
  /** A second, quieter line, e.g. what happened before a change. */
  detail?: string;
  /** Add-up mode: the turn the run that added it belongs to. */
  turn?: number;
}
/** One score of a score list; each carries its own name, as a rater names them. */
export interface ScoreEntry {
  label: string;
  score: number;
  why: string;
  /** What the rater checked directly that backs the score. */
  verified?: string[];
}
export interface ChecklistEntry {
  text: string;
  state: ChecklistState;
}
export interface StatusRow {
  state: StatusState;
  text: string;
  value?: string;
}

export type SlotValue =
  | { type: 'line'; text: string }
  | { type: 'text'; text: string }
  | { type: 'score'; score: number; why: string }
  | { type: 'scores'; scores: ScoreEntry[] }
  | { type: 'stat'; value: number; unit: string; limit?: number }
  | { type: 'items'; items: CardItem[] }
  | { type: 'checklist'; items: ChecklistEntry[] }
  | { type: 'status'; rows: StatusRow[] };

export const SLOT_LIMITS = {
  // 240 holds the question a confidence_publish payload may carry.
  line: 240,
  text: 2_000,
  why: 240,
  unit: 16,
  // 10, 240 and 310 hold every finding a confidence_publish payload may carry, and its
  // key line as "path:line".
  items: 10,
  addUpItems: 20,
  itemText: 240,
  file: 310,
  tag: 60,
  detail: 200,
  scores: 6,
  scoreLabel: 32,
  verified: 3,
  verifiedText: 120,
  checklist: 12,
  status: 8,
  statusText: 120,
  statusValue: 60,
  label: 40,
  hint: 200,
  slotId: 32,
  slots: 8,
} as const;

const SEVERITIES: readonly ItemSeverity[] = ['info', 'warn', 'block'];
const CHECKLIST_STATES: readonly ChecklistState[] = ['done', 'current', 'todo'];
const STATUS_STATES: readonly StatusState[] = ['ok', 'warn', 'fail', 'running', 'unknown'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One line of plain text: whitespace collapsed, clipped. */
export function clipLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clipBlock(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trimEnd().slice(0, max) : '';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((entry) => entry === value);
}

/** Accepts a bare value or an object carrying it under `key`. */
function unwrap(raw: unknown, key: string): { main: unknown; rest: Record<string, unknown> } {
  return isRecord(raw) ? { main: raw[key], rest: raw } : { main: raw, rest: {} };
}

/** `keepTurn`: an add-up slot's stored items carry their turn; anything else is stray input. */
function parseItem(raw: unknown, keepTurn: boolean): CardItem | undefined {
  const { main, rest } = unwrap(raw, 'text');
  const text = clipLine(main, SLOT_LIMITS.itemText);
  if (!text) return undefined;
  const file = clipLine(rest.file, SLOT_LIMITS.file);
  const tag = clipLine(rest.tag, SLOT_LIMITS.tag);
  const detail = clipLine(rest.detail, SLOT_LIMITS.detail);
  const turn = finite(rest.turn);
  return {
    text,
    severity: pick(rest.severity, SEVERITIES) ?? 'info',
    ...(file && { file }),
    ...(tag && { tag }),
    ...(detail && { detail }),
    ...(keepTurn && turn !== undefined && turn >= 0 && { turn: Math.floor(turn) }),
  };
}

function parseScoreEntry(raw: unknown): ScoreEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const label = clipLine(raw.label, SLOT_LIMITS.scoreLabel);
  const score = finite(raw.score);
  if (!label || score === undefined || score < 0 || score > 100) return undefined;
  const verified = Array.isArray(raw.verified)
    ? raw.verified
        .map((entry) => clipLine(entry, SLOT_LIMITS.verifiedText))
        .filter(Boolean)
        .slice(0, SLOT_LIMITS.verified)
    : [];
  return {
    label,
    score: Math.round(score),
    why: clipLine(raw.why, SLOT_LIMITS.why),
    ...(verified.length && { verified }),
  };
}

function parseChecklistEntry(raw: unknown): ChecklistEntry | undefined {
  const { main, rest } = unwrap(raw, 'text');
  const text = clipLine(main, SLOT_LIMITS.itemText);
  return text ? { text, state: pick(rest.state, CHECKLIST_STATES) ?? 'todo' } : undefined;
}

function parseStatusRow(raw: unknown): StatusRow | undefined {
  if (!isRecord(raw)) return undefined;
  const text = clipLine(raw.text, SLOT_LIMITS.statusText);
  const state = pick(raw.state, STATUS_STATES);
  if (!text || !state) return undefined;
  const value = clipLine(raw.value, SLOT_LIMITS.statusValue);
  return { state, text, ...(value && { value }) };
}

/**
 * A list slot's entries. An empty list is a real answer ("nothing found");
 * a non-list, or a list whose entries are all malformed, is no value.
 */
function parseList<T>(
  raw: unknown,
  parse: (entry: unknown) => T | undefined,
  max: number,
): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .map(parse)
    .filter((entry): entry is T => entry !== undefined)
    .slice(0, max);
  return list.length || !raw.length ? list : undefined;
}

/**
 * Validates one slot's raw value. Lists may arrive bare or wrapped in an
 * object; a score or stat may be a bare number. Returns undefined when nothing
 * usable is left, so the slot shows its placeholder instead.
 */
export function parseSlotValue(slot: SlotDefinition, raw: unknown): SlotValue | undefined {
  switch (slot.type) {
    case 'line': {
      const text = clipLine(unwrap(raw, 'text').main, SLOT_LIMITS.line);
      return text ? { type: 'line', text } : undefined;
    }
    case 'text': {
      const text = clipBlock(unwrap(raw, 'text').main, SLOT_LIMITS.text);
      return text.trim() ? { type: 'text', text } : undefined;
    }
    case 'score': {
      const { main, rest } = unwrap(raw, 'score');
      const score = finite(main);
      if (score === undefined || score < 0 || score > 100) return undefined;
      return { type: 'score', score: Math.round(score), why: clipLine(rest.why, SLOT_LIMITS.why) };
    }
    case 'scores': {
      // A score list is never empty: no scores is no rating, not a result.
      const scores = parseList(unwrap(raw, 'scores').main, parseScoreEntry, SLOT_LIMITS.scores);
      return scores?.length ? { type: 'scores', scores } : undefined;
    }
    case 'stat': {
      const { main, rest } = unwrap(raw, 'value');
      const value = finite(main);
      if (value === undefined) return undefined;
      const limit = finite(rest.limit);
      return {
        type: 'stat',
        value,
        unit: clipLine(rest.unit, SLOT_LIMITS.unit),
        ...(limit !== undefined && limit > 0 && { limit }),
      };
    }
    case 'items': {
      const max = slot.addUp ? SLOT_LIMITS.addUpItems : SLOT_LIMITS.items;
      const keepTurn = !!slot.addUp;
      const items = parseList(unwrap(raw, 'items').main, (e) => parseItem(e, keepTurn), max);
      return items && { type: 'items', items };
    }
    case 'checklist': {
      const items = parseList(
        unwrap(raw, 'items').main,
        parseChecklistEntry,
        SLOT_LIMITS.checklist,
      );
      return items && { type: 'checklist', items };
    }
    case 'status': {
      const rows = parseList(unwrap(raw, 'rows').main, parseStatusRow, SLOT_LIMITS.status);
      return rows && { type: 'status', rows };
    }
  }
}

/** A stored value read back: valid only when it still matches its slot's type. */
export function restoreSlotValue(slot: SlotDefinition, raw: unknown): SlotValue | undefined {
  if (!isRecord(raw) || raw.type !== slot.type) return undefined;
  const { type: _type, ...rest } = raw;
  const inner: Record<SlotType, unknown> = {
    line: rest.text,
    text: rest.text,
    score: rest,
    scores: rest.scores,
    stat: rest,
    items: rest.items,
    checklist: rest.items,
    status: rest.rows,
  };
  return parseSlotValue(slot, inner[slot.type]);
}

const SLOT_ID = /^[a-z0-9][a-z0-9-_]*$/i;

/** Restores one slot definition; anything malformed is dropped. */
export function restoreSlotDefinition(raw: unknown): SlotDefinition | undefined {
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, SLOT_LIMITS.slotId) : '';
  const type = pick(raw.type, SLOT_TYPES);
  if (!SLOT_ID.test(id) || !type) return undefined;
  const label = clipLine(raw.label, SLOT_LIMITS.label) || id;
  const hint = clipLine(raw.hint, SLOT_LIMITS.hint);
  const warnBelow = finite(raw.warnBelow);
  const limit = finite(raw.limit);
  return {
    id,
    type,
    label,
    ...(hint && { hint }),
    ...((type === 'score' || type === 'scores') && warnBelow !== undefined && { warnBelow }),
    ...(type === 'stat' && limit !== undefined && { limit }),
    ...(type === 'items' && raw.addUp === true && { addUp: true }),
    ...(raw.hidden === true && { hidden: true }),
  };
}

/** Restores a layout: valid slots in order, unique ids, at most eight. */
export function restoreSlots(raw: unknown): SlotDefinition[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const slots: SlotDefinition[] = [];
  for (const entry of raw) {
    const slot = restoreSlotDefinition(entry);
    if (!slot || seen.has(slot.id)) continue;
    seen.add(slot.id);
    slots.push(slot);
    if (slots.length === SLOT_LIMITS.slots) break;
  }
  return slots;
}

const itemKey = (item: CardItem) => item.text.trim().toLowerCase();

function addUpItems(previous: CardItem[], fresh: CardItem[], turn: number): CardItem[] {
  const seen = new Set(previous.map(itemKey));
  const added: CardItem[] = [];
  for (const item of fresh) {
    if (seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    added.push({ ...item, turn });
  }
  return [...added, ...previous].slice(0, SLOT_LIMITS.addUpItems);
}

/**
 * One run's values over the previous ones: add-up item slots gain the run's
 * new items, tagged with `turn`; every other slot is replaced, and one the run
 * left out goes empty.
 */
export function mergeRunValues(
  slots: readonly SlotDefinition[],
  previous: Record<string, SlotValue> | undefined,
  fresh: Record<string, SlotValue>,
  turn: number,
): Record<string, SlotValue> {
  const merged: Record<string, SlotValue> = {};
  for (const slot of slots) {
    const next = fresh[slot.id];
    const before = previous?.[slot.id];
    if (slot.addUp && slot.type === 'items') {
      const old = before?.type === 'items' ? before.items : [];
      const items = addUpItems(old, next?.type === 'items' ? next.items : [], turn);
      // A run that found nothing still answers, so the slot reads None, not –.
      if (items.length || next?.type === 'items') merged[slot.id] = { type: 'items', items };
    } else if (next) merged[slot.id] = next;
  }
  return merged;
}
