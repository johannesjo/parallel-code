import { Show, createMemo, createEffect, ErrorBoundary } from "solid-js";
import { store, pickAndAddProject } from "../store/store";
import { closeTask } from "../store/tasks";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { TaskPanel } from "./TaskPanel";
import { NewTaskPlaceholder } from "./NewTaskPlaceholder";
import { theme } from "../lib/theme";
import { mod } from "../lib/platform";

export function TilingLayout() {
  let containerRef: HTMLDivElement | undefined;

  // Scroll the active task panel into view when selection changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!activeId || !containerRef) return;
    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  });
  // Cache PanelChild objects by ID so <For> sees stable references
  // and doesn't unmount/remount panels when taskOrder changes.
  const panelCache = new Map<string, PanelChild>();

  const panelChildren = createMemo((): PanelChild[] => {
    const currentIds = new Set<string>(store.taskOrder);
    currentIds.add("__placeholder");

    // Remove stale entries for deleted tasks
    for (const key of panelCache.keys()) {
      if (!currentIds.has(key)) panelCache.delete(key);
    }

    const panels: PanelChild[] = store.taskOrder.map((taskId) => {
      let cached = panelCache.get(taskId);
      if (!cached) {
        cached = {
          id: taskId,
          initialSize: 520,
          minSize: 300,
          content: () => {
            const task = store.tasks[taskId];
            if (!task) return <div />;
            return (
              <div
                data-task-id={taskId}
                class={task?.closingStatus === "removing" ? "task-removing" : "task-appearing"}
                style={{ height: "100%", padding: "6px 3px" }}
              >
                <ErrorBoundary fallback={(err, reset) => (
                  <div style={{
                    height: "100%",
                    display: "flex",
                    "flex-direction": "column",
                    "align-items": "center",
                    "justify-content": "center",
                    gap: "12px",
                    padding: "24px",
                    background: theme.islandBg,
                    "border-radius": "12px",
                    border: `1px solid ${theme.border}`,
                    color: theme.fgMuted,
                    "font-size": "13px",
                  }}>
                    <div style={{ color: theme.error, "font-weight": "600" }}>Panel crashed</div>
                    <div style={{ "text-align": "center", "word-break": "break-word", "max-width": "300px" }}>
                      {String(err)}
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={reset}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          color: theme.fg,
                          padding: "6px 16px",
                          "border-radius": "6px",
                          cursor: "pointer",
                        }}
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => closeTask(taskId)}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          color: theme.error,
                          padding: "6px 16px",
                          "border-radius": "6px",
                          cursor: "pointer",
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}>
                  <TaskPanel task={task} isActive={store.activeTaskId === taskId} />
                </ErrorBoundary>
              </div>
            );
          },
        };
        panelCache.set(taskId, cached);
      }
      return cached;
    });

    let placeholder = panelCache.get("__placeholder");
    if (!placeholder) {
      placeholder = {
        id: "__placeholder",
        initialSize: 54,
        fixed: true,
        content: () => <NewTaskPlaceholder />,
      };
      panelCache.set("__placeholder", placeholder);
    }
    panels.push(placeholder);

    return panels;
  });

  return (
    <div
      ref={containerRef}
      style={{
        flex: "1",
        "overflow-x": "auto",
        "overflow-y": "hidden",
        height: "100%",
        padding: "2px 4px",
      }}
    >
      <Show
        when={store.taskOrder.length > 0}
        fallback={
          <div
            class="empty-state"
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "100%",
              height: "100%",
              "flex-direction": "column",
              gap: "16px",
            }}
          >
            <Show
              when={store.projects.length > 0}
              fallback={
                <>
                  <div
                    style={{
                      width: "56px",
                      height: "56px",
                      "border-radius": "16px",
                      background: theme.islandBg,
                      border: `1px solid ${theme.border}`,
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "center",
                      color: theme.fgSubtle,
                    }}
                  >
                    <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                    </svg>
                  </div>
                  <div style={{ "text-align": "center" }}>
                    <div
                      style={{
                        "font-size": "15px",
                        color: theme.fgMuted,
                        "font-weight": "500",
                        "margin-bottom": "6px",
                      }}
                    >
                      Link your first project to get started
                    </div>
                    <div style={{ "font-size": "12px", color: theme.fgSubtle }}>
                      A project is a local folder with your code
                    </div>
                  </div>
                  <button
                    onClick={() => pickAndAddProject()}
                    style={{
                      background: theme.bgElevated,
                      border: `1px solid ${theme.border}`,
                      "border-radius": "8px",
                      padding: "8px 20px",
                      color: theme.fg,
                      cursor: "pointer",
                      "font-size": "13px",
                      "font-weight": "500",
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                    </svg>
                    Link Project
                  </button>
                </>
              }
            >
              <div
                style={{
                  width: "56px",
                  height: "56px",
                  "border-radius": "16px",
                  background: theme.islandBg,
                  border: `1px solid ${theme.border}`,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "font-size": "24px",
                  color: theme.fgSubtle,
                }}
              >
                +
              </div>
              <div style={{ "text-align": "center" }}>
                <div
                  style={{
                    "font-size": "15px",
                    color: theme.fgMuted,
                    "font-weight": "500",
                    "margin-bottom": "6px",
                  }}
                >
                  No tasks yet
                </div>
                <div style={{ "font-size": "12px", color: theme.fgSubtle }}>
                  Press{" "}
                  <kbd
                    style={{
                      background: theme.bgElevated,
                      border: `1px solid ${theme.border}`,
                      "border-radius": "4px",
                      padding: "2px 6px",
                      "font-family": "'JetBrains Mono', monospace",
                      "font-size": "11px",
                    }}
                  >
                    {mod}+N
                  </kbd>{" "}
                  to create a new task
                </div>
              </div>
            </Show>
          </div>
        }
      >
        <ResizablePanel
          direction="horizontal"
          children={panelChildren()}
          fitContent
          persistKey="tiling"
        />
      </Show>
    </div>
  );
}
