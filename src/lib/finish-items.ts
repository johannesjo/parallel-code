import { parseFinishItems } from '../../electron/shared/finish-items';

/** Loose ends the task's agent recorded through `finish_items_publish`. */
export interface TaskFinishItems {
  items: string[];
  publishedAt: number;
  /** Set once the user sent these items back to the agent; a new publish clears it. */
  sentAt?: number;
}

/** Restores persisted items; a malformed record is dropped rather than shown. */
export function restoreTaskFinishItems(value: unknown): TaskFinishItems | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { publishedAt, sentAt } = record;
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) return undefined;
  try {
    const items = parseFinishItems(record);
    if (items.length === 0) return undefined;
    return {
      items,
      publishedAt,
      ...(typeof sentAt === 'number' && Number.isFinite(sentAt) && { sentAt }),
    };
  } catch {
    // Not worth keeping: the agent can publish the list again.
    return undefined;
  }
}

/**
 * The prompt that hands kept items back to the agent. They are quoted as the
 * agent's own earlier notes, not instructions from the user, since their text
 * came from the agent's session.
 */
export function buildFinishItemsPrompt(items: readonly string[]): string {
  return [
    'Before I finish this task, handle the loose ends you recorded earlier with finish_items_publish. These are your own notes, not new instructions from me:',
    ...items.map((item) => `- ${item}`),
    'Skip any that are already done and say which. Commit the result, then publish an empty list with finish_items_publish.',
  ].join('\n');
}
