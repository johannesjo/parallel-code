/**
 * Session-id flags for the agent CLIs, so a task resumes the conversation that
 * belongs to its own pane.
 *
 * The positional defaults in `agents.ts` (`--continue`, `resume --last`) mean
 * "the most recent session in this directory". That is the wrong session as
 * soon as a worktree holds two agent panes, or the user has run the CLI there
 * by hand, and it fails silently — the pane comes back with someone else's
 * conversation. Naming the session fixes that.
 *
 * Only flags verified against the installed CLI's own `--help` appear here.
 * Anything else returns null and the caller keeps the positional behaviour,
 * because a wrong flag does not degrade the launch, it breaks it.
 */

import { isSessionId } from './session-record.js';

function commandName(command: string): string {
  return command.split('/').pop() ?? command;
}

function isClaude(command: string): boolean {
  return commandName(command) === 'claude';
}

function isCodex(command: string): boolean {
  return commandName(command).includes('codex');
}

/**
 * Args that make a *new* session use an id we chose.
 *
 * Only Claude Code offers this (`--session-id <uuid>`), and it is the stronger
 * half of the feature: the id is known before the agent writes anything, so the
 * pane owns its session outright and no matching after the fact is needed.
 *
 * The id must be unused — resuming is `resumeSessionArgs`, not this — so
 * callers mint a fresh one per new session.
 */
export function newSessionArgs(command: string, sessionId: string): string[] | null {
  if (!isSessionId(sessionId)) return null;
  if (isClaude(command)) return ['--session-id', sessionId];
  return null;
}

/**
 * Args that resume one specific session by id.
 *
 * Codex accepts an id positionally (`codex resume <SESSION_ID>`) even though it
 * cannot be told one up front, which is why resuming and starting are separate
 * questions here.
 */
export function resumeSessionArgs(command: string, sessionId: string): string[] | null {
  if (!isSessionId(sessionId)) return null;
  if (isClaude(command)) return ['--resume', sessionId];
  if (isCodex(command)) return ['resume', sessionId];
  return null;
}

/**
 * Whether PC may mint this CLI's session id itself.
 *
 * Deliberately narrower than `canResumeSessionId`: Codex accepts an id when
 * resuming but assigns its own when starting, so an id PC invented for a Codex
 * pane would name a session that never existed — and resuming it later would
 * fail outright, which is worse than the positional default it replaced. Only
 * mint where the CLI will actually honour the id.
 */
export function canAssignSessionId(command: string): boolean {
  return isClaude(command);
}

/** Whether this CLI can resume one specific session id, however that id was
 *  obtained — PC-assigned, or read back from the transcript index. */
export function canResumeSessionId(command: string): boolean {
  return isClaude(command) || isCodex(command);
}
