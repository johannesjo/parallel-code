/** Turns a raw GitHub Actions job log into a short tail fit for a prompt. */

const MAX_TAIL_LINES = 80;
const MAX_TAIL_CHARS = 4_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** Strips colors and timestamps, then keeps the lines leading up to the failure. */
export function cleanJobLog(raw: string): string {
  let lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(ANSI, '').replace(TIMESTAMP, '').trimEnd());
  // Post-job cleanup steps follow the failing step; end at its last error marker.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('##[error]')) {
      lines = lines.slice(0, i + 1);
      break;
    }
  }
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  let tail = lines.slice(-MAX_TAIL_LINES).join('\n');
  if (tail.length > MAX_TAIL_CHARS) {
    tail = tail.slice(-MAX_TAIL_CHARS);
    // Drop the partial first line left by the character cut.
    tail = tail.slice(tail.indexOf('\n') + 1);
  }
  return tail;
}
