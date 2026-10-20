/** A brief summarises one finished turn; waiting longer than this is not worth it. */
export const TASK_BRIEF_TIMEOUT_MS = 2 * 60_000;
/**
 * Character budget for one brief request: the diff excerpt, the agent's last
 * message, the prompts of the turn and the previous brief, plus instructions.
 */
export const TASK_BRIEF_PROMPT_LIMIT = 90_000;
