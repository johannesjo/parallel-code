/**
 * Parsing for the transcripts agent CLIs write to disk. Pure: entries arrive
 * already JSON-parsed, so the scanner owns all I/O and this stays testable.
 *
 * Both formats are undocumented and will drift. Every field is therefore
 * optional and every parser returns null rather than throwing on a shape it
 * does not recognise — a session that fails to parse is simply absent, which
 * degrades resume to the positional `--continue` PC used before this existed.
 */

// Declared in electron/shared so the renderer may import them too; the
// renderer lists what this module parses.
export type { SessionAgent, SessionRecord } from '../shared/session-record.js';

import { isSessionId, type SessionRecord } from '../shared/session-record.js';

const TITLE_MAX_CHARS = 120;
const LAST_PROMPT_MAX_CHARS = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return undefined;
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function asEpoch(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Directory name Claude Code gives a working directory under
 * `~/.claude/projects`: path separators and dots both become dashes, so
 * `/home/u/p/.worktrees/t` becomes `-home-u-p--worktrees-t`.
 *
 * Derived forward only, and used solely to pick a directory to look in. The
 * real rule is Claude's and undocumented, so a slug this gets wrong points at a
 * directory that does not exist and yields no sessions — never at the wrong
 * ones, because `cwd` is then re-read from each transcript and compared.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Build a record from Claude Code transcript entries.
 *
 * `fileId` is the transcript's filename stem, used when no entry carries a
 * `sessionId` — the two agree in every observed file, but the filename is the
 * one the resume flag actually needs.
 */
export function parseClaudeTranscript(
  entries: readonly unknown[],
  fileId: string,
): Omit<SessionRecord, 'updatedAt'> | null {
  let id: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let startedAt: number | undefined;

  for (const entry of entries) {
    const raw = asRecord(entry);
    if (!raw) continue;
    id ??= asString(raw.sessionId);
    cwd ??= asString(raw.cwd);
    branch ??= asString(raw.gitBranch);
    startedAt ??= asEpoch(raw.timestamp);
    // Claude rewrites these as the session goes, appending a fresh line each
    // time, so the last one in the file is the current one.
    if (raw.type === 'ai-title') title = asString(raw.aiTitle) ?? title;
    if (raw.type === 'last-prompt') lastPrompt = asString(raw.lastPrompt) ?? lastPrompt;
  }

  // Both candidates are checked, so a file named `--flag.jsonl` cannot stand in
  // for a session id that the body declared properly.
  const sessionId = [id, fileId].find(isSessionId);
  if (!sessionId || !cwd) return null;
  return {
    id: sessionId,
    agent: 'claude',
    cwd,
    branch,
    title: clip(title, TITLE_MAX_CHARS),
    lastPrompt: clip(lastPrompt, LAST_PROMPT_MAX_CHARS),
    startedAt,
  };
}

/**
 * Blocks Codex injects into the first user turn — the project's AGENTS.md and
 * an `<environment_context>` dump, as two parts of one message. They are the
 * harness talking, not the user, and titling every session with the same
 * project instructions would make them indistinguishable in a picker.
 *
 * The second pattern covers the pseudo-XML wrappers generally
 * (`<environment_context>`, `<INSTRUCTIONS>`, `<user_instructions>`) rather
 * than naming each: a real prompt rarely opens with a bare tag, and the cost of
 * being wrong is a poor title, never a wrong session.
 */
const CODEX_INJECTED_PREFIXES = [/^#\s*AGENTS\.md instructions\b/i, /^<[a-z_][\w-]*>/i];

function isInjectedInstructions(text: string): boolean {
  const start = text.trimStart();
  return CODEX_INJECTED_PREFIXES.some((pattern) => pattern.test(start));
}

/**
 * The agent's own first words, from a Codex `event_msg` item.
 *
 * Only used when a session has no user turn at all, which is what a sub-agent
 * session looks like: it is handed its instructions through another channel and
 * its transcript opens with the agent already talking.
 */
function codexAgentText(payload: Record<string, unknown> | null): string | undefined {
  const item = asRecord(payload?.item);
  if (item?.type !== 'AgentMessage') return undefined;
  const content = Array.isArray(item.content) ? item.content : [];
  for (const part of content) {
    const text = asString(asRecord(part)?.text);
    if (text) return text;
  }
  return undefined;
}

/** Pull the user's own text out of a Codex `response_item` message payload. */
function codexUserText(payload: Record<string, unknown>): string | undefined {
  if (payload.role !== 'user') return undefined;
  const content = payload.content;
  const parts = Array.isArray(content) ? content : [content];
  for (const part of parts) {
    const raw = asRecord(part);
    const text = asString(raw?.text);
    if (text && !isInjectedInstructions(text)) return text;
  }
  return undefined;
}

/**
 * The user's first words in a Codex session, from however much of the file the
 * caller managed to read.
 *
 * Split out from `parseCodexTranscript` because it needs a far deeper read than
 * the metadata does. Codex front-loads its injected preamble — AGENTS.md,
 * `<environment_context>`, plugin lists — into the first user turn, and on a
 * real project that runs to a few hundred kilobytes before the user's own text
 * begins: measured across transcripts on a working machine, the median first
 * real turn starts around 250KB in, p90 around 288KB. `session_meta` is on line
 * one; the title is nowhere near it. The scanner therefore reads a small window
 * for the record and a large one for this.
 */
export function codexTitleFrom(entries: readonly unknown[]): string | undefined {
  let userText: string | undefined;
  let agentText: string | undefined;

  for (const entry of entries) {
    const raw = asRecord(entry);
    if (!raw) continue;
    if (raw.type === 'response_item') {
      const payload = asRecord(raw.payload);
      userText ??= payload ? codexUserText(payload) : undefined;
      if (userText) break;
    }
    if (raw.type === 'event_msg') agentText ??= codexAgentText(asRecord(raw.payload));
  }
  // The user's own words when there are any. Codex's sub-agent sessions have
  // none — no human ever typed into them — and they are the bulk of what a
  // busy worktree accumulates, so without the fallback most rows in the picker
  // would read "Session 01a09b37" and be impossible to tell apart.
  return clip(userText ?? agentText, TITLE_MAX_CHARS);
}

/**
 * Build a record from Codex CLI transcript entries.
 *
 * Codex writes no title or summary of its own, so the user's own turns stand in
 * for both: the earliest available one titles the session, the latest one is
 * its last prompt.
 *
 * On a windowed read the title this produces is only as good as the window —
 * see `codexTitleFrom`, which the scanner uses to get a real one. The last
 * prompt is reliable either way, because it comes from the file's tail.
 */
export function parseCodexTranscript(
  entries: readonly unknown[],
): Omit<SessionRecord, 'updatedAt'> | null {
  let meta: Record<string, unknown> | null = null;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;

  for (const entry of entries) {
    const raw = asRecord(entry);
    if (!raw) continue;
    if (raw.type === 'session_meta') meta ??= asRecord(raw.payload);
    if (raw.type === 'response_item') {
      const payload = asRecord(raw.payload);
      const text = payload ? codexUserText(payload) : undefined;
      if (text) {
        firstUserText ??= text;
        lastUserText = text;
      }
    }
  }
  if (!meta) return null;

  const id = [meta.id, meta.session_id].find(isSessionId);
  const cwd = asString(meta.cwd);
  if (!id || !cwd) return null;
  const title = clip(firstUserText, TITLE_MAX_CHARS);
  const lastPrompt = clip(lastUserText, LAST_PROMPT_MAX_CHARS);
  return {
    id,
    agent: 'codex',
    cwd,
    branch: asString(asRecord(meta.git)?.branch),
    title,
    // A single-turn session would otherwise show the same string twice.
    lastPrompt: lastPrompt === title ? undefined : lastPrompt,
    startedAt: asEpoch(meta.timestamp),
  };
}
