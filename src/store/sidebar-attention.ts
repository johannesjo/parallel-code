import { batch } from 'solid-js';
import { store } from './core';
import { delegationStates } from './delegation';
import { isLandedTaskState } from './landing';
import { unfocusSidebar } from './focus';
import {
  agentIdFromAiTerminalPanel,
  aiTerminalPanelId,
  getTaskFocusedPanel,
  isShellPanel,
  setTaskFocusedPanel,
  shellPanelId,
  shellPanelIndex,
} from './focused-panel';
import { setActiveTask } from './navigation';
import { uncollapseTask } from './tasks';
import { getTaskOpenQuestions, isTaskWorking } from './taskStatus';

export interface AttentionEntry {
  key: string;
  kind: 'question' | 'review' | 'launch_failed' | 'delivery_failed' | 'integration_issue';
  taskId: string;
  label: string;
  detail?: string;
  /** Only a timestamp recorded by the source, never a derived first-seen time. */
  since?: number;
  panel: string | null;
}

/** Which panel hosts the asking agent. AI agents are addressed by id; shells by
 *  their position in `shellAgentIds`, matching the rest of the panel grid.
 *
 *  The null return is belt-and-braces: the asking agent came from these same
 *  two arrays a moment earlier, so today it always resolves. */
function panelForAskingAgent(taskId: string, agentId: string): string | null {
  const task = store.tasks[taskId];
  if (!task) return null;
  if (task.agentIds.includes(agentId)) return aiTerminalPanelId(agentId);
  const shellIndex = task.shellAgentIds.indexOf(agentId);
  return shellIndex >= 0 ? shellPanelId(shellIndex) : null;
}

function taskAttentionEntries(taskId: string): AttentionEntry[] {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'closing' || task.closingStatus === 'removing') return [];
  const entries: AttentionEntry[] = getTaskOpenQuestions(taskId).map((question) => ({
    key: JSON.stringify([taskId, 'question', question.agentId, question.since]),
    kind: 'question',
    taskId,
    label: 'Answer question',
    detail: task.agentIds.includes(question.agentId)
      ? (store.agents[question.agentId]?.def.name ?? 'Agent') +
        ' · pane ' +
        (task.agentIds.indexOf(question.agentId) + 1)
      : 'Shell ' + (task.shellAgentIds.indexOf(question.agentId) + 1),
    since: question.since,
    panel: panelForAskingAgent(taskId, question.agentId),
  }));
  const landedReview = task.landingState === 'landed_pending_review';
  if (
    landedReview ||
    (!isLandedTaskState(task.landingState) &&
      (task.needsReview || (task.integrationPolicy === 'review' && task.signalDoneReceived)))
  ) {
    const at = landedReview ? task.landedMetadata?.landedAt : task.signalDoneAt;
    const since = at ? Date.parse(at) : NaN;
    entries.push({
      key: JSON.stringify([taskId, 'review', task.completion?.id ?? at ?? 'legacy']),
      kind: 'review',
      taskId,
      label: landedReview ? 'Review merged result' : 'Review result',
      since: Number.isFinite(since) ? since : undefined,
      panel: null,
    });
  }
  if (
    task.landingState === 'landing_failed' ||
    task.landingState === 'landing_escalated' ||
    task.landingState === 'landed_cleanup_failed'
  ) {
    entries.push({
      key: JSON.stringify([taskId, 'integration_issue', task.landingState, task.landingReason]),
      kind: 'integration_issue',
      taskId,
      label:
        task.landingState === 'landed_cleanup_failed'
          ? 'Cleanup failed'
          : 'Integration needs attention',
      detail: task.landingReason,
      panel: null,
    });
  }
  const state = delegationStates[taskId];
  for (const attempt of state?.attempts ?? []) {
    if (attempt.status !== 'failed') continue;
    entries.push({
      key: JSON.stringify([taskId, 'launch_failed', attempt.requestId]),
      kind: 'launch_failed',
      taskId,
      label: 'Child launch failed: ' + attempt.name,
      detail: attempt.error,
      panel: null,
    });
  }
  for (const message of state?.messages ?? []) {
    if (!message.deliveryFailed || message.recipient.taskId !== taskId) continue;
    entries.push({
      key: JSON.stringify(['delivery_failed', message.deliveryId]),
      kind: 'delivery_failed',
      taskId,
      label: 'Message delivery failed',
      detail: message.reason,
      panel: panelForAskingAgent(taskId, message.recipient.agentId),
    });
  }
  return entries;
}

