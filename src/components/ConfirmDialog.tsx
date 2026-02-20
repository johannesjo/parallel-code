import { Show, createEffect, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { createFocusRestore } from "../lib/focus-restore";
import { theme } from "../lib/theme";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  autoFocusCancel?: boolean;
  width?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let dialogRef: HTMLDivElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;

  createFocusRestore(() => props.open);

  createEffect(() => {
    if (!props.open) return;
    // Auto-focus cancel button or dialog panel for keyboard navigation
    requestAnimationFrame(() => (props.autoFocusCancel ? cancelRef : dialogRef)?.focus());
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  function handleDialogKeyDown(e: KeyboardEvent) {
    if (!dialogRef) return;
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
            if (e.target === e.currentTarget) props.onCancel();
          }}
        >
          <div
            ref={dialogRef}
            tabIndex={0}
            onKeyDown={handleDialogKeyDown}
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "14px",
              padding: "28px",
              width: props.width ?? "400px",
              "max-height": "80vh",
              overflow: "auto",
              display: "flex",
              "flex-direction": "column",
              gap: "16px",
              outline: "none",
              "box-shadow":
                "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                margin: "0",
                "font-size": "16px",
                color: theme.fg,
                "font-weight": "600",
              }}
            >
              {props.title}
            </h2>

            <div style={{ "font-size": "13px", color: theme.fgMuted, "line-height": "1.5" }}>
              {props.message}
            </div>

            <div
              style={{
                display: "flex",
                gap: "8px",
                "justify-content": "flex-end",
                "padding-top": "4px",
              }}
            >
              <button
                ref={cancelRef}
                type="button"
                class="btn-secondary"
                onClick={() => props.onCancel()}
                style={{
                  padding: "9px 18px",
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  color: theme.fgMuted,
                  cursor: "pointer",
                  "font-size": "13px",
                }}
              >
                {props.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                class={props.danger ? "btn-danger" : "btn-primary"}
                disabled={props.confirmDisabled}
                onClick={() => props.onConfirm()}
                style={{
                  padding: "9px 20px",
                  background: props.danger ? theme.error : theme.accent,
                  border: "none",
                  "border-radius": "8px",
                  color: props.danger ? "#fff" : theme.accentText,
                  cursor: props.confirmDisabled ? "not-allowed" : "pointer",
                  "font-size": "13px",
                  "font-weight": "500",
                  opacity: props.confirmDisabled ? "0.5" : "1",
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "8px",
                }}
              >
                <Show when={props.confirmLoading}>
                  <span class="inline-spinner" aria-hidden="true" />
                </Show>
                {props.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  );
}
