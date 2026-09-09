/**
 * The workspace's interactive agent is an ordinary task agent. Each document
 * project gets a hidden task, kept out of the task order so it never shows in
 * the sidebar. It is persisted with its agents, and the task terminal, its prompt
 * box, the last-prompt bar and the agent chips are reused as they are.
 */
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { effectiveAgentId } from '../store/agent-select';
import { restartAgent } from '../store/agents';
import { getAgentHookStatus } from '../store/agentHookStatus';
import { setActiveTask } from '../store/navigation';
import {
  createAgentRecord,
  forgetTask,
  sendPrompt,
  setInitialPrompt,
  setPrefillPrompt,
} from '../store/tasks';
import { isAgentAskingQuestion, isAgentIdle, markAgentSpawned } from '../store/taskStatus';
import type { AgentDef } from '../ipc/types';
import type { Project, Task } from '../store/types';
import { documentMainAgentId } from './store';
import { setRailTab } from './workspace-ui';
import { documentAgentTaskId, isDocumentAgentTaskId } from './task-id';
export { documentAgentTaskId, isDocumentAgentTaskId } from './task-id';

function terminalAgentDef(project: Project): AgentDef | undefined {
  const installed = store.availableAgents.filter((a) => a.available !== false);
  const wanted = project.documentTerminalAgentId ?? documentMainAgentId(project);
  return installed.find((a) => a.id === wanted) ?? installed[0];
}

/** The project's agent task, created on first use. Null while no agent is installed. */
export function ensureDocumentAgentTask(project: Project): Task | null {
  const id = documentAgentTaskId(project.id);
  const existing = store.tasks[id];
  if (existing) return existing;
  const def = terminalAgentDef(project);
  if (!def) return null;
  const agent = createAgentRecord({ id, taskId: id, def, attachExisting: true });
  const task: Task = {
    id,
    name: project.name,
    projectId: project.id,
    gitIsolation: 'none',
    branchName: '',
    worktreePath: project.path,
    agentIds: [id],
    selectedAgentId: id,
    // Start with one visible agent, as in the simplified document task layout.
    aiTerminalLayout: 'tabs',
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  };
  setStore(
    produce((s) => {
      s.agents[id] = agent;
      s.tasks[id] = task;
    }),
  );
  markAgentSpawned(id);
  return store.tasks[id] ?? null;
}

/**
 * Readies the task's agents for a terminal about to mount. A live session is
 * attached to again: restart and switch clear the flag for the one spawn that
 * replaces a session, and the next mount must not spawn a second time. A
 * session that exited is resumed by the mount, so its record is reset
 * the way a restart resets it, or the exit badge would sit over a live agent.
 */
export function rearmDocumentAgents(task: Task): void {
  for (const id of task.agentIds) {
    const agent = store.agents[id];
    if (!agent) continue;
    if (agent.status === 'exited') restartAgent(id, true);
    else setStore('agents', id, 'attachExisting', true);
  }
}

/**
 * Hands `text` to the workspace's selected agent, bringing its tab up first.
 * A first agent that is still booting, busy or asking something gets it
 * queued: the prompt box sends it once the agent looks idle, as it does for a
 * new task's initial prompt. Only one instruction can wait. Any other agent
 * is written to right away, like a typed prompt.
 */
export async function sendToDocumentAgent(project: Project, text: string): Promise<void> {
  const task = ensureDocumentAgentTask(project);
  const agentId = task ? effectiveAgentId(task) : null;
  if (!task || !agentId) throw new Error('No agent is installed.');
  setRailTab('agent');
  if (store.agents[agentId]?.resumed) {
    // A missing PTY may have reopened at a session picker. Never send prose
    // into that picker; keep it in the prompt box for an explicit send.
    if (agentId !== task.agentIds[0]) {
      throw new Error('Resume the selected session and send the instruction in its terminal.');
    }
    if (task.initialPrompt || task.prefillPrompt || task.promptDraft?.trim()) {
      throw new Error('Send or clear the existing prompt before adding another instruction.');
    }
    setPrefillPrompt(task.id, text);
    return;
  }
  if (looksIdle(agentId) || agentId !== task.agentIds[0]) {
    await sendPrompt(task.id, agentId, text);
    return;
  }
  if (task.initialPrompt) {
    throw new Error('The agent has not taken the previous instruction yet.');
  }
  setInitialPrompt(task.id, text);
}

/** Quiet output is the only sign for most agents; Claude's hooks say outright
 *  whether a turn is in flight or the agent waits on the user. */
function looksIdle(agentId: string): boolean {
  const hook = getAgentHookStatus(agentId)?.state;
  if (hook === 'working' || hook === 'waiting') return false;
  return isAgentIdle(agentId) && !isAgentAskingQuestion(agentId);
}

/** Makes the workspace's task the active one so its terminal and prompt box
 *  take focus and the send-prompt shortcut reaches them. */
export function activateDocumentAgentTask(project: Project): void {
  const task = ensureDocumentAgentTask(project);
  if (task && store.activeTaskId !== task.id) setActiveTask(task.id);
}

function isOpenPanel(id: string | null): id is string {
  if (!id || isDocumentAgentTaskId(id)) return false;
  return store.tasks[id] !== undefined || store.terminals[id] !== undefined;
}

/** Hands the active task back to `previousId` when the workspace closes, or
 *  to the first task when that one is gone meanwhile. */
export function releaseDocumentAgentTask(previousId: string | null): void {
  if (!isDocumentAgentTaskId(store.activeTaskId)) return;
  const next = isOpenPanel(previousId) ? previousId : store.taskOrder.find(isOpenPanel);
  if (next) setActiveTask(next);
  else setStore({ activeTaskId: null, activeAgentId: null });
}

/** Ends the project's sessions and forgets the task; for when the project is
 *  removed, since nothing else would ever kill these ptys. */
export async function disposeDocumentAgentTask(projectId: string): Promise<void> {
  const task = store.tasks[documentAgentTaskId(projectId)];
  if (!task) return;
  const agentIds = [...task.agentIds];
  if (store.activeTaskId === task.id) releaseDocumentAgentTask(null);
  await Promise.allSettled(
    agentIds.map((id) => invoke(IPC.KillAgent, { agentId: id }).catch(console.error)),
  );
  forgetTask(task.id, agentIds);
}
