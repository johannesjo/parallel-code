import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import type { ChangedFile } from "../ipc/types";

interface ChangedFilesListProps {
  worktreePath: string;
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  ref?: (el: HTMLDivElement) => void;
}

function getStatusColor(status: string): string {
  return ({ M: theme.warning, A: theme.success, D: theme.error, "?": theme.fgMuted }[status] ?? theme.fgMuted);
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);

  function handleKeyDown(e: KeyboardEvent) {
    const list = files();
    if (list.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = selectedIndex();
      if (idx >= 0 && idx < list.length) {
        props.onFileClick?.(list[idx]);
      }
    }
  }

  let refreshInFlight = false;

  async function refresh(path: string, cancelled: () => boolean) {
    if (!path || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const result = await invoke<ChangedFile[]>("get_changed_files", {
        worktreePath: path,
      });
      if (!cancelled()) setFiles(result);
    } catch {
      // Silently ignore — worktree may not exist yet
    } finally {
      refreshInFlight = false;
    }
  }

  // Poll every 2s, but only when active (avoids thundering herd with many tasks)
  createEffect(() => {
    const path = props.worktreePath;
    if (props.isActive === false) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    refresh(path, isCancelled);
    const timer = setInterval(() => refresh(path, isCancelled), 2000);
    onCleanup(() => { cancelled = true; clearInterval(timer); });
  });

  const totalAdded = () => files().reduce((s, f) => s + f.lines_added, 0);
  const totalRemoved = () => files().reduce((s, f) => s + f.lines_removed, 0);
  const uncommittedCount = () => files().filter((f) => !f.committed).length;

  return (
    <div
      ref={props.ref}
      class="focusable-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        overflow: "hidden",
        "font-family": "'JetBrains Mono', monospace",
        "font-size": sf(11),
        outline: "none",
      }}
    >
      <div style={{ flex: "1", overflow: "auto", padding: "4px 0" }}>
        <For each={files()}>
          {(file, i) => (
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
                opacity: file.committed ? "0.45" : "1",
                background: selectedIndex() === i() ? theme.bgHover : "transparent",
              }}
              onClick={() => { setSelectedIndex(i()); props.onFileClick?.(file); }}
            >
              <span
                style={{
                  color: getStatusColor(file.status),
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
          <Show
            when={
              uncommittedCount() > 0 &&
              uncommittedCount() < files().length
            }
          >
            {" "}
            <span style={{ color: theme.warning }}>
              ({uncommittedCount()} uncommitted)
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
