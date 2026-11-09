// Git queries the coordinator runs against child worktrees. Stateless: each
// helper takes the worktree path and shells out to git.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectPreambleFiles, buildNormalizedPreambleFileDiff } from '../preamble.js';

export const execAsync = promisify(execFile);

/** Files the app injects into a child worktree; uncommitted edits to them are not the child's work. */
export const PREAMBLE_ARTIFACT_PATHS = new Set([
  'AGENTS.md',
  'GEMINI.md',
  '.agent.md',
  '.claude/settings.local.json',
]);

function parsePorcelainPaths(statusOut: string): string[] {
  return statusOut
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const renameMarker = ' -> ';
      const rawPath = line.slice(3);
      if (!rawPath.includes(renameMarker)) return rawPath;
      const parts = rawPath.split(renameMarker);
      return parts[parts.length - 1] ?? rawPath;
    });
}

export function execStdout(result: Awaited<ReturnType<typeof execAsync>>): string {
  const stdout = typeof result === 'string' ? result : result.stdout;
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

/** Whether `worktreePath`'s HEAD already contains every commit of `branch`. */
export async function containsBranch(worktreePath: string, branch: string): Promise<boolean> {
  try {
    await execAsync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: worktreePath });
    return true;
  } catch (err) {
    // Exit 1 is git's "no"; anything else is a real failure.
    if ((err as { code?: unknown }).code === 1) return false;
    throw err;
  }
}

export async function currentBranch(worktreePath: string): Promise<string | null> {
  const result = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
  });
  const branch = execStdout(result).trim();
  return branch === 'HEAD' ? null : branch;
}

export async function statusPaths(worktreePath: string): Promise<string[]> {
  const result = await execAsync('git', ['--no-optional-locks', 'status', '--porcelain'], {
    cwd: worktreePath,
  });
  return parsePorcelainPaths(execStdout(result));
}

/** Uncommitted paths holding the child's own work, not just the app's injected instructions. */
export async function ownDirtyPaths(worktreePath: string): Promise<string[]> {
  const [paths, preambleFiles] = await Promise.all([
    statusPaths(worktreePath),
    detectPreambleFiles(worktreePath),
  ]);
  const own: string[] = [];
  for (const pathName of paths) {
    const injected = preambleFiles.has(pathName) && PREAMBLE_ARTIFACT_PATHS.has(pathName);
    if (!injected || (await buildNormalizedPreambleFileDiff(pathName, worktreePath, 'HEAD')).trim())
      own.push(pathName);
  }
  return own;
}
