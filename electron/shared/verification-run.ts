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
