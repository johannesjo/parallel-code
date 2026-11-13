// Read-only views of a coordinator's sub-tasks: listings, status, diff and output.

import { getWorktreeDiff } from '../worktree-diff.js';
import type { CoordinatorInternals } from './internals.js';
import { getAgentScrollback, getAgentPromptSnapshot } from '../../ipc/pty.js';
import { getAgentActivityEvidence } from '../../agent-hooks/observations.js';
import type { ActivityEvidence } from '../../agent-hooks/status.js';
import { stripAnsi } from '../../shared/prompt-detect.js';
import type { CoordinatedTask, ApiTaskSummary, ApiTaskDetail, ApiDiffResult } from '../types.js';

function activityEvidence(task: CoordinatedTask): ActivityEvidence {
  return (
    getAgentActivityEvidence(task.agentId) ?? {
      agentId: task.agentId,
      source: 'process',
      activity: 'unknown',
      event:
        task.status === 'exited' || task.status === 'error'
          ? 'ProcessUnavailable'
          : 'NoObservation',
      freshness: 'unknown',
    }
  );
}

export function listTasks(c: CoordinatorInternals): ApiTaskSummary[] {
  return Array.from(c.tasks.values()).map((t) => ({
    id: t.id,
    name: t.name,
    branchName: t.branchName,
    status: t.status,
    activityEvidence: activityEvidence(t),
    delivery: c.prompts.promptDelivery(t),
    coordinatorTaskId: t.coordinatorTaskId,
    integrationPolicy: t.integrationPolicy,
    signalDoneAt: t.signalDoneAt?.toISOString(),
    closeSuggestion: t.closeSuggestion,
    archived: t.archived,
    completion: t.completion,
    reviewRevision: t.reviewRevision,
    verification: t.verification,
    landingState: t.landingState,
    landingReason: t.landingReason,
    landingSummary: t.landingSummary,
    landedMetadata: t.landedMetadata,
  }));
}

export function getTaskStatus(c: CoordinatorInternals, taskId: string): ApiTaskDetail | null {
  const task = c.tasks.get(taskId);
  if (!task) return null;
  return {
    id: task.id,
    name: task.name,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    projectId: task.projectId,
    agentId: task.agentId,
    status: task.status,
    coordinatorTaskId: task.coordinatorTaskId,
    integrationPolicy: task.integrationPolicy,
    exitCode: task.exitCode,
    activityEvidence: activityEvidence(task),
    delivery: c.prompts.promptDelivery(task),
    pendingPrompt: task.pendingPrompts?.[0],
    pendingPrompts: task.pendingPrompts ? [...task.pendingPrompts] : undefined,
    pendingPromptCount: task.pendingPrompts?.length,
    signalDoneAt: task.signalDoneAt?.toISOString(),
    closeSuggestion: task.closeSuggestion,
    archived: task.archived,
    completion: task.completion,
    reviewRevision: task.reviewRevision,
    verification: task.verification,
    landingState: task.landingState,
    landingReason: task.landingReason,
    landingSummary: task.landingSummary,
    landedMetadata: task.landedMetadata,
  };
}

export async function getTaskDiff(c: CoordinatorInternals, taskId: string): Promise<ApiDiffResult> {
  const task = c.tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return getWorktreeDiff(task.worktreePath, task.baseBranch);
}

export function getTaskOutput(c: CoordinatorInternals, taskId: string): string {
  const task = c.tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // A full-screen TUI such as Codex repaints cells in place, so its raw output
  // strips to word fragments; the rendered screen is what the user reads.
  // shortcut: visible rows only, so text scrolled out of the TUI is gone —
  // read the mirror's scrollback too if callers need earlier turns.
  // Output a few ms behind is fine, so don't wait for the mirror to catch up.
  const screen = getAgentPromptSnapshot(task.agentId, { parsedSoFar: true });
  if (screen?.alternateScreen) return screen.text;
  // Try scrollback buffer first, fall back to tail buffer
  const scrollback = getAgentScrollback(task.agentId);
  if (scrollback) {
    const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
    return stripAnsi(decoded);
  }
  return stripAnsi(c.tailBuffers.get(task.agentId) ?? '');
}
