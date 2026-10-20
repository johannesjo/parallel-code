import type { ChatDiff, ChatItem } from '../shared/agent-chat-types.js';
import { hunksDiff, replacementDiff, wholeFileDiff } from '../shared/chat-diffs.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The change an edit tool asks to make, readable while it waits for approval or
 * runs. It lacks line numbers and context: the tool call does not carry them.
 */
export function proposedDiffs(
  tool: string,
  input: Record<string, unknown>,
): ChatDiff[] | undefined {
  const path = string(input.file_path);
  if (!path) return undefined;
  if (tool === 'Write') return [wholeFileDiff(path, string(input.content), '+')];
  const edits = tool === 'Edit' ? [input] : tool === 'MultiEdit' ? input.edits : undefined;
  if (!Array.isArray(edits)) return undefined;
  const replacements = edits.map((edit: unknown) => ({
    before: string(record(edit).old_string),
    after: string(record(edit).new_string),
  }));
  return [replacementDiff(path, replacements)];
}

/**
 * The change as applied, with line numbers, from the tool's structured result.
 * Undefined keeps the proposed diff: a resumed session's history lacks the patch,
 * and a new file's patch is empty.
 */
export function appliedDiffs(item: ChatItem | undefined, result: unknown): ChatDiff[] | undefined {
  const path = item?.activity?.diffs?.[0]?.path;
  const applied = record(result);
  if (!path || string(applied.filePath) !== path) return undefined;
  const diff = hunksDiff(path, applied.structuredPatch);
  return diff ? [diff] : undefined;
}
