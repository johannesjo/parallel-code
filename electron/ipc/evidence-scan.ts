/**
 * Git plumbing for the evidence integrity scan. Only read-only git commands run,
 * with argument arrays and no shell, so nothing from the repo is executed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVIDENCE_LIMITS, type EvidenceScan } from '../shared/evidence.js';
import { getDiffBaseSha } from './git.js';
import { analyzeDiff, type DiffFileInput } from './evidence-scan-rules.js';
import { classifyPath } from './evidence-scan-paths.js';
import { findCoveringTests } from './evidence-covering.js';

const run = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FILE_PATCH = 200 * 1024;
const MAX_TOTAL_PATCH = 4 * 1024 * 1024;
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

/** Added/removed counts keyed by new path; binary files report `-` and count as 0. */
function parseNumstat(raw: string): Map<string, { added: number; removed: number }> {
  const tokens = raw.split('\0');
  const stats = new Map<string, { added: number; removed: number }>();
  for (let i = 0; i < tokens.length - 1; ) {
    // Split on the first two tabs only: a path may itself contain tabs.
    const [added, removed, ...rest] = tokens[i++].split('\t');
    let path = rest.join('\t');
    if (path === '') {
      i++; // old path of a rename; the new path follows
      path = tokens[i++];
    }
    stats.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return stats;
}

function pathOfChunk(chunk: string): string | undefined {
  const rename = /^rename to (.+)$/m.exec(chunk);
  if (rename) return rename[1];
  const added = /^\+\+\+ b\/(.+)$/m.exec(chunk);
  if (added) return added[1];
  return /^--- a\/(.+)$/m.exec(chunk)?.[1];
}

/** Splits a combined patch per file; git emits files in name-status order. */
function splitPatch(patch: string, files: NameStatus[]): Map<string, string> {
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  const byIndex = chunks.length === files.length;
  const result = new Map<string, string>();
  chunks.forEach((chunk, index) => {
    const path = byIndex ? files[index].path : pathOfChunk(chunk);
    if (path !== undefined) result.set(path, chunk);
  });
  return result;
}

function boundPatches(chunks: Map<string, string>): { patches: Map<string, string>; cut: boolean } {
  let total = 0;
  let cut = false;
  const patches = new Map<string, string>();
  for (const [path, chunk] of chunks) {
    let text = chunk.slice(0, MAX_FILE_PATCH);
    if (text.length < chunk.length) cut = true;
    if (total + text.length > MAX_TOTAL_PATCH) {
      text = '';
      cut = true;
    }
    total += text.length;
    patches.set(path, text);
  }
  return { patches, cut };
}

/** Patch text is best effort: an oversized diff still yields file lists and path rules. */
async function readPatches(cwd: string, files: NameStatus[], range: string[]) {
  const raw = await git(cwd, [...SAFE_DIFF, '-U3', ...range]).catch(() => null);
  // Without patch text the line rules cannot run, so the scan must say it is incomplete.
  if (raw === null) return { patches: new Map<string, string>(), cut: files.length > 0 };
  return boundPatches(splitPatch(raw, files));
}

/** Scans the committed change against the diff base; uncommitted work only sets `dirty`. */
export async function scanEvidence(
  worktreePath: string,
  baseBranch?: string,
): Promise<EvidenceScan> {
  const headSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
  const [baseSha, dirty] = await Promise.all([
    getDiffBaseSha(worktreePath, baseBranch),
    isDirty(worktreePath),
  ]);
  const range = [baseSha, headSha];
  const [nameStatus, numstat] = await Promise.all([
    git(worktreePath, [...SAFE_DIFF, '--name-status', '-z', ...range]),
    git(worktreePath, [...SAFE_DIFF, '--numstat', '-z', ...range]),
  ]);
  const changed = parseNameStatus(nameStatus);
  const stats = parseNumstat(numstat);
  const { patches, cut } = await readPatches(worktreePath, changed, range);
  const files: DiffFileInput[] = changed.map((f) => ({
    ...f,
    added: stats.get(f.path)?.added ?? 0,
    removed: stats.get(f.path)?.removed ?? 0,
    patch: patches.get(f.path) ?? '',
  }));
  const changedPaths = new Set(files.map((f) => f.path));
  const sources = files
    .filter((f) => f.status !== 'D' && classifyPath(f.path) === 'source')
    .map((f) => f.path)
    .slice(0, EVIDENCE_LIMITS.maxCovering);
  const coveringTests = await findCoveringTests(worktreePath, headSha, sources, changedPaths);
  const analysis = analyzeDiff({ files, coveringTests });
  return {
    headSha,
    baseSha,
    dirty,
    ...analysis,
    ...((cut || analysis.truncated) && { truncated: true }),
  };
}
