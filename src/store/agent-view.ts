/**
 * Moving the main agent's conversation between the chat view and the terminal.
 *
 * Both views drive the same CLI session, so only one of them may hold it: the
 * one being left is shut down first, then the one being entered resumes that
 * exact session id. Without this the two views keep separate conversations and
 * every switch looks like the work was lost.
 */
import { batch } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { restartAgent } from './agents';
import { agentChatProvider } from './agent-chat';
import type { Task } from './types';

export type MainAgentView = 'chat' | 'terminal';

/** Store writes to apply once the CLI on the far side has actually let go. */
type Commit = () => void;
const noop: Commit = () => {};

/**
 * The session the view being entered should pick up, or '' when there is none.
 *
 * Empty means the two views cannot be joined up — a chat that never got a
 * thread, or a terminal pane older than assigned session ids — and the switch
 * then falls back to what it always did: a separate conversation per view.
 */
function agentHandoffSessionId(task: Task, agentId: string, mode: MainAgentView): string {
  return (mode === 'chat' ? task.agentSessionIds?.[agentId] : task.claudeChatSessionId) ?? '';
}

/**
 * Whether switching to `mode` carries the conversation across, rather than
 * leaving both sides running with separate ones.
 *
 * The single answer for everything that depends on it — the preconditions the
 * switch enforces, the confirmation it asks for, and the handoff itself — so
 * they cannot disagree about whether a CLI is about to be quit.
 */
export function agentViewHandsOff(task: Task, agentId: string, mode: MainAgentView): boolean {
  const provider = agentChatProvider(agentId);
  if (!provider) return false;
  // Codex always quits the CLI, reading either its resume id or an unsaved-session
  // footer. Claude's id is assigned up front: without it there is nothing to join.
  return provider === 'codex' || !!agentHandoffSessionId(task, agentId, mode);
}

/** What a switch shuts down, phrased for the confirmation the user gets first. */
export interface ViewSwitchCost {
  title: string;
  message: string;
  confirmLabel: string;
}

/**
 * What switching to `mode` shuts down, or null when it costs nothing.
 *
 * A handoff quits the CLI on the side being left, and that cannot be undone: a
 * running CLI holds state its transcript does not — a half-typed message, a
 * plan it has not written down — so the user decides, not the switch.
 */
export function agentViewSwitchCost(
  task: Task,
  agentId: string,
  mode: MainAgentView,
): ViewSwitchCost | null {
  const provider = agentChatProvider(agentId);
  // Nothing is handed over, so nothing is shut down: the two views keep
  // separate conversations and both sides keep running.
  if (!provider || !agentViewHandsOff(task, agentId, mode)) return null;
  const name = provider === 'claude' ? 'Claude' : 'Codex';
  const shared = 'Chat and the terminal cannot share one session, so';
  if (mode === 'chat') {
    if (store.agents[agentId]?.status === 'exited') return null;
    return {
      title: `Quit the ${name} terminal?`,
      message: `${shared} the terminal's ${name} quits and Chat picks the conversation up where it stopped. The terminal output stays on screen.`,
      confirmLabel: 'Quit and open Chat',
    };
  }
  const chat = store.agents[agentId]?.chatState;
  if (!chat || chat.status === 'closed') return null;
  return {
    title: `Close the ${name} chat?`,
    message: `${shared} the chat closes and ${name} relaunches in the terminal with the same conversation.`,
    confirmLabel: 'Close and open Terminal',
  };
}

async function handoffCodex(task: Task, agentId: string, mode: MainAgentView): Promise<Commit> {
  const session = await invoke<NonNullable<Task['codexChatHandoff']>>(IPC.AgentChat, {
    action: mode === 'chat' ? 'handoffToChat' : 'handoffToTerminal',
    agentId,
  });
  return () => {
    if (mode === 'chat') {
      setStore('tasks', task.id, 'codexChatThreadId', session.threadId);
      setStore('tasks', task.id, 'codexChatHandoff', undefined);
      return;
    }
    setStore('tasks', task.id, 'codexChatHandoff', {
      threadId: session.threadId ?? task.codexChatThreadId,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    });
    restartAgent(agentId, true);
  };
}

async function handoffClaude(task: Task, agentId: string, mode: MainAgentView): Promise<Commit> {
  const sessionId = agentHandoffSessionId(task, agentId, mode);
  if (!sessionId) return noop;
  await invoke(IPC.AgentChat, {
    action: mode === 'chat' ? 'handoffToChat' : 'handoffToTerminal',
    provider: 'claude',
    agentId,
  });
  return () => {
    if (mode === 'chat') {
      setStore('tasks', task.id, 'claudeChatSessionId', sessionId);
      return;
    }
    setStore('tasks', task.id, 'agentSessionIds', (ids) => ({ ...ids, [agentId]: sessionId }));
    // The CLI reads the transcript at launch, so it has to be relaunched to see
    // the turns the chat added. Its scrollback is replayed into the new process.
    restartAgent(agentId, true);
  };
}

/**
 * Hand the conversation to `mode`'s view, then show it.
 *
 * Rejects when the view being left refuses to release the session — a running
 * turn, a CLI that will not quit — leaving the current view on screen with its
 * conversation untouched.
 */
export async function switchMainAgentView(
  taskId: string,
  agentId: string,
  mode: MainAgentView,
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;
  const provider = agentChatProvider(agentId);
  const commit =
    provider === 'codex'
      ? await handoffCodex(task, agentId, mode)
      : provider === 'claude'
        ? await handoffClaude(task, agentId, mode)
        : noop;
  // The task or its agent can be closed while the handoff is in flight; landing
  // these writes afterwards would resurrect state the close just cleared.
  if (!store.tasks[taskId] || !store.agents[agentId]) return;
  batch(() => {
    commit();
    setStore('tasks', taskId, 'mainAgentView', mode);
  });
}
