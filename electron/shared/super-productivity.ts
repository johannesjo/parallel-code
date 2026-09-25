/**
 * Renderer-safe types and pure rules for the Super Productivity integration.
 *
 * Super Productivity (a todo + time-tracking app) exposes a token-protected
 * REST API on 127.0.0.1. The main process owns the token and every request
 * (electron/super-productivity/); the renderer decides *when* to call it using
 * the rules below, which stay pure so they can be tested without either app.
 */

export interface SpTaskSummary {
  id: string;
  title: string;
  isDone: boolean;
  projectId: string | null;
  parentId: string | null;
}

export interface SpTaskDetail extends SpTaskSummary {
  notes: string;
  /** Link to the issue the task was imported from (GitHub, Jira, …), if any. */
  issueUrl?: string;
}

export interface SpProject {
  id: string;
  title: string;
}

export interface SpTrackingState {
  /** The task Super Productivity is tracking time on, or null. */
  current: SpTaskSummary | null;
  /** True while a focus-mode break is running. */
  isBreak: boolean;
}

export type SpConnectionState =
  | 'not_configured'
  | 'connected'
  | 'unreachable'
  | 'disabled'
  | 'unauthorized'
  | 'not_ready';

export type SpFailureReason =
  | Exclude<SpConnectionState, 'connected'>
  | 'not_found'
  | 'invalid_request'
  | 'error';

/** Longest title sent to Super Productivity; longer task names are shortened. */
export const SP_MAX_TITLE_LENGTH = 500;
/** Most task ids one refresh asks about (one GET each, a few at a time). */
export const SP_MAX_BATCH_IDS = 50;

/** The title Parallel Code sends for a task name — also what title sync compares. */
export function toSpTitle(name: string): string {
  const title = name.trim();
  return title.length > SP_MAX_TITLE_LENGTH
    ? `${title.slice(0, SP_MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : title;
}

export type SpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SpFailureReason; message?: string };

// ---------------------------------------------------------------------------
// Focus → tracking

export type SpFocusDecision =
  | { kind: 'none' }
  | { kind: 'track' }
  | { kind: 'banner'; reason: SpBannerReason; trackingTitle?: string };

export type SpBannerReason = 'other_task' | 'break' | 'done' | 'missing';

/**
 * What to do when the user settles on a Parallel Code task:
 * - already tracking it → nothing
 * - a focus-mode break is running → ask (banner) instead of starting
 * - Super Productivity tracks a task that isn't Parallel Code's → ask
 * - the linked task was completed in Super Productivity → ask, because
 *   starting a done task reopens it there
 * - the linked task is gone there (archived by "finish day", or deleted) →
 *   ask, rather than silently start a duplicate
 * - otherwise (nothing tracked, or another Parallel Code task) → track
 *
 * A task counts as Parallel Code's when it, or its parent, is linked:
 * starting a parent can make Super Productivity track one of its subtasks.
 */
export function decideSpFocusAction(input: {
  tracking: SpTrackingState;
  ownSpTaskId: string | null;
  ownSpTaskIsDone: boolean;
  /** Linked, but Super Productivity no longer has an active task with that id. */
  ownSpTaskMissing?: boolean;
  linkedSpTaskIds: ReadonlySet<string>;
}): SpFocusDecision {
  const { tracking, ownSpTaskId, ownSpTaskIsDone, linkedSpTaskIds } = input;
  const current = tracking.current;
  if (ownSpTaskId && current && (current.id === ownSpTaskId || current.parentId === ownSpTaskId)) {
    return { kind: 'none' };
  }
  if (tracking.isBreak) return { kind: 'banner', reason: 'break' };
  if (current && !isLinkedSpTask(current, linkedSpTaskIds)) {
    return { kind: 'banner', reason: 'other_task', trackingTitle: current.title };
  }
  if (input.ownSpTaskMissing) return { kind: 'banner', reason: 'missing' };
  if (ownSpTaskId && ownSpTaskIsDone) return { kind: 'banner', reason: 'done' };
  return { kind: 'track' };
}

function isLinkedSpTask(task: SpTaskSummary, linked: ReadonlySet<string>): boolean {
  return linked.has(task.id) || (task.parentId !== null && linked.has(task.parentId));
}

// ---------------------------------------------------------------------------
// Title sync

export type SpTitleSyncAction =
  | { kind: 'none' }
  /** Both sides agree on a new title; only the remembered base moves. */
  | { kind: 'rebase'; title: string }
  /** Super Productivity's title changed: copy it into Parallel Code. */
  | { kind: 'pull'; title: string }
  /** Parallel Code's title changed (or both did): send it to Super Productivity. */
  | { kind: 'push'; title: string };

/**
 * Three-way title merge against the last title both apps agreed on. Whichever
 * side moved away from it wins; when both moved, Parallel Code wins — its
 * renames are sent immediately, so that only happens when the other app was
 * unreachable at the time.
 */
export function resolveSpTitleSync(base: string, local: string, remote: string): SpTitleSyncAction {
  if (local === remote) return base === local ? { kind: 'none' } : { kind: 'rebase', title: local };
  if (local === base) return { kind: 'pull', title: remote };
  return { kind: 'push', title: local };
}

// ---------------------------------------------------------------------------
// Done notes

export function buildSpDoneNote(input: {
  kind: 'merged' | 'closed';
  branchName?: string;
  baseBranch?: string;
  linesAdded?: number;
  linesRemoved?: number;
  prUrl?: string;
}): string {
  const branch = input.branchName ? `\`${input.branchName}\`` : '';
  let line: string;
  if (input.kind === 'merged') {
    const into = input.baseBranch ? ` into \`${input.baseBranch}\`` : '';
    line = `Merged ${branch || 'branch'}${into} in Parallel Code`;
    if (typeof input.linesAdded === 'number' && typeof input.linesRemoved === 'number') {
      line += ` (+${input.linesAdded} −${input.linesRemoved})`;
    }
  } else {
    line = `Closed in Parallel Code${branch ? ` (branch ${branch})` : ''}`;
  }
  line += '.';
  if (input.prUrl) line += ` PR: ${input.prUrl}`;
  return line;
}

