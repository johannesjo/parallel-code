import { createSignal } from 'solid-js';
import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { AgentDef } from '../ipc/types';
import type { Agent } from './types';
import { refreshTaskStatus, clearAgentActivity, markAgentSpawned } from './taskStatus';
import { saveState } from './persistence';
import { refreshUsage, usageProviderForAgent } from './usage';
import { assignFreshSessionId } from './session-ids';
import { widenTaskColumnForAgentPanes } from './task-column';
import { forgetAgentPrompts } from '../lib/prompt-history';

const [agentsLoaded, setAgentsLoaded] = createSignal(false);
const [agentsLoadFailed, setAgentsLoadFailed] = createSignal(false);

/** False until the first agent list arrived, so "none installed" is not shown while it is empty. */
export { agentsLoaded };
/** The listing failed, so an empty agent list says nothing about what is installed. */
export { agentsLoadFailed };

export async function loadAgents(): Promise<void> {
  try {
    const defaults = await invoke<AgentDef[]>(IPC.ListAgents);
    const custom = store.customAgents;
    const customIds = new Set(custom.map((a) => a.id));
    setStore('availableAgents', [...defaults.filter((d) => !customIds.has(d.id)), ...custom]);
    setAgentsLoaded(true);
    setAgentsLoadFailed(false);
  } catch (error) {
    setAgentsLoadFailed(true);
    throw error;
  }
}

export async function addAgentToTask(taskId: string, agentDef: AgentDef): Promise<string | null> {
  const task = store.tasks[taskId];
  if (!task) return null;

  const agentId = crypto.randomUUID();
  const agent: Agent = {
    id: agentId,
    taskId,
    def: agentDef,
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((s) => {
      s.agents[agentId] = agent;
      assignFreshSessionId(s, taskId, agentId, agentDef.command);
      s.tasks[taskId].agentIds.push(agentId);
      s.tasks[taskId].selectedAgentId = agentId;
      s.activeAgentId = agentId;
      s.lastAgentId = agentDef.id;
    }),
  );

  // The new pane splits the task body; keep every pane workable.
  widenTaskColumnForAgentPanes(taskId);

  // Start the agent as "busy" immediately, before any PTY data arrives.
  markAgentSpawned(agentId);
  void saveState();
  return agentId;
}

export async function closeAgentInTask(taskId: string, agentId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.agentIds.length <= 1 || !task.agentIds.includes(agentId)) return;

  await invoke(IPC.KillAgent, { agentId }).catch(console.error);
  clearAgentActivity(agentId);

  setStore(
    produce((s) => {
      const t = s.tasks[taskId];
      if (!t) return;

      const idx = t.agentIds.indexOf(agentId);
      if (idx === -1 || t.agentIds.length <= 1) return;
      forgetAgentPrompts(t, agentId);

      if (idx === 0) {
        t.mainAgentView = undefined;
        t.codexChatThreadId = undefined;
        t.codexChatHandoff = undefined;
        t.claudeChatSessionId = undefined;
        t.chatPermissionMode = undefined;
      }
      t.agentIds.splice(idx, 1);
      const promptedAgentIds = t.promptedAgentIds?.filter((id) => id !== agentId);
      t.promptedAgentIds =
        promptedAgentIds && promptedAgentIds.length > 0 ? promptedAgentIds : undefined;
      delete s.agents[agentId];

      const fallbackAgentId = t.agentIds[Math.min(idx, t.agentIds.length - 1)] ?? null;
      if (s.activeAgentId === agentId) {
        s.activeAgentId = fallbackAgentId;
      }
      if (t.selectedAgentId === agentId) {
        t.selectedAgentId = fallbackAgentId ?? undefined;
      }
    }),
  );

  refreshTaskStatus(taskId);
  void saveState();
}

