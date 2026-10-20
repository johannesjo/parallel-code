import { stripAnsi } from './prompt-detect.js';

/** Read Codex's final exit footer, never a "latest session" guess. */
export function codexResumeId(output: string): string | undefined {
  const footer = stripAnsi(output).trim();
  return /\bTo continue this session, run:?\s+codex resume ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s*$/i.exec(
    footer,
  )?.[1];
}

/** Codex prints this footer when the thread has no saved conversation to resume. */
export function isCodexUnsavedSessionExit(output: string): boolean {
  return /(?:^|[\r\n])Session ID: [0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\s*$/i.test(
    stripAnsi(output).trim(),
  );
}
