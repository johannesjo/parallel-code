import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

export type AppendGitInfoExcludeResult = 'appended' | 'present' | 'missing' | 'failed';
type ExecFileSync = typeof childProcess.execFileSync;

export function resolveGitInfoExcludePath(
  worktreePath: string,
  execFileSyncImpl: ExecFileSync = childProcess.execFileSync,
): string | null {
  try {
    const out = execFileSyncImpl('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const commonDir = path.isAbsolute(out) ? out : path.join(worktreePath, out);
    return path.join(commonDir, 'info', 'exclude');
  } catch {
    return null;
  }
}

export function appendGitInfoExcludeBlockAtPath(
  excludePath: string,
  marker: string,
  block: string,
  onError?: (err: unknown) => void,
  knownExisting?: string,
): AppendGitInfoExcludeResult {
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    let existing = knownExisting;
    if (existing === undefined) {
      existing = '';
      try {
        existing = fs.readFileSync(excludePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    // Gitignore strips trailing whitespace only — a hand-written line with
    // leading spaces is a different pattern, not the marker.
    if (existing.split('\n').some((line) => line.replace(/\s+$/, '') === marker)) return 'present';
    const normalizedBlock = block.replace(/^\n+/, '').endsWith('\n')
      ? block.replace(/^\n+/, '')
      : `${block.replace(/^\n+/, '')}\n`;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${prefix}${normalizedBlock}`, 'utf8');
    return 'appended';
  } catch (err) {
    onError?.(err);
    return 'failed';
  }
}

export function appendGitInfoExcludeBlock(
  worktreePath: string,
  marker: string,
  block: string,
  onError?: (err: unknown) => void,
): AppendGitInfoExcludeResult {
  const excludePath = resolveGitInfoExcludePath(worktreePath);
  if (!excludePath) return 'missing';
  return appendGitInfoExcludeBlockAtPath(excludePath, marker, block, onError);
}
