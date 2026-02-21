import { createEffect, onMount, onCleanup } from "solid-js";
import {
  store,
  closeTerminal,
  updateTerminalName,
  setActiveTask,
  reorderTask,
  getFontScale,
  registerFocusFn,
  unregisterFocusFn,
  triggerFocus,
  setTaskFocusedPanel,
} from "../store/store";
import { EditableText, type EditableTextHandle } from "./EditableText";
import { IconButton } from "./IconButton";
import { TerminalView } from "./TerminalView";
import { ScalablePanel } from "./ScalablePanel";
import { theme } from "../lib/theme";
import { handleDragReorder } from "../lib/dragReorder";
import type { Terminal } from "../store/types";

interface TerminalPanelProps {
  terminal: Terminal;
  isActive: boolean;
}

export function TerminalPanel(props: TerminalPanelProps) {
  let panelRef!: HTMLDivElement;
  let titleEditHandle: EditableTextHandle | undefined;

  // Focus registration
  onMount(() => {
    const id = props.terminal.id;
    registerFocusFn(`${id}:title`, () => titleEditHandle?.startEdit());

    onCleanup(() => {
      unregisterFocusFn(`${id}:title`);
      unregisterFocusFn(`${id}:terminal`);
    });
  });

  // Respond to focus panel changes
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.terminal.id] ?? "terminal";
    triggerFocus(`${props.terminal.id}:${panel}`);
  });

  function handleTitleMouseDown(e: MouseEvent) {
    handleDragReorder(e, {
      itemId: props.terminal.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.terminal.id),
    });
  }

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? "active" : ""}`}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        background: theme.taskContainerBg,
        "border-radius": "0",
        border: `1px solid ${theme.border}`,
        overflow: "clip",
        position: "relative",
      }}
      onClick={() => setActiveTask(props.terminal.id)}
    >
      {/* Title bar */}
      <div
        class={props.isActive ? "island-header-active" : ""}
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "0 10px",
          height: "36px",
          "min-height": "36px",
          background: "transparent",
          "border-bottom": `1px solid ${theme.border}`,
          "user-select": "none",
          cursor: "grab",
          "flex-shrink": "0",
        }}
        onMouseDown={handleTitleMouseDown}
      >
        <div style={{
          overflow: "hidden",
          flex: "1",
          "min-width": "0",
          display: "flex",
          "align-items": "center",
          gap: "8px",
        }}>
          <span style={{
            "font-family": "monospace",
            "font-size": "13px",
            color: theme.fgMuted,
            "flex-shrink": "0",
          }}>&gt;_</span>
          <EditableText
            value={props.terminal.name}
            onCommit={(v) => updateTerminalName(props.terminal.id, v)}
            class="editable-text"
            ref={(h) => titleEditHandle = h}
          />
        </div>
        <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            }
            onClick={() => closeTerminal(props.terminal.id)}
            title="Close terminal"
          />
        </div>
      </div>

      {/* Terminal */}
      <ScalablePanel panelId={`${props.terminal.id}:terminal`}>
        <div
          class="focusable-panel"
          style={{
            height: "100%",
            position: "relative",
          }}
          onClick={() => setTaskFocusedPanel(props.terminal.id, "terminal")}
        >
          <TerminalView
            taskId={props.terminal.id}
            agentId={props.terminal.agentId}
            isFocused={props.isActive && store.focusedPanel[props.terminal.id] === "terminal"}
            command=""
            args={["-l"]}
            cwd=""
            onReady={(focusFn) => registerFocusFn(`${props.terminal.id}:terminal`, focusFn)}
            fontSize={Math.round(13 * getFontScale(`${props.terminal.id}:terminal`))}
            autoFocus
          />
        </div>
      </ScalablePanel>
    </div>
  );
}
