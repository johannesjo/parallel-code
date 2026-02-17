import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import type { JSX } from "solid-js";

interface InfoBarProps {
  children: JSX.Element;
  onClick?: () => void;
  title?: string;
  class?: string;
}

export function InfoBar(props: InfoBarProps) {
  return (
    <div
      class={props.class}
      title={props.title}
      onClick={props.onClick}
      style={{
        height: "28px",
        "min-height": "28px",
        display: "flex",
        "align-items": "center",
        padding: "0 10px",
        background: theme.bgElevated,
        "font-family": "'JetBrains Mono', monospace",
        "font-size": sf(11),
        color: theme.fgMuted,
        "white-space": "nowrap",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        cursor: props.onClick ? "pointer" : "default",
        "user-select": "none",
        "border-top": `1px solid ${theme.border}`,
        "border-bottom": `1px solid ${theme.border}`,
      }}
    >
      {props.children}
    </div>
  );
}
