import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  store,
  retryCloseTask,
  setActiveTask,
  markAgentExited,
  restartAgent,
  updateTaskName,
  updateTaskNotes,
  spawnShellForTask,
  closeShell,
  setLastPrompt,
  clearInitialPrompt,
  getProject,
  reorderTask,
  getFontScale,
  getTaskDotStatus,
  markAgentOutput,
  registerFocusFn,
  unregisterFocusFn,
  setTaskFocusedPanel,
  triggerFocus,
  clearPendingAction,
} from "../store/store";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { EditableText, type EditableTextHandle } from "./EditableText";
import { IconButton } from "./IconButton";
import { InfoBar } from "./InfoBar";
import { PromptInput } from "./PromptInput";
import { ChangedFilesList } from "./ChangedFilesList";
import { StatusDot } from "./StatusDot";
import { TerminalView } from "./TerminalView";
import { ScalablePanel } from "./ScalablePanel";
import { TaskDialogs } from "./TaskDialogs";
import { EditProjectDialog } from "./EditProjectDialog";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import { mod } from "../lib/platform";
import { extractLabel, consumePendingShellCommand } from "../lib/bookmarks";
import type { Task } from "../store/types";
import type { ChangedFile } from "../ipc/types";

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);
  const [shellExits, setShellExits] = createStore<Record<string, { exitCode: number | null; signal: string | null }>>({});
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let notesRef: HTMLTextAreaElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;
  let shellToolbarRef: HTMLDivElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  const [shellToolbarIdx, setShellToolbarIdx] = createSignal(0);
  const [shellToolbarFocused, setShellToolbarFocused] = createSignal(false);
  const projectBookmarks = () => getProject(props.task.projectId)?.terminalBookmarks ?? [];
  const editingProject = () => {
    const id = editingProjectId();
    return id ? getProject(id) ?? null : null;
  };

  // Focus registration for this task's panels
  onMount(() => {
    const id = props.task.id;
    registerFocusFn(`${id}:title`, () => titleEditHandle?.startEdit());
    registerFocusFn(`${id}:notes`, () => notesRef?.focus());
    registerFocusFn(`${id}:changed-files`, () => { changedFilesRef?.focus(); });
    registerFocusFn(`${id}:prompt`, () => promptRef?.focus());
    registerFocusFn(`${id}:shell-toolbar`, () => shellToolbarRef?.focus());
    // Individual shell:N and ai-terminal focus fns are registered via TerminalView.onReady

    onCleanup(() => {
      unregisterFocusFn(`${id}:title`);
      unregisterFocusFn(`${id}:notes`);
      unregisterFocusFn(`${id}:changed-files`);
      unregisterFocusFn(`${id}:shell-toolbar`);
      // Individual shell:N focus fns are cleaned up by their own onCleanup
      unregisterFocusFn(`${id}:ai-terminal`);
      unregisterFocusFn(`${id}:prompt`);
    });
  });

  // Respond to focus panel changes from store
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.task.id];
    if (panel) {
      triggerFocus(`${props.task.id}:${panel}`);
    }
  });

  // Auto-focus prompt when task first becomes active (if no panel set yet)
  createEffect(() => {
    if (props.isActive && !store.focusedPanel[props.task.id]) {
      const id = props.task.id;
      setTimeout(() => {
        // Only focus prompt if no panel was set in the meantime
        if (!store.focusedPanel[id] && !panelRef.contains(document.activeElement)) {
          promptRef?.focus();
        }
      }, 0);
    }
  });

  // React to pendingAction from keyboard shortcuts
  createEffect(() => {
    const action = store.pendingAction;
    if (!action || action.taskId !== props.task.id) return;
    clearPendingAction();
    switch (action.type) {
      case "close": setShowCloseConfirm(true); break;
      case "merge": if (!props.task.directMode) openMergeConfirm(); break;
      case "push": if (!props.task.directMode) setShowPushConfirm(true); break;
    }
  });

  function openMergeConfirm() {
    setShowMergeConfirm(true);
  }

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
            background: "transparent",
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
            <Show when={props.task.directMode}>
              <span style={{
                "font-size": "11px",
                "font-weight": "600",
                padding: "2px 8px",
                "border-radius": "4px",
                background: "#f0a03025",
                color: theme.warning,
                border: "1px solid #f0a03040",
                "flex-shrink": "0",
                "white-space": "nowrap",
              }}>
                {props.task.branchName}
              </span>
            </Show>
            <EditableText
              value={props.task.name}
              onCommit={(v) => updateTaskName(props.task.id, v)}
              class="editable-text"
              ref={(h) => titleEditHandle = h}
            />
          </div>
          <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
            <Show when={!props.task.directMode}>
              <IconButton
                icon={
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
                  </svg>
                }
                onClick={openMergeConfirm}
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
            </Show>
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
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingProjectId(project.id);
                }}
                title="Project settings"
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "4px",
                  background: "transparent",
                  border: "none",
                  padding: "0",
                  margin: "0 12px 0 0",
                  color: "inherit",
                  cursor: "pointer",
                  "font-family": "inherit",
                  "font-size": "inherit",
                }}
              >
                <div style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  background: project.color,
                  "flex-shrink": "0",
                }} />
                {project.name}
              </button>
            ) : null;
          })()}
          <span style={{ display: "inline-flex", "align-items": "center", gap: "4px", "margin-right": "12px" }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
              <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
            </svg>
            {props.task.branchName}
            <Show when={props.task.directMode}>
              <span style={{
                "font-size": "10px",
                "font-weight": "600",
                padding: "1px 6px",
                "border-radius": "4px",
                background: "#f0a03025",
                color: theme.warning,
                border: "1px solid #f0a03040",
              }}>
                {props.task.branchName}
              </span>
            </Show>
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
                <div class="focusable-panel" style={{ width: "100%", height: "100%" }} onClick={() => setTaskFocusedPanel(props.task.id, "notes")}>
                <textarea
                  ref={notesRef}
                  value={props.task.notes}
                  onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
                  placeholder="Notes..."
                  style={{
                    width: "100%",
                    height: "100%",
                    background: theme.taskPanelBg,
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
                    background: theme.taskPanelBg,
                    display: "flex",
                    "flex-direction": "column",
                  }}
                  onClick={() => setTaskFocusedPanel(props.task.id, "changed-files")}
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
                    <ChangedFilesList worktreePath={props.task.worktreePath} isActive={props.isActive} onFileClick={setDiffFile} ref={(el) => changedFilesRef = el} />
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
        <div style={{ height: "100%", display: "flex", "flex-direction": "column", background: "transparent" }}>
          <div
            ref={shellToolbarRef}
            class="focusable-panel shell-toolbar-panel"
            tabIndex={0}
            onClick={() => setTaskFocusedPanel(props.task.id, "shell-toolbar")}
            onFocus={() => setShellToolbarFocused(true)}
            onBlur={() => setShellToolbarFocused(false)}
            onKeyDown={(e) => {
              const itemCount = 1 + projectBookmarks().length;
              if (e.key === "ArrowRight") {
                e.preventDefault();
                setShellToolbarIdx((i) => Math.min(itemCount - 1, i + 1));
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                setShellToolbarIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const idx = shellToolbarIdx();
                if (idx === 0) {
                  spawnShellForTask(props.task.id);
                } else {
                  const bm = projectBookmarks()[idx - 1];
                  if (bm) spawnShellForTask(props.task.id, bm.command);
                }
              }
            }}
            style={{
              height: "28px",
              "min-height": "28px",
              display: "flex",
              "align-items": "center",
              padding: "0 8px",
              background: "transparent",
              gap: "4px",
              outline: "none",
            }}
          >
            <button
              class="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                spawnShellForTask(props.task.id);
              }}
              tabIndex={-1}
              title={`Open terminal (${mod}+Shift+T)`}
              style={{
                background: theme.taskPanelBg,
                border: `1px solid ${shellToolbarIdx() === 0 && shellToolbarFocused() ? theme.accent : theme.border}`,
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
            <For each={projectBookmarks()}>
              {(bookmark, i) => (
                <button
                  class="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    spawnShellForTask(props.task.id, bookmark.command);
                  }}
                  tabIndex={-1}
                  title={bookmark.command}
                  style={{
                    background: theme.taskPanelBg,
                    border: `1px solid ${shellToolbarIdx() === i() + 1 && shellToolbarFocused() ? theme.accent : theme.border}`,
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
                  <span>{extractLabel(bookmark.command)}</span>
                </button>
              )}
            </For>
          </div>
          <Show when={props.task.shellAgentIds.length > 0}>
            <div style={{
              flex: "1",
              display: "flex",
              overflow: "hidden",
              background: theme.taskContainerBg,
              gap: "6px",
              "margin-top": "6px",
            }}>
              <For each={props.task.shellAgentIds}>
                {(shellId, i) => {
                  const initialCommand = consumePendingShellCommand(shellId);
                  let shellFocusFn: (() => void) | undefined;
                  let registeredKey: string | undefined;

                  // Re-register focus fn whenever the index changes (e.g. after a sibling is removed)
                  createEffect(() => {
                    const key = `${props.task.id}:shell:${i()}`;
                    if (registeredKey && registeredKey !== key) unregisterFocusFn(registeredKey);
                    if (shellFocusFn) registerFocusFn(key, shellFocusFn);
                    registeredKey = key;
                  });
                  onCleanup(() => { if (registeredKey) unregisterFocusFn(registeredKey); });

                  return (
                    <div
                      class="focusable-panel shell-terminal-container"
                      style={{
                        flex: "1",
                        overflow: "hidden",
                        position: "relative",
                        background: theme.taskPanelBg,
                      }}
                      onClick={() => setTaskFocusedPanel(props.task.id, `shell:${i()}`)}
                    >
                      <button
                        class="shell-terminal-close"
                        onClick={(e) => { e.stopPropagation(); closeShell(props.task.id, shellId); }}
                        title="Close terminal (Ctrl+Shift+W)"
                        style={{
                          background: "color-mix(in srgb, var(--island-bg) 85%, transparent)",
                          border: `1px solid ${theme.border}`,
                          color: theme.fgMuted,
                          cursor: "pointer",
                          "border-radius": "6px",
                          padding: "2px 6px",
                          "line-height": "1",
                          "font-size": "14px",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                        </svg>
                      </button>
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
                        taskId={props.task.id}
                        agentId={shellId}
                        command={getShellCommand()}
                        args={["-l"]}
                        cwd={props.task.worktreePath}
                        initialCommand={initialCommand}
                        onExit={(info) => setShellExits(shellId, { exitCode: info.exit_code, signal: info.signal })}
                        onReady={(focusFn) => { shellFocusFn = focusFn; if (registeredKey) registerFocusFn(registeredKey, focusFn); }}
                        fontSize={Math.round(13 * getFontScale(`${props.task.id}:shell`))}
                        autoFocus
                      />
                    </div>
                  );
                }}
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
        <div class="focusable-panel" style={{ height: "100%", position: "relative", background: theme.taskPanelBg, display: "flex", "flex-direction": "column" }} onClick={() => setTaskFocusedPanel(props.task.id, "ai-terminal")}>
          <InfoBar title={props.task.lastPrompt || (props.task.initialPrompt ? "Waiting to send prompt…" : "No prompts sent yet")}>
            <span style={{ opacity: props.task.lastPrompt ? 1 : 0.4 }}>
              {props.task.lastPrompt
                ? `> ${props.task.lastPrompt}`
                : props.task.initialPrompt
                  ? "⏳ Waiting to send prompt…"
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
                    <TerminalView
                      taskId={props.task.id}
                      agentId={a().id}
                      command={a().def.command}
                      args={a().resumed && a().def.resume_args?.length ? a().def.resume_args! : a().def.args}
                      cwd={props.task.worktreePath}
                      onExit={(code) => markAgentExited(a().id, code)}
                      onData={(data) => markAgentOutput(a().id, data)}
                      onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
                      onReady={(focusFn) => registerFocusFn(`${props.task.id}:ai-terminal`, focusFn)}
                      fontSize={Math.round(13 * getFontScale(`${props.task.id}:ai-terminal`))}
                    />
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
      initialSize: 60,
      minSize: 36,
      maxSize: 300,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:prompt`}>
          <div onClick={() => setTaskFocusedPanel(props.task.id, "prompt")} style={{ height: "100%" }}>
            <PromptInput
              taskId={props.task.id}
              agentId={firstAgentId()}
              initialPrompt={props.task.initialPrompt}
              onSend={() => {
                if (props.task.initialPrompt) clearInitialPrompt(props.task.id);
              }}
              ref={(el) => promptRef = el}
            />
          </div>
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
        background: theme.taskContainerBg,
        "border-radius": "12px",
        border: `1px solid ${theme.border}`,
        overflow: "clip",
        position: "relative",
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <Show when={props.task.closingStatus && props.task.closingStatus !== "removing"}>
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
      <TaskDialogs
        task={props.task}
        showCloseConfirm={showCloseConfirm()}
        onCloseConfirmDone={() => setShowCloseConfirm(false)}
        showMergeConfirm={showMergeConfirm()}
        initialCleanup={getProject(props.task.projectId)?.deleteBranchOnClose ?? true}
        onMergeConfirmDone={() => setShowMergeConfirm(false)}
        showPushConfirm={showPushConfirm()}
        onPushConfirmDone={() => setShowPushConfirm(false)}
        diffFile={diffFile()}
        onDiffClose={() => setDiffFile(null)}
        onDiffFileClick={setDiffFile}
      />
      <EditProjectDialog
        project={editingProject()}
        onClose={() => setEditingProjectId(null)}
      />
    </div>
  );
}

function getShellCommand(): string {
  // Empty string tells the backend to use $SHELL (Unix) or %COMSPEC% (Windows)
  return "";
}
