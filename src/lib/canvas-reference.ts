/**
 * Turns a passage the user selected in the task canvas into the prompt typed
 * into the agent session: their words first, then where the passage lives and
 * the passage itself, so the agent can find and edit it.
 */

export interface QuoteLocation {
  startLine: number;
  endLine: number;
  heading?: string;
}

export interface CanvasReferenceInput {
  /** Worktree-relative path of the document on the canvas. */
  documentPath: string;
  /** The text the user selected. */
  quote: string;
  instruction: string;
  /** Where the selection sits in the file, when the file holds it as shown. */
  location: QuoteLocation | null;
}

/** The nearest heading above the 1-based `line`, if any. */
export function headingAbove(source: string, line: number): string | undefined {
  const lines = source.split(/\r?\n/);
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * The passage is pasted into a live terminal: an ESC or a stray `\r` would
 * arrive as keystrokes, so every C0 control but tab and newline is dropped.
 */
function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export function buildCanvasReference(input: CanvasReferenceInput): string {
  const where = input.location;
  const scope = where
    ? `Scope: lines ${where.startLine}-${where.endLine}${where.heading ? ` (under "${where.heading}")` : ''}.`
    : null;
  const quoted = input.quote
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const parts = [input.instruction.trim(), `Document: ${input.documentPath}`];
  if (scope) parts.push(scope);
  parts.push(`The passage, verbatim:\n${quoted}`);
  return plainText(parts.filter(Boolean).join('\n\n'));
}
