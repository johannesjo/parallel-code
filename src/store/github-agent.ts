/**
 * The GitHub page's agent: a hidden task in the project checkout, like a
 * document workspace agent. It can publish issue lists to the page.
 */
import { ensureHiddenAgentTask } from '../documents/agent-task';
import { githubAgentTaskId } from '../documents/task-id';
import type { AgentDef } from '../ipc/types';
import { agentsLoadFailed, agentsLoaded } from './agents';
import { store } from './core';
import { isSupportedDelegationAgent } from './delegation';
import { setPrefillPrompt } from './tasks';
import type { Project, Task } from './types';

/** Only CLIs the app can give its MCP tools can publish lists, so they come first. */
function pickGitHubAgent(): AgentDef | undefined {
  const installed = store.availableAgents.filter((a) => a.available !== false);
  const capable = installed.filter(isSupportedDelegationAgent);
  return (
    capable.find((a) => a.id === store.lastAgentId) ??
    capable[0] ??
    installed.find((a) => a.id === store.lastAgentId) ??
    installed[0]
  );
}

/** Whether an installed agent could run the GitHub agent task. */
export function canStartGitHubAgent(): boolean {
  return pickGitHubAgent() !== undefined;
}

/** Why the GitHub agent can or cannot start; the UI words each state the same way. */
export function githubAgentAvailability(): 'loading' | 'failed' | 'none' | 'ready' {
  if (!agentsLoaded()) return agentsLoadFailed() ? 'failed' : 'loading';
  return canStartGitHubAgent() ? 'ready' : 'none';
}

/** The project's GitHub agent task, created on first use. Null while no agent is installed. */
export function ensureGitHubAgentTask(project: Project): Task | null {
  return ensureProjectAgentTask(githubAgentTaskId(project.id), project);
}

/** A hidden agent task in the project checkout under `id`, created on first use. */
export function ensureProjectAgentTask(id: string, project: Project): Task | null {
  return ensureHiddenAgentTask(id, project, pickGitHubAgent);
}

/** Puts `text` in the GitHub agent's prompt box for the user to edit and send. */
export function prefillGitHubAgentPrompt(project: Project, text: string): boolean {
  const task = ensureGitHubAgentTask(project);
  if (!task) return false;
  setPrefillPrompt(task.id, text);
  return true;
}
