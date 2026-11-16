/**
 * The `card_publish` request as it crosses from the MCP server to the
 * renderer. Only its shape is checked here; card definitions live in the
 * renderer, which checks the values against the card's slots.
 */

/** The built-in Confidence card, whose values are a confidence_publish payload. */
export const CONFIDENCE_CARD_ID = 'confidence';

/** A card id: lower-case letters, digits and dashes. */
export const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CARD_ID_MAX = 40;

/** The overall ceiling on a published payload; each slot's own limit is lower. */
export const CARD_PUBLISH_MAX_BYTES = 32 * 1024;

export interface CardPublishRequest {
  card: string;
  values: Record<string, unknown>;
}

/** Checks a `card_publish` request's shape; throws with a message for the agent. */
export function parseCardPublishRequest(value: unknown): CardPublishRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('card_publish takes {card, values}.');
  const { card, values } = value as Record<string, unknown>;
  if (typeof card !== 'string' || card.length > CARD_ID_MAX || !CARD_ID_PATTERN.test(card))
    throw new Error('"card" must be a card id from card_list.');
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('"values" must be an object keyed by slot id.');
  return { card, values: values as Record<string, unknown> };
}
