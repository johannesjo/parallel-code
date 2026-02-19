import type { TaskDotStatus } from "../store/taskStatus";
import { theme } from "../lib/theme";

const SIZES = { sm: 6, md: 8 } as const;

function getDotColor(status: TaskDotStatus): string {
  return ({ busy: theme.fgMuted, waiting: "#e5a800", ready: theme.success }[status]);
}

export function StatusDot(props: {
  status: TaskDotStatus;
  size?: "sm" | "md";
}) {
  const px = () => SIZES[props.size ?? "sm"];
  return (
    <span
      class={props.status === "busy" ? "status-dot-pulse" : undefined}
      style={{
        display: "inline-block",
        width: `${px()}px`,
        height: `${px()}px`,
        "border-radius": "50%",
        background: getDotColor(props.status),
        "flex-shrink": "0",
      }}
    />
  );
}
