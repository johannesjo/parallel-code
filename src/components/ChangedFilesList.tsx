import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import type { ChangedFile } from "../ipc/types";

interface ChangedFilesListProps {
  worktreePath: string;
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: theme.warning,
  A: theme.success,
  D: theme.error,
  "?": theme.fgMuted,
};

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);

  async function refresh(path: string) {
    if (!path) return;
    try {
      const result = await invoke<ChangedFile[]>("get_changed_files", {
        worktreePath: path,
      });
      setFiles(result);
    } catch {
      // Silently ignore — worktree may not exist yet
    }
  }

  // Poll every 2s, but only when active (avoids thundering herd with many tasks)
  createEffect(() => {
    const path = props.worktreePath;
    if (props.isActive === false) return;
    refresh(path);
    const timer = setInterval(() => refresh(path), 2000);
    onCleanup(() => clearInterval(timer));
  });

  const totalAdded = () => files().reduce((s, f) => s + f.lines_added, 0);
  const totalRemoved = () => files().reduce((s, f) => s + f.lines_removed, 0);

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        overflow: "hidden",
        "font-family": "'JetBrains Mono', monospace",
        "font-size": sf(11),
      }}
    >
      <div style={{ flex: "1", overflow: "auto", padding: "4px 0" }}>
        <For each={files()}>
          {(file) => (
            <div
              class="file-row"
              style={{
                display: "flex",
                "align-items": "center",
                gap: "6px",
                padding: "2px 8px",
                "white-space": "nowrap",
                cursor: props.onFileClick ? "pointer" : "default",
                "border-radius": "3px",
              }}
              onClick={() => props.onFileClick?.(file)}
            >
              <span
                style={{
                  color: STATUS_COLORS[file.status] ?? theme.fgMuted,
                  "font-weight": "600",
                  width: "12px",
                  "text-align": "center",
                  "flex-shrink": "0",
                }}
              >
                {file.status}
              </span>
              <span
                style={{
                  flex: "1",
                  color: theme.fg,
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}
              >
                {file.path}
              </span>
              <Show when={file.lines_added > 0 || file.lines_removed > 0}>
                <span style={{ color: theme.success, "flex-shrink": "0" }}>
                  +{file.lines_added}
                </span>
                <span style={{ color: theme.error, "flex-shrink": "0" }}>
                  -{file.lines_removed}
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={files().length > 0}>
        <div
          style={{
            padding: "4px 8px",
            "border-top": `1px solid ${theme.border}`,
            color: theme.fgMuted,
            "flex-shrink": "0",
          }}
        >
          {files().length} files,{" "}
          <span style={{ color: theme.success }}>+{totalAdded()}</span>{" "}
          <span style={{ color: theme.error }}>-{totalRemoved()}</span>
        </div>
      </Show>
    </div>
  );
}
