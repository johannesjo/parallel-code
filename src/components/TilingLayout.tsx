import { For, Show } from "solid-js";
import { store } from "../store/store";
import { TaskPanel } from "./TaskPanel";
import { NewTaskPlaceholder } from "./NewTaskPlaceholder";
import { theme } from "../lib/theme";

export function TilingLayout() {
  return (
    <div
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
                  Ctrl+N
                </kbd>{" "}
                to create a new task
              </div>
            </div>
          </div>
        }
      >
        <div
          style={{
            display: "flex",
            height: "100%",
            "min-width": "min-content",
          }}
        >
          <For each={store.taskOrder}>
            {(taskId) => {
              const task = () => store.tasks[taskId];
              return (
                <Show when={task()}>
                  {(t) => (
                    <div style={{ "min-width": "400px", flex: "1", height: "100%", padding: "6px 3px" }}>
                      <TaskPanel task={t()} isActive={store.activeTaskId === taskId} />
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
          <NewTaskPlaceholder />
        </div>
      </Show>
    </div>
  );
}
