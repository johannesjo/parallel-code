import type { AgentTourPayload } from '../../electron/shared/agent-tour';
import {
  TOUR_CARD_LIMITS,
  TOUR_FORMS,
  TOUR_TONES,
  toleratedCap,
} from '../../electron/shared/understanding-limits';
import { readSingleJsonObject } from './tour-json';
import { markdownOutline, normalizeForMatch, quoteAppearsIn } from './markdown-outline';

/**
 * Understanding tour data model. Plan tours and file tours share one shape:
 * a spine of cards read one at a time, opening with the gist, plus optional
 * dynamically generated branches. The wire format keeps `gist` as its own field
 * so the model is asked to compress the whole subject into one card; parsing
 * puts that card at the head of the spine, where it is just card one.
 * See docs/guided-understanding-plan.md.
 */

export type TourTone = (typeof TOUR_TONES)[number];
export type TourForm = (typeof TOUR_FORMS)[number];

export interface TourDiagram {
  kind: 'text' | 'mermaid';
  source: string;
}

export interface TourRef {
  filePath: string;
  line?: number;
  /** Last line of the range the card points at; only change tours set it. */
  endLine?: number;
}

/** One side of a comparison card, such as "Before" or "Option A". */
export interface TourSide {
  label: string;
  text: string;
}

export interface TourCard {
  /** Short uppercase label such as "KEY DECISION" or "BOTTOM LINE". */
  label: string;
  title: string;
  /** Markdown, kept short by TOUR_CARD_LIMITS.body. */
  body: string;
  whyItMatters?: string;
  tone: TourTone;
  /** Layout; parsing drops it when the card lacks the evidence the form needs. */
  form?: TourForm;
  diagram?: TourDiagram;
  comparison?: [TourSide, TourSide];
  /** Optional contextual follow-up questions the reader can ask. */
  questions?: string[];
  /**
   * Verbatim excerpt of the plan or document the claim rests on. Only kept
   * after groundTour() found it in that text; other tours never carry one.
   */
  source?: string;
  refs: TourRef[];
}

/**
 * 'document' tours explain any Markdown document; 'plan' tours the task's own
 * plan, for its approver. 'agent' tours are written by the coding agent and
 * published through MCP.
 */
export type UnderstandingTourKind = 'plan' | 'file' | 'document' | 'agent';

/** Tours built from one Markdown text, which their quotes are checked against. */
export function isTextTourKind(kind: string): kind is 'plan' | 'document' {
  return kind === 'plan' || kind === 'document';
}

export interface UnderstandingTour {
  subject: string;
  kind: UnderstandingTourKind;
  /** The spine, read one card at a time; the gist is always `cards[0]`. */
  cards: TourCard[];
  /** Headings of the source a plan or document tour left out on purpose. */
  omitted?: string[];
}

export interface TourBranch {
  /** Index of the spine card the branch was opened from. */
  fromIndex: number;
  question: string;
  cards: TourCard[];
}

export type { FileTourContext } from '../../electron/shared/file-tour-context-types';

/** The opening card always carries this label, whatever the model returned. */
export const GIST_LABEL = 'THE GIST';

