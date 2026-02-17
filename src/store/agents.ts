import { produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { AgentDef } from "../ipc/types";
import type { Agent } from "./types";

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
  };

  setStore(
    produce((s) => {
      s.agents[agentId] = agent;
      s.tasks[taskId].agentIds.push(agentId);
      s.activeAgentId = agentId;
    })
  );
}

export function markAgentExited(agentId: string, code: number | null): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = "exited";
        s.agents[agentId].exitCode = code;
      }
    })
  );
}
