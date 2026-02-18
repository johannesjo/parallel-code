import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  store,
  addProject,
  removeProject,
  toggleNewTaskDialog,
  setActiveTask,
  toggleSidebar,
  reorderTask,
  getFontScale,
  adjustFontScale,
  getTaskDotStatus,
  registerFocusFn,
  unregisterFocusFn,
  unfocusSidebar,
  setTaskFocusedPanel,
  getTaskFocusedPanel,
} from "../store/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./IconButton";
import { StatusDot } from "./StatusDot";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";

const DRAG_THRESHOLD = 5;

export function Sidebar() {
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  let taskListRef: HTMLDivElement | undefined;

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
    const idx = store.taskOrder.indexOf(activeId);
    if (idx < 0) return;
    const el = taskListRef.querySelector<HTMLElement>(`[data-task-index="${idx}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  async function handleAddProject() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const path = selected as string;
    const segments = path.split("/");
    const name = segments[segments.length - 1] || path;
    addProject(name, path);
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

  function tasksByProject() {
    const grouped: Record<string, string[]> = {};
    const orphaned: string[] = [];

    for (const taskId of store.taskOrder) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const pid = task.projectId;
      if (pid && store.projects.some((p) => p.id === pid)) {
        (grouped[pid] ??= []).push(taskId);
      } else {
        orphaned.push(taskId);
      }
    }
    return { grouped, orphaned };
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
    return store.taskOrder.indexOf(taskId);
  }

  let sidebarRef!: HTMLDivElement;
  onMount(() => {
    sidebarRef.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      adjustFontScale("sidebar", e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  });

  return (
    <div
      ref={sidebarRef}
      style={{
        "--font-scale": String(getFontScale("sidebar")),
        width: "240px",
        "min-width": "240px",
        background: theme.islandBg,
        "border-right": `1px solid ${theme.border}`,
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
          <div style={{
            width: "24px",
            height: "24px",
            "border-radius": "6px",
            background: `linear-gradient(135deg, ${theme.accent}, #6366f1)`,
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "font-size": sf(12),
            "font-weight": "600",
            color: "#fff",
            "flex-shrink": "0",
          }}>M</div>
          <span style={{ "font-size": sf(14), "font-weight": "600", color: theme.fg }}>
            Parallel Code
          </span>
        </div>
        <IconButton
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
            </svg>
          }
          onClick={() => toggleSidebar()}
          title="Collapse sidebar (Ctrl+B)"
        />
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
              style={{
                display: "flex",
                "align-items": "center",
                gap: "6px",
                padding: "4px 6px",
                "border-radius": "6px",
                background: theme.bgInput,
                "font-size": sf(11),
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
                onClick={() => handleRemoveProject(project.id)}
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
            No projects. Click + to add one.
          </span>
        </Show>
      </div>

      <div style={{ height: "1px", background: theme.border }} />

      {/* New task button */}
      <button
        class="btn-primary"
        onClick={() => toggleNewTaskDialog(true)}
        style={{
          background: theme.accent,
          border: "none",
          "border-radius": "8px",
          padding: "9px 14px",
          color: theme.accentText,
          cursor: "pointer",
          "font-size": sf(13),
          "font-weight": "500",
        }}
      >
        + New Task
      </button>

      {/* Tasks grouped by project */}
      <div
        ref={taskListRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!store.sidebarFocused) return;
          const { taskOrder, activeTaskId } = store;
          if (taskOrder.length === 0) return;
          const currentIdx = activeTaskId ? taskOrder.indexOf(activeTaskId) : -1;

          if (e.key === "ArrowUp" && e.altKey) {
            e.preventDefault();
            const prevIdx = Math.max(0, currentIdx - 1);
            setActiveTask(taskOrder[prevIdx]);
          } else if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            const nextIdx = Math.min(taskOrder.length - 1, currentIdx + 1);
            setActiveTask(taskOrder[nextIdx]);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (activeTaskId) {
              unfocusSidebar();
              setTaskFocusedPanel(activeTaskId, getTaskFocusedPanel(activeTaskId));
            }
          }
        }}
        style={{ display: "flex", "flex-direction": "column", gap: "1px", flex: "1", overflow: "auto", outline: "none" }}
      >
        <For each={store.projects}>
          {(project) => {
            const projectTasks = () => tasksByProject().grouped[project.id] ?? [];
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
                          class="task-item"
                          data-task-index={idx()}
                          onClick={() => setActiveTask(taskId)}
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
                          }}
                        >
                          <StatusDot status={getTaskDotStatus(taskId)} size="sm" />
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
        <Show when={tasksByProject().orphaned.length > 0}>
          <span style={{
            "font-size": sf(10),
            color: theme.fgSubtle,
            "text-transform": "uppercase",
            "letter-spacing": "0.05em",
            "margin-top": "8px",
            "margin-bottom": "4px",
            padding: "0 2px",
          }}>
            Other ({tasksByProject().orphaned.length})
          </span>
          <For each={tasksByProject().orphaned}>
            {(taskId) => {
              const task = () => store.tasks[taskId];
              const idx = () => globalIndex(taskId);
              return (
                <Show when={task()}>
                  <Show when={dropTargetIndex() === idx()}>
                    <div class="drop-indicator" />
                  </Show>
                  <div
                    class="task-item"
                    data-task-index={idx()}
                    onClick={() => setActiveTask(taskId)}
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
                    }}
                  >
                    <StatusDot status={getTaskDotStatus(taskId)} size="sm" />
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

      {/* Tips */}
      <div style={{
        "border-top": `1px solid ${theme.border}`,
        "padding-top": "12px",
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        "flex-shrink": "0",
      }}>
        <span style={{
          "font-size": sf(10),
          color: theme.fgSubtle,
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}>
          Tips
        </span>
        <span style={{
          "font-size": sf(11),
          color: theme.fgSubtle,
          "line-height": "1.4",
        }}>
          <kbd style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "3px",
            padding: "1px 4px",
            "font-size": sf(10),
            "font-family": "'JetBrains Mono', monospace",
          }}>Alt + Arrows</kbd>{" "}
          to navigate panels
        </span>
        <span style={{
          "font-size": sf(11),
          color: theme.fgSubtle,
          "line-height": "1.4",
        }}>
          <kbd style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "3px",
            padding: "1px 4px",
            "font-size": sf(10),
            "font-family": "'JetBrains Mono', monospace",
          }}>Ctrl + /</kbd>{" "}
          for all shortcuts
        </span>
      </div>

      {/* Confirm remove project dialog */}
      <ConfirmDialog
        open={confirmRemove() !== null}
        title="Remove project?"
        message="This project has active tasks. Removing it won't delete the tasks, but they'll appear under 'Other'."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const id = confirmRemove();
          if (id) removeProject(id);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
