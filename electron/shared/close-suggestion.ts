/**
 * A coordinator's note that it no longer needs a child task. Agents may not close
 * tasks themselves; the user reads the reason and decides.
 */
export interface CloseSuggestion {
  reason: string;
  /** ISO timestamp of the suggestion. */
  at: string;
}

export const CLOSE_SUGGESTION_REASON_MAX = 500;

/** Accepts a persisted or IPC-supplied suggestion; anything malformed is dropped. */
export function parseCloseSuggestion(raw: unknown): CloseSuggestion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { reason, at } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || typeof at !== 'string') return undefined;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > CLOSE_SUGGESTION_REASON_MAX || Number.isNaN(Date.parse(at)))
    return undefined;
  return { reason: trimmed, at };
}
