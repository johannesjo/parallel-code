export function messageForTerminal(text: string, bracketedPaste: boolean): string {
  // Clipboard controls must not escape the pasted region or submit midway.
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
  if (!clean) return '';
  return bracketedPaste ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/\n/g, ' ');
}

interface TextBuffer {
  length: number;
  getLine(
    index: number,
  ): { isWrapped: boolean; translateToString(trimRight: boolean): string } | undefined;
}

/** Plain text of a terminal buffer, with soft-wrapped rows rejoined into their line. */
export function terminalBufferText(buffer: TextBuffer): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    // A wrapped row continues its line, so keep its trailing spaces.
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').trimEnd();
}
