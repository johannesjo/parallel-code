import type { TerminalBookmark } from '../store/types';
import { expandPortVariable } from './task-ports';

/** Kept short so toolbar buttons stay compact; the forms enforce it too. */
export const BOOKMARK_NAME_MAX_LENGTH = 40;
const URL_MAX_LENGTH = 2048;

/** Extract a short label from a command string. */
export function extractLabel(command: string): string {
  const words = command.trim().split(/\s+/);
  // Walk backwards, skip flags (words starting with -)
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.startsWith('-')) continue;
    // Strip path prefixes and file extensions
    const base = w.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
    if (base) return base;
  }
  return words[0] ?? 'cmd';
}

/** A program a task terminal runs in place of the user's shell. */
export interface ShellLaunch {
  command: string;
  args: string[];
  /** The agent's env file, so the program runs with the same account and settings. */
  envFile?: string;
}

/** Ephemeral map for passing a direct launch from spawn to TerminalView; argv skips shell quoting. */
const pendingLaunches = new Map<string, ShellLaunch>();

export function setPendingShellLaunch(shellId: string, launch: ShellLaunch): void {
  pendingLaunches.set(shellId, launch);
}

export function consumePendingShellLaunch(shellId: string): ShellLaunch | undefined {
  const launch = pendingLaunches.get(shellId);
  if (launch !== undefined) pendingLaunches.delete(shellId);
  return launch;
}

/** A bookmark's toolbar label: its name, or a short word from its command. */
export function bookmarkLabel(bookmark: Pick<TerminalBookmark, 'name' | 'command'>): string {
  return bookmark.name || extractLabel(bookmark.command);
}

/** Builds a bookmark from the form's drafts, leaving out blank optional fields. */
export function draftBookmark(draft: {
  command: string;
  name: string;
  url: string;
}): TerminalBookmark | undefined {
  const command = draft.command.trim();
  if (!command) return undefined;
  const name = draft.name.trim();
  const url = draft.url.trim();
  return {
    id: crypto.randomUUID(),
    command,
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
  };
}

function sanitizeBookmark(raw: unknown): TerminalBookmark | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, command, name, url } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const label = typeof name === 'string' ? name.trim() : '';
  const link = typeof url === 'string' ? url.trim() : '';
  return {
    id,
    command,
    ...(label && label.length <= BOOKMARK_NAME_MAX_LENGTH ? { name: label } : {}),
    ...(link && link.length <= URL_MAX_LENGTH ? { url: link } : {}),
  };
}

/** Saved bookmarks with unusable entries dropped; a bad name or link is cleared, not the bookmark. */
export function sanitizeBookmarks(raw: unknown): TerminalBookmark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(sanitizeBookmark).filter((b): b is TerminalBookmark => b !== undefined);
}

/**
 * A bookmark's preview address in one task. A bare `localhost:3000` gets a
 * scheme, matching what the browser's address bar accepts.
 */
export function bookmarkUrl(
  bookmark: Pick<TerminalBookmark, 'url'>,
  portBase: number | undefined,
): string | undefined {
  if (!bookmark.url) return undefined;
  const url = portBase === undefined ? bookmark.url : expandPortVariable(bookmark.url, portBase);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}
