import { createSignal } from 'solid-js';
import { store } from '../../store/core';
import { getAgentHookStatus } from '../../store/agentHookStatus';
import { isCheckSuiteBusy } from '../../store/check-suite-state';
import { computeAttentionEntries, jumpToWaitingTask } from '../../store/sidebar-attention';
import { getReadyLabel, getTaskAttentionState } from '../../store/taskStatus';
import type { Task } from '../../store/types';
import { isUserVerifyRunning } from '../../store/verification';

/** How a linked task is doing, from the card's point of view. */
export type CardTaskState = 'needs_input' | 'error' | 'review' | 'active' | 'ready' | 'idle';

const [now, setNow] = createSignal(Date.now());
/** The minute clock's reading; ticks only while `useBoardClock` has users. */
export const boardNow = now;
let clockUsers = 0;
let clock: ReturnType<typeof setInterval> | undefined;

/** A minute clock for "working 3m" labels, running only while a board is open. */
export function useBoardClock(): () => void {
  clockUsers++;
  if (!clock) clock = setInterval(() => setNow(Date.now()), 30_000);
  return () => {
    clockUsers--;
    if (clockUsers === 0 && clock) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

export function cardTaskState(task: Task): CardTaskState {
  const state = getTaskAttentionState(task.id);
  if (state === 'needs_input' || state === 'error' || state === 'review' || state === 'active') {
    return state;
  }
  if (task.signalDoneReceived || task.landingState === 'landed_pending_review') return 'review';
  return state === 'ready' ? 'ready' : 'idle';
}

/**
 * What a check started from Finish is doing, or '' when none runs. The
 * verify command's background run after each turn doesn't count: it would
 * hold every finished task back from Needs you until its tests end.
 */
export function finishCheckLabel(task: Task): string {
  if (task.reviewStatus?.state === 'running') return 'Reviewing';
  if (task.evidence && isCheckSuiteBusy(task.evidence)) return 'Running checks';
  if (isUserVerifyRunning(task.id)) return 'Running verify';
  return '';
}

export function stateLabel(task: Task, state: CardTaskState): string {
  switch (state) {
    case 'needs_input':
      return 'Needs input';
    case 'error':
      return 'Failed';
    case 'review':
      return 'Ready for review';
    case 'active':
      return 'Working';
    case 'ready':
      return getReadyLabel(task.id);
    default:
      return 'Idle';
  }
}

function firstLine(text: string | undefined): string {
  return (
    (text ?? '')
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

/** One line about what the task's agent is doing or last said. */
export function activityLine(task: Task): { text: string; since?: number } {
  const hook = task.agentIds.map(getAgentHookStatus).find((status) => status !== null);
  if (hook?.state === 'working' && hook.toolName) {
    return {
      text: [hook.toolName, firstLine(hook.detail)].filter(Boolean).join(' · '),
      since: hook.since,
    };
  }
  const said = firstLine(hook?.lastAssistantMessage);
  if (said) return { text: said, since: hook?.since };
  // Nothing reported yet: name the agent rather than echo the prompt, which
  // starts with the card's own title.
  return { text: agentName(task), since: hook?.since };
}

/** The name of the task's agent, or '' before one is known. */
export function agentName(task: Task): string {
  return task.agentIds.map((id) => store.agents[id]?.def?.name).find(Boolean) ?? '';
}

/** The pane of the task's agent that is asking a question, if any. */
export function askingPanel(taskId: string): string | null {
  const question = computeAttentionEntries().find(
    (entry) => entry.taskId === taskId && entry.kind === 'question',
  );
  return question?.panel ?? null;
}

/** Opens the task on the panel that is asking, if one is. */
export function openTask(task: Task, panel = askingPanel(task.id)): void {
  jumpToWaitingTask(task.id, panel);
}
