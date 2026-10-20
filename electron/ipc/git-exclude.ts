import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

export type AppendGitInfoExcludeResult = 'appended' | 'present' | 'missing' | 'failed';
type ExecFileSync = typeof childProcess.execFileSync;

/**
 * Normalize an exclude line for dedup comparison the way Git parses it: a CR
 * from CRLF endings and unescaped trailing ASCII spaces are insignificant,
 * while tabs, Unicode whitespace, and escaped trailing spaces (`\ `) stay
 * significant. Use this everywhere an existing line is compared against a
 * pattern — plain exact match and `\s+$` stripping both diverge from Git.
 */
export function normalizeExcludeLine(line: string): string {
  const noCr = line.endsWith('\r') ? line.slice(0, -1) : line;
  // ponytail: `endsWith('\\ ')` only inspects the final space — `/foo\  `
  // (escaped space followed by an unescaped one) is normalized imprecisely,
  // but such lines don't occur in real exclude files.
  if (/ +$/.test(noCr) && !noCr.endsWith('\\ ')) return noCr.replace(/ +$/, '');
  return noCr;
}

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
  // Set when the caller has already computed the missing lines from
  // `knownExisting` itself — the single-marker recheck below must not gate a
  // multi-line block whose remaining entries may genuinely be missing.
  skipMarkerCheck?: boolean,
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
    // Comparison matches Git's parsing (see normalizeExcludeLine): a
    // hand-written line with leading spaces or a trailing tab is a different
    // pattern, not the marker.
    if (
      !skipMarkerCheck &&
      existing.split('\n').some((line) => normalizeExcludeLine(line) === marker)
    )
      return 'present';
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
