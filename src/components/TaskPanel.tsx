import { Show, createMemo } from "solid-js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  store,
  closeTask,
  setActiveTask,
  markAgentExited,
  addAgentToTask,
  updateTaskName,
  updateTaskNotes,
  toggleTaskCollapsed,
  spawnShellForTask,
} from "../store/store";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { EditableText } from "./EditableText";
import { IconButton } from "./IconButton";
import { InfoBar } from "./InfoBar";
import { PromptInput } from "./PromptInput";
import { ChangedFilesList } from "./ChangedFilesList";
import { TerminalView } from "./TerminalView";
import { theme } from "../lib/theme";
import type { Task } from "../store/types";

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  // Ensure shell PTY is spawned
  const shellAgentId = createMemo(() => {
    const id = props.task.shellAgentId;
    if (!id) {
      return spawnShellForTask(props.task.id);
    }
    return id;
  });

  const firstAgent = () => {
    const ids = props.task.agentIds;
    return ids.length > 0 ? store.agents[ids[0]] : undefined;
  };

  const firstAgentId = () => props.task.agentIds[0] ?? "";

  function titleBar(): PanelChild {
    return {
      id: "title",
      initialSize: 32,
      minSize: 32,
      content: () => (
        <div
          class={props.isActive ? "island-header-active" : ""}
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            padding: "0 10px",
            height: "100%",
            background: theme.islandBg,
            "border-bottom": `1px solid ${theme.border}`,
            "user-select": "none",
          }}
          onClick={() => setActiveTask(props.task.id)}
        >
          <div
            style={{
              overflow: "hidden",
              flex: "1",
              "min-width": "0",
            }}
          >
            <EditableText
              value={props.task.name}
              onCommit={(v) => updateTaskName(props.task.id, v)}
              class="editable-text"
            />
          </div>
          <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
            <IconButton
              icon={props.task.collapsed ? "+" : "-"}
              onClick={() => toggleTaskCollapsed(props.task.id)}
              title={props.task.collapsed ? "Expand" : "Collapse"}
              size="sm"
            />
            <IconButton
              icon="+"
              onClick={() => {
                const agent = store.availableAgents[0];
                if (agent) addAgentToTask(props.task.id, agent);
              }}
              title="Add agent"
              size="sm"
            />
            <IconButton
              icon="x"
              onClick={() => closeTask(props.task.id)}
              title="Close task"
              size="sm"
            />
          </div>
        </div>
      ),
    };
  }

  function branchInfoBar(): PanelChild {
    return {
      id: "branch",
      initialSize: 28,
      fixed: true,
      content: () => (
        <InfoBar
          title={props.task.worktreePath}
          onClick={() => revealItemInDir(props.task.worktreePath).catch(() => {})}
        >
          <span style={{ "margin-right": "8px", color: theme.accent }}>
            {props.task.branchName}
          </span>
          <span style={{ opacity: 0.6 }}>{props.task.worktreePath}</span>
        </InfoBar>
      ),
    };
  }

  function notesAndFiles(): PanelChild {
    return {
      id: "notes-files",
      initialSize: 300,
      minSize: 80,
      content: () => (
        <ResizablePanel
          direction="horizontal"
          children={[
            {
              id: "notes",
              initialSize: 200,
              minSize: 100,
              content: () => (
                <textarea
                  value={props.task.notes}
                  onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
                  placeholder="Notes..."
                  style={{
                    width: "100%",
                    height: "100%",
                    background: theme.bg,
                    border: "none",
                    padding: "6px 8px",
                    color: theme.fg,
                    "font-size": "11px",
                    "font-family": "'JetBrains Mono', monospace",
                    resize: "none",
                    outline: "none",
                  }}
                />
              ),
            },
            {
              id: "changed-files",
              initialSize: 200,
              minSize: 100,
              content: () => (
                <div
                  style={{
                    height: "100%",
                    background: theme.bgElevated,
                    "border-left": `1px solid ${theme.border}`,
                    display: "flex",
                    "flex-direction": "column",
                  }}
                >
                  <div
                    style={{
                      padding: "4px 8px",
                      "font-size": "10px",
                      "font-weight": "600",
                      color: theme.fgMuted,
                      "text-transform": "uppercase",
                      "letter-spacing": "0.05em",
                      "border-bottom": `1px solid ${theme.border}`,
                      "flex-shrink": "0",
                    }}
                  >
                    Changed Files
                  </div>
                  <div style={{ flex: "1", overflow: "hidden" }}>
                    <ChangedFilesList worktreePath={props.task.worktreePath} />
                  </div>
                </div>
              ),
            },
          ]}
        />
      ),
    };
  }

  function shellTerminal(): PanelChild {
    return {
      id: "shell",
      initialSize: 48,
      minSize: 32,
      content: () => (
        <div style={{ height: "100%", background: theme.bg }}>
          <TerminalView
            agentId={shellAgentId()}
            command={getShellCommand()}
            args={["-l"]}
            cwd={props.task.worktreePath}
            onExit={() => {}}
          />
        </div>
      ),
    };
  }

  function lastPromptBar(): PanelChild {
    return {
      id: "last-prompt",
      initialSize: 28,
      fixed: true,
      content: () => (
        <InfoBar title={props.task.lastPrompt || "No prompts sent yet"}>
          <span style={{ opacity: props.task.lastPrompt ? 1 : 0.4 }}>
            {props.task.lastPrompt
              ? `> ${props.task.lastPrompt}`
              : "No prompts sent"}
          </span>
        </InfoBar>
      ),
    };
  }

  function aiTerminal(): PanelChild {
    const agent = firstAgent();
    return {
      id: "ai-terminal",
      initialSize: 300,
      minSize: 80,
      content: () => (
        <div style={{ height: "100%", position: "relative", background: theme.bg }}>
          <Show when={agent}>
            {(a) => (
              <>
                <Show when={a().status === "exited"}>
                  <div
                    class="exit-badge"
                    style={{
                      position: "absolute",
                      top: "8px",
                      right: "12px",
                      "z-index": "10",
                      "font-size": "11px",
                      color: a().exitCode === 0 ? theme.success : theme.error,
                      background: `${theme.islandBg}cc`,
                      padding: "4px 12px",
                      "border-radius": "8px",
                      border: `1px solid ${theme.border}`,
                    }}
                  >
                    Process exited ({a().exitCode ?? "?"})
                  </div>
                </Show>
                <TerminalView
                  agentId={a().id}
                  command={a().def.command}
                  args={a().def.args}
                  cwd={props.task.worktreePath}
                  onExit={(code) => markAgentExited(a().id, code)}
                />
              </>
            )}
          </Show>
        </div>
      ),
    };
  }

  function promptInput(): PanelChild {
    return {
      id: "prompt",
      initialSize: 68,
      minSize: 54,
      content: () => (
        <PromptInput taskId={props.task.id} agentId={firstAgentId()} />
      ),
    };
  }

  return (
    <div
      class={`task-column ${props.isActive ? "active" : ""}`}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        background: theme.islandBg,
        "border-radius": "12px",
        border: `1px solid ${props.isActive ? theme.borderFocus : theme.border}`,
        overflow: "hidden",
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <Show
        when={!props.task.collapsed}
        fallback={titleBar().content()}
      >
        <ResizablePanel
          direction="vertical"
          children={[
            titleBar(),
            branchInfoBar(),
            notesAndFiles(),
            shellTerminal(),
            lastPromptBar(),
            aiTerminal(),
            promptInput(),
          ]}
        />
      </Show>
    </div>
  );
}

function getShellCommand(): string {
  // Detect user's shell from env or fallback
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
    ? "cmd"
    : "bash";
}
