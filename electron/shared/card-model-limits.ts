/** A card run reads one turn; waiting longer than this is not worth it. */
export const CARD_MODEL_TIMEOUT_MS = 2 * 60_000;
/**
 * Character budget for one card request: the diff excerpt, the agent's last
 * message, the prompts of the turn, a check's output and the previous values,
 * plus instructions.
 */
export const CARD_MODEL_PROMPT_LIMIT = 90_000;
/** Drafting a layout reads only a short description. */
export const CARD_LAYOUT_TIMEOUT_MS = 60_000;
export const CARD_LAYOUT_PROMPT_LIMIT = 12_000;