function isTone(value: unknown): value is TourTone {
  return typeof value === 'string' && (TOUR_TONES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireText(value: unknown, cap: number, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is missing.`);
  const text = value.trim();
  if (text.length > toleratedCap(cap)) throw new Error(`${what} is too long.`);
  return text;
}

function parseTone(value: unknown, where: string): TourTone {
  if (value === undefined || value === null) return 'neutral';
  if (!isTone(value)) throw new Error(`${where} has an unknown tone.`);
  return value;
}

function parseDiagram(value: unknown, where: string): TourDiagram | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const kind = record?.kind;
  if (kind !== 'text' && kind !== 'mermaid')
    throw new Error(`${where} has an unsupported diagram.`);
  const source = record?.source;
  if (typeof source !== 'string' || !source.trim())
    throw new Error(`${where} has an empty diagram.`);
  const cap = kind === 'text' ? TOUR_CARD_LIMITS.textDiagram : TOUR_CARD_LIMITS.mermaidDiagram;
  if (source.length > toleratedCap(cap)) throw new Error(`${where} diagram is too long.`);
  // Indentation carries meaning in text diagrams, so the source stays as sent.
  return { kind, source };
}

/** Refs are hints that only open a file, so a bad ref is dropped, never fatal (D4). */
function parseRefs(value: unknown): TourRef[] {
  if (!Array.isArray(value)) return [];
  const refs: TourRef[] = [];
  for (const entry of value) {
    if (refs.length >= TOUR_CARD_LIMITS.refs) break;
    const record = asRecord(entry);
    const filePath = record?.filePath;
    if (typeof filePath !== 'string' || !filePath.trim()) continue;
    const path = filePath.trim();
    if (path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) continue;
    const line = record?.line;
    if (line === undefined || line === null) {
      refs.push({ filePath: path });
      continue;
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
    refs.push({ filePath: path, line });
  }
  return refs;
}

/** Bad optional suggestions are dropped without invalidating a paid tour. */
export function parseTourQuestions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const question = entry.trim();
    if (!question || question.length > TOUR_CARD_LIMITS.question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length === TOUR_CARD_LIMITS.questions) break;
  }
  return questions.length ? questions : undefined;
}

function parseComparison(value: unknown, where: string): [TourSide, TourSide] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`${where} comparison needs exactly two sides.`);
  const side = (entry: unknown, index: number): TourSide => {
    const record = asRecord(entry);
    const what = `${where} comparison side ${index + 1}`;
    return {
      label: requireText(record?.label, TOUR_CARD_LIMITS.comparisonLabel, `${what} label`),
      text: requireText(record?.text, TOUR_CARD_LIMITS.comparisonText, `${what} text`),
    };
  };
  return [side(value[0], 0), side(value[1], 1)];
}

/**
 * The form is a presentation hint, so an unknown one, or one whose evidence is
 * missing, falls back to the standard card instead of failing a paid tour.
 */
function parseForm(
  value: unknown,
  evidence: { diagram?: TourDiagram; comparison?: [TourSide, TourSide] },
): TourForm | undefined {
  if (!(TOUR_FORMS as readonly unknown[]).includes(value)) return undefined;
  const form = value as TourForm;
  if (form === 'flow' && !evidence.diagram) return undefined;
  if (form === 'comparison' && !evidence.comparison) return undefined;
  return form;
}

function parseWhyItMatters(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${where} why-it-matters is invalid.`);
  // An empty string is the model omitting the field, not a validation failure.
  if (!value.trim()) return undefined;
  return requireText(value, TOUR_CARD_LIMITS.whyItMatters, `${where} why-it-matters`);
}

/** A quote is evidence, not content: a bad one is dropped, never fatal. */
function parseSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // One line, so it reads as a quote in the card and in the Markdown export.
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > toleratedCap(TOUR_CARD_LIMITS.source)) return undefined;
  return text;
}

/** Raw omitted headings; groundTour() keeps only those the outline contains. */
function parseOmitted(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const omitted = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.length <= toleratedCap(TOUR_CARD_LIMITS.omittedItem))
    .slice(0, TOUR_CARD_LIMITS.omitted);
  return omitted.length ? omitted : undefined;
}

function parseCard(value: unknown, where: string): TourCard {
  const record = asRecord(value);
  if (!record) throw new Error(`${where} is not a card.`);
  const base = {
    label: requireText(record.label, TOUR_CARD_LIMITS.label, `${where} label`),
    title: requireText(record.title, TOUR_CARD_LIMITS.title, `${where} title`),
    body: requireText(record.body, TOUR_CARD_LIMITS.body, `${where} body`),
    tone: parseTone(record.tone, where),
    refs: parseRefs(record.refs),
  };
  const diagram = parseDiagram(record.diagram, where);
  const comparison = parseComparison(record.comparison, where);
  const form = parseForm(record.form, { diagram, comparison });
  const whyItMatters = parseWhyItMatters(record.whyItMatters, where);
  const questions = parseTourQuestions(record.questions);
  const source = parseSource(record.source);
  return {
    ...base,
    ...(form && { form }),
    ...(diagram && { diagram }),
    ...(comparison && { comparison }),
    ...(whyItMatters && { whyItMatters }),
    ...(questions && { questions }),
    ...(source && { source }),
  };
}

