export interface SaveFailure {
  /** The backend rejected the base revision; the same operations may succeed on a refreshed graph. */
  conflict: boolean;
  message: string;
}

const remotePrefix = /^Error invoking remote method '[^']*': /;
// The two base-revision rejections from graph.ts and ipc/reasoning.ts; validation errors
// such as 'Supply expectedRevision.' must not be retried.
const conflictPattern = /^The graph (?:has changed|revision or run changed)\b/;
export const conflictMessage = 'Could not save because the graph changed; try again.';
export const retriedMessage =
  'The agent updated the graph while you were saving. Your change was applied to the latest version.';

/** Turn an IPC or model error into a message a person can act on. */
export function describeSaveFailure(error: unknown, fallback: string): SaveFailure {
  const raw = error instanceof Error ? error.message.replace(remotePrefix, '') : '';
  if (conflictPattern.test(raw)) return { conflict: true, message: conflictMessage };
  return { conflict: false, message: raw || fallback };
}
