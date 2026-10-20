/**
 * The shape of an indexed agent session, shared by the main-process scanner
 * that produces these and the renderer that lists them. Pure types plus one
 * CLI lookup — no Node or Electron imports, so `src/` may import it.
 */

export type SessionAgent = 'claude' | 'codex';

/**
 * Shape of a session id, deliberately checked on the way in *and* on the way
 * out to argv.
 *
 * A session id is read out of a transcript file and then handed to a spawned
 * CLI as an argument. `claude --resume` takes an *optional* argument, and
 * `codex resume` takes a positional, so a value beginning with a dash is
 * parsed by both as a flag in its own right rather than as the id — which is
 * how `--dangerously-skip-permissions` would get in. Nothing about the id is
 * trusted for being on disk; anything an agent can write, an attacker who can
 * steer an agent can write.
 *
 * Both CLIs use UUIDs (Claude v4, Codex v7), so this matches the hex shape and
 * not a version nibble — a future version bump should not silently drop every
 * session from the picker.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export interface SessionRecord {
  /** Session id as the CLI's resume flag expects it. */
  id: string;
  agent: SessionAgent;
  /** Working directory the session ran in, read from the transcript body —
   *  never inferred from the file's location. */
  cwd: string;
  branch?: string;
  title?: string;
  /** The agent's own summary of the last exchange, already clipped. */
  lastPrompt?: string;
  startedAt?: number;
  /** File mtime; the scanner fills this in. */
  updatedAt: number;
}

/**
 * Which indexed agent a launch command corresponds to, or null when PC keeps
 * no transcripts for it.
 *
 * Used to keep a pane from being offered another CLI's sessions: a Claude
 * session id means nothing to Codex, and resuming across them would fail at
 * launch rather than politely.
 */
export function sessionAgentForCommand(command: string): SessionAgent | null {
  const name = command.split('/').pop() ?? command;
  if (name === 'claude') return 'claude';
  if (name.includes('codex')) return 'codex';
  return null;
}