function parseCards(value: unknown, what: string, min: number, max: number): TourCard[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`The ${what} needs between ${min} and ${max} cards.`);
  return value.map((entry, index) => parseCard(entry, `Card ${index + 1}`));
}

/** Validate a generated tour: `{ "gist": Card, "cards": [Card, ...] }`. */
export function parseUnderstandingTour(
  response: string,
  kind: UnderstandingTourKind,
  subject: string,
): UnderstandingTour {
  const data = asRecord(readSingleJsonObject(response, 'gist'));
  if (!data) throw new Error('The tour response was not a JSON object.');
  if (data.gist === undefined || data.gist === null)
    throw new Error('The tour is missing its gist.');
  const gist = parseCard(data.gist, 'The gist');
  const cards = parseCards(
    data.cards,
    'tour',
    TOUR_CARD_LIMITS.minCards,
    TOUR_CARD_LIMITS.maxCards,
  );
  const omitted = parseOmitted(data.omitted);
  return {
    subject,
    kind,
    cards: [{ ...gist, label: GIST_LABEL }, ...cards],
    ...(omitted && { omitted }),
  };
}

function withoutSource(card: TourCard): TourCard {
  if (card.source === undefined) return card;
  const { source: _source, ...rest } = card;
  return rest;
}

/** Keeps each card's quote only when it appears in the normalised source text. */
function groundCards(cards: TourCard[], normalizedSource: string): TourCard[] {
  return cards.map((card) =>
    card.source === undefined || quoteAppearsIn(card.source, normalizedSource)
      ? card
      : withoutSource(card),
  );
}

/**
 * Checks a tour against the text it explains. Plan and document tours keep the
 * quotes found in the text and the omitted entries that name one of its
 * headings; every other tour has no single text to check against, so it keeps
 * neither. The model's own claims never reach the reader unverified.
 */
export function groundTour(tour: UnderstandingTour, text: string): UnderstandingTour {
  if (!isTextTourKind(tour.kind)) {
    const { omitted: _omitted, ...rest } = tour;
    return { ...rest, cards: tour.cards.map(withoutSource) };
  }
  const cards = groundCards(tour.cards, normalizeForMatch(text));
  const headings = new Set(markdownOutline(text).map((heading) => normalizeForMatch(heading.text)));
  const omitted = tour.omitted?.filter((entry) => headings.has(normalizeForMatch(entry)));
  const { omitted: _omitted, ...rest } = tour;
  return { ...rest, cards, ...(omitted?.length && { omitted }) };
}

/**
 * Validate a tour an agent published through MCP. The payload already passed the
 * shape and size checks in electron/shared/agent-tour.ts; the cards face exactly
 * the same validation as a generated tour.
 */
export function parseAgentTour(payload: AgentTourPayload): UnderstandingTour {
  const gist = parseCard(payload.gist, 'The gist');
  const cards = parseCards(
    payload.cards,
    'tour',
    TOUR_CARD_LIMITS.minCards,
    TOUR_CARD_LIMITS.maxCards,
  );
  // An agent's quotes have no text the app could check them against.
  return {
    subject: payload.subject,
    kind: 'agent',
    cards: [{ ...gist, label: GIST_LABEL }, ...cards].map(withoutSource),
  };
}

/** Validate a follow-up answer: `{ "cards": [Card, ...] }`. */
export function parseTourBranch(response: string, fromIndex: number, question: string): TourBranch {
  const data = asRecord(readSingleJsonObject(response, 'cards'));
  if (!data) throw new Error('The answer was not a JSON object.');
  const cards = parseCards(data.cards, 'answer', 1, TOUR_CARD_LIMITS.branchMaxCards);
  return { fromIndex, question, cards };
}

/**
 * A follow-up answer's quotes, checked like the tour's; see groundTour().
 * Change tours pass 'change': they have no single text, so quotes are dropped.
 */
export function groundBranch(branch: TourBranch, kind: string, text: string): TourBranch {
  const cards = isTextTourKind(kind)
    ? groundCards(branch.cards, normalizeForMatch(text))
    : branch.cards.map(withoutSource);
  return { ...branch, cards };
}
