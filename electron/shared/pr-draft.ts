/**
 * A pull request title and description, drafted by the task's agent through
 * the `pr_draft_publish` MCP tool or by a separate model. Shared by the MCP
 * server, the remote route and the renderer, which each check it again.
 */

export interface PrDraft {
  title: string;
  body: string;
}

export const PR_DRAFT_LIMITS = {
  title: 256,
  body: 20_000,
  /** Both fields at their limits as JSON, with room for escaping. */
  payloadBytes: 128 * 1024,
} as const;

/**
 * Reads a draft: the title collapsed to one line, both fields trimmed and cut
 * to their limits, since the user reviews them before anything is created.
 * Throws when it is not an object or has no title.
 */
export function parsePrDraft(value: unknown): PrDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A pull request draft must be an object {title, body}.');
  }
  const { title, body } = value as Record<string, unknown>;
  const oneLine = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!oneLine) throw new Error('The pull request draft has no title.');
  return {
    title: oneLine.slice(0, PR_DRAFT_LIMITS.title),
    body: typeof body === 'string' ? body.trim().slice(0, PR_DRAFT_LIMITS.body) : '',
  };
}
