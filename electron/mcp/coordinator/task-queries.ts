// Read-only views of a coordinator's sub-tasks: listings, status, diff and output.

import {
  detectPreambleFiles,
  filterDiffSections,
  buildNormalizedPreambleFileDiff,
} from '../preamble.js';
import { truncateDiffForTool } from '../diff-format.js';
import type { CoordinatorInternals } from './internals.js';
import { getAgentScrollback, getAgentPromptSnapshot } from '../../ipc/pty.js';
import { getAgentActivityEvidence } from '../../agent-hooks/observations.js';
import type { ActivityEvidence } from '../../agent-hooks/status.js';
import { getChangedFiles, getAllFileDiffs, getDiffBaseSha } from '../../ipc/git.js';
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

  // Compute baseSha first so detectDiffBase/pinHead results are cached.
  // getChangedFiles and getAllFileDiffs internally call the same helpers;
  // running all three concurrently causes three simultaneous cache misses.
  const baseSha = await getDiffBaseSha(task.worktreePath, task.baseBranch);
  const [files, diff] = await Promise.all([
    getChangedFiles(task.worktreePath, task.baseBranch),
    getAllFileDiffs(task.worktreePath, task.baseBranch),
  ]);

  // For preamble-bearing files: strip the injected block and show only real sub-task edits.
  // Files with no real changes beyond the preamble are excluded entirely.
  // Files with real changes (before or after the preamble block) include a normalized diff.
  const preambleFiles = await detectPreambleFiles(task.worktreePath);

  let filteredFiles = files;
  let filteredDiff = diff;
  if (preambleFiles.size > 0) {
    // Drop preamble file sections from the raw diff; we'll add normalized sections below.
    filteredDiff = filterDiffSections(diff, preambleFiles);
    // For each preamble file, generate a diff that excludes the injected block.
    const normalizedSections = await Promise.all(
      [...preambleFiles].map((f) => buildNormalizedPreambleFileDiff(f, task.worktreePath, baseSha)),
    );
    const preambleFilesWithChanges = new Set<string>();
    for (let i = 0; i < [...preambleFiles].length; i++) {
      if (normalizedSections[i]) preambleFilesWithChanges.add([...preambleFiles][i]);
    }
    filteredDiff += normalizedSections.filter(Boolean).join('');
    // Files list: exclude preamble-only files, keep files with real changes.
    filteredFiles = files.filter(
      (f) => !preambleFiles.has(f.path) || preambleFilesWithChanges.has(f.path),
    );
  }

  const truncatedDiff = truncateDiffForTool(filteredDiff);
  if (truncatedDiff.truncated) {
    return {
      files: filteredFiles,
      diff: truncatedDiff.diff,
      truncated: true,
      originalSizeBytes: truncatedDiff.originalSizeBytes,
    };
  }
  return { files: filteredFiles, diff: truncatedDiff.diff };
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
