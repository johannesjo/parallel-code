import type { VerificationRun } from '../ipc/shared-types.js';

/** The placeholder both the renderer and the coordinator show while a run is
 *  in flight, before the main process reports the result. */
export function pendingVerificationRun(command: string): VerificationRun {
  return {
    command,
    status: 'running',
    exitCode: null,
    headSha: null,
    dirty: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputTail: '',
  };
}

/** Why the runner cancelled an automatic run before starting it: the tree no
 *  longer matched the commit it was meant for. */
export const HELD_RUN_MESSAGE =
  'Automatic check held: the worktree changed since the evidence scan. Rebuild or run this check explicitly.';
