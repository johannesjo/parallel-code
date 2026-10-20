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
