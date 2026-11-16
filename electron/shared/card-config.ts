/**
 * A change to the card definitions as it crosses from the MCP server to the
 * renderer. Only its shape is checked here; the definitions live in the
 * renderer, which checks the card itself.
 */

import { CARD_ID_PATTERN } from './card-publish.js';

const CARD_ID_MAX = 40;

/** One card with a full prompt, description and eight slots, with room for multi-byte text. */
export const CARD_CONFIG_MAX_BYTES = 64 * 1024;

export type CardConfigChange =
  | { action: 'save'; card: Record<string, unknown>; position?: number }
  | { action: 'remove'; card: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Checks a card definition change's shape; throws with a message for the agent. */
export function parseCardConfigChange(value: unknown): CardConfigChange {
  const { action, card, position } = isRecord(value) ? value : {};
  if (action === 'remove') {
    if (typeof card !== 'string' || card.length > CARD_ID_MAX || !CARD_ID_PATTERN.test(card))
      throw new Error('"card" must be a card id from card_config_read.');
    return { action, card };
  }
  if (action !== 'save') throw new Error('"action" must be "save" or "remove".');
  if (!isRecord(card)) throw new Error('"card" must be a card definition object.');
  if (position === undefined) return { action, card };
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0)
    throw new Error('"position" must be a place in the display order, counted from 0.');
  return { action, card, position };
}
