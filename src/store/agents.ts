import { produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { AgentDef } from "../ipc/types";
import type { Agent } from "./types";
import {
  refreshTaskStatus,
  clearAgentActivity,
  markAgentSpawned,
} from "./taskStatus";

export async function loadAgents(): Promise<void> {
  const agents = await invoke<AgentDef[]>("list_agents");
  setStore("availableAgents", agents);
}

export async function addAgentToTask(
  taskId: string,
  agentDef: AgentDef
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const agentId = crypto.randomUUID();
  const agent: Agent = {
    id: agentId,
    taskId,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((s) => {
      s.agents[agentId] = agent;
      s.tasks[taskId].agentIds.push(agentId);
      s.activeAgentId = agentId;
    })
  );

  // Start the agent as "busy" immediately, before any PTY data arrives.
  markAgentSpawned(agentId);
}

export function markAgentExited(
  agentId: string,
  exitInfo: { exit_code: number | null; signal: string | null; last_output: string[] }
): void {
  const agent = store.agents[agentId];
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = "exited";
        s.agents[agentId].exitCode = exitInfo.exit_code;
        s.agents[agentId].signal = exitInfo.signal;
        s.agents[agentId].lastOutput = exitInfo.last_output;
      }
    })
  );
  if (agent) {
    clearAgentActivity(agentId);
    refreshTaskStatus(agent.taskId);
  }
}

export function restartAgent(agentId: string, useResumeArgs: boolean): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = "running";
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = useResumeArgs;
        s.agents[agentId].generation += 1;
      }
    })
  );
  markAgentSpawned(agentId);
}
