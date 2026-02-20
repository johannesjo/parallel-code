import { Show, createEffect } from "solid-js";
import { Portal } from "solid-js/web";
import { createFocusRestore } from "../lib/focus-restore";
import { theme } from "../lib/theme";
import { alt, mod } from "../lib/platform";

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

const SECTIONS = [
  {
    title: "Navigation",
    shortcuts: [
      [`${alt} + Up/Down`, "Move between panels or sidebar tasks"],
      [`${alt} + Left/Right`, "Navigate within row or across tasks"],
      [`${alt} + Left (from first task)`, "Focus sidebar"],
      [`${alt} + Right (from sidebar)`, "Focus active task"],
      ["Enter (in sidebar)", "Jump to active task panel"],
    ],
  },
  {
    title: "Task Actions",
    shortcuts: [
      [`${mod} + Enter`, "Send prompt"],
      [`${mod} + W`, "Close focused terminal"],
      [`${mod} + Shift + Q`, "Close active task"],
      [`${mod} + Shift + M`, "Merge active task"],
      [`${mod} + Shift + P`, "Push to remote"],
      [`${mod} + Shift + T`, "New shell terminal"],
      [`${mod} + ${alt} + Left/Right`, "Reorder tasks"],
    ],
  },
  {
    title: "App",
    shortcuts: [
      [`${mod} + N`, "New task"],
      [`${mod} + Shift + A`, "New task"],
      [`${mod} + B`, "Toggle sidebar"],
      [`${mod} + ,`, "Open settings"],
      [`${mod} + 0`, "Reset zoom"],
      [`${mod} + / or F1`, "Toggle this help"],
      ["Escape", "Close dialogs"],
    ],
  },
];

export function HelpDialog(props: HelpDialogProps) {
  let dialogRef: HTMLDivElement | undefined;

  createFocusRestore(() => props.open);

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => dialogRef?.focus());
    }
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (!dialogRef) return;
    if (e.key === "Escape") { props.onClose(); return; }
    const step = 40;
    const page = 200;
    if (e.key === "ArrowDown") { e.preventDefault(); dialogRef.scrollTop += step; }
    else if (e.key === "ArrowUp") { e.preventDefault(); dialogRef.scrollTop -= step; }
    else if (e.key === "PageDown") { e.preventDefault(); dialogRef.scrollTop += page; }
    else if (e.key === "PageUp") { e.preventDefault(); dialogRef.scrollTop -= page; }
  }

  return (
    <Portal>
      <Show when={props.open}>
        <div
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
            ref={dialogRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "14px",
              padding: "28px",
              width: "480px",
              "max-height": "80vh",
              overflow: "auto",
              display: "flex",
              "flex-direction": "column",
              gap: "20px",
              outline: "none",
              "box-shadow": "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
              <h2 style={{ margin: "0", "font-size": "16px", color: theme.fg, "font-weight": "600" }}>
                Keyboard Shortcuts
              </h2>
              <button
                onClick={() => props.onClose()}
                style={{
                  background: "transparent",
                  border: "none",
                  color: theme.fgMuted,
                  cursor: "pointer",
                  "font-size": "18px",
                  padding: "0 4px",
                  "line-height": "1",
                }}
              >
                &times;
              </button>
            </div>

            {SECTIONS.map((section) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                <div style={{
                  "font-size": "11px",
                  color: theme.fgMuted,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.05em",
                  "font-weight": "600",
                }}>
                  {section.title}
                </div>
                {section.shortcuts.map(([key, desc]) => (
                  <div style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    padding: "4px 0",
                  }}>
                    <span style={{ color: theme.fgMuted, "font-size": "12px" }}>{desc}</span>
                    <kbd style={{
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      "border-radius": "4px",
                      padding: "2px 8px",
                      "font-size": "11px",
                      color: theme.fg,
                      "font-family": "'JetBrains Mono', monospace",
                      "white-space": "nowrap",
                    }}>
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Show>
    </Portal>
  );
}
