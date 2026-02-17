import { type JSX } from "solid-js";
import { theme } from "../lib/theme";

interface IconButtonProps {
  icon: string | JSX.Element;
  onClick: (e: MouseEvent) => void;
  title?: string;
  size?: "sm" | "md";
}

export function IconButton(props: IconButtonProps) {
  const isSm = () => props.size === "sm";

  return (
    <button
      class="icon-btn"
      title={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick(e);
      }}
      style={{
        background: "transparent",
        border: `1px solid ${theme.border}`,
        color: theme.fgMuted,
        cursor: "pointer",
        "border-radius": "6px",
        padding: isSm() ? "2px 6px" : "3px 8px",
        "font-size": isSm() ? "11px" : "13px",
        "line-height": "1",
        "flex-shrink": "0",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
      }}
    >
      {props.icon}
    </button>
  );
}
