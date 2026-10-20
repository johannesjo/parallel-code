/**
 * The files of a document project, for the workspace's file tree. Git decides
 * what counts: tracked files plus untracked ones that are not ignored, so
 * scratch files show up but build output and the app's own folders do not.
 */
import { git } from './git.js';

/** A tree beyond this is a code project, not a document project. */
const MAX_FILES = 5_000;
/** Folders the workspace owns or must never offer to open; `.claude/` holds
 *  the settings the app writes for the project's agent session. */
const HIDDEN_PREFIXES = ['.parallel/', '.worktrees/', '.git/', '.claude/'];

export async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const out = await git(projectRoot, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  const files = out
    .split('\0')
    .filter((p) => p && !HIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)));
  // `--cached` and `--others` never overlap, but a path can be listed twice
  // when the index holds a merge conflict; the tree wants each once.
  return [...new Set(files)].sort().slice(0, MAX_FILES);
}
