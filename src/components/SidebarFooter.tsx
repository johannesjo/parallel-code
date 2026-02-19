import { createMemo } from "solid-js";
import { getCompletedTasksTodayCount, getMergedLineTotals } from "../store/store";
import { toggleHelpDialog } from "../store/focus";
import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import { mod } from "../lib/platform";

export function SidebarFooter() {
  const completedTasksToday = createMemo(() => getCompletedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());

  return (
    <>
      <div style={{
        "border-top": `1px solid ${theme.border}`,
        "padding-top": "12px",
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        "flex-shrink": "0",
      }}>
        <span style={{
          "font-size": sf(10),
          color: theme.fgSubtle,
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}>
          Progress
        </span>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          "border-radius": "8px",
          padding: "8px 10px",
          "font-size": sf(11),
          color: theme.fgMuted,
        }}>
          <span>Completed today</span>
          <span style={{
            color: theme.fg,
            "font-weight": "600",
            "font-variant-numeric": "tabular-nums",
          }}>
            {completedTasksToday()}
          </span>
        </div>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          "border-radius": "8px",
          padding: "8px 10px",
          "font-size": sf(11),
          color: theme.fgMuted,
        }}>
          <span>Merged to main/master</span>
          <span style={{
            color: theme.fg,
            "font-weight": "600",
            "font-variant-numeric": "tabular-nums",
            display: "flex",
            "align-items": "center",
            gap: "8px",
          }}>
            <span style={{ color: theme.success }}>+{mergedLines().added.toLocaleString()}</span>
            <span style={{ color: theme.error }}>-{mergedLines().removed.toLocaleString()}</span>
          </span>
        </div>
      </div>

      {/* Tips */}
      <div
        onClick={() => toggleHelpDialog(true)}
        style={{
          "border-top": `1px solid ${theme.border}`,
          "padding-top": "12px",
          display: "flex",
          "flex-direction": "column",
          gap: "6px",
          "flex-shrink": "0",
          cursor: "pointer",
        }}
      >
        <span style={{
          "font-size": sf(10),
          color: theme.fgSubtle,
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}>
          Tips
        </span>
        <span style={{
          "font-size": sf(11),
          color: theme.fgMuted,
          "line-height": "1.4",
        }}>
          <kbd style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "3px",
            padding: "1px 4px",
            "font-size": sf(10),
            "font-family": "'JetBrains Mono', monospace",
          }}>Alt + Arrows</kbd>{" "}
          to navigate panels
        </span>
        <span style={{
          "font-size": sf(11),
          color: theme.fgMuted,
          "line-height": "1.4",
        }}>
          <kbd style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "3px",
            padding: "1px 4px",
            "font-size": sf(10),
            "font-family": "'JetBrains Mono', monospace",
          }}>{mod} + /</kbd>{" "}
          for all shortcuts
        </span>
      </div>
    </>
  );
}
