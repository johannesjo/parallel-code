/**
 * Strip text an agent's terminal should never receive in a paste: controls
 * that could end a bracketed paste early and run the rest as keystrokes, and
 * invisible characters that hide text from the reader. Claude Code also drops
 * these itself, but then holds the paste for review ("Removed N invisible
 * characters"), so the app's Enter does not submit it.
 * Tabs and newlines stay; carriage returns become newlines.
 */
export function cleanPasteText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    '',
  );
}
