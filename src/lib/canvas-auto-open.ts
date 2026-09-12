/**
 * Decides when a Markdown file the agent just wrote should open on the task
 * canvas. Claude's PreToolUse hook carries the file path; PostToolUse only the
 * tool-use id, so the path is remembered until the write completes. A write
 * that never completes (denied permission) is dropped when the map fills.
 */
import { isPlanApprovalTool } from '../../electron/agent-hooks/status';

interface HookEventLike {
  event: string;
  toolName?: string;
  toolUseId?: string;
  detail?: string;
}

/** Claude asking to have a plan approved: the moment to put the plan on the canvas. */
export function isPlanApprovalEvent(event: HookEventLike): boolean {
  return event.event === 'PreToolUse' && isPlanApprovalTool(event.toolName);
}

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const PENDING_CAP = 50;

const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p);

/** Worktree-relative form of a path the hook reported, or null when it is not
 *  a Markdown file inside the worktree (or was clipped by the hook summary). */
export function worktreeMarkdownPath(reported: string, worktreePath: string): string | null {
  if (!reported || reported.endsWith('…')) return null;
  const root = worktreePath.replace(/\/+$/, '');
  let rel = reported;
  if (reported.startsWith('/')) {
    if (!reported.startsWith(`${root}/`)) return null;
    rel = reported.slice(root.length + 1);
  }
  rel = rel.replace(/^\.\//, '');
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '..')) return null;
  if (/^\.(parallel|worktrees|git|claude)(\/|$)/.test(rel)) return null;
  return isMarkdown(rel) ? rel : null;
}

/**
 * Feeds one hook event through; returns the worktree-relative Markdown path to
 * open when this event completes a write, else null. `pending` is the caller's
 * map of tool-use ids to paths.
 */
export function nextCanvasOpen(
  pending: Map<string, string>,
  event: HookEventLike,
  worktreePath: string,
): string | null {
  const id = event.toolUseId;
  if (!id) return null;
  if (event.event === 'PreToolUse') {
    if (!WRITE_TOOLS.has((event.toolName ?? '').toLowerCase()) || !event.detail) return null;
    const rel = worktreeMarkdownPath(event.detail, worktreePath);
    if (!rel) return null;
    if (pending.size >= PENDING_CAP) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    pending.set(id, rel);
    return null;
  }
  if (event.event === 'PostToolUse') {
    const rel = pending.get(id) ?? null;
    pending.delete(id);
    return rel;
  }
  if (event.event === 'PostToolUseFailure') pending.delete(id);
  return null;
}
