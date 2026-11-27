import { batch } from 'solid-js';
import { produce } from 'solid-js/store';
import { store, setStore } from './core';
import { restartAgent } from './agents';
import { isAgentChat } from './agent-chat';
import { listResumableSessions, resumeAgentSession } from './sessions';
import { saveState } from './persistence';
import { UNSENT_TERMINAL_INPUT, planHandoffBlocker, planHandoffPrompt } from '../lib/plan-handoff';
import { canResumeSessionId } from '../../electron/shared/session-resume';

/** Why the task's plan can't be handed to a fresh session now, or null. The
 *  first pane is the one the plan viewer's feedback and the prompt box target. */
export function taskPlanHandoffBlocker(taskId: string): string | null {
  const task = store.tasks[taskId];
  const agentId = task?.agentIds[0];
  const agent = agentId ? store.agents[agentId] : undefined;
  if (!task || !agentId || !agent) return 'No agent to hand the plan to.';
  return planHandoffBlocker({
    planContent: task.planContent,
    hasTerminalAgent: !isAgentChat(task, agentId),
    canReopenSession: canResumeSessionId(agent.def.command),
    coordinated: Boolean(task.coordinatedBy),
    promptDraft: task.promptDraft,
    terminalInputPending: task.terminalInputPending,
    initialPrompt: task.initialPrompt,
  });
}

/**
 * The session the pane is planning in, so it can be reopened. Claude panes
 * carry the id PC gave them; Codex picks its own, so read it back from the
 * transcript index.
 */
async function planningSessionId(taskId: string, agentId: string): Promise<string | undefined> {
  const task = store.tasks[taskId];
  const command = store.agents[agentId]?.def.command;
  if (!task || !command) return undefined;
  const known = task.agentSessionIds?.[agentId];
  if (known) return known;
  // shortcut: the newest session in the worktree is the planner's only while no
  // other pane runs the same CLI — per-pane Codex session tracking removes the guess.
  // A shared project folder also holds other tasks' and the user's own sessions.
  if (task.gitIsolation !== 'worktree') return undefined;
  if (task.agentIds.filter((id) => store.agents[id]?.def.command === command).length !== 1)
    return undefined;
  return (await listResumableSessions(taskId, command))[0]?.id;
}

/**
 * Restart the task's first pane with an empty context and the approved plan as
 * its first prompt. The planning session is remembered first, so the user can
 * go back if the handoff fails; without it nothing is changed. Resolves to the reason nothing happened, or
 * null once the restart is under way.
 */
export async function implementPlanInFreshSession(taskId: string): Promise<string | null> {
  const before = taskPlanHandoffBlocker(taskId);
  if (before) return before;
  const agentId = store.tasks[taskId].agentIds[0];
  const command = store.agents[agentId].def.command;
  const sessionId = await planningSessionId(taskId, agentId);
  // The lookup awaited the filesystem; the user may have typed or switched agent.
  const task = store.tasks[taskId];
  if (task?.agentIds[0] !== agentId || store.agents[agentId]?.def.command !== command)
    return 'The agent changed. Try again.';
  const after = taskPlanHandoffBlocker(taskId);
  if (after) return after;
  // Handing over again from the implementing session keeps Back on the planner.
  const kept = planningSessionToReturnTo(taskId) ? task.planHandoff : undefined;
  const handoff = kept ?? (sessionId ? { sessionId, command } : undefined);
  // The way back is the point of keeping the old session; don't hand off without it.
  if (!handoff)
    return 'Could not tell which session the plan was made in, so nothing was changed. Close other panes running the same agent and try again.';
  const prompt = planHandoffPrompt({
    content: task.planContent ?? '',
    path: task.planPath ?? task.planFileName ?? 'the plan file',
  });
  // One update: the prompt box's auto-send must first see the prompt on the new
  // launch, never on the planning process that is about to be stopped.
  batch(() => {
    setStore(
      produce((s) => {
        const t = s.tasks[taskId];
        if (!t) return;
        t.planHandoff = handoff;
        t.initialPrompt = prompt;
        // The fresh launch has not had its first prompt; while it is marked as
        // prompted, an app restart before delivery would skip the plan.
        const prompted = t.promptedAgentIds?.filter((id) => id !== agentId);
        t.promptedAgentIds = prompted?.length ? prompted : undefined;
        // Otherwise a later resume of this pane reopens the chat's Codex thread.
        t.codexChatHandoff = undefined;
        // The prompt box is what sends the plan, so it shows on this task
        // until the plan is sent, whatever the "Show prompt input" setting.
        t.promptInputRevealed = true;
      }),
    );
    restartAgent(agentId, false);
  });
  void saveState();
  return null;
}

/** The planning session the first pane can go back to, if any. */
export function planningSessionToReturnTo(taskId: string): string | undefined {
  const task = store.tasks[taskId];
  const agentId = task?.agentIds[0];
  const handoff = task?.planHandoff;
  if (!task || !agentId || !handoff) return undefined;
  // The pane now runs another CLI, which can't open this session.
  if (store.agents[agentId]?.def.command !== handoff.command) return undefined;
  if (task.agentSessionIds?.[agentId] === handoff.sessionId) return undefined;
  return handoff.sessionId;
}

/** Why the first pane can't go back to the planning session now, or null. */
export function returnToPlanningBlocker(taskId: string): string | null {
  return store.tasks[taskId]?.terminalInputPending ? UNSENT_TERMINAL_INPUT : null;
}

/** Reopen the planning session in the first pane, stopping whatever runs there.
 *  The stopped session stays in the session history. Returns why nothing
 *  happened, or null once the pane is restarting. */
export function returnToPlanningSession(taskId: string): string | null {
  const sessionId = planningSessionToReturnTo(taskId);
  const agentId = store.tasks[taskId]?.agentIds[0];
  if (!sessionId || !agentId) return 'There is no planning session to go back to.';
  const blocked = returnToPlanningBlocker(taskId);
  if (blocked) return blocked;
  batch(() => {
    setStore(
      produce((s) => {
        const t = s.tasks[taskId];
        if (!t) return;
        t.planHandoff = undefined;
        // A plan still queued for the fresh session must not land in the planning one.
        t.initialPrompt = undefined;
      }),
    );
    resumeAgentSession(taskId, agentId, sessionId);
  });
  return null;
}
