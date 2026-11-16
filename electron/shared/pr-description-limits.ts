/** A PR draft reads prompts, commits and a diff excerpt; waiting longer than this is not worth it. */
export const PR_DESCRIPTION_TIMEOUT_MS = 2 * 60_000;
/**
 * Character budget for one PR draft request: the diff excerpt, the prompts,
 * the commits and the repo's PR template, plus instructions.
 */
export const PR_DESCRIPTION_PROMPT_LIMIT = 90_000;
