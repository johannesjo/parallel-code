import { createSignal, onMount } from "solid-js";
import { store, setProjectRoot, toggleNewTaskDialog, setActiveTask } from "../store/store";
import { theme } from "../lib/theme";

const DEFAULT_PROJECT_ROOT = "/home/johannes/www/git-test";

export function Sidebar() {
  const [folderInput, setFolderInput] = createSignal(store.projectRoot ?? DEFAULT_PROJECT_ROOT);

  onMount(() => {
    if (!store.projectRoot) {
      setProjectRoot(DEFAULT_PROJECT_ROOT);
    }
  });

  async function handleSetRoot() {
    const path = folderInput().trim();
    if (!path) return;
    await setProjectRoot(path);
  }

  return (
    <div
      style={{
        width: "220px",
        "min-width": "220px",
        background: theme.islandBg,
        "border-right": `1px solid ${theme.border}`,
        display: "flex",
        "flex-direction": "column",
        padding: "12px",
        gap: "12px",
        "user-select": "none",
      }}
    >
      <div style={{ "font-size": "14px", "font-weight": "500", color: theme.fg, "letter-spacing": "0.02em" }}>
        AI Mush
      </div>

      {/* Project root */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
        <label style={{ "font-size": "11px", color: theme.fgMuted }}>
          Project root
        </label>
        <input
          type="text"
          value={folderInput()}
          onInput={(e) => setFolderInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSetRoot();
          }}
          placeholder="/path/to/repo"
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "6px",
            padding: "6px 8px",
            color: theme.fg,
            "font-size": "11px",
            "font-family": "'JetBrains Mono', monospace",
            outline: "none",
            width: "100%",
          }}
        />
        <button
          onClick={handleSetRoot}
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "6px",
            padding: "5px 8px",
            color: theme.fgMuted,
            cursor: "pointer",
            "font-size": "11px",
            transition: "background 0.15s",
          }}
        >
          Set root
        </button>
      </div>

      <div style={{ "border-top": `1px solid ${theme.border}`, "padding-top": "8px" }}>
        <span style={{ "font-size": "11px", color: theme.fgSubtle }}>
          {store.projectRoot ? store.projectRoot : "No project set"}
        </span>
      </div>

      <button
        onClick={() => toggleNewTaskDialog(true)}
        style={{
          background: theme.accent,
          border: "none",
          "border-radius": "6px",
          padding: "8px 12px",
          color: theme.accentText,
          cursor: "pointer",
          "font-size": "13px",
          "font-weight": "500",
          transition: "background 0.15s",
        }}
      >
        + New Task
      </button>

      {/* Task list */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: "1", overflow: "auto" }}>
        <span style={{ "font-size": "11px", color: theme.fgSubtle, "margin-bottom": "4px" }}>
          Tasks ({store.taskOrder.length})
        </span>
        {store.taskOrder.map((taskId) => {
          const task = store.tasks[taskId];
          if (!task) return null;
          return (
            <div
              style={{
                padding: "5px 8px",
                "border-radius": "6px",
                background: store.activeTaskId === taskId ? theme.bgSelected : "transparent",
                color: store.activeTaskId === taskId ? theme.fg : theme.fgMuted,
                "font-size": "12px",
                cursor: "pointer",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                transition: "background 0.15s",
              }}
              onClick={() => setActiveTask(taskId)}
            >
              {task.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
