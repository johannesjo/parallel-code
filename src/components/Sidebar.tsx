import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import {
  store,
  pickAndAddProject,
  removeProject,
  removeProjectWithTasks,
  toggleNewTaskDialog,
  setActiveTask,
  toggleSidebar,
  reorderTask,
  getFontScale,
  adjustFontScale,
  getTaskDotStatus,
  registerFocusFn,
  unregisterFocusFn,
  focusSidebar,
  unfocusSidebar,
  setTaskFocusedPanel,
  getTaskFocusedPanel,
  getPanelSize,
  setPanelSizes,
  toggleSettingsDialog,
} from "../store/store";
import type { Project } from "../store/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { EditProjectDialog } from "./EditProjectDialog";
import { SidebarFooter } from "./SidebarFooter";
import { IconButton } from "./IconButton";
import { StatusDot } from "./StatusDot";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import { mod } from "../lib/platform";

const DRAG_THRESHOLD = 5;
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_SIZE_KEY = "sidebar:width";

export function Sidebar() {
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [editingProject, setEditingProject] = createSignal<Project | null>(null);
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  const [resizing, setResizing] = createSignal(false);
  let taskListRef: HTMLDivElement | undefined;

  const sidebarWidth = () => getPanelSize(SIDEBAR_SIZE_KEY) ?? SIDEBAR_DEFAULT_WIDTH;
  const taskIndexById = createMemo(() => {
    const map = new Map<string, number>();
    store.taskOrder.forEach((taskId, idx) => map.set(taskId, idx));
    return map;
  });
  const groupedTasks = createMemo(() => {
    const grouped: Record<string, string[]> = {};
    const orphaned: string[] = [];
    const projectIds = new Set(store.projects.map((p) => p.id));

    for (const taskId of store.taskOrder) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const projectId = task.projectId;
      if (projectId && projectIds.has(projectId)) {
        (grouped[projectId] ??= []).push(taskId);
      } else {
        orphaned.push(taskId);
      }
    }

    return { grouped, orphaned };
  });
  function handleResizeMouseDown(e: MouseEvent) {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth();

    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + ev.clientX - startX));
      setPanelSizes({ [SIDEBAR_SIZE_KEY]: newWidth });
    }

    function onUp() {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  onMount(() => {
    // Attach mousedown on task list container via native listener
    const el = taskListRef;
    if (el) {
      const handler = (e: MouseEvent) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>("[data-task-index]");
        if (!target) return;
        const index = Number(target.dataset.taskIndex);
        const taskId = store.taskOrder[index];
        if (taskId == null) return;
        handleTaskMouseDown(e, taskId, index);
      };
      el.addEventListener("mousedown", handler);
      onCleanup(() => el.removeEventListener("mousedown", handler));
    }

    // Register sidebar focus
    registerFocusFn("sidebar", () => taskListRef?.focus());
    onCleanup(() => unregisterFocusFn("sidebar"));
  });

  // When sidebarFocused changes, trigger focus
  createEffect(() => {
    if (store.sidebarFocused) {
      taskListRef?.focus();
    }
  });

  // Scroll the active task into view when it changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!activeId || !taskListRef) return;
    const idx = taskIndexById().get(activeId);
    if (idx == null) return;
    const el = taskListRef.querySelector<HTMLElement>(`[data-task-index="${idx}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "instant" });
  });

  // Scroll the focused task into view when navigating via keyboard
  createEffect(() => {
    const focusedId = store.sidebarFocusedTaskId;
    if (!focusedId || !taskListRef) return;
    const idx = taskIndexById().get(focusedId);
    if (idx == null) return;
    const el = taskListRef.querySelector<HTMLElement>(`[data-task-index="${idx}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "instant" });
  });

  // Scroll the focused project into view when it changes
  createEffect(() => {
    const projectId = store.sidebarFocusedProjectId;
    if (!projectId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-project-id="${projectId}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  });

  async function handleAddProject() {
    await pickAndAddProject();
  }

  function handleRemoveProject(projectId: string) {
    const hasTasks = store.taskOrder.some(
      (tid) => store.tasks[tid]?.projectId === projectId
    );
    if (hasTasks) {
      setConfirmRemove(projectId);
    } else {
      removeProject(projectId);
    }
  }

  function computeDropIndex(clientY: number, fromIdx: number): number {
    if (!taskListRef) return fromIdx;
    const items = taskListRef.querySelectorAll<HTMLElement>("[data-task-index]");
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }
    return items.length;
  }

  function handleTaskMouseDown(e: MouseEvent, taskId: string, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

      if (!dragging) {
        dragging = true;
        setDragFromIndex(index);
        document.body.classList.add("dragging-task");
      }

      const dropIdx = computeDropIndex(ev.clientY, index);
      setDropTargetIndex(dropIdx);
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);

      if (dragging) {
        document.body.classList.remove("dragging-task");
        const from = dragFromIndex();
        const to = dropTargetIndex();
        setDragFromIndex(null);
        setDropTargetIndex(null);

        if (from !== null && to !== null && from !== to) {
          const adjustedTo = to > from ? to - 1 : to;
          reorderTask(from, adjustedTo);
        }
      } else {
        setActiveTask(taskId);
        focusSidebar();
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function abbreviatePath(path: string): string {
    const home = "/home/";
    if (path.startsWith(home)) {
      const rest = path.slice(home.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx !== -1) return "~" + rest.slice(slashIdx);
      return "~";
    }
    return path;
  }

  // Compute the global taskOrder index for a given task
  function globalIndex(taskId: string): number {
    return taskIndexById().get(taskId) ?? -1;
  }

  let sidebarRef!: HTMLDivElement;
  onMount(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      adjustFontScale("sidebar", e.deltaY < 0 ? 1 : -1);
    };
    sidebarRef.addEventListener("wheel", handleWheel, { passive: false });
    onCleanup(() => sidebarRef.removeEventListener("wheel", handleWheel));
  });

  return (
    <div
      ref={sidebarRef}
      style={{
        "--font-scale": String(getFontScale("sidebar")),
        width: `${sidebarWidth()}px`,
        "min-width": `${SIDEBAR_MIN_WIDTH}px`,
        "max-width": `${SIDEBAR_MAX_WIDTH}px`,
        display: "flex",
        "flex-shrink": "0",
        "user-select": resizing() ? "none" : undefined,
      }}
    >
    <div
      style={{
        flex: "1",
        "min-width": "0",
        display: "flex",
        "flex-direction": "column",
        padding: "16px",
        gap: "16px",
        "user-select": "none",
      }}
    >
      {/* Logo + collapse */}
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "0 2px" }}>
          <svg width="24" height="24" viewBox="0 0 56 56" fill="none" stroke={theme.fg} stroke-width="4" style={{ "flex-shrink": "0" }}>
            <line x1="10" y1="6" x2="10" y2="50"/>
            <line x1="22" y1="6" x2="22" y2="50"/>
            <path d="M30 8 H47 V24 H30"/>
            <path d="M49 32 H32 V48 H49"/>
          </svg>
          <span style={{ "font-size": sf(14), "font-weight": "600", color: theme.fg, "font-family": "'JetBrains Mono', monospace" }}>
            Parallel Code
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2.25a.75.75 0 0 1 .73.56l.2.72a4.48 4.48 0 0 1 1.04.43l.66-.37a.75.75 0 0 1 .9.13l.75.75a.75.75 0 0 1 .13.9l-.37.66c.17.33.31.68.43 1.04l.72.2a.75.75 0 0 1 .56.73v1.06a.75.75 0 0 1-.56.73l-.72.2a4.48 4.48 0 0 1-.43 1.04l.37.66a.75.75 0 0 1-.13.9l-.75.75a.75.75 0 0 1-.9.13l-.66-.37a4.48 4.48 0 0 1-1.04.43l-.2.72a.75.75 0 0 1-.73.56H6.94a.75.75 0 0 1-.73-.56l-.2-.72a4.48 4.48 0 0 1-1.04-.43l-.66.37a.75.75 0 0 1-.9-.13l-.75-.75a.75.75 0 0 1-.13-.9l.37-.66a4.48 4.48 0 0 1-.43-1.04l-.72-.2a.75.75 0 0 1-.56-.73V7.47a.75.75 0 0 1 .56-.73l.72-.2c.11-.36.26-.71.43-1.04l-.37-.66a.75.75 0 0 1 .13-.9l.75-.75a.75.75 0 0 1 .9-.13l.66.37c.33-.17.68-.31 1.04-.43l.2-.72a.75.75 0 0 1 .73-.56H8Zm-.53 3.22a2.5 2.5 0 1 0 1.06 4.88 2.5 2.5 0 0 0-1.06-4.88Z" />
              </svg>
            }
            onClick={() => toggleSettingsDialog(true)}
            title={`Settings (${mod}+,)`}
          />
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
            }
            onClick={() => toggleSidebar()}
            title={`Collapse sidebar (${mod}+B)`}
          />
        </div>
      </div>

      {/* Projects section */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "0 2px" }}>
          <label style={{ "font-size": sf(11), color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Projects
          </label>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
              </svg>
            }
            onClick={() => handleAddProject()}
            title="Add project"
            size="sm"
          />
        </div>

        <For each={store.projects}>
          {(project) => (
            <div
              role="button"
              tabIndex={0}
              data-project-id={project.id}
              onClick={() => setEditingProject(project)}
              onKeyDown={(e) => { if (e.key === "Enter") setEditingProject(project); }}
              style={{
                display: "flex",
                "align-items": "center",
                gap: "6px",
                padding: "4px 6px",
                "border-radius": "6px",
                background: theme.bgInput,
                "font-size": sf(11),
                cursor: "pointer",
                border: store.sidebarFocused && store.sidebarFocusedProjectId === project.id
                  ? `1.5px solid var(--border-focus)`
                  : "1.5px solid transparent",
              }}
            >
              <div style={{
                width: "8px",
                height: "8px",
                "border-radius": "50%",
                background: project.color,
                "flex-shrink": "0",
              }} />
              <div style={{ flex: "1", "min-width": "0", overflow: "hidden" }}>
                <div style={{ color: theme.fg, "font-weight": "500", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                  {project.name}
                </div>
                <div style={{ color: theme.fgSubtle, "font-size": sf(10), "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                  {abbreviatePath(project.path)}
                </div>
              </div>
              <button
                class="icon-btn"
                onClick={(e) => { e.stopPropagation(); handleRemoveProject(project.id); }}
                title="Remove project"
                style={{
                  background: "transparent",
                  border: "none",
                  color: theme.fgSubtle,
                  cursor: "pointer",
                  "font-size": sf(12),
                  "line-height": "1",
                  padding: "0 2px",
                  "flex-shrink": "0",
                }}
              >
                &times;
              </button>
            </div>
          )}
        </For>

        <Show when={store.projects.length === 0}>
          <span style={{ "font-size": sf(10), color: theme.fgSubtle, padding: "0 2px" }}>
            No projects linked yet.
          </span>
        </Show>
      </div>

      <div style={{ height: "1px", background: theme.border }} />

      {/* New task / Link project button */}
      <Show
        when={store.projects.length > 0}
        fallback={
          <button
            class="icon-btn"
            onClick={() => pickAndAddProject()}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              "border-radius": "8px",
              padding: "8px 14px",
              color: theme.fgMuted,
              cursor: "pointer",
              "font-size": sf(12),
              "font-weight": "500",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              gap: "6px",
              width: "100%",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
            </svg>
            Link Project
          </button>
        }
      >
        <button
          class="icon-btn"
          onClick={() => toggleNewTaskDialog(true)}
          style={{
            background: "transparent",
            border: `1px solid ${theme.border}`,
            "border-radius": "8px",
            padding: "8px 14px",
            color: theme.fgMuted,
            cursor: "pointer",
            "font-size": sf(12),
            "font-weight": "500",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            gap: "6px",
            width: "100%",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
          </svg>
          New Task
        </button>
      </Show>

      {/* Tasks grouped by project */}
      <div
        ref={taskListRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!store.sidebarFocused) return;
          if (e.key === "Enter") {
            e.preventDefault();
            const focusedProjectId = store.sidebarFocusedProjectId;
            if (focusedProjectId) {
              const project = store.projects.find((p) => p.id === focusedProjectId);
              if (project) setEditingProject(project);
              return;
            }
            const taskId = store.sidebarFocusedTaskId;
            if (taskId) {
              setActiveTask(taskId);
              unfocusSidebar();
              setTaskFocusedPanel(taskId, getTaskFocusedPanel(taskId));
            }
          }
        }}
        style={{ display: "flex", "flex-direction": "column", gap: "1px", flex: "1", overflow: "auto", outline: "none" }}
      >
        <For each={store.projects}>
          {(project) => {
            const projectTasks = () => groupedTasks().grouped[project.id] ?? [];
            return (
              <Show when={projectTasks().length > 0}>
                <span style={{
                  "font-size": sf(10),
                  color: theme.fgSubtle,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.05em",
                  "margin-top": "8px",
                  "margin-bottom": "4px",
                  padding: "0 2px",
                  display: "flex",
                  "align-items": "center",
                  gap: "5px",
                }}>
                  <div style={{
                    width: "6px",
                    height: "6px",
                    "border-radius": "50%",
                    background: project.color,
                    "flex-shrink": "0",
                  }} />
                  {project.name} ({projectTasks().length})
                </span>
                <For each={projectTasks()}>
                  {(taskId) => {
                    const task = () => store.tasks[taskId];
                    const idx = () => globalIndex(taskId);
                    return (
                      <Show when={task()}>
                        <Show when={dropTargetIndex() === idx()}>
                          <div class="drop-indicator" />
                        </Show>
                        <div
                          class={`task-item${task()!.closingStatus === "removing" ? " task-item-removing" : " task-item-appearing"}`}
                          data-task-index={idx()}
                          onClick={() => { setActiveTask(taskId); focusSidebar(); }}
                          style={{
                            padding: "7px 10px",
                            "border-radius": "6px",
                            background: "transparent",
                            color: store.activeTaskId === taskId ? theme.fg : theme.fgMuted,
                            "font-size": sf(12),
                            "font-weight": store.activeTaskId === taskId ? "500" : "400",
                            cursor: dragFromIndex() !== null ? "grabbing" : "pointer",
                            "white-space": "nowrap",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            opacity: dragFromIndex() === idx() ? "0.4" : "1",
                            display: "flex",
                            "align-items": "center",
                            gap: "6px",
                            border: store.sidebarFocused && store.sidebarFocusedTaskId === taskId
                              ? `1.5px solid var(--border-focus)`
                              : "1.5px solid transparent",
                          }}
                        >
                          <StatusDot status={getTaskDotStatus(taskId)} size="sm" />
                          <Show when={task()!.directMode}>
                            <span style={{
                              "font-size": sf(10),
                              "font-weight": "600",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "#f0a03020",
                              color: theme.warning,
                              "flex-shrink": "0",
                              "line-height": "1.5",
                            }}>
                              {task()!.branchName}
                            </span>
                          </Show>
                          <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>{task()!.name}</span>
                        </div>
                      </Show>
                    );
                  }}
                </For>
              </Show>
            );
          }}
        </For>

        {/* Orphaned tasks (no matching project) */}
        <Show when={groupedTasks().orphaned.length > 0}>
          <span style={{
            "font-size": sf(10),
            color: theme.fgSubtle,
            "text-transform": "uppercase",
            "letter-spacing": "0.05em",
            "margin-top": "8px",
            "margin-bottom": "4px",
            padding: "0 2px",
          }}>
            Other ({groupedTasks().orphaned.length})
          </span>
          <For each={groupedTasks().orphaned}>
            {(taskId) => {
              const task = () => store.tasks[taskId];
              const idx = () => globalIndex(taskId);
              return (
                <Show when={task()}>
                  <Show when={dropTargetIndex() === idx()}>
                    <div class="drop-indicator" />
                  </Show>
                  <div
                    class={`task-item${task()!.closingStatus === "removing" ? " task-item-removing" : " task-item-appearing"}`}
                    data-task-index={idx()}
                    onClick={() => { setActiveTask(taskId); focusSidebar(); }}
                    style={{
                      padding: "7px 10px",
                      "border-radius": "6px",
                      background: "transparent",
                      color: store.activeTaskId === taskId ? theme.fg : theme.fgMuted,
                      "font-size": sf(12),
                      "font-weight": store.activeTaskId === taskId ? "500" : "400",
                      cursor: dragFromIndex() !== null ? "grabbing" : "pointer",
                      "white-space": "nowrap",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      opacity: dragFromIndex() === idx() ? "0.4" : "1",
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      border: store.sidebarFocused && store.sidebarFocusedTaskId === taskId
                        ? `1.5px solid var(--border-focus)`
                        : "1.5px solid transparent",
                    }}
                  >
                    <StatusDot status={getTaskDotStatus(taskId)} size="sm" />
                    <Show when={task()!.directMode}>
                      <span style={{
                        "font-size": sf(10),
                        "font-weight": "600",
                        padding: "1px 5px",
                        "border-radius": "3px",
                        background: "#f0a03020",
                        color: theme.warning,
                        "flex-shrink": "0",
                        "line-height": "1.5",
                      }}>
                        {task()!.branchName}
                      </span>
                    </Show>
                    <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>{task()!.name}</span>
                  </div>
                </Show>
              );
            }}
          </For>
        </Show>

      <Show when={dropTargetIndex() === store.taskOrder.length}>
          <div class="drop-indicator" />
        </Show>
      </div>

      <SidebarFooter />

      {/* Edit project dialog */}
      <EditProjectDialog
        project={editingProject()}
        onClose={() => setEditingProject(null)}
      />

      {/* Confirm remove project dialog */}
      <ConfirmDialog
        open={confirmRemove() !== null}
        title="Remove project?"
        message={`This project has ${
          store.taskOrder.filter(
            (tid) => store.tasks[tid]?.projectId === confirmRemove()
          ).length
        } open task(s). Removing it will also close all tasks, delete their worktrees and branches.`}
        confirmLabel="Remove all"
        danger
        onConfirm={() => {
          const id = confirmRemove();
          if (id) removeProjectWithTasks(id);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
    {/* Resize handle */}
    <div
      class={`resize-handle resize-handle-h${resizing() ? " dragging" : ""}`}
      onMouseDown={handleResizeMouseDown}
    />
    </div>
  );
}
