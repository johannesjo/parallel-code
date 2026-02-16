import { For, Show } from "solid-js";
import { store, closeTask, setActiveTask, markAgentExited, addAgentToTask } from "../store/store";
import { TerminalView } from "./TerminalView";
import { theme } from "../lib/theme";
import type { Task } from "../store/types";

interface TaskColumnProps {
  task: Task;
  isActive: boolean;
}

export function TaskColumn(props: TaskColumnProps) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        flex: "1 1 0",
        "min-width": "300px",
        height: "100%",
        background: theme.bg,
        margin: "4px 2px",
        "border-radius": theme.islandRadius,
        border: `1px solid ${props.isActive ? theme.borderFocus : theme.islandBorder}`,
        overflow: "hidden",
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "8px 12px",
          background: theme.islandBg,
          "border-bottom": `1px solid ${theme.border}`,
          "min-height": "40px",
          "user-select": "none",
        }}
      >
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px", overflow: "hidden" }}>
          <span
            style={{
              "font-size": "13px",
              "font-weight": "500",
              color: theme.fg,
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
          >
            {props.task.name}
          </span>
          <span
            style={{
              "font-size": "11px",
              color: theme.fgMuted,
              "font-family": "'JetBrains Mono', monospace",
            }}
          >
            {props.task.branchName}
          </span>
        </div>
        <div style={{ display: "flex", gap: "4px", "flex-shrink": "0" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const firstAgent = store.availableAgents[0];
              if (firstAgent) addAgentToTask(props.task.id, firstAgent);
            }}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
              cursor: "pointer",
              "border-radius": "6px",
              padding: "2px 8px",
              "font-size": "12px",
              transition: "background 0.15s",
            }}
            title="Add agent"
          >
            +
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeTask(props.task.id);
            }}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
              cursor: "pointer",
              "border-radius": "6px",
              padding: "2px 8px",
              "font-size": "12px",
              transition: "background 0.15s",
            }}
            title="Close task"
          >
            x
          </button>
        </div>
      </div>

      {/* Agent terminals */}
      <div style={{ flex: "1", display: "flex", "flex-direction": "column", overflow: "hidden" }}>
        <For each={props.task.agentIds}>
          {(agentId) => {
            const agent = () => store.agents[agentId];
            return (
              <Show when={agent()}>
                {(a) => (
                  <div
                    style={{
                      flex: "1",
                      position: "relative",
                      "border-top": `1px solid ${theme.border}`,
                      overflow: "hidden",
                    }}
                  >
                    <Show when={a().status === "exited"}>
                      <div
                        style={{
                          position: "absolute",
                          top: "6px",
                          right: "10px",
                          "z-index": "10",
                          "font-size": "11px",
                          color: a().exitCode === 0 ? theme.success : theme.error,
                          background: `${theme.bgElevated}dd`,
                          padding: "3px 10px",
                          "border-radius": "6px",
                          border: `1px solid ${theme.border}`,
                        }}
                      >
                        exited ({a().exitCode ?? "?"})
                      </div>
                    </Show>
                    <TerminalView
                      agentId={a().id}
                      command={a().def.command}
                      args={a().def.args}
                      cwd={props.task.worktreePath}
                      onExit={(code) => markAgentExited(a().id, code)}
                    />
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}
