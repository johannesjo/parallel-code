import { isSessionId } from '../../electron/shared/session-record';
import type { PlanHandoff } from '../store/types';

/**
 * Handing an approved plan to a fresh session of the task's agent, so the
 * implementation starts with a clean context instead of the whole planning
 * conversation. See docs/plan-handoff-design.md.
 */

/** The first prompt of the fresh session. The plan is inline so the handoff
 *  does not depend on the file staying put; the path lets the agent re-read it
 *  after its own compaction. */
export function planHandoffPrompt(plan: { content: string; path: string }): string {
  return (
    'Implement this approved plan. It was planned and approved in an earlier session, ' +
    'so this session starts with a clean context.\n' +
    `Plan file: ${plan.path} (re-read it if you need it again).\n\n` +
    plan.content.trim()
  );
}

/** Restarting the pane would discard text typed into the agent's terminal. */
export const UNSENT_TERMINAL_INPUT =
  'Send or clear the text typed into the agent first; the restart would discard it.';

/**
 * Why the plan can't be handed over right now, or null when it can.
 *
 * A draft or a queued first prompt would block the handoff's auto-send (it only
 * fills an empty prompt box), leaving the plan unsent in a session that has
 * already lost the planning context — so refuse up front instead.
 */
export function planHandoffBlocker(input: {
  planContent?: string;
  hasTerminalAgent: boolean;
  /** The CLI can reopen one specific session, which going back relies on. */
  canReopenSession: boolean;
  /** A coordinating agent delivers this task's prompts, not the prompt box. */
  coordinated?: boolean;
  promptDraft?: string;
  /** Text typed straight into the agent's terminal and not yet sent. */
  terminalInputPending?: boolean;
  initialPrompt?: string;
}): string | null {
  if (!input.planContent?.trim()) return 'No plan to implement.';
  if (!input.hasTerminalAgent) return 'Only available for agents running in a terminal.';
  if (!input.canReopenSession)
    return 'Only available for Claude Code and Codex, whose planning session can be reopened.';
  if (input.coordinated) return 'Not available for tasks run by a coordinating agent.';
  if (input.initialPrompt?.trim())
    return 'A prompt is still waiting to be sent. Wait until it has gone out.';
  if (input.terminalInputPending) return UNSENT_TERMINAL_INPUT;
  if (input.promptDraft?.trim())
    return 'Send or clear the text in the prompt box first; it would block the plan.';
  return null;
}

/**
 * The queued first prompt and prompt-box draft to restore. With a handoff on
 * record the queued prompt is the plan, still undelivered; it is kept only when
 * the pane will reopen a session other than the planner. Without a known one
 * the pane resumes the newest session, which may be the planning one, so the
 * plan is dropped, along with the copy the prompt box saved as its draft.
 */
export function restoredQueuedPrompt(input: {
  initialPrompt: unknown;
  promptDraft: unknown;
  planHandoff: PlanHandoff | undefined;
  firstPaneSessionId: string | undefined;
}): { initialPrompt?: string; promptDraft?: string } {
  const initialPrompt = typeof input.initialPrompt === 'string' ? input.initialPrompt : undefined;
  const promptDraft = typeof input.promptDraft === 'string' ? input.promptDraft : undefined;
  const sessionId = input.firstPaneSessionId;
  const planMayReachPlanner =
    !!input.planHandoff && (!sessionId || sessionId === input.planHandoff.sessionId);
  if (!initialPrompt || !planMayReachPlanner) return { initialPrompt, promptDraft };
  return {
    promptDraft: promptDraft?.trim() === initialPrompt.trim() ? undefined : promptDraft,
  };
}

/** A saved handoff, or undefined when the stored value is unusable. */
export function restorePlanHandoff(value: unknown): PlanHandoff | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!isSessionId(v.sessionId) || typeof v.command !== 'string' || !v.command) return undefined;
  return { sessionId: v.sessionId, command: v.command };
}
