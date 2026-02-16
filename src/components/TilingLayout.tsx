import { For, Show } from "solid-js";
import { store } from "../store/store";
import { TaskColumn } from "./TaskColumn";
import { theme } from "../lib/theme";

export function TilingLayout() {
  return (
    <div
      style={{
        display: "flex",
        flex: "1",
        overflow: "hidden",
        height: "100%",
        padding: "2px",
      }}
    >
      <Show
        when={store.taskOrder.length > 0}
        fallback={
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "100%",
              height: "100%",
              color: theme.fgSubtle,
              "font-family": "'JetBrains Mono', monospace",
              "flex-direction": "column",
              gap: "12px",
            }}
          >
            <span style={{ "font-size": "16px", color: theme.fgMuted }}>No tasks open</span>
            <span style={{ "font-size": "12px" }}>
              Press Ctrl+N to create a new task
            </span>
          </div>
        }
      >
        <For each={store.taskOrder}>
          {(taskId) => {
            const task = () => store.tasks[taskId];
            return (
              <Show when={task()}>
                {(t) => (
                  <TaskColumn
                    task={t()}
                    isActive={store.activeTaskId === taskId}
                  />
                )}
              </Show>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