export function appendSpNote(existing: string, line: string): string {
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${line}` : line;
}

// ---------------------------------------------------------------------------
// parallelcode:// links

export const PARALLEL_CODE_PROTOCOL = 'parallelcode';

/** Super Productivity task and project ids are nanoids (or `INBOX_PROJECT`); allow headroom. */
const SP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSpId(value: unknown): value is string {
  return typeof value === 'string' && SP_ID_PATTERN.test(value);
}

/**
 * The only link Parallel Code accepts: `parallelcode://new-task?spTaskId=<id>`.
 * It carries an opaque id and nothing else — the task's content is fetched
 * from Super Productivity, and the link only pre-fills the New Task panel —
 * so a web page that fires it can at most open a form for the user's own task.
 */
export function parseParallelCodeUrl(url: string): { action: 'new-task'; spTaskId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PARALLEL_CODE_PROTOCOL}:`) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  // The action is the host (`parallelcode://new-task`, optionally with a
  // trailing slash) or, without one, the whole path (`parallelcode:new-task`).
  const action = parsed.host
    ? parsed.pathname === '' || parsed.pathname === '/'
      ? parsed.host
      : ''
    : parsed.pathname;
  if (action.toLowerCase() !== 'new-task') return null;
  const spTaskId = parsed.searchParams.get('spTaskId');
  return isValidSpId(spTaskId) ? { action: 'new-task', spTaskId } : null;
}

/** The New Task prompt for a task sent from Super Productivity. */
export function buildPromptFromSpTask(
  task: Pick<SpTaskDetail, 'title' | 'notes' | 'issueUrl'>,
): string {
  const parts = [task.title.trim()];
  const notes = task.notes.trim();
  if (notes) parts.push(notes);
  if (task.issueUrl && !notes.includes(task.issueUrl)) parts.push(task.issueUrl);
  return parts.join('\n\n');
}
