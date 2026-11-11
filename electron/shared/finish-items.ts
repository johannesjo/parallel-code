/**
 * Loose ends a task's agent records through the `finish_items_publish` MCP tool,
 * such as a temporary flag to remove, so the Finish dialog can send them back
 * to it before the task is merged. Shared by the MCP server, the remote route
 * and the renderer, which each check them again.
 */

export const FINISH_ITEMS_LIMITS = {
  maxItems: 8,
  item: 200,
  /** All items at their limits as JSON, with room for escaping. */
  payloadBytes: 16 * 1024,
} as const;

/**
 * Reads a published list: each item collapsed to one trimmed line, blanks and
 * case-insensitive duplicates dropped. An empty list is valid and clears the
 * task's items. Throws on a malformed payload or limits exceeded, so the agent
 * learns to shorten or prioritize instead of losing items silently.
 */
export function parseFinishItems(value: unknown): string[] {
  const items =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(items)) throw new Error('Finish items must be an object {items: string[]}.');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new Error('Each finish item must be a string.');
    const line = item.replace(/\s+/g, ' ').trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    if (line.length > FINISH_ITEMS_LIMITS.item)
      throw new Error(`Each finish item must be at most ${FINISH_ITEMS_LIMITS.item} characters.`);
    seen.add(line.toLowerCase());
    result.push(line);
  }
  if (result.length > FINISH_ITEMS_LIMITS.maxItems)
    throw new Error(
      `At most ${FINISH_ITEMS_LIMITS.maxItems} finish items; keep only what must happen before merge.`,
    );
  return result;
}
