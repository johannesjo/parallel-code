import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

import { atomicWriteFileSync } from '../mcp/atomic.js';

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

/** The exclude file Git reads for a common git dir (shared by all its worktrees). */
export function gitInfoExcludePath(commonDir: string): string {
  return path.join(commonDir, 'info', 'exclude');
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
    return gitInfoExcludePath(commonDir);
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

/**
 * Reconcile marker-prefixed exclude entries to exactly `desiredPatterns`.
 * A managed entry is a two-line unit: the `marker` comment immediately
 * followed by a pattern line. Units whose pattern is in `managedPatterns`
 * are removed and rewritten as needed; the same pattern written outside a
 * marker pair (e.g. by the user) is left alone, so removal only ever
 * un-hides what this mechanism hid. The file is rewritten only when the
 * managed set differs from `desiredPatterns`; unrelated lines keep their
 * order and position.
 */
export function syncGitInfoExcludeEntriesAtPath(
  excludePath: string,
  marker: string,
  managedPatterns: readonly string[],
  desiredPatterns: readonly string[],
  onError?: (err: unknown) => void,
): 'synced' | 'unchanged' | 'failed' {
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const managed = new Set(managedPatterns.map(normalizeExcludeLine));
    // Desired entries outside the managed universe can never be satisfied.
    const desired = new Set(
      desiredPatterns.map(normalizeExcludeLine).filter((pattern) => managed.has(pattern)),
    );

    const lines = existing.split('\n');
    // The split artifact of a trailing newline is not a real line.
    if (lines[lines.length - 1] === '') lines.pop();
    const kept: string[] = [];
    const present = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      if (normalizeExcludeLine(lines[i]) !== marker) {
        kept.push(lines[i]);
        continue;
      }
      // Marker lines are dropped either way — needed ones are rewritten
      // below. The pattern after a marker is ours only when it belongs to
      // the managed set; anything else stays as a user-written line.
      if (i + 1 < lines.length && managed.has(normalizeExcludeLine(lines[i + 1]))) {
        present.add(normalizeExcludeLine(lines[i + 1]));
        i++;
      }
    }

    if (present.size === desired.size && [...present].every((p) => desired.has(p))) {
      return 'unchanged';
    }

    for (const pattern of managedPatterns) {
      if (desired.has(normalizeExcludeLine(pattern))) kept.push(marker, pattern);
    }
    const body = kept.join('\n');
    // Whole-file rewrite (unlike the append-only helpers): atomic so a crash
    // can't leave a torn exclude file with half the user's entries missing.
    atomicWriteFileSync(excludePath, body.length > 0 ? `${body}\n` : '');
    return 'synced';
  } catch (err) {
    onError?.(err);
    return 'failed';
  }
}

/** Whether Git tracks `file`; exclusion cannot hide a tracked file from `git status`. */
export function isTrackedByGit(workspace: string, file: string): boolean {
  try {
    childProcess.execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
      cwd: workspace,
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch (err) {
    // Exit 1 means untracked. Anything else (no repo, no git, timeout) is no answer:
    // fail closed rather than risk writing a token into a tracked file.
    if ((err as { status?: unknown }).status === 1) return false;
    throw new Error(`Could not check whether ${file} is tracked: ${String(err)}`);
  }
}
