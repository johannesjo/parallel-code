import type { GitIgnoredEntry } from '../ipc/types';
import type { WorktreeInclude, WorktreeIncludeMode } from '../store/types';

/** More than any real repo root has; bounds a corrupted state file. */
const MAX_INCLUDES = 200;
/** Matches `WORKTREE_SCRIPT_MAX_LENGTH` in electron/ipc/worktree-scripts.ts. */
export const WORKTREE_SCRIPT_MAX_LENGTH = 16 * 1024;

/** Mirrors `isValidSymlinkName` in electron/ipc/git.ts, which re-checks every name. */
export function isValidIncludeName(name: string): boolean {
  if (name.length === 0 || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return !name.includes('\n') && !name.includes('\r') && !name.includes('\0');
}

function isMode(value: unknown): value is WorktreeIncludeMode {
  return value === 'symlink' || value === 'copy';
}

/**
 * A saved include list as persisted, or undefined when the project has none.
 * An empty array is kept: it means "bring nothing in", unlike unset, which
 * keeps the per-task defaults.
 */
export function sanitizeWorktreeIncludes(raw: unknown): WorktreeInclude[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: WorktreeInclude[] = [];
  for (const item of raw) {
    if (out.length >= MAX_INCLUDES) break;
    if (!item || typeof item !== 'object') continue;
    const { name, mode } = item as { name?: unknown; mode?: unknown };
    if (typeof name !== 'string' || !isValidIncludeName(name) || seen.has(name)) continue;
    if (!isMode(mode)) continue;
    seen.add(name);
    out.push({ name, mode });
  }
  return out;
}

/** A persisted script, or undefined when it is missing, blank or not a string. */
export function sanitizeWorktreeScript(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw.length > WORKTREE_SCRIPT_MAX_LENGTH ? undefined : raw;
}

export interface IncludeSelection {
  /** Names offered in the New Task picker, in the backend's order. */
  dirs: string[];
  /** Names checked to start with. */
  selected: Set<string>;
  /** Checked names that are copied rather than symlinked. */
  copy: Set<string>;
}

/**
 * The New Task picker's starting state. Without a saved list this is exactly
 * today's behaviour: the built-in defaults are checked, all as symlinks. With
 * one, the saved entries are checked in their saved mode and nothing else is.
 * Saved names that no longer exist in the checkout are not offered.
 */
export function resolveIncludeSelection(
  entries: readonly GitIgnoredEntry[],
  saved: readonly WorktreeInclude[] | undefined,
): IncludeSelection {
  const dirs = entries.map((entry) => entry.name);
  if (!saved) {
    return {
      dirs,
      selected: new Set(entries.filter((entry) => entry.isDefault).map((entry) => entry.name)),
      copy: new Set(),
    };
  }
  const offered = new Set(dirs);
  const selected = new Set<string>();
  const copy = new Set<string>();
  for (const include of saved) {
    if (!offered.has(include.name)) continue;
    selected.add(include.name);
    if (include.mode === 'copy') copy.add(include.name);
  }
  return { dirs, selected, copy };
}

/** Splits the checked names into the two lists `CreateTask` takes. */
export function splitIncludeSelection(
  selected: ReadonlySet<string>,
  copy: ReadonlySet<string>,
): { symlinkDirs: string[]; copyDirs: string[] } {
  const symlinkDirs: string[] = [];
  const copyDirs: string[] = [];
  for (const name of selected) (copy.has(name) ? copyDirs : symlinkDirs).push(name);
  return { symlinkDirs, copyDirs };
}

/** The seed when a project first turns on its saved list: today's defaults, as symlinks. */
export function defaultIncludes(entries: readonly GitIgnoredEntry[]): WorktreeInclude[] {
  return entries
    .filter((entry) => entry.isDefault)
    .map((entry) => ({ name: entry.name, mode: 'symlink' }));
}

export interface IncludeRow {
  name: string;
  /** null = not brought in. */
  mode: WorktreeIncludeMode | null;
  /** False for a saved name the checkout no longer has; new tasks skip it. */
  present: boolean;
}

/** Rows for the settings editor: every candidate, then saved names that are gone. */
export function includeRows(
  entries: readonly GitIgnoredEntry[],
  saved: readonly WorktreeInclude[],
): IncludeRow[] {
  const modes = new Map(saved.map((include) => [include.name, include.mode]));
  const rows: IncludeRow[] = entries.map((entry) => ({
    name: entry.name,
    mode: modes.get(entry.name) ?? null,
    present: true,
  }));
  const offered = new Set(entries.map((entry) => entry.name));
  for (const include of saved) {
    if (!offered.has(include.name)) rows.push({ ...include, present: false });
  }
  return rows;
}

/** The saved list with one entry's mode changed, kept in its original order. */
export function withIncludeMode(
  saved: readonly WorktreeInclude[],
  name: string,
  mode: WorktreeIncludeMode | null,
): WorktreeInclude[] {
  const index = saved.findIndex((include) => include.name === name);
  if (mode === null) return saved.filter((include) => include.name !== name);
  if (index === -1) return [...saved, { name, mode }];
  return saved.map((include, i) => (i === index ? { name, mode } : include));
}
