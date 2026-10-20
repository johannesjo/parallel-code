import { IPC } from '../../electron/ipc/channels';
import type { ReasoningDocument, ReasoningFeedRead } from '../../electron/shared/reasoning';
import { parseReasoningFeed, parseReasoningUpdate } from '../../electron/shared/reasoning-feed';
import type { ReasoningUpdate, Snapshot } from '../../electron/shared/reasoning-state';
import { invoke } from '../lib/ipc';
import { store } from './core';
import { openCanvasReasoning } from './canvas';
import { notifyReasoningFeedChanged, recordAgentPublication } from './reasoning-activity';
import { reasoningProfiles } from '../investigation/profiles';
function sourceForTask(taskId: string) {
  const task = Object.hasOwn(store.tasks, taskId) ? store.tasks[taskId] : undefined;
  const agentId = task?.agentIds[0];
  if (!task?.worktreePath || !agentId || task.closingStatus) throw new Error('Task not available.');
  return { taskId, agentId, worktreePath: task.worktreePath };
}
function assertSession(source: ReturnType<typeof sourceForTask>) {
  const current = sourceForTask(source.taskId);
  if (current.agentId !== source.agentId || current.worktreePath !== source.worktreePath)
    throw new Error('Task session changed. Read again.');
}
/** The persisted log is the only committed graph; draft workspaces are never read here. */
export async function getTaskReasoning(taskId: string): Promise<ReasoningDocument> {
  const source = sourceForTask(taskId);
  const read = await invoke<ReasoningFeedRead | null>(IPC.ReadReasoningFeed, source);
  assertSession(source);
  const parsed = parseReasoningFeed(read && 'raw' in read ? read.raw : '');
  const graph = parsed.history.snapshots.at(-1) ?? null;
  return {
    runId: parsed.history.updates[0]?.runId ?? null,
    revision: graph?.revision ?? 0,
    workflow: store.tasks[taskId].reasoningProfile ?? 'investigation',
    // Graphs opened from chat skip the activation prompt, so the guidance travels with the read.
    workflows: Object.fromEntries(
      Object.entries(reasoningProfiles).map(([key, value]) => [key, value.instructions]),
    ),
    graph,
    warning: parsed.error ?? (parsed.pending ? 'An update is still being written.' : undefined),
  };
}
export async function commitTaskReasoningEdit(
  taskId: string,
  update: ReasoningUpdate,
): Promise<Snapshot> {
  const source = sourceForTask(taskId);
  const snapshot = await invoke<Snapshot>(IPC.CommitReasoningEdit, { ...source, update });
  notifyReasoningFeedChanged(taskId);
  assertSession(source);
  return snapshot;
}
export async function updateTaskReasoningFromAgent(
  taskId: string,
  input: unknown,
): Promise<ReasoningDocument> {
  const update = parseReasoningUpdate(input);
  const source = sourceForTask(taskId);
  await invoke<Snapshot>(IPC.AppendReasoningUpdate, { ...source, update });
  notifyReasoningFeedChanged(taskId);
  assertSession(source);
  const hasTab = store.tasks[taskId].canvasTabs?.some((tab) => tab.kind === 'reasoning');
  if (!hasTab && update.newRunId) openCanvasReasoning(taskId);
  recordAgentPublication({
    taskId,
    agentId: source.agentId,
    generation: store.agents[source.agentId]?.generation ?? 0,
  });
  return getTaskReasoning(taskId);
}
