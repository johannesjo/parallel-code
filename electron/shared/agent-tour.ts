import { TOUR_CARD_LIMITS } from './understanding-limits.js';

/**
 * Payload of a tour an agent publishes through the `tour_publish` MCP tool.
 * This module only checks shape and size, so the main process can reject junk
 * before it reaches the renderer; the cards themselves are validated there by
 * `parseAgentTour` in src/lib/understanding-tour.ts. Kept free of Node and
 * Electron imports so both sides can use it.
 */
export interface AgentTourPayload {
  subject: string;
  /** One card object; shape checked in the renderer. */
  gist: unknown;
  /** Array of card objects; shape checked in the renderer. */
  cards: unknown;
  /** What the cards summarise, replayed to answer the reader's follow-ups. */
  context?: string;
}

/**
 * Characters, not tokens. `context` is far below UNDERSTANDING_PROMPT_LIMIT
 * because a follow-up prompt inlines it whole alongside the tour, and the
 * payload cap bounds it again.
 */
export const AGENT_TOUR_LIMITS = {
  subject: 120,
  context: 100_000,
  /** Serialized payload cap; the HTTP route caps its body at the same size. */
  payloadChars: 256 * 1024,
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSubject(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('subject is required.');
  const subject = value.trim();
  if (subject.length > AGENT_TOUR_LIMITS.subject)
    throw new Error(`subject must be at most ${AGENT_TOUR_LIMITS.subject} characters.`);
  return subject;
}

function parseContext(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('context must be a string.');
  if (value.length > AGENT_TOUR_LIMITS.context)
    throw new Error(`context must be at most ${AGENT_TOUR_LIMITS.context} characters.`);
  // An empty context is the agent omitting the field, not a failure.
  return value.trim() ? value : undefined;
}

function parseCardObjects(value: unknown): unknown[] {
  const { minCards, maxCards } = TOUR_CARD_LIMITS;
  if (!Array.isArray(value) || value.length < minCards || value.length > maxCards)
    throw new Error(`cards must be an array of ${minCards} to ${maxCards} cards.`);
  value.forEach((card, index) => {
    if (!asRecord(card)) throw new Error(`cards[${index}] must be an object.`);
  });
  return value;
}

export function parseAgentTourPayload(value: unknown): AgentTourPayload {
  const record = asRecord(value);
  if (!record) throw new Error('The tour must be an object.');
  if (!asRecord(record.gist)) throw new Error('gist must be an object.');
  const context = parseContext(record.context);
  const payload: AgentTourPayload = {
    subject: parseSubject(record.subject),
    gist: record.gist,
    cards: parseCardObjects(record.cards),
    ...(context !== undefined && { context }),
  };
  if (JSON.stringify(payload).length > AGENT_TOUR_LIMITS.payloadChars)
    throw new Error(`The tour must be at most ${AGENT_TOUR_LIMITS.payloadChars} characters.`);
  return payload;
}
