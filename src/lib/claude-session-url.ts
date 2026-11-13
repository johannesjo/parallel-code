/** Parsing for Claude Code on the web session links (`https://claude.ai/code/session_…`). */

import { stripAnsi } from '../../electron/shared/prompt-detect';

// The id is passed to `claude --teleport` as argv, so the fixed `session_`
// prefix also guarantees it can never be parsed as a flag.
const SESSION_ID_RE = /^session_[A-Za-z0-9_-]{1,128}$/;

/** Teleport session id from a Claude web session URL, or null for any other text. */
export function parseClaudeSessionUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai') return null;
  if (url.username || url.password) return null;
  const match = /^\/code\/([^/]+)\/?$/.exec(url.pathname);
  const id = match?.[1];
  return id && SESSION_ID_RE.test(id) ? id : null;
}

/** Whether `text` is a Claude web session URL. */
export function isClaudeSessionUrl(text: string): boolean {
  return parseClaudeSessionUrl(text) !== null;
}

/**
 * The web sessions list. Standing in for a dropped link, it asks for the CLI's
 * own picker (`claude --teleport` without an id), which lists only the
 * sessions of the repository it runs in, so the project picks the repo.
 */
export const CLAUDE_SESSIONS_URL = 'https://claude.ai/code';

/** What `claude --teleport` continues: a named session, or one picked in the CLI. */
export interface TeleportTarget {
  sessionId?: string;
}

/** Teleport target of a dropped link: a session link or the sessions list. */
export function parseTeleportTarget(text: string): TeleportTarget | null {
  if (text === CLAUDE_SESSIONS_URL) return {};
  const sessionId = parseClaudeSessionUrl(text);
  return sessionId ? { sessionId } : null;
}

/** The web session link for a teleport session id. */
export function claudeSessionUrl(sessionId: string): string {
  return `https://claude.ai/code/${sessionId}`;
}

/**
 * Repository name from `claude --teleport`'s "You must run claude --teleport …
 * from a checkout of owner/repo." error, or null for any other output. The CLI
 * names the repo as `owner/repo` or `host/owner/repo`; only the last segment
 * can be matched to a project, as GitHub drops do.
 */
export function parseTeleportRepoMismatch(lines: readonly string[]): string | null {
  const text = stripAnsi(lines.join('\n'));
  const match = /claude --teleport \S+ from a checkout of (\S+?)\.(?:\s|$)/.exec(text);
  return match?.[1]?.split('/').pop() || null;
}
