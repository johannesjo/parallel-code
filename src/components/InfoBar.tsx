import { theme } from "../lib/theme";
import { sf } from "../lib/fontScale";
import type { JSX } from "solid-js";

interface InfoBarProps {
  children: JSX.Element;
  onClick?: () => void;
  onDblClick?: () => void;
  title?: string;
  class?: string;
}

export function InfoBar(props: InfoBarProps) {
  return (
    <div
      class={props.class}
      title={props.title}
      onClick={props.onClick}
      onDblClick={props.onDblClick}
      style={{
        height: "28px",
        "min-height": "28px",
        display: "flex",
        "align-items": "center",
        padding: "0 10px",
        "font-family": "'JetBrains Mono', monospace",
        "font-size": sf(11),
        color: theme.fgMuted,
        "white-space": "nowrap",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        cursor: props.onClick ? "pointer" : "default",
        "user-select": "none",
      }}
    >
      {props.children}
    </div>
  );
}
