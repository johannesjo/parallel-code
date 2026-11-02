/**
 * Git plumbing for the scan behind the execution gate. Only read-only git
 * commands run, with argument arrays and no shell, so nothing from the repo is
 * executed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeScan } from '../shared/checks.js';
import { getDiffBaseSha } from './git.js';
import { analyzeDiff, type DiffFileInput } from './change-scan-rules.js';

const run = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
// Git config (writable from inside a worktree) can name external diff and
// textconv programs or force colour; none of that may run or reach the parser.
const SAFE_DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

async function isDirty(cwd: string): Promise<boolean> {
  // A status failure (index.lock while the agent commits) counts as dirty, as in verify.ts.
  return git(cwd, ['status', '--porcelain']).then(
    (out) => out.trim().length > 0,
    () => true,
  );
}

interface NameStatus {
  path: string;
  oldPath?: string;
  status: DiffFileInput['status'];
}

function parseNameStatus(raw: string): NameStatus[] {
  const tokens = raw.split('\0');
  const out: NameStatus[] = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const code = tokens[i++];
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i++];
      out.push({ path: tokens[i++], oldPath, status: 'R' });
    } else {
      // Type changes and other codes are treated as modifications.
      const status = code === 'A' || code === 'D' ? code : 'M';
      out.push({ path: tokens[i++], status });
    }
  }
  return out;
}

/** Scans the committed change against the diff base; uncommitted work only sets `dirty`. */
export async function scanChange(worktreePath: string, baseBranch?: string): Promise<ChangeScan> {
  const headSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
  const [baseSha, dirty] = await Promise.all([
    getDiffBaseSha(worktreePath, baseBranch),
    isDirty(worktreePath),
  ]);
  const nameStatus = await git(worktreePath, [
    ...SAFE_DIFF,
    '--name-status',
    '-z',
    baseSha,
    headSha,
  ]);
  return { headSha, baseSha, dirty, ...analyzeDiff(parseNameStatus(nameStatus)) };
}
