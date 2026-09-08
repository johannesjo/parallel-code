import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { AgentDef } from '../ipc/types';
import type { Agent } from './types';
import { refreshTaskStatus, clearAgentActivity, markAgentSpawned } from './taskStatus';
import { saveState } from './persistence';
import { refreshUsage, usageProviderForAgent } from './usage';

export async function loadAgents(): Promise<void> {
  const defaults = await invoke<AgentDef[]>(IPC.ListAgents);
  const custom = store.customAgents;
  const customIds = new Set(custom.map((a) => a.id));
  setStore('availableAgents', [...defaults.filter((d) => !customIds.has(d.id)), ...custom]);
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
      s.tasks[taskId].agentIds.push(agentId);
      s.tasks[taskId].selectedAgentId = agentId;
      s.activeAgentId = agentId;
      s.lastAgentId = agentDef.id;
    }),
  );

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
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = useResumeArgs;
        s.agents[agentId].spawnDelayMs = undefined;
        s.agents[agentId].attachExisting = false;
        s.agents[agentId].generation += 1;
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function switchAgent(agentId: string, newDef: AgentDef): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].def = newDef;
        s.agents[agentId].status = 'running';
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
