/** Task actions that reach claude.ai: Remote Control for the running agent, and a cloud handoff. */

import { cloudLaunchArgs, isClaudeCommand, remoteControlCommand } from '../lib/claude-cloud';
import { isAgentChat } from './agent-chat';
import { setStore, store } from './core';
import { spawnProgramForTask, typeIntoAgent } from './tasks';
import { isAgentAskingQuestion } from './taskStatus';
import type { Agent, Task } from './types';

/**
 * The task's lead agent when it is a running Claude terminal, the only kind
 * `/remote-control` can be typed into. The chat view drives the CLI without
 * its TUI, which Remote Control does not document support for.
 */
export function remoteControlAgent(task: Task): Agent | null {
  const agentId = task.agentIds[0];
  const agent = agentId ? store.agents[agentId] : undefined;
  // A Docker agent's claude.ai sign-in is not verified to reach Remote Control.
  if (task.dockerMode || task.closingStatus) return null;
  if (!agent || agent.status !== 'running' || !isClaudeCommand(agent.def.command)) return null;
  return isAgentChat(task, agent.id) ? null : agent;
}

/**
 * Why typing `/remote-control` into the agent now would go wrong, or null. It would
 * join a draft in the prompt, and on a question or permission dialog its Enter
 * would pick the highlighted option.
 */
export function remoteControlBlocker(task: Task, agent: Agent): string | null {
  if (task.terminalInputPending) return 'Send or clear the text typed in the agent terminal first.';
  if (isAgentAskingQuestion(agent.id)) return 'Answer the question in the agent terminal first.';
  return null;
}

/** Whether Remote Control was turned on in this agent's current session. */
export function remoteControlStarted(agent: Agent): boolean {
  return agent.remoteControlGeneration === agent.generation;
}

/**
 * Turns on Remote Control, named after the task; once on, opens the CLI's
 * status panel instead, where the session URL and Disconnect live.
 */
export async function runRemoteControl(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  const agent = task ? remoteControlAgent(task) : null;
  if (!task || !agent || remoteControlBlocker(task, agent)) return;
  const started = remoteControlStarted(agent);
  const generation = agent.generation;
  // Not sendPrompt: a slash command starts no turn, so it must not mark the agent
  // busy or enter the prompt history.
  await typeIntoAgent(taskId, agent.id, remoteControlCommand(task.name, !started));
  // shortcut: recorded once sent, even if the user declines the CLI's confirmation;
  // a later click then sends a bare `/remote-control`, which asks again unnamed.
  // A restart while sending spawns a session that never saw the command.
  if (store.agents[agent.id]?.generation === generation)
    setStore('agents', agent.id, 'remoteControlGeneration', generation);
}

/**
 * The Claude command a cloud handoff runs, from the task's own lead agent so a
 * custom install path carries over. A Docker task's terminals run inside its
 * container, which has no claude.ai sign-in for `--cloud`.
 */
export function cloudHandoffCommand(task: Task): string | null {
  return cloudHandoffAgent(task)?.def.command ?? null;
}

function cloudHandoffAgent(task: Task): Agent | null {
  if (task.dockerMode || task.closingStatus) return null;
  const agentId = task.agentIds[0];
  const agent = agentId ? store.agents[agentId] : undefined;
  return agent && isClaudeCommand(agent.def.command) ? agent : null;
}

/**
 * Starts a cloud session from the task's worktree in a new task terminal, where its setup checklist shows.
 * shortcut: only the shell count persists, so after an app restart the terminal comes back
 * as a plain shell — persist launches with shells if that surprises users.
 */
export function startCloudSession(taskId: string, prompt: string): void {
  const task = store.tasks[taskId];
  const agent = task ? cloudHandoffAgent(task) : null;
  if (!agent) return;
  spawnProgramForTask(taskId, {
    command: agent.def.command,
    args: cloudLaunchArgs(prompt),
    envFile: store.agentEnvFiles[agent.def.id],
  });
}
