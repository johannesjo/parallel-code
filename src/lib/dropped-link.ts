/** Normalizing for links dropped or pasted to start a task. */

// Dragging selected address-bar text (seen on Linux/Wayland) gives plain text
// without the scheme. Only task-source hosts get one back, so other text stays
// unrecognized.
const SCHEMELESS_TASK_LINK_RE = /^(?:claude\.ai|(?:www\.)?github\.com)\//;

/** `text` trimmed, with `https://` restored on a scheme-less Claude or GitHub link. */
export function withLinkScheme(text: string): string {
  const trimmed = text.trim();
  return SCHEMELESS_TASK_LINK_RE.test(trimmed) ? `https://${trimmed}` : trimmed;
}
