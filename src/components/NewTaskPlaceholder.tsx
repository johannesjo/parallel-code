import { toggleNewTaskDialog, createTerminal, store, unfocusPlaceholder } from "../store/store";
import { theme } from "../lib/theme";
import { mod } from "../lib/platform";

export function NewTaskPlaceholder() {
  const isFocused = (btn: "add-task" | "add-terminal") =>
    store.placeholderFocused && store.placeholderFocusedButton === btn;

  const focusedBorder = (btn: "add-task" | "add-terminal") =>
    isFocused(btn)
      ? `2px dashed ${theme.accent}`
      : `2px dashed ${theme.border}`;

  const focusedColor = (btn: "add-task" | "add-terminal") =>
    isFocused(btn) ? theme.accent : theme.fgSubtle;

  const focusedBg = (btn: "add-task" | "add-terminal") =>
    isFocused(btn) ? `color-mix(in srgb, ${theme.accent} 8%, transparent)` : undefined;

  return (
    <div
      style={{
        width: "48px",
        "min-width": "48px",
        height: "calc(100% - 12px)",
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
        margin: "6px 3px",
        "flex-shrink": "0",
      }}
    >
      {/* Add task button — fills remaining space */}
      <div
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New task"
        onClick={() => toggleNewTaskDialog(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            unfocusPlaceholder();
            toggleNewTaskDialog(true);
          }
        }}
        style={{
          flex: "1",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          cursor: "pointer",
          "border-radius": "12px",
          border: focusedBorder("add-task"),
          color: focusedColor("add-task"),
          background: focusedBg("add-task"),
          "font-size": "20px",
          "user-select": "none",
        }}
        title={`New task (${mod}+N)`}
      >
        +
      </div>

      {/* Terminal button — same width, fixed height */}
      <div
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New terminal"
        onClick={() => createTerminal()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            unfocusPlaceholder();
            createTerminal();
          }
        }}
        style={{
          height: "44px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          cursor: "pointer",
          "border-radius": "10px",
          border: focusedBorder("add-terminal"),
          color: focusedColor("add-terminal"),
          background: focusedBg("add-terminal"),
          "font-size": "13px",
          "font-family": "monospace",
          "user-select": "none",
          "flex-shrink": "0",
        }}
        title={`New terminal (${mod}+Shift+D)`}
      >
        &gt;_
      </div>
    </div>
  );
}