/** Independent unresolved reasons, including tasks in hidden projects or the background. */
export function computeAttentionEntries(): AttentionEntry[] {
  const entries = [...new Set([...store.taskOrder, ...store.collapsedTaskOrder])].flatMap(
    taskAttentionEntries,
  );
  const rank = (entry: AttentionEntry) =>
    entry.kind === 'question' ? 0 : entry.kind === 'review' ? 2 : 1;
  return entries.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.kind === 'question' && b.kind === 'question' ? (b.since ?? 0) - (a.since ?? 0) : 0),
  );
}

/** Count child tasks once even when they have several reasons; launches have no child yet. */
export function getChildAttentionSummary(parentTaskId: string): string {
  let attention = 0;
  let working = 0;
  for (const taskId of new Set([...store.taskOrder, ...store.collapsedTaskOrder])) {
    const task = store.tasks[taskId];
    if (
      task?.coordinatedBy !== parentTaskId ||
      task.closingStatus === 'closing' ||
      task.closingStatus === 'removing'
    )
      continue;
    if (taskAttentionEntries(taskId).length) attention++;
    if (isTaskWorking(taskId)) working++;
  }
  const failedLaunches =
    delegationStates[parentTaskId]?.attempts.filter((attempt) => attempt.status === 'failed')
      .length ?? 0;
  return [
    attention ? attention + ' need attention' : '',
    working ? working + ' working' : '',
    failedLaunches
      ? failedLaunches + ' launch' + (failedLaunches === 1 ? '' : 'es') + ' failed'
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Whether the panel still names something the task actually has. Checked at
 *  jump time rather than trusting the entry: `uncollapseTask` mints fresh agent
 *  ids, so a panel captured before an uncollapse can name an agent that is gone,
 *  and focusing it would record a dead panel and fire no focus callback at all —
 *  the task would open with nothing focused instead of falling back. */
function panelIsLive(taskId: string, panel: string): boolean {
  const task = store.tasks[taskId];
  if (!task) return false;
  const agentId = agentIdFromAiTerminalPanel(panel);
  if (agentId !== null) return task.agentIds.includes(agentId);
  // Test the prefix, not the parse: a malformed `shell:` must be rejected
  // rather than waved through as some other kind of panel.
  if (isShellPanel(panel)) {
    const shellIndex = shellPanelIndex(panel);
    return shellIndex !== null && shellIndex < task.shellAgentIds.length;
  }
  return true;
}

/** Open a tray row's task and land on the panel that is actually asking, so the
 *  question can be answered without a second click. `setTaskFocusedPanel`
 *  selects the agent behind an `ai-terminal:<id>` panel, which brings a
 *  non-selected agent's tab to the front — hence the ordering here: it must run
 *  after `setActiveTask`, which would otherwise pick its own agent. `batch`
 *  keeps that intermediate state off screen: `setActiveTask` resolves its agent
 *  from the *previously* focused panel, so without it the old tab would render
 *  as selected for a frame before the asking one takes over.
 *
 *  Falls back to the last focused panel when the asking agent could not be
 *  placed or no longer exists. Callers must label collapsed navigation as
 *  "Resume and open": uncollapsing starts agents. Passive reviews bypass this. */
export function jumpToWaitingTask(taskId: string, panel: string | null): void {
  batch(() => {
    if (store.tasks[taskId]?.collapsed) uncollapseTask(taskId);
    setActiveTask(taskId);
    unfocusSidebar();
    const target =
      panel !== null && panelIsLive(taskId, panel) ? panel : getTaskFocusedPanel(taskId);
    setTaskFocusedPanel(taskId, target);
  });
}
