import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { createFocusRestore } from "../lib/focus-restore";
import { invoke } from "../lib/ipc";
import { DiffView, DiffModeEnum } from "@git-diff-view/solid";
import "@git-diff-view/solid/styles/diff-view.css";
import { theme } from "../lib/theme";
import { isBinaryDiff } from "../lib/diff-parser";
import { getStatusColor } from "../lib/status-colors";
import type { ChangedFile } from "../ipc/types";

interface DiffViewerDialogProps {
  file: ChangedFile | null;
  worktreePath: string;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  "?": "Untracked",
};

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  dockerfile: "dockerfile",
  lua: "lua",
  cpp: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
};

function detectLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

export function DiffViewerDialog(props: DiffViewerDialogProps) {
  createFocusRestore(() => props.file !== null);

  const [rawDiff, setRawDiff] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [binary, setBinary] = createSignal(false);
  const [viewMode, setViewMode] = createSignal(DiffModeEnum.Split);

  createEffect(() => {
    const file = props.file;
    if (!file) return;

    setLoading(true);
    setError("");
    setBinary(false);
    setRawDiff("");

    invoke<string>("get_file_diff", {
      worktreePath: props.worktreePath,
      filePath: file.path,
    })
      .then((raw) => {
        if (isBinaryDiff(raw)) {
          setBinary(true);
        } else {
          setRawDiff(raw);
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  });

  // Escape key to close
  createEffect(() => {
    if (!props.file) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  return (
    <Portal>
      <Show when={props.file}>
        {(file) => (
          <div
            class="dialog-overlay"
            style={{
              position: "fixed",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              background: "rgba(0,0,0,0.55)",
              "z-index": "1000",
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) props.onClose();
            }}
          >
            <div
              class="dialog-content"
              style={{
                background: theme.islandBg,
                border: `1px solid ${theme.border}`,
                "border-radius": "14px",
                width: "90vw",
                height: "85vh",
                "max-width": "1400px",
                display: "flex",
                "flex-direction": "column",
                overflow: "hidden",
                "box-shadow":
                  "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "10px",
                  padding: "16px 20px",
                  "border-bottom": `1px solid ${theme.border}`,
                  "flex-shrink": "0",
                }}
              >
                <span
                  style={{
                    "font-size": "11px",
                    "font-weight": "600",
                    padding: "2px 8px",
                    "border-radius": "4px",
                    color: getStatusColor(file().status),
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  {STATUS_LABELS[file().status] ?? file().status}
                </span>
                <span
                  style={{
                    flex: "1",
                    "font-size": "13px",
                    "font-family": "'JetBrains Mono', monospace",
                    color: theme.fg,
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {file().path}
                </span>

                {/* Split / Unified toggle */}
                <div
                  style={{
                    display: "flex",
                    gap: "2px",
                    background: "rgba(255,255,255,0.04)",
                    "border-radius": "6px",
                    padding: "2px",
                  }}
                >
                  <button
                    onClick={() => setViewMode(DiffModeEnum.Split)}
                    style={{
                      background:
                        viewMode() === DiffModeEnum.Split
                          ? "rgba(255,255,255,0.10)"
                          : "transparent",
                      border: "none",
                      color:
                        viewMode() === DiffModeEnum.Split
                          ? theme.fg
                          : theme.fgMuted,
                      "font-size": "11px",
                      padding: "3px 10px",
                      "border-radius": "4px",
                      cursor: "pointer",
                      "font-family": "inherit",
                    }}
                  >
                    Split
                  </button>
                  <button
                    onClick={() => setViewMode(DiffModeEnum.Unified)}
                    style={{
                      background:
                        viewMode() === DiffModeEnum.Unified
                          ? "rgba(255,255,255,0.10)"
                          : "transparent",
                      border: "none",
                      color:
                        viewMode() === DiffModeEnum.Unified
                          ? theme.fg
                          : theme.fgMuted,
                      "font-size": "11px",
                      padding: "3px 10px",
                      "border-radius": "4px",
                      cursor: "pointer",
                      "font-family": "inherit",
                    }}
                  >
                    Unified
                  </button>
                </div>

                <button
                  onClick={() => props.onClose()}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.fgMuted,
                    cursor: "pointer",
                    padding: "4px",
                    display: "flex",
                    "align-items": "center",
                    "border-radius": "4px",
                  }}
                  title="Close"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                  </svg>
                </button>
              </div>

              {/* Body */}
              <div
                style={{
                  flex: "1",
                  overflow: "auto",
                }}
              >
                <Show when={loading()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    Loading diff...
                  </div>
                </Show>

                <Show when={error()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.error }}>
                    {error()}
                  </div>
                </Show>

                <Show when={binary()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    Binary file — cannot display diff
                  </div>
                </Show>

                <Show when={!loading() && !error() && !binary() && !rawDiff()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    No changes
                  </div>
                </Show>

                <Show when={!loading() && !error() && !binary() && rawDiff()}>
                  <DiffView
                    data={{
                      oldFile: { fileName: file().path, fileLang: detectLang(file().path) },
                      newFile: { fileName: file().path, fileLang: detectLang(file().path) },
                      hunks: [rawDiff()],
                    }}
                    diffViewMode={viewMode()}
                    diffViewTheme="dark"
                    diffViewHighlight
                    diffViewWrap={false}
                    diffViewFontSize={12}
                  />
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Portal>
  );
}
