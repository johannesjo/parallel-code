import { batch } from 'solid-js';
import { store } from './core';
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
import { getTaskOpenQuestion } from './taskStatus';

export interface NeedsInputEntry {
  taskId: string;
  /** When the *newest* open question in the task appeared (epoch ms) — not how
   *  long the task has been waiting overall. With several agents asking, an
   *  older unanswered question is not what the row's elapsed label reports. */
  since: number;
  /** The panel that is actually asking — `ai-terminal:<agentId>` or
   *  `shell:<index>` — so opening the row lands on it. Null only if the asking
   *  agent could not be placed — a guard, not reachable today (see
   *  `panelForAskingAgent`); the row is still listed, minus the shortcut. */
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

/** Tasks currently blocked on a human answer, newest question first.
 *
 *  Membership comes from open-question state directly, not from the task's
 *  prioritized attention state: a task showing `error` or `review` can still
 *  have another agent waiting on an answer, and dropping it here would strand
 *  the question.
 *
 *  The `collapsedTaskOrder` sweep yields nothing today — `collapseTask` kills
 *  every agent and clears its question state — and is kept only so the tray
 *  keeps working if collapsing ever stops tearing agents down. */
export function computeNeedsInputTasks(): NeedsInputEntry[] {
  const entries: NeedsInputEntry[] = [];
  const seen = new Set<string>();

  for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    if (!store.tasks[taskId]) continue;
    const question = getTaskOpenQuestion(taskId);
    if (!question) continue;
    entries.push({
      taskId,
      since: question.since,
      panel: panelForAskingAgent(taskId, question.agentId),
    });
  }

  return entries.sort((a, b) => b.since - a.since);
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
 *  placed (see `panelForAskingAgent`) or no longer exists. Neither is reachable
 *  today; the uncollapse likewise mirrors the inert collapsed sweep in
 *  `computeNeedsInputTasks` and is kept in step with it. */
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
