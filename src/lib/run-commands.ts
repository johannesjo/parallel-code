import type { RunCommand } from '../store/types';
import { expandPortVariable } from './task-ports';
import { WORKTREE_SCRIPT_MAX_LENGTH } from './worktree-includes';

/** Kept short so toolbar buttons stay compact; the settings form enforces it too. */
export const RUN_NAME_MAX_LENGTH = 40;
const URL_MAX_LENGTH = 2048;

function sanitizeRunCommand(raw: unknown): RunCommand | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, name, command, url } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof name !== 'string' || !name.trim() || name.length > RUN_NAME_MAX_LENGTH)
    return undefined;
  if (typeof command !== 'string' || !command.trim()) return undefined;
  if (command.length > WORKTREE_SCRIPT_MAX_LENGTH) return undefined;
  const link = typeof url === 'string' && url.trim() && url.length <= URL_MAX_LENGTH ? url : '';
  return { id, name: name.trim(), command, ...(link ? { url: link.trim() } : {}) };
}

/** A saved run list with malformed entries dropped; unset when nothing is left. */
export function sanitizeRunCommands(raw: unknown): RunCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const runs = raw.map(sanitizeRunCommand).filter((r): r is RunCommand => r !== undefined);
  return runs.length > 0 ? runs : undefined;
}

/**
 * The preview address of a run in one task. A bare `localhost:3000` gets a
 * scheme, matching what the browser's address bar accepts.
 */
export function runCommandUrl(run: RunCommand, portBase: number | undefined): string | undefined {
  if (!run.url) return undefined;
  const url = portBase === undefined ? run.url : expandPortVariable(run.url, portBase);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}
