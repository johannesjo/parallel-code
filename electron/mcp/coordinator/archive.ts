// archive_task: a coordinator gives up a child it no longer needs. The app
// collapses the child (stopping its agent, keeping its worktree), unless work is
// at stake, in which case the blockers go back to the coordinator.

import { warn as logWarn } from '../../log.js';
import { IPC } from '../../ipc/channels.js';
import { getAgentInputBlocker } from '../../ipc/pty.js';
import type { CloseSuggestion } from '../../shared/close-suggestion.js';
import { ownDirtyPaths } from './child-git.js';
import type { CoordinatorNotifications } from './notifications.js';
import type { ArchiveBlocker, ArchiveResult, CoordinatedTask } from '../types.js';

// Enough for the parent to judge the stakes; get_task_diff has the rest.
const ARCHIVE_CHANGED_FILES_MAX = 20;

/** What archiving reads from, and asks of, the coordinator that owns the child. */
export interface ArchiveHost {
  readonly tasks: ReadonlyMap<string, CoordinatedTask>;
  readonly notifications: CoordinatorNotifications;
  isClosingOrIntegrating(taskId: string): boolean;
  isHumanControlled(taskId: string): boolean;
  /** A prompt write to the child's agent is under way. */
  isWritingPrompt(taskId: string): boolean;
  suggestClose(taskId: string, reason: string): CloseSuggestion;
  /** Drop queued and initial prompts so a restore does not replay them. */
  discardAutomatedPrompts(task: CoordinatedTask): void;
  notifyRenderer(channel: string, data: unknown): void;
}

export class ChildArchiver {
  constructor(private readonly host: ArchiveHost) {}

  /**
   * Archive a child the coordinator no longer needs: the app collapses it, which
   * stops its agent but keeps the worktree, so the user can restore or close it.
   * The reason is recorded as a close suggestion. Unless forced, a child with work
   * at stake is left alone and the blockers are returned so the parent can decide.
   */
  async archiveTask(taskId: string, reason: string, force = false): Promise<ArchiveResult> {
    const current = this.assertArchivable(taskId);
    // Repeating the call must not report an archived child as left alone.
    if (current.archived && current.closeSuggestion) {
      // The app may have skipped the first collapse (e.g. mid-close); asking again lets it catch up.
      this.host.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, archived: true });
      return { ...current.closeSuggestion, archived: true };
    }
    const blockers = force ? undefined : await this.archiveBlockers(taskId);
    // Git status yields to other work; the child may have changed hands meanwhile.
    const task = this.assertArchivable(taskId);
    if (blockers && blockers.blockers.length > 0) return { archived: false, ...blockers };
    const suggestion = this.host.suggestClose(taskId, reason);
    task.archived = true;
    // A restore must not replay instructions the parent has since given up on.
    this.host.discardAutomatedPrompts(task);
    // The parent just gave this child up; a staged "ready for review" would only nag it.
    this.host.notifications.suppressPendingNotificationForTask(task, true);
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, archived: true });
    return { ...suggestion, archived: true };
  }

  private assertArchivable(taskId: string): CoordinatedTask {
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.host.isClosingOrIntegrating(taskId))
      throw new Error('Task is closing or being integrated; it cannot be archived now.');
    // The app may not show the task yet, so it could not collapse it.
    if (task.status === 'creating')
      throw new Error('Task is still being created; wait for it to start before archiving.');
    // Forcing must never stop an agent out from under the user.
    if (this.host.isHumanControlled(taskId))
      throw new Error('The user has taken over this task; leave archiving it to them.');
    return task;
  }

  /** What archiving would cut short: a working agent, the user's input, or unsaved work. */
  private async archiveBlockers(
    taskId: string,
  ): Promise<{ blockers: ArchiveBlocker[]; changedFiles?: string[] }> {
    const worktree = await this.worktreeArchiveBlocker(taskId);
    // Read the agent only after git returns: a turn may have started meanwhile.
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const blockers: ArchiveBlocker[] = [];
    const input = task.agentId ? getAgentInputBlocker(task.agentId) : null;
    // An idle child has a live terminal, so 'busy' means a peer prompt or handoff is under way;
    // an exited child is 'busy' only because it has no terminal.
    if (
      task.status === 'running' ||
      this.host.isWritingPrompt(taskId) ||
      (input === 'busy' && task.status === 'idle')
    )
      blockers.push('agent-working');
    if (input === 'unsent-input' || input === 'recent-input') blockers.push(input);
    // Committed work the user has not reviewed yet; archiving would withdraw its notification.
    // A merge the user made and kept the task after marks it reviewed.
    if (
      task.signalDoneAt &&
      task.integrationPolicy !== 'automatic' &&
      task.landingState !== 'reviewed'
    )
      blockers.push('unreviewed-result');
    if (!worktree) return { blockers };
    blockers.push(worktree.blocker);
    return worktree.changedFiles ? { blockers, changedFiles: worktree.changedFiles } : { blockers };
  }

  private async worktreeArchiveBlocker(
    taskId: string,
  ): Promise<{ blocker: ArchiveBlocker; changedFiles?: string[] } | null> {
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    try {
      const paths = await ownDirtyPaths(task.worktreePath);
      if (paths.length === 0) return null;
      return {
        blocker: 'uncommitted-changes',
        changedFiles: paths.slice(0, ARCHIVE_CHANGED_FILES_MAX),
      };
    } catch (err) {
      logWarn('coordinator.archive', 'could not read worktree status', {
        taskId,
        err: String(err),
      });
      return { blocker: 'changes-unknown' };
    }
  }
}
