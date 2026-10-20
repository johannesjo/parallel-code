/** Tours analyze whole changes; inline code questions keep their shorter timeout. */
export const CHANGE_TOUR_TIMEOUT_MS = 5 * 60_000;
// Separate app guard for whole-change tours, including instructions/JSON escaping.
// This is a character budget, not an exact token count. The providers' context
// limits are token-based (MiniMax M2.7: 204,800; Sonnet: 200k or more).
export const CHANGE_TOUR_PROMPT_LIMIT = 500_000;
