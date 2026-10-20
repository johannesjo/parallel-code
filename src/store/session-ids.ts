import { canAssignSessionId } from '../../electron/shared/session-resume';

/**
 * Give this pane a session id of its own, or drop the one it had.
 *
 * Called wherever a *new* conversation begins, never on a resume: the id has to
 * be fresh, because Claude rejects `--session-id` for a session that already
 * exists. Panes on a CLI that assigns its own ids keep no entry, which leaves
 * them on the positional resume they have always used.
 *
 * Mutates a `produce` draft so it lands in the same store update as the rest of
 * the spawn — a pane must never be visible with a stale id attached.
 *
 * Lives in its own module rather than in `agents.ts` because every domain that
 * starts a conversation needs it — agents, tasks and projects — and routing
 * those through `agents.ts` closes a cycle back through `persistence.ts`.
 * Nothing here touches the store directly, which is what keeps it free of one.
 */
export function assignFreshSessionId(
  draft: { tasks?: Record<string, { agentSessionIds?: Record<string, string> } | undefined> },
  taskId: string,
  agentId: string,
  command: string,
): void {
  // A shell terminal or a document pane has no task entry to hang this on.
  const task = draft.tasks?.[taskId];
  if (!task) return;
  if (!canAssignSessionId(command)) {
    if (task.agentSessionIds) delete task.agentSessionIds[agentId];
    return;
  }
  task.agentSessionIds ??= {};
  task.agentSessionIds[agentId] = crypto.randomUUID();
}
