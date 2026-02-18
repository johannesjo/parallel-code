import { Show, For, createSignal, createResource, createEffect, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import {
  store,
  closeTask,
  retryCloseTask,
  mergeTask,
  pushTask,
  setActiveTask,
  markAgentExited,
  restartAgent,
  updateTaskName,
  updateTaskNotes,
  spawnShellForTask,
  closeShell,
  setLastPrompt,
  clearInitialPrompt,
  sendPrompt,
  getProject,
  reorderTask,
  getFontScale,
  getTaskDotStatus,
  markAgentActive,
} from "../store/store";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { EditableText } from "./EditableText";
import { IconButton } from "./IconButton";
import { InfoBar } from "./InfoBar";
import { PromptInput } from "./PromptInput";
import { ChangedFilesList } from "./ChangedFilesList";
import { StatusDot } from "./StatusDot";
import { TerminalView } from "./TerminalView";
import { ScalablePanel } from "./ScalablePanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffViewerDialog } from "./DiffViewerDialog";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import type { Task } from "../store/types";
import type { ChangedFile, WorktreeStatus } from "../ipc/types";

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [mergeError, setMergeError] = createSignal("");
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal("");
  const [branchLog] = createResource(
    () => showMergeConfirm() ? props.task.worktreePath : null,
    (path) => invoke<string>("get_branch_log", { worktreePath: path }),
  );
  const [worktreeStatus] = createResource(
    () => (showMergeConfirm() || showCloseConfirm()) ? props.task.worktreePath : null,
    (path) => invoke<WorktreeStatus>("get_worktree_status", { worktreePath: path }),
  );
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushError, setPushError] = createSignal("");
  const [pushing, setPushing] = createSignal(false);
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [shellExits, setShellExits] = createStore<Record<string, { exitCode: number | null; signal: string | null }>>({});
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;

  // Debounced readiness detection for sending initialPrompt
  let readyTimer: number | undefined;
  let initialPromptSent = false;

  function handleAgentData(agentId: string) {
    markAgentActive(agentId);

    // If there's an initial prompt pending and we haven't sent it yet,
    // reset the debounce timer on each data event. After 1s of silence,
    // the agent is likely ready for input.
    if (initialPromptSent || !props.task.initialPrompt) return;

    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      readyTimer = undefined;
      const ip = props.task.initialPrompt;
      if (!ip || initialPromptSent) return;
      initialPromptSent = true;
      const aid = firstAgentId();
      if (aid) {
        sendPrompt(props.task.id, aid, ip);
        clearInitialPrompt(props.task.id);
      }
    }, 1000);
  }

  onCleanup(() => {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
  });

  createEffect(() => {
    if (props.isActive) {
      setTimeout(() => {
        if (!panelRef.contains(document.activeElement)) {
          promptRef?.focus();
        }
      }, 0);
    }
  });

  const firstAgent = () => {
    const ids = props.task.agentIds;
    return ids.length > 0 ? store.agents[ids[0]] : undefined;
  };

  const firstAgentId = () => props.task.agentIds[0] ?? "";

  const DRAG_THRESHOLD = 5;

  function handleTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.tagName === "INPUT") return;

    e.preventDefault();
    const startX = e.clientX;
    const titleBarEl = e.currentTarget as HTMLElement;
    const draggedCol = titleBarEl.closest("[data-task-id]") as HTMLElement;
    // DOM: ResizablePanel root > size-wrapper div > [data-task-id]
    const sizeWrapper = draggedCol.parentElement;
    const columnsContainer = sizeWrapper?.parentElement as HTMLElement;
    if (!columnsContainer) return;

    let dragging = false;
    let lastDropIdx = -1;
    let indicator: HTMLElement | null = null;

    function getColumns(): HTMLElement[] {
      return Array.from(columnsContainer.querySelectorAll<HTMLElement>("[data-task-id]"));
    }

    function computeDropIndex(clientX: number): number {
      const columns = getColumns();
      for (let i = 0; i < columns.length; i++) {
        const rect = columns[i].getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (clientX < midX) return i;
      }
      return columns.length;
    }

    function positionIndicator(dropIdx: number) {
      if (!indicator) return;
      const columns = getColumns();
      const containerRect = columnsContainer.getBoundingClientRect();
      let x: number;

      if (dropIdx < columns.length) {
        // Get the wrapper div (parent of [data-task-id]) for accurate edge position
        const wrapper = columns[dropIdx].parentElement!;
        x = wrapper.getBoundingClientRect().left;
      } else if (columns.length > 0) {
        const wrapper = columns[columns.length - 1].parentElement!;
        const rect = wrapper.getBoundingClientRect();
        x = rect.right;
      } else {
        x = containerRect.left;
      }

      indicator.style.left = `${x - 1}px`;
      indicator.style.top = `${containerRect.top}px`;
      indicator.style.height = `${containerRect.height}px`;
    }

    function onMove(ev: MouseEvent) {
      if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;

      if (!dragging) {
        dragging = true;
        document.body.classList.add("dragging-task");
        draggedCol.style.opacity = "0.4";

        indicator = document.createElement("div");
        indicator.className = "drag-drop-indicator";
        document.body.appendChild(indicator);
      }

      const dropIdx = computeDropIndex(ev.clientX);
      if (dropIdx !== lastDropIdx) {
        lastDropIdx = dropIdx;
        positionIndicator(dropIdx);
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);

      if (dragging) {
        document.body.classList.remove("dragging-task");
        draggedCol.style.opacity = "";
        indicator?.remove();
        indicator = null;

        const fromIdx = store.taskOrder.indexOf(props.task.id);
        if (fromIdx !== -1 && lastDropIdx !== -1 && fromIdx !== lastDropIdx) {
          const adjustedTo = lastDropIdx > fromIdx ? lastDropIdx - 1 : lastDropIdx;
          reorderTask(fromIdx, adjustedTo);
        }
      } else {
        setActiveTask(props.task.id);
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

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
            cursor: "grab",
          }}
          onMouseDown={handleTitleMouseDown}
        >
          <div
            style={{
              overflow: "hidden",
              flex: "1",
              "min-width": "0",
              display: "flex",
              "align-items": "center",
              gap: "8px",
            }}
          >
            <StatusDot status={getTaskDotStatus(props.task.id)} size="md" />
            <EditableText
              value={props.task.name}
              onCommit={(v) => updateTaskName(props.task.id, v)}
              class="editable-text"
            />
          </div>
          <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
                </svg>
              }
              onClick={() => setShowMergeConfirm(true)}
              title="Merge into main"
            />
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.75 8a.75.75 0 0 1 .75-.75h5.19L8.22 4.78a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06l2.47-2.47H5.5A.75.75 0 0 1 4.75 8Z" transform="rotate(-90 8 8)" />
                </svg>
              }
              onClick={() => setShowPushConfirm(true)}
              title="Push to remote"
            />
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              }
              onClick={() => setShowCloseConfirm(true)}
              title="Close task"
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
          {(() => {
            const project = getProject(props.task.projectId);
            return project ? (
              <span style={{ display: "inline-flex", "align-items": "center", gap: "4px", "margin-right": "12px" }}>
                <div style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  background: project.color,
                  "flex-shrink": "0",
                }} />
                {project.name}
              </span>
            ) : null;
          })()}
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
      initialSize: 150,
      minSize: 60,
      content: () => (
        <ResizablePanel
          direction="horizontal"
          persistKey={`task:${props.task.id}:notes-split`}
          children={[
            {
              id: "notes",
              initialSize: 200,
              minSize: 100,
              content: () => (
                <ScalablePanel panelId={`${props.task.id}:notes`}>
                <div class="focusable-panel" style={{ width: "100%", height: "100%" }}>
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
                    "font-size": sf(11),
                    "font-family": "'JetBrains Mono', monospace",
                    resize: "none",
                    outline: "none",
                  }}
                />
                </div>
                </ScalablePanel>
              ),
            },
            {
              id: "changed-files",
              initialSize: 200,
              minSize: 100,
              content: () => (
                <ScalablePanel panelId={`${props.task.id}:changed-files`}>
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
                      "font-size": sf(10),
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
                    <ChangedFilesList worktreePath={props.task.worktreePath} isActive={props.isActive} onFileClick={setDiffFile} />
                  </div>
                </div>
                </ScalablePanel>
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
      get fixed() { return props.task.shellAgentIds.length === 0; },
      requestSize: () => props.task.shellAgentIds.length > 0 ? 200 : 28,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:shell`}>
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
                padding: "4px 12px",
                "font-size": sf(13),
                "line-height": "1",
                display: "flex",
                "align-items": "center",
                gap: "4px",
              }}
            >
              <span style={{ "font-family": "monospace", "font-size": sf(13) }}>&gt;_</span>
              <span>Terminal</span>
            </button>
            <For each={props.task.shellAgentIds}>
              {(shellId, i) => (
                <span
                  style={{
                    "font-size": sf(10),
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
                    class="focusable-panel"
                    style={{
                      flex: "1",
                      "border-left": i() > 0 ? `1px solid ${theme.border}` : "none",
                      overflow: "hidden",
                      position: "relative",
                    }}
                  >
                    <Show when={shellExits[shellId]}>
                      <div
                        class="exit-badge"
                        style={{
                          position: "absolute",
                          top: "8px",
                          right: "12px",
                          "z-index": "10",
                          "font-size": sf(11),
                          color: shellExits[shellId]?.exitCode === 0 ? theme.success : theme.error,
                          background: "color-mix(in srgb, var(--island-bg) 80%, transparent)",
                          padding: "4px 12px",
                          "border-radius": "8px",
                          border: `1px solid ${theme.border}`,
                        }}
                      >
                        Process exited ({shellExits[shellId]?.exitCode ?? "?"})
                      </div>
                    </Show>
                    <TerminalView
                      agentId={shellId}
                      command={getShellCommand()}
                      args={["-l"]}
                      cwd={props.task.worktreePath}
                      onExit={(info) => setShellExits(shellId, { exitCode: info.exit_code, signal: info.signal })}
                      fontSize={Math.round(13 * getFontScale(`${props.task.id}:shell`))}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
        </ScalablePanel>
      ),
    };
  }

  function aiTerminal(): PanelChild {
    return {
      id: "ai-terminal",
      minSize: 80,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:ai-terminal`}>
        <div class="focusable-panel" style={{ height: "100%", position: "relative", background: theme.bgElevated, display: "flex", "flex-direction": "column" }}>
          <InfoBar title={props.task.lastPrompt || "No prompts sent yet"}>
            <span style={{ opacity: props.task.lastPrompt ? 1 : 0.4 }}>
              {props.task.lastPrompt
                ? `> ${props.task.lastPrompt}`
                : "No prompts sent"}
            </span>
          </InfoBar>
          <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
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
                        "font-size": sf(11),
                        color: a().exitCode === 0 ? theme.success : theme.error,
                        background: "color-mix(in srgb, var(--island-bg) 80%, transparent)",
                        padding: "4px 12px",
                        "border-radius": "8px",
                        border: `1px solid ${theme.border}`,
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                      }}
                    >
                      <span>Process exited ({a().exitCode ?? "?"})</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); restartAgent(a().id, false); }}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          color: theme.fg,
                          padding: "2px 8px",
                          "border-radius": "4px",
                          cursor: "pointer",
                          "font-size": sf(10),
                        }}
                      >
                        Restart
                      </button>
                      <Show when={a().def.resume_args?.length}>
                        <button
                          onClick={(e) => { e.stopPropagation(); restartAgent(a().id, true); }}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.fg,
                            padding: "2px 8px",
                            "border-radius": "4px",
                            cursor: "pointer",
                            "font-size": sf(10),
                          }}
                        >
                          Resume
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <Show when={`${a().id}:${a().generation}`} keyed>
                    {() => (
                      <TerminalView
                        agentId={a().id}
                        command={a().def.command}
                        args={a().resumed && a().def.resume_args?.length ? a().def.resume_args! : a().def.args}
                        cwd={props.task.worktreePath}
                        onExit={(code) => markAgentExited(a().id, code)}
                        onData={() => handleAgentData(a().id)}
                        onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
                        fontSize={Math.round(13 * getFontScale(`${props.task.id}:ai-terminal`))}
                      />
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
        </ScalablePanel>
      ),
    };
  }

  function promptInput(): PanelChild {
    return {
      id: "prompt",
      initialSize: 72,
      minSize: 36,
      maxSize: 300,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:prompt`}>
          <PromptInput taskId={props.task.id} agentId={firstAgentId()} ref={(el) => promptRef = el} />
        </ScalablePanel>
      ),
    };
  }

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? "active" : ""}`}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        background: theme.islandBg,
        "border-radius": "12px",
        border: `1px solid ${theme.border}`,
        overflow: "clip",
        position: "relative",
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <Show when={props.task.closingStatus}>
        <div style={{
          position: "absolute",
          inset: "0",
          "z-index": "50",
          background: "rgba(0, 0, 0, 0.6)",
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "center",
          gap: "12px",
          "border-radius": "12px",
          color: theme.fg,
        }}>
          <Show when={props.task.closingStatus === "closing"}>
            <div style={{ "font-size": "13px", color: theme.fgMuted }}>Closing task...</div>
          </Show>
          <Show when={props.task.closingStatus === "error"}>
            <div style={{ "font-size": "13px", color: theme.error, "font-weight": "600" }}>
              Close failed
            </div>
            <div style={{
              "font-size": "11px",
              color: theme.fgMuted,
              "max-width": "260px",
              "text-align": "center",
              "word-break": "break-word",
            }}>
              {props.task.closingError}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); retryCloseTask(props.task.id); }}
              style={{
                background: theme.bgElevated,
                border: `1px solid ${theme.border}`,
                color: theme.fg,
                padding: "6px 16px",
                "border-radius": "6px",
                cursor: "pointer",
                "font-size": "12px",
              }}
            >
              Retry
            </button>
          </Show>
        </div>
      </Show>
        <ResizablePanel
          direction="vertical"
          persistKey={`task:${props.task.id}`}
          children={[
            titleBar(),
            branchInfoBar(),
            notesAndFiles(),
            shellSection(),
            aiTerminal(),
            promptInput(),
          ]}
        />
      <ConfirmDialog
        open={showCloseConfirm()}
        title="Close Task"
        message={
          <div>
            <Show when={worktreeStatus()?.has_uncommitted_changes || worktreeStatus()?.has_committed_changes}>
              <div style={{
                "margin-bottom": "12px",
                display: "flex",
                "flex-direction": "column",
                gap: "8px",
              }}>
                <Show when={worktreeStatus()?.has_uncommitted_changes}>
                  <div style={{
                    "font-size": "12px",
                    color: theme.warning,
                    background: "#f0a03014",
                    padding: "8px 12px",
                    "border-radius": "8px",
                    border: "1px solid #f0a03033",
                    "font-weight": "600",
                  }}>
                    Warning: There are uncommitted changes that will be permanently lost.
                  </div>
                </Show>
                <Show when={worktreeStatus()?.has_committed_changes}>
                  <div style={{
                    "font-size": "12px",
                    color: theme.warning,
                    background: "#f0a03014",
                    padding: "8px 12px",
                    "border-radius": "8px",
                    border: "1px solid #f0a03033",
                    "font-weight": "600",
                  }}>
                    Warning: This branch has commits that have not been merged into main.
                  </div>
                </Show>
              </div>
            </Show>
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
        width="520px"
        message={
          <div>
            <Show when={worktreeStatus()?.has_uncommitted_changes}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: theme.warning,
                background: "#f0a03014",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f0a03033",
                "font-weight": "600",
              }}>
                Warning: You have uncommitted changes that will NOT be included in this merge.
              </div>
            </Show>
            <p style={{ margin: "0 0 12px" }}>
              Merge <strong>{props.task.branchName}</strong> into main:
            </p>
            <div
              style={{
                border: `1px solid ${theme.border}`,
                "border-radius": "8px",
                overflow: "hidden",
                "max-height": "240px",
                display: "flex",
                "flex-direction": "column",
              }}
            >
              <ChangedFilesList worktreePath={props.task.worktreePath} onFileClick={setDiffFile} />
            </div>
            <label
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "margin-top": "12px",
                cursor: "pointer",
                "font-size": "13px",
                color: theme.fg,
              }}
            >
              <input
                type="checkbox"
                checked={squash()}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setSquash(checked);
                  if (checked && !squashMessage()) {
                    setSquashMessage(branchLog() ?? "");
                  }
                }}
                style={{ cursor: "pointer" }}
              />
              Squash commits
            </label>
            <Show when={squash()}>
              <textarea
                value={squashMessage()}
                onInput={(e) => setSquashMessage(e.currentTarget.value)}
                placeholder="Commit message..."
                rows={6}
                style={{
                  "margin-top": "8px",
                  width: "100%",
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  padding: "8px 10px",
                  color: theme.fg,
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', monospace",
                  resize: "vertical",
                  outline: "none",
                  "box-sizing": "border-box",
                }}
              />
            </Show>
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
        confirmLabel={merging() ? "Merging..." : squash() ? "Squash Merge" : "Merge"}
        onConfirm={async () => {
          setMergeError("");
          setMerging(true);
          try {
            await mergeTask(props.task.id, squash() ? {
              squash: true,
              message: squashMessage() || undefined,
            } : undefined);
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
          setSquash(false);
          setSquashMessage("");
        }}
      />
      <ConfirmDialog
        open={showPushConfirm()}
        title="Push to Remote"
        message={
          <div>
            <p style={{ margin: "0 0 8px" }}>
              Push branch <strong>{props.task.branchName}</strong> to remote?
            </p>
            <Show when={pushError()}>
              <div style={{
                "margin-top": "12px",
                "font-size": "12px",
                color: theme.error,
                background: "#f7546414",
                padding: "8px 12px",
                "border-radius": "8px",
                border: "1px solid #f7546433",
              }}>
                {pushError()}
              </div>
            </Show>
          </div>
        }
        confirmLabel={pushing() ? "Pushing..." : "Push"}
        onConfirm={async () => {
          setPushError("");
          setPushing(true);
          try {
            await pushTask(props.task.id);
            setShowPushConfirm(false);
          } catch (err) {
            setPushError(String(err));
          } finally {
            setPushing(false);
          }
        }}
        onCancel={() => {
          setShowPushConfirm(false);
          setPushError("");
        }}
      />
      <DiffViewerDialog
        file={diffFile()}
        worktreePath={props.task.worktreePath}
        onClose={() => setDiffFile(null)}
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
