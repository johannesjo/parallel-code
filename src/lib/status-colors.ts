import { theme } from "./theme";

/** Map a git status letter (M, A, D, ?) to a theme color. */
export function getStatusColor(status: string): string {
  return ({ M: theme.warning, A: theme.success, D: theme.error, "?": theme.fgMuted }[status] ?? theme.fgMuted);
}
