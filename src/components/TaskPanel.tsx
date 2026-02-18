import { Show, For, createSignal, createResource, createEffect, onMount, onCleanup } from "solid-js";
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
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffViewerDialog } from "./DiffViewerDialog";
import { EditProjectDialog } from "./EditProjectDialog";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import { mod } from "../lib/platform";
import { extractLabel, consumePendingShellCommand } from "../lib/bookmarks";
import type { Task } from "../store/types";
import type { ChangedFile, MergeStatus, WorktreeStatus } from "../ipc/types";

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
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal("");
  const [branchLog] = createResource(
    () => showMergeConfirm() ? props.task.worktreePath : null,
    (path) => invoke<string>("get_branch_log", { worktreePath: path }),
  );
  const [worktreeStatus] = createResource(
    () => (showMergeConfirm() || showCloseConfirm()) ? props.task.worktreePath : null,
    (path) => invoke<WorktreeStatus>("get_worktree_status", { worktreePath: path }),
  );
  const [mergeStatus, { refetch: refetchMergeStatus }] = createResource(
    () => showMergeConfirm() ? props.task.worktreePath : null,
    (path) => invoke<MergeStatus>("check_merge_status", { worktreePath: path }),
  );
  const [rebasing, setRebasing] = createSignal(false);
  const [rebaseError, setRebaseError] = createSignal("");
  const [rebaseSuccess, setRebaseSuccess] = createSignal(false);
  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushError, setPushError] = createSignal("");
  const [pushing, setPushing] = createSignal(false);
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
      case "merge": openMergeConfirm(); break;
      case "push": setShowPushConfirm(true); break;
    }
  });

  function openMergeConfirm() {
    const project = getProject(props.task.projectId);
    setCleanupAfterMerge(project?.deleteBranchOnClose ?? true);
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
            <EditableText
              value={props.task.name}
              onCommit={(v) => updateTaskName(props.task.id, v)}
              class="editable-text"
              ref={(h) => titleEditHandle = h}
            />
          </div>
          <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
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
            {(() => {
              const project = getProject(props.task.projectId);
              const willDeleteBranch = project?.deleteBranchOnClose ?? true;
              return (
                <>
                  <p style={{ margin: "0 0 8px" }}>
                    {willDeleteBranch
                      ? "This action cannot be undone. The following will be permanently deleted:"
                      : "The worktree will be removed but the branch will be kept:"}
                  </p>
                  <ul style={{ margin: "0", "padding-left": "20px", display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <Show when={willDeleteBranch}>
                      <li>Local feature branch <strong>{props.task.branchName}</strong></li>
                    </Show>
                    <li>Worktree at <strong>{props.task.worktreePath}</strong></li>
                    <Show when={!willDeleteBranch}>
                      <li style={{ color: theme.fgMuted }}>Branch <strong>{props.task.branchName}</strong> will be kept</li>
                    </Show>
                  </ul>
                </>
              );
            })()}
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
        autoFocusCancel
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
            <Show when={!worktreeStatus.loading && !hasCommittedChangesToMerge()}>
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
                Nothing to merge: this branch has no committed changes compared to main/master.
              </div>
            </Show>
            <Show when={mergeStatus.loading}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: theme.fgMuted,
                padding: "8px 12px",
                "border-radius": "8px",
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
              }}>
                Checking for conflicts with main...
              </div>
            </Show>
            <Show when={!mergeStatus.loading && mergeStatus() && mergeStatus()!.main_ahead_count > 0}>
              <div style={{
                "margin-bottom": "12px",
                "font-size": "12px",
                color: hasConflicts() ? theme.error : theme.warning,
                background: hasConflicts() ? "#f7546414" : "#f0a03014",
                padding: "8px 12px",
                "border-radius": "8px",
                border: hasConflicts() ? "1px solid #f7546433" : "1px solid #f0a03033",
                "font-weight": "600",
              }}>
                <Show when={!hasConflicts()}>
                  Main has {mergeStatus()!.main_ahead_count} new commit{mergeStatus()!.main_ahead_count > 1 ? "s" : ""}. Rebase onto main first.
                </Show>
                <Show when={hasConflicts()}>
                  <div>Conflicts detected with main ({mergeStatus()!.conflicting_files.length} file{mergeStatus()!.conflicting_files.length > 1 ? "s" : ""}):</div>
                  <ul style={{ margin: "4px 0 0", "padding-left": "20px", "font-weight": "400" }}>
                    <For each={mergeStatus()!.conflicting_files}>
                      {(f) => <li>{f}</li>}
                    </For>
                  </ul>
                  <div style={{ "margin-top": "4px", "font-weight": "400" }}>
                    Rebase onto main to resolve conflicts.
                  </div>
                </Show>
              </div>
              <div style={{ "margin-bottom": "12px", display: "flex", "align-items": "center", gap: "8px" }}>
                <button
                  type="button"
                  disabled={rebasing() || worktreeStatus()?.has_uncommitted_changes}
                  onClick={async () => {
                    setRebasing(true);
                    setRebaseError("");
                    setRebaseSuccess(false);
                    try {
                      await invoke("rebase_task", { worktreePath: props.task.worktreePath });
                      setRebaseSuccess(true);
                      refetchMergeStatus();
                    } catch (err) {
                      setRebaseError(String(err));
                    } finally {
                      setRebasing(false);
                    }
                  }}
                  title={worktreeStatus()?.has_uncommitted_changes ? "Commit or stash changes before rebasing" : "Rebase onto main"}
                  style={{
                    padding: "6px 14px",
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    "border-radius": "8px",
                    color: theme.fg,
                    cursor: (rebasing() || worktreeStatus()?.has_uncommitted_changes) ? "not-allowed" : "pointer",
                    "font-size": "12px",
                    opacity: (rebasing() || worktreeStatus()?.has_uncommitted_changes) ? "0.5" : "1",
                  }}
                >
                  {rebasing() ? "Rebasing..." : "Rebase onto main"}
                </button>
                <Show when={rebaseSuccess()}>
                  <span style={{ "font-size": "12px", color: theme.success }}>Rebase successful</span>
                </Show>
                <Show when={rebaseError()}>
                  <span style={{ "font-size": "12px", color: theme.error }}>{rebaseError()}</span>
                </Show>
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
                checked={cleanupAfterMerge()}
                onChange={(e) => setCleanupAfterMerge(e.currentTarget.checked)}
                style={{ cursor: "pointer" }}
              />
              Delete branch and worktree after merge
            </label>
            <label
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "margin-top": "8px",
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
        confirmDisabled={merging() || hasConflicts() || !hasCommittedChangesToMerge()}
        confirmLoading={merging()}
        confirmLabel={merging() ? "Merging..." : squash() ? "Squash Merge" : "Merge"}
        onConfirm={async () => {
          setMergeError("");
          setMerging(true);
          try {
            await mergeTask(props.task.id, {
              squash: squash(),
              message: squash() ? squashMessage() || undefined : undefined,
              cleanup: cleanupAfterMerge(),
            });
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
          setCleanupAfterMerge(false);
          setSquashMessage("");
          setRebaseError("");
          setRebaseSuccess(false);
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
