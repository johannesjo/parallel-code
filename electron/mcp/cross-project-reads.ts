import { warn as logWarn, errMessage } from '../log.js';

/** What the user is asked before a session's first read of another project. */
export interface CrossProjectReadRequest {
  sessionInstanceId: string;
  taskName: string;
  projectName: string;
  targetProjectId: string;
  targetProjectName: string;
}

/** `off` means the global setting is off; `pending` means the user has not answered yet. */
export type CrossProjectReadAccess = 'allowed' | 'denied' | 'pending' | 'off';

export interface CrossProjectReads {
  setEnabled(enabled: boolean): void;
  /** Whether the project's tasks may appear in the session's peer list (not denied). */
  visible(sessionInstanceId: string, projectId: string): boolean;
  /** Never waits: an unanswered read asks the user once and reports `pending` meanwhile. */
  access(request: CrossProjectReadRequest): CrossProjectReadAccess;
  /** Drops decisions of sessions that ended; a relaunch is a new session and asks again. */
  forget(liveInstances: ReadonlySet<string>): void;
}

const key = (sessionInstanceId: string, projectId: string) =>
  JSON.stringify([sessionInstanceId, projectId]);

/**
 * Global read-only access to other projects, confirmed by the user once per session and project.
 * Turning the setting off forgets every decision; answers to dialogs shown before that are ignored.
 */
export function createCrossProjectReads(
  confirm: (request: CrossProjectReadRequest) => Promise<boolean>,
): CrossProjectReads {
  let enabled = false;
  let epoch = 0;
  const decisions = new Map<string, Exclude<CrossProjectReadAccess, 'off'>>();
  // One dialog at a time, so several agents asking at once don't stack native dialogs.
  let queue = Promise.resolve();

  async function ask(request: CrossProjectReadRequest, id: string, askedEpoch: number) {
    if (askedEpoch !== epoch || decisions.get(id) !== 'pending') return;
    try {
      const allowed = await confirm(request);
      if (askedEpoch === epoch && decisions.get(id) === 'pending')
        decisions.set(id, allowed ? 'allowed' : 'denied');
    } catch (error) {
      // No answer (for example the window closed): the next read asks again.
      if (decisions.get(id) === 'pending') decisions.delete(id);
      logWarn('mcp', 'Cross-project read confirmation failed', { err: errMessage(error) });
    }
  }

  return {
    setEnabled(next) {
      if (enabled && !next) {
        epoch += 1;
        decisions.clear();
      }
      enabled = next;
    },
    visible: (sessionInstanceId, projectId) =>
      enabled && decisions.get(key(sessionInstanceId, projectId)) !== 'denied',
    access(request) {
      if (!enabled) return 'off';
      const id = key(request.sessionInstanceId, request.targetProjectId);
      const decision = decisions.get(id);
      if (decision) return decision;
      decisions.set(id, 'pending');
      const askedEpoch = epoch;
      queue = queue.then(() => ask(request, id, askedEpoch));
      return 'pending';
    },
    forget(liveInstances) {
      for (const id of decisions.keys()) {
        const [instance] = JSON.parse(id) as [string, string];
        if (!liveInstances.has(instance)) decisions.delete(id);
      }
    },
  };
}