export function markAgentExited(
  agentId: string,
  exitInfo: { exit_code: number | null; signal: string | null; last_output: string[] },
): void {
  const agent = store.agents[agentId];
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'exited';
        s.agents[agentId].canvasTools = undefined;
        s.agents[agentId].capabilities = undefined;
        s.agents[agentId].sessionInstanceId = undefined;
        s.agents[agentId].exitCode = exitInfo.exit_code;
        s.agents[agentId].signal = exitInfo.signal;
        s.agents[agentId].lastOutput = exitInfo.last_output;
      }
    }),
  );
  if (agent) {
    clearAgentActivity(agentId);
    refreshTaskStatus(agent.taskId);
    // A finished session just moved its agent's meter; the slow poll would lag by minutes.
    const provider = usageProviderForAgent(agent.def.id);
    if (provider) void refreshUsage(provider);
  }
}

export function restartAgent(agentId: string, useResumeArgs: boolean): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'running';
        s.agents[agentId].canvasTools = undefined;
        s.agents[agentId].capabilities = undefined;
        s.agents[agentId].sessionInstanceId = undefined;
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = useResumeArgs;
        s.agents[agentId].spawnDelayMs = undefined;
        s.agents[agentId].attachExisting = false;
        s.agents[agentId].generation += 1;
        // A resume continues the pane's existing session, so its id stands.
        // A restart without resume is a new conversation and needs a new one.
        if (!useResumeArgs) {
          s.agents[agentId].requireResumeSuccess = undefined;
          const agent = s.agents[agentId];
          assignFreshSessionId(s, agent.taskId, agentId, agent.def.command);
          const task = s.tasks[agent.taskId];
          if (task) forgetAgentPrompts(task, agentId);
        }
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function switchAgent(agentId: string, newDef: AgentDef): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        // Switching CLI starts a fresh conversation, and the new CLI may not
        // take an assigned id at all — so re-decide rather than carry over.
        assignFreshSessionId(s, s.agents[agentId].taskId, agentId, newDef.command);
        const task = s.tasks[s.agents[agentId].taskId];
        if (task) forgetAgentPrompts(task, agentId);
        s.agents[agentId].def = newDef;
        s.agents[agentId].status = 'running';
        s.agents[agentId].canvasTools = undefined;
        s.agents[agentId].capabilities = undefined;
        s.agents[agentId].sessionInstanceId = undefined;
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = false;
        s.agents[agentId].spawnDelayMs = undefined;
        s.agents[agentId].attachExisting = false;
        s.agents[agentId].generation += 1;
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function addCustomAgent(agent: AgentDef): void {
  setStore(
    produce((s) => {
      s.customAgents.push(agent);
    }),
  );
  void refreshAvailableAgents();
}

export function removeCustomAgent(agentId: string): void {
  setStore(
    produce((s) => {
      s.customAgents = s.customAgents.filter((a) => a.id !== agentId);
      // Custom agent ids are slugs of the name, so a later agent with the same
      // name would otherwise silently inherit this one's env file.
      delete s.agentEnvFiles[agentId];
    }),
  );
  void refreshAvailableAgents();
}

/** Point an agent at a `KEY=VALUE` env file, or clear it with an empty path.
 *  Applies to built-in and custom agents alike, and takes effect on the next
 *  spawn — the file itself is read by the main process, never by the renderer. */
export function setAgentEnvFile(agentId: string, filePath: string): void {
  const trimmed = filePath.trim();
  setStore(
    produce((s) => {
      if (trimmed) s.agentEnvFiles[agentId] = trimmed;
      else delete s.agentEnvFiles[agentId];
    }),
  );
}

/** Rebuild availableAgents from backend defaults + custom agents. */
async function refreshAvailableAgents(): Promise<void> {
  const defaults = await invoke<AgentDef[]>(IPC.ListAgents);
  const custom = store.customAgents;
  const customIds = new Set(custom.map((a) => a.id));
  setStore('availableAgents', [...defaults.filter((d) => !customIds.has(d.id)), ...custom]);
}

/** Capability comes from the completed launch, including reattachment to an existing PTY. */
export function setAgentCanvasTools(agentId: string, available: boolean): void {
  if (store.agents[agentId]?.status === 'running')
    setStore('agents', agentId, 'canvasTools', available);
}
