import { Show, For, createSignal } from "solid-js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  store,
  closeTask,
  mergeTask,
  setActiveTask,
  markAgentExited,
  updateTaskName,
  updateTaskNotes,
  spawnShellForTask,
  closeShell,
  setLastPrompt,
} from "../store/store";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { EditableText } from "./EditableText";
import { IconButton } from "./IconButton";
import { InfoBar } from "./InfoBar";
import { PromptInput } from "./PromptInput";
import { ChangedFilesList } from "./ChangedFilesList";
import { TerminalView } from "./TerminalView";
import { ConfirmDialog } from "./ConfirmDialog";
import { theme } from "../lib/theme";
import type { Task } from "../store/types";

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [mergeError, setMergeError] = createSignal("");
  const [merging, setMerging] = createSignal(false);

  const firstAgent = () => {
    const ids = props.task.agentIds;
    return ids.length > 0 ? store.agents[ids[0]] : undefined;
  };

  const firstAgentId = () => props.task.agentIds[0] ?? "";

  function titleBar(): PanelChild {
    return {
      id: "title",
      initialSize: 50,
      fixed: true,
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
              icon={
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
                </svg>
              }
              onClick={() => setShowMergeConfirm(true)}
              title="Merge into main"
              size="sm"
            />
            <IconButton
              icon={
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              }
              onClick={() => setShowCloseConfirm(true)}
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
          <span style={{ display: "inline-flex", "align-items": "center", gap: "4px", "margin-right": "12px" }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
              <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
            </svg>
            {props.task.branchName}
          </span>
          <span style={{ display: "inline-flex", "align-items": "center", gap: "4px", opacity: 0.6 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
              <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
            </svg>
            {props.task.worktreePath}
          </span>
        </InfoBar>
      ),
    };
  }

  function notesAndFiles(): PanelChild {
    return {
      id: "notes-files",
      initialSize: 120,
      minSize: 60,
      content: () => (
        <ResizablePanel
          direction="horizontal"
          class="focusable-panel"
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
                    background: theme.bgElevated,
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

  function shellSection(): PanelChild {
    return {
      id: "shell-section",
      initialSize: 28,
      minSize: 28,
      requestSize: () => props.task.shellAgentIds.length > 0 ? 200 : 28,
      content: () => (
        <div style={{ height: "100%", display: "flex", "flex-direction": "column", background: theme.bgElevated }}>
          <div
            style={{
              height: "28px",
              "min-height": "28px",
              display: "flex",
              "align-items": "center",
              padding: "0 8px",
              background: theme.bgElevated,
              "border-top": `1px solid ${theme.border}`,
              "border-bottom": `1px solid ${theme.border}`,
              gap: "4px",
            }}
          >
            <button
              class="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                spawnShellForTask(props.task.id);
              }}
              title="Open terminal"
              style={{
                background: "transparent",
                border: `1px solid ${theme.border}`,
                color: theme.fgMuted,
                cursor: "pointer",
                "border-radius": "4px",
                padding: "2px 8px",
                "font-size": "11px",
                "line-height": "1",
                display: "flex",
                "align-items": "center",
                gap: "4px",
              }}
            >
              <span style={{ "font-family": "monospace", "font-size": "13px" }}>&gt;_</span>
              <span>Terminal</span>
            </button>
            <For each={props.task.shellAgentIds}>
              {(shellId, i) => (
                <span
                  style={{
                    "font-size": "10px",
                    color: theme.fgMuted,
                    padding: "2px 4px 2px 8px",
                    "border-radius": "3px",
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "4px",
                  }}
                >
                  shell {i() + 1}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      closeShell(props.task.id, shellId);
                    }}
                    style={{
                      cursor: "pointer",
                      color: theme.fgSubtle,
                      display: "inline-flex",
                      "align-items": "center",
                      padding: "2px",
                      "border-radius": "3px",
                    }}
                    title="Close terminal"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                    </svg>
                  </span>
                </span>
              )}
            </For>
          </div>
          <Show when={props.task.shellAgentIds.length > 0}>
            <div style={{ flex: "1", display: "flex", overflow: "hidden", background: theme.bgElevated }}>
              <For each={props.task.shellAgentIds}>
                {(shellId, i) => (
                  <div
                    style={{
                      flex: "1",
                      "border-left": i() > 0 ? `1px solid ${theme.border}` : "none",
                      overflow: "hidden",
                    }}
                  >
                    <TerminalView
                      agentId={shellId}
                      command={getShellCommand()}
                      args={["-l"]}
                      cwd={props.task.worktreePath}
                      onExit={() => {}}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
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
    return {
      id: "ai-terminal",
      initialSize: 300,
      minSize: 80,
      content: () => (
        <div class="focusable-panel" style={{ height: "100%", position: "relative", background: theme.bgElevated }}>
          <Show when={firstAgent()}>
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
                      background: "color-mix(in srgb, var(--island-bg) 80%, transparent)",
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
                  args={a().resumed && a().def.resume_args?.length ? a().def.resume_args! : a().def.args}
                  cwd={props.task.worktreePath}
                  onExit={(code) => markAgentExited(a().id, code)}
                  onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
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
      initialSize: 62,
      fixed: true,
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
        <ResizablePanel
          direction="vertical"
          children={[
            titleBar(),
            branchInfoBar(),
            notesAndFiles(),
            shellSection(),
            lastPromptBar(),
            aiTerminal(),
            promptInput(),
          ]}
        />
      <ConfirmDialog
        open={showCloseConfirm()}
        title="Close Task"
        message={
          <div>
            <p style={{ margin: "0 0 8px" }}>
              This action cannot be undone. The following will be permanently deleted:
            </p>
            <ul style={{ margin: "0", "padding-left": "20px", display: "flex", "flex-direction": "column", gap: "4px" }}>
              <li>Local feature branch <strong>{props.task.branchName}</strong></li>
              <li>Worktree at <strong>{props.task.worktreePath}</strong></li>
            </ul>
          </div>
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setShowCloseConfirm(false);
          closeTask(props.task.id);
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
      <ConfirmDialog
        open={showMergeConfirm()}
        title="Merge into Main"
        message={
          <div>
            <p style={{ margin: "0 0 8px" }}>
              This will merge <strong>{props.task.branchName}</strong> into the main branch. Afterwards:
            </p>
            <ul style={{ margin: "0", "padding-left": "20px", display: "flex", "flex-direction": "column", gap: "4px" }}>
              <li>All changes will be merged into the main branch</li>
              <li>The worktree at <strong>{props.task.worktreePath}</strong> will be removed</li>
              <li>The feature branch <strong>{props.task.branchName}</strong> will be deleted</li>
            </ul>
            <Show when={mergeError()}>
              <div style={{
                "margin-top": "12px",
                "font-size": "12px",
                color: theme.error,
                background: "#f7546414",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f7546433",
              }}>
                {mergeError()}
              </div>
            </Show>
          </div>
        }
        confirmLabel={merging() ? "Merging..." : "Merge"}
        onConfirm={async () => {
          setMergeError("");
          setMerging(true);
          try {
            await mergeTask(props.task.id);
            setShowMergeConfirm(false);
          } catch (err) {
            setMergeError(String(err));
          } finally {
            setMerging(false);
          }
        }}
        onCancel={() => {
          setShowMergeConfirm(false);
          setMergeError("");
        }}
      />
    </div>
  );
}

function getShellCommand(): string {
  // Detect user's shell from env or fallback
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
    ? "cmd"
    : "bash";
}
