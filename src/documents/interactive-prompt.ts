import type { DocumentSelection } from './store';

/**
 * The message typed into the interactive session for a scoped instruction.
 * That session runs in the checkout with the user watching, so it is asked to
 * edit directly and told where; the rest is the user's own words.
 */
export function buildInteractivePrompt(
  documentPath: string,
  selection: DocumentSelection,
  instruction: string,
): string {
  const where = selection.wholeDocument
    ? 'the whole document'
    : selection.heading
      ? `lines ${selection.startLine}-${selection.endLine} (under "${selection.heading}")`
      : `lines ${selection.startLine}-${selection.endLine}`;
  const parts = [`Document: ${documentPath}`, `Scope: ${where}.`];
  if (!selection.wholeDocument && selection.quote.trim()) {
    const quote = selection.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    parts.push(`The passage, verbatim:\n${quote}`);
  }
  parts.push(instruction.trim());
  return plainText(parts.join('\n\n'));
}

/**
 * The passage comes from a file the app did not write and is pasted into a
 * live terminal. An ESC or a stray `\r` in it would arrive as keystrokes —
 * enough to end the paste and answer the agent's next prompt — so every C0
 * control but tab and newline is dropped.
 */
function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
