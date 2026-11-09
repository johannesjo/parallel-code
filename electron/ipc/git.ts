import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Notify } from './notify.js';
import { KANBAN_FILE } from './kanban.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { debug as logDebug } from '../log.js';
import { exec, MAX_BUFFER } from './git-exec.js';
import {
  detectDiffBase,
  detectMainBranch,
  detectMergeBase,
  detectOneWayDiffRange,
  detectRepoLockKey,
  getCurrentBranchName,
  invalidateDiffBaseCache,
  oneWayDiffRange,
  pinHead,
} from './git-diff-base.js';
import {
  getBranchWorktreePath,
  parseWorktreeList,
  removeWorktree,
  safeRealpath,
  splitContentLines,
  withWorktreeLock,
} from './git-worktree.js';
import { baseUpstreamDivergence, conflictSourcesNote, upstreamOf } from './git-base-upstream.js';
import type {
  ChangedFile,
  CommitInfo,
  FileDiffResult,
  MergeResult,
  MergeStatus,
  MergeTargetChanges,
  RemoteBranchState,
  WorktreeStatus,
} from './shared-types.js';

export type { ChangedFile, CommitInfo, FileDiffResult, GitIgnoredEntry } from './shared-types.js';
export {
  createWorktree,
  detectRepoRoot,
  getBranchWorktreePath,
  ensureClaudeSandboxFiles,
  ensureSandboxExcludes,
  ensureSymlinkExcludes,
  ensureWorktreeContainerExclude,
  getSymlinkCandidates,
  isValidSymlinkName,
  refreshWorktreeNodeModules,
  removeWorktree,
  worktreePathFor,
} from './git-worktree.js';

// `git diff` against the working tree refreshes stat-only changes by rewriting
// the index, which takes index.lock; an agent committing in the same worktree
// then fails with "index.lock: File exists". --no-optional-locks doesn't cover it.
const NO_INDEX_REFRESH = ['-c', 'diff.autoRefreshIndex=false'];

const STDERR_CAP = 4096; // cap for stderr buffers in spawned git processes
/** Git's well-known empty tree SHA — used to diff the initial commit against nothing. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Check if a file is binary by looking for null bytes in the first 8KB (same heuristic as git). */
async function isBinaryFile(filePath: string): Promise<boolean> {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(filePath, 'r');
  } catch {
    return true; // unreadable files are safer treated as binary
  }
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fd.read(buf, 0, 8000, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fd.close();
  }
}

// --- Internal helpers ---

function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
}

/** Parse combined `git diff --raw --numstat -z` output into status and numstat maps. */
function parseDiffRawNumstat(output: string): {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
  previousPathMap: Map<string, string>;
} {
  const statusMap = new Map<string, string>();
  const numstatMap = new Map<string, [number, number]>();
  const previousPathMap = new Map<string, string>();
  const numstatPaths = new Set<string>();

  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;

    if (field.startsWith(':')) {
      const statusLetter = field.split(/\s+/).pop()?.charAt(0) ?? 'M';
      const firstPath = fields[++index] ?? '';
      if (statusLetter === 'R' || statusLetter === 'C') {
        const destinationPath = fields[++index] ?? '';
        if (destinationPath) {
          statusMap.set(destinationPath, statusLetter);
          if (firstPath) previousPathMap.set(destinationPath, firstPath);
        }
      } else if (firstPath) {
        statusMap.set(firstPath, statusLetter);
      }
      continue;
    }

    const firstTab = field.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    let destinationPath = field.slice(secondTab + 1);
    if (!destinationPath) {
      const previousPath = fields[++index] ?? '';
      destinationPath = fields[++index] ?? '';
      if (destinationPath && previousPath && !previousPathMap.has(destinationPath)) {
        previousPathMap.set(destinationPath, previousPath);
      }
    }
    if (!destinationPath) continue;
    numstatPaths.add(destinationPath);

    // Binary files report `-\t-`; they keep their raw status without line counts.
    const added = Number.parseInt(field.slice(0, firstTab), 10);
    const removed = Number.parseInt(field.slice(firstTab + 1, secondTab), 10);
    if (Number.isFinite(added) && Number.isFinite(removed)) {
      numstatMap.set(destinationPath, [added, removed]);
    }
  }

  // Without the index refresh (NO_INDEX_REFRESH), --raw also lists files whose
  // stat changed but content didn't; --numstat compares content and omits them.
  for (const p of statusMap.keys()) {
    if (!numstatPaths.has(p)) {
      statusMap.delete(p);
      previousPathMap.delete(p);
    }
  }

  return { statusMap, numstatMap, previousPathMap };
}

export function changedFilesFromMaps(opts: {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
  previousPathMap?: Map<string, string>;
  committed: boolean | ((filePath: string) => boolean);
  sort?: boolean;
}): ChangedFile[] {
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  const committedFor = (filePath: string) =>
    typeof opts.committed === 'function' ? opts.committed(filePath) : opts.committed;

  for (const [p, [added, removed]] of opts.numstatMap) {
    seen.add(p);
    files.push({
      path: p,
      previous_path: opts.previousPathMap?.get(p),
      lines_added: added,
      lines_removed: removed,
      status: opts.statusMap.get(p) ?? 'M',
      committed: committedFor(p),
    });
  }

  for (const [p, status] of opts.statusMap) {
    if (seen.has(p)) continue;
    files.push({
      path: p,
      previous_path: opts.previousPathMap?.get(p),
      lines_added: 0,
      lines_removed: 0,
      status,
      committed: committedFor(p),
    });
  }

  if (opts.sort !== false) files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

interface LineCountEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  lines: number;
}

// The changed-files poll recounts every untracked file each tick; an agent's
// new directory would otherwise be re-read in full every few seconds.
// shortcut: cleared wholesale at the cap — LRU if large worktrees thrash it.
const lineCountCache = new Map<string, LineCountEntry>();
const LINE_COUNT_CACHE_MAX = 5_000;

const NEWLINE = 0x0a;

export async function countReadableTextLines(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size >= MAX_BUFFER) return 0;
    const cached = lineCountCache.get(filePath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs
    ) {
      return cached.lines;
    }
    // Same count as splitting the decoded text: UTF-8 never encodes another
    // character with a 0x0a byte, so counting raw newlines skips the decode.
    const buf = await fs.promises.readFile(filePath);
    let lines = 0;
    for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, i + 1)) lines++;
    if (buf.length > 0 && buf[buf.length - 1] !== NEWLINE) lines++;
    if (lineCountCache.size >= LINE_COUNT_CACHE_MAX) lineCountCache.clear();
    lineCountCache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      lines,
    });
    return lines;
  } catch {
    return 0;
  }
}

function parseConflictPath(line: string): string | null {
  const trimmed = line.trim();

  // Format: "CONFLICT (...): Merge conflict in <path>"
  const mergeConflictIdx = trimmed.indexOf('Merge conflict in ');
  if (mergeConflictIdx !== -1) {
    const p = trimmed.slice(mergeConflictIdx + 'Merge conflict in '.length).trim();
    return p || null;
  }

  if (!trimmed.startsWith('CONFLICT')) return null;

  // Format: "CONFLICT (...): path <marker>"
  const parenClose = trimmed.indexOf('): ');
  if (parenClose === -1) return null;
  const afterParen = trimmed.slice(parenClose + 3);

  const markers = [' deleted in ', ' modified in ', ' added in ', ' renamed in ', ' changed in '];
  let cutoff = Infinity;
  for (const m of markers) {
    const idx = afterParen.indexOf(m);
    if (idx !== -1 && idx < cutoff) cutoff = idx;
  }

  const candidate = (cutoff === Infinity ? afterParen : afterParen.slice(0, cutoff)).trim();
  return candidate || null;
}

async function computeBranchDiffStats(
  projectRoot: string,
  mainBranch: string,
  branchName: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, mainBranch);
  const { stdout } = await exec('git', ['diff', '--numstat', diffRange], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    linesAdded += parseInt(parts[0], 10) || 0;
    linesRemoved += parseInt(parts[1], 10) || 0;
  }
  return { linesAdded, linesRemoved };
}

// --- Public functions (used by tasks.ts and register.ts) ---

/**
 * Unstaged edits to the project's Kanban board, which the app makes as tasks
 * move: ` M KANBAN.md` or `?? KANBAN.md`. Staged or conflicted states are not
 * the app's doing and are left to block a merge like any other change.
 */
function isUnstagedKanbanLine(line: string): boolean {
  return (line[0] === ' ' || line[0] === '?') && line.slice(3) === KANBAN_FILE;
}

/** Uncommitted changes that block a merge: all of them except unstaged board edits. */
export function blockingStatusLines(porcelain: string): string[] {
  return porcelain.split('\n').filter((line) => line.trim() && !isUnstagedKanbanLine(line));
}

/**
 * The board as committed at HEAD, with the checkout's line-ending filters
 * applied so it compares with the working copy (CRLF on many Windows
 * checkouts); empty when HEAD has none (untracked or absent).
 */
async function committedBoard(mergeRoot: string): Promise<string> {
  const opts = { cwd: mergeRoot, maxBuffer: MAX_BUFFER };
  const { stdout: entry } = await exec(
    'git',
    ['ls-tree', '--name-only', 'HEAD', '--', KANBAN_FILE],
    opts,
  );
  if (!entry.trim()) return '';
  const { stdout } = await exec('git', ['cat-file', '--filters', `HEAD:${KANBAN_FILE}`], opts);
  return stdout;
}

/**
 * Three-way merge of the local board edits onto the board a merge committed,
 * via `git merge-file`. Null when the two sides' edits overlap.
 */
async function mergeBoardText(
  mergeRoot: string,
  sides: { local: Buffer; base: string; merged: string },
): Promise<string | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kanban-merge-'));
  const files = [path.join(dir, 'local'), path.join(dir, 'base'), path.join(dir, 'merged')];
  try {
    await fs.promises.writeFile(files[0], sides.local);
    await fs.promises.writeFile(files[1], sides.base);
    await fs.promises.writeFile(files[2], sides.merged);
    const { stdout } = await exec('git', ['merge-file', '-p', ...files], {
      cwd: mergeRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    // merge-file exits with the number of conflicts (1-127); anything else is a real failure.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number' && code > 0 && code < 128) return null;
    throw err;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

const KANBAN_CLASH_WARNING =
  `${KANBAN_FILE} keeps your local edits: the board changes the task committed ` +
  `could not be combined with them and are only in the commit.`;

/**
 * Moves unstaged Kanban board edits out of the way for a merge and returns
 * a function that puts them back. The file returns to its committed state (or
 * is removed when untracked), so the merge, its checkout and any recovery
 * (`reset --hard`) run on a clean tree and can never touch the board's edits.
 *
 * Putting them back compares the board at HEAD before and after the merge.
 * Unchanged: the saved text is written back as is. Changed (the task branch
 * committed board edits): the saved edits are merged onto the new board with
 * `git merge-file`, so the branch's changes are not reverted in the working
 * copy (#337). When the edits overlap, the saved text is written back and the
 * function resolves to a warning naming the board, since the file then lacks
 * changes that are in the commit.
 */
export async function setAsideKanbanEdits(
  mergeRoot: string,
  porcelain: string,
): Promise<() => Promise<string | undefined>> {
  const line = porcelain.split('\n').find(isUnstagedKanbanLine);
  if (!line) return async () => undefined;
  const target = path.join(mergeRoot, KANBAN_FILE);
  const saved = await fs.promises.readFile(target);
  const base = await committedBoard(mergeRoot);
  if (line.startsWith('??')) await fs.promises.unlink(target);
  else await exec('git', ['checkout', '--', KANBAN_FILE], { cwd: mergeRoot });
  return async () => {
    let text: Buffer | string = saved;
    let warning: string | undefined;
    try {
      const merged = await committedBoard(mergeRoot);
      if (merged !== base) {
        const combined = await mergeBoardText(mergeRoot, { local: saved, base, merged });
        if (combined === null) warning = KANBAN_CLASH_WARNING;
        else text = combined;
      }
    } catch (err) {
      console.warn(`Failed to merge ${KANBAN_FILE} edits after merge:`, err);
      warning = KANBAN_CLASH_WARNING;
    }
    try {
      atomicWriteFileSync(target, text);
    } catch (err) {
      console.warn(`Failed to restore ${KANBAN_FILE} after merge:`, err);
    }
    return warning;
  };
}

const PATH_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Undoes git's C-style quoting of a path: `"my notes.txt"`, `"caf\303\251.txt"`. */
function unquotePath(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const chars = [...quoted.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = chars[++i] ?? '';
    if (/[0-7]/.test(next)) {
      // Octal escapes are single bytes of a UTF-8 sequence.
      bytes.push(parseInt(chars.slice(i, i + 3).join(''), 8));
      i += 2;
    } else bytes.push(PATH_ESCAPES[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Paths named by `git status --porcelain` lines; a rename names both sides.
 * shortcut: a path containing ` -> ` splits wrongly — parse `-z` output if that matters.
 */
function statusPaths(lines: string[]): string[] {
  return lines.flatMap((line) => line.slice(3).split(' -> ').map(unquotePath));
}

/**
 * Uncommitted changes in `cwd` (except unstaged board edits), and those of
 * them `to` changed since it diverged from `from`. Bringing `to` in would
 * change those files under the user's edits, so a stash could not be put
 * back cleanly.
 */
async function uncommittedOverlap(
  cwd: string,
  from: string,
  to: string,
): Promise<{ files: string[]; overlap: string[]; porcelain: string }> {
  // Every untracked file, not just its directory, so paths compare one to one.
  const { stdout: porcelain } = await exec(
    'git',
    ['--no-optional-locks', 'status', '--porcelain', '-uall'],
    { cwd },
  );
  const files = statusPaths(blockingStatusLines(porcelain));
  if (!files.length) return { files, overlap: [], porcelain };
  // -z: unquoted paths, as statusPaths returns them.
  const { stdout } = await exec(
    'git',
    ['diff', '--name-only', '-z', '--no-renames', `${from}...${to}`, '--'],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const changed = new Set(stdout.split('\0').filter(Boolean));
  return { files, overlap: files.filter((file) => changed.has(file)), porcelain };
}

/** `a, b, c and 2 more`: short enough for an error message. */
function fileList(files: string[], max = 5): string {
  const shown = files.slice(0, max).join(', ');
  return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}

/** Git's own explanation of a failed command, without Node's "Command failed: …" preamble. */
function gitErrorText(e: unknown): string {
  const stderr = typeof e === 'object' && e !== null ? (e as { stderr?: unknown }).stderr : null;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return e instanceof Error ? e.message : String(e);
}

/** Files left unmerged by a stopped merge or rebase; read before aborting it. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function findStash(
  cwd: string,
  message: string,
): Promise<{ sha: string; ref: string } | undefined> {
  const { stdout } = await exec('git', ['stash', 'list', '--format=%H%x00%gd%x00%gs'], { cwd });
  for (const line of stdout.split('\n')) {
    const [sha, ref, subject] = line.split('\0');
    if (sha && ref && subject?.endsWith(message)) return { sha, ref };
  }
  return undefined;
}

/**
 * Stashes the tracked changes in `mergeRoot` for a merge and returns a
 * function that puts them back, staged state included. It resolves to a
 * warning when they could not be put back, or `keep` asks to leave them; the
 * stash then stays for the user.
 * Untracked files stay in place: neither the merge nor its recovery
 * (`reset --hard`, `merge --abort`) removes them.
 */
async function setAsideLocalChanges(
  mergeRoot: string,
  branchName: string,
): Promise<(keep?: boolean) => Promise<string | undefined>> {
  const message = `Parallel Code: set aside to merge ${branchName} (${new Date().toISOString()})`;
  await exec('git', ['stash', 'push', '-m', message], { cwd: mergeRoot });
  const kept = `Your uncommitted changes in ${mergeRoot} could not be put back; they are saved in the stash “${message}”.`;
  // The stash list is shared with every worktree, so find ours by its message.
  const stash = await findStash(mergeRoot, message).catch((err: unknown) => {
    console.warn('git stash list failed after stashing for a merge:', err);
    return 'unknown' as const;
  });
  if (stash === 'unknown') return async () => kept;
  // Only untracked files: git had nothing to stash.
  if (!stash) return async () => undefined;
  return async (keep = false) => {
    // Applied on another commit than they were made on, they would land on the wrong branch.
    if (keep) return kept;
    try {
      await exec('git', ['stash', 'apply', '--index', stash.sha], { cwd: mergeRoot });
    } catch (err) {
      console.warn('git stash apply failed after merge:', err);
      return kept;
    }
    // Other stashes may have been pushed meanwhile: look the entry up again.
    const current = await findStash(mergeRoot, message).catch(() => undefined);
    if (current)
      await exec('git', ['stash', 'drop', current.ref], { cwd: mergeRoot }).catch((err) =>
        console.warn('git stash drop failed after merge:', err),
      );
    return undefined;
  };
}

// --- IPC command functions ---

export async function getMainBranch(projectRoot: string): Promise<string> {
  return detectMainBranch(projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function checkoutBranch(projectRoot: string, branchName: string): Promise<void> {
  await exec('git', ['checkout', branchName], { cwd: projectRoot });
}

export async function getBranches(projectRoot: string): Promise<string[]> {
  const { stdout } = await exec('git', ['branch', '--list', '--format=%(refname:short)'], {
    cwd: projectRoot,
  });
  return stdout
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
}

export async function getChangedFiles(
  worktreePath: string,
  baseBranch?: string,
): Promise<ChangedFile[]> {
  const headHash = await pinHead(worktreePath);

  // Use the picked merge-base as the stats anchor so the file list matches
  // the all-changes diff body, including tracked local edits on top of HEAD.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let finalDiffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', diffBase.sha],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    finalDiffStr = stdout;
  } catch {
    /* empty */
  }

  const {
    statusMap: finalStatusMap,
    numstatMap: finalNumstatMap,
    previousPathMap: finalPreviousPathMap,
  } = parseDiffRawNumstat(finalDiffStr);

  // git diff --raw --numstat <headHash> — tracked uncommitted changes (HEAD vs working tree).
  // NO_INDEX_REFRESH keeps it from taking index.lock while an agent commits.
  // git ls-files --others --exclude-standard — untracked files (no index lock needed).
  // Both commands run in parallel since they are independent.
  const [uncommittedResult, untrackedResult] = await Promise.all([
    exec('git', [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    }).catch(() => ({ stdout: '' })),
    exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    }).catch(() => ({ stdout: '' })),
  ]);

  const { statusMap: uncommittedStatusMap, numstatMap: uncommittedNumstatMap } =
    parseDiffRawNumstat(uncommittedResult.stdout);

  const untrackedPaths = new Set<string>();
  for (const line of untrackedResult.stdout.split('\n')) {
    const p = normalizeStatusPath(line);
    if (p) untrackedPaths.add(p);
  }

  const isCommitted = (p: string) =>
    !uncommittedNumstatMap.has(p) && !uncommittedStatusMap.has(p) && !untrackedPaths.has(p);

  const files = changedFilesFromMaps({
    statusMap: finalStatusMap,
    numstatMap: finalNumstatMap,
    previousPathMap: finalPreviousPathMap,
    committed: isCommitted,
    sort: false,
  });
  const seen = new Set(files.map((file) => file.path));

  // Untracked (new) files: count all lines as added
  for (const p of untrackedPaths) {
    if (seen.has(p)) continue;
    const added = await countReadableTextLines(path.join(worktreePath, p));
    files.push({ path: p, lines_added: added, lines_removed: 0, status: '?', committed: false });
  }

  files.sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return files;
}

async function buildUntrackedPseudoDiffs(worktreePath: string, pathPrefix = ''): Promise<string[]> {
  const parts: string[] = [];
  let stdout = '';
  try {
    const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch {
    return parts;
  }

  for (const line of stdout.split('\n')) {
    const filePath = normalizeStatusPath(line);
    if (!filePath) continue;
    const fullPath = path.join(worktreePath, filePath);
    const shownPath = pathPrefix + filePath;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile() || stat.size >= MAX_BUFFER) continue;
      if (await isBinaryFile(fullPath)) {
        parts.push(
          `diff --git a/${shownPath} b/${shownPath}\nnew file mode 100644\nBinary files /dev/null and b/${shownPath} differ\n`,
        );
        continue;
      }
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const lines = splitContentLines(content);
      const pseudoLines: string[] = [];
      pseudoLines.push(`diff --git a/${shownPath} b/${shownPath}`);
      pseudoLines.push('new file mode 100644');
      pseudoLines.push('--- /dev/null');
      pseudoLines.push(`+++ b/${shownPath}`);
      pseudoLines.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        pseudoLines.push(`+${line}`);
      }
      parts.push(pseudoLines.join('\n') + '\n');
    } catch {
      /* skip unreadable files */
    }
  }
  return parts;
}

async function getUntrackedChangedFiles(
  worktreePath: string,
  seen: Set<string> = new Set(),
): Promise<ChangedFile[]> {
  let stdout = '';
  try {
    const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    const p = normalizeStatusPath(line);
    if (!p || seen.has(p)) continue;
    seen.add(p);

    const added = await countReadableTextLines(path.join(worktreePath, p));
    files.push({ path: p, lines_added: added, lines_removed: 0, status: '?', committed: false });
  }
  return files;
}

export async function getDiffBaseSha(worktreePath: string, baseBranch?: string): Promise<string> {
  const headHash = await pinHead(worktreePath);
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));
  return diffBase.sha;
}

/** `git diff` options that show paths under `pathPrefix`, for a repo nested in a task's worktree. */
function diffPathPrefixArgs(pathPrefix: string): string[] {
  return pathPrefix ? [`--src-prefix=a/${pathPrefix}`, `--dst-prefix=b/${pathPrefix}`] : [];
}

export async function getAllFileDiffs(
  worktreePath: string,
  baseBranch?: string,
  pathPrefix = '',
): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // For working-tree output, use the merge-base SHA as a single diff start
  // point. `git diff base...` would stop at HEAD and hide tracked local edits.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let combinedDiff = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '-U3', ...diffPathPrefixArgs(pathPrefix), diffBase.sha],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath, pathPrefix);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedFileDiffs(
  worktreePath: string,
  pathPrefix = '',
): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // Diff against HEAD captures only tracked uncommitted changes (working tree
  // vs HEAD), excluding committed work. NO_INDEX_REFRESH keeps it from taking
  // index.lock while an agent commits.
  let combinedDiff = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '-U3', ...diffPathPrefixArgs(pathPrefix), headHash],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath, pathPrefix);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const headHash = await pinHead(worktreePath);
  let diffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', headHash],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    diffStr = stdout;
  } catch {
    /* empty */
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);
  const files = changedFilesFromMaps({
    statusMap,
    numstatMap,
    previousPathMap,
    committed: false,
    sort: false,
  });
  const seen = new Set(files.map((file) => file.path));

  files.push(...(await getUntrackedChangedFiles(worktreePath, seen)));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function getAllFileDiffsFromBranch(
  projectRoot: string,
  branchName: string,
  baseBranch?: string,
): Promise<string> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, baseBranch);
  try {
    const { stdout } = await exec('git', ['diff', '-U3', diffRange], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const headHash = await pinHead(worktreePath);
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));
  const base = diffBase.sha;

  // Old content from merge-base (what existed when the branch was created)
  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at merge-base — new file */
  }

  // New content: prefer committed content from HEAD, fall back to disk
  let newContent = '';
  let committedContent = '';
  let fileExistsOnDisk = false;
  let fileContentReadable = false;

  // Try reading committed content from git
  try {
    const { stdout } = await exec('git', ['show', `${headHash}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    committedContent = stdout;
  } catch {
    /* file not in HEAD — untracked or new */
  }

  // Read disk content
  const fullPath = path.join(worktreePath, filePath);
  let diskContent = '';
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.isFile()) {
      fileExistsOnDisk = true;
      if (stat.size < MAX_BUFFER) {
        diskContent = await fs.promises.readFile(fullPath, 'utf8');
        fileContentReadable = true;
      }
    }
  } catch {
    /* file doesn't exist — deleted file */
  }

  // Detect uncommitted deletion: file tracked in HEAD but deleted locally
  const isUncommittedDeletion = !fileExistsOnDisk && committedContent !== '';

  // Select newContent based on file state
  const hasUncommittedChanges =
    committedContent && fileExistsOnDisk && fileContentReadable && diskContent !== committedContent;
  if (isUncommittedDeletion) {
    newContent = '';
    // File added in branch but deleted locally — show committed content as "old" side
    if (!oldContent && committedContent) {
      oldContent = committedContent;
    }
  } else if (hasUncommittedChanges) {
    newContent = diskContent;
  } else if (committedContent) {
    newContent = committedContent;
  } else {
    newContent = diskContent;
  }

  // Generate diff between merge-base and HEAD for committed files
  let diff = '';
  try {
    const diffRange = oneWayDiffRange(diffBase, headHash);
    const { stdout } = await exec('git', ['diff', diffRange, '--', filePath], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    if (stdout.trim()) diff = stdout;
  } catch {
    /* empty */
  }

  // Untracked/uncommitted file with no committed diff — build pseudo-diff from disk content
  // Only when content was actually readable (skip for files exceeding MAX_BUFFER)
  if (!diff && fileExistsOnDisk && !oldContent && fileContentReadable) {
    if (await isBinaryFile(fullPath)) {
      diff = `Binary files /dev/null and b/${filePath} differ`;
    } else {
      const lines = splitContentLines(newContent);
      const pseudoLines: string[] = [];
      pseudoLines.push(`--- /dev/null`);
      pseudoLines.push(`+++ b/${filePath}`);
      pseudoLines.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        pseudoLines.push(`+${line}`);
      }
      diff = pseudoLines.join('\n') + '\n';
    }
  }

  // Uncommitted deletion with no committed diff — build deletion pseudo-diff
  if (!diff && isUncommittedDeletion && oldContent) {
    const lines = splitContentLines(oldContent);
    const pseudoLines: string[] = [];
    pseudoLines.push(`--- a/${filePath}`);
    pseudoLines.push(`+++ /dev/null`);
    pseudoLines.push(`@@ -1,${lines.length} +0,0 @@`);
    for (const line of lines) {
      pseudoLines.push(`-${line}`);
    }
    diff = pseudoLines.join('\n') + '\n';
  }

  return { diff, oldContent, newContent };
}

const UNREADABLE_WORKTREE_STATUS: WorktreeStatus = {
  has_committed_changes: false,
  has_uncommitted_changes: false,
  current_branch: null,
  base_branch: null,
};

/** Parse `git status --porcelain=v2 --branch` output. */
export function parseStatusV2(out: string): {
  currentBranch: string | null;
  headSha: string | null;
  hasUncommittedChanges: boolean;
} {
  let currentBranch: string | null = null;
  let headSha: string | null = null;
  let hasUncommittedChanges = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      currentBranch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      // An unborn branch has no commit yet.
      headSha = oid === '(initial)' ? null : oid;
    } else if (line.length > 0 && !line.startsWith('#')) {
      hasUncommittedChanges = true;
    }
  }
  return { currentBranch, headSha, hasUncommittedChanges };
}

export async function getWorktreeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<WorktreeStatus> {
  if (!fs.existsSync(worktreePath)) {
    return UNREADABLE_WORKTREE_STATUS;
  }
  let statusOut: string;
  try {
    // Polled every few seconds while agents run git in the same worktree:
    // skip status's opportunistic index refresh so it never takes index.lock
    // (agents would see "index.lock: File exists") or rewrites the index.
    // `--branch` also reports HEAD's branch and sha, saving two git spawns per
    // poll; `--no-ahead-behind` skips the upstream count this doesn't use.
    ({ stdout: statusOut } = await exec(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--no-ahead-behind'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    ));
  } catch {
    // Worktree removed between existsSync and exec (race condition)
    return UNREADABLE_WORKTREE_STATUS;
  }
  const { currentBranch, headSha, hasUncommittedChanges } = parseStatusV2(statusOut);

  // Resolved base branch name, so the frontend can tell "agent switched to a
  // feature branch" (adoptable) apart from "agent is sitting on main" (not).
  const resolvedBaseBranch = baseBranch ?? (await detectMainBranch(worktreePath).catch(() => null));

  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', resolvedBaseBranch ?? undefined);
  let hasCommittedChanges = false;
  try {
    // One commit is enough to answer "any?"; don't list the whole branch.
    const { stdout: logOut } = await exec(
      'git',
      ['log', '-1', '--format=%H', `${mergeBase}..HEAD`],
      {
        cwd: worktreePath,
      },
    );
    hasCommittedChanges = logOut.trim().length > 0;
  } catch {
    /* ignore */
  }

  return {
    has_committed_changes: hasCommittedChanges,
    has_uncommitted_changes: hasUncommittedChanges,
    current_branch: currentBranch,
    base_branch: resolvedBaseBranch,
    head_sha: headSha,
    ...(await countChangedLines(worktreePath, mergeBase)),
  };
}

/** Parse `git diff --shortstat` output, e.g. " 2 files changed, 5 insertions(+), 1 deletion(-)". */
function parseShortstat(out: string): { lines_added: number; lines_removed: number } {
  const added = /(\d+) insertions?\(\+\)/.exec(out);
  const removed = /(\d+) deletions?\(-\)/.exec(out);
  return {
    lines_added: added ? Number(added[1]) : 0,
    lines_removed: removed ? Number(removed[1]) : 0,
  };
}

/** Lines the branch's commits change since the merge base; uncommitted work counts once committed. */
async function countChangedLines(
  worktreePath: string,
  mergeBase: string,
): Promise<{ lines_added?: number; lines_removed?: number }> {
  try {
    // Tree to tree: never reads the working tree or the index an agent may be locking.
    // -M: a renamed file counts its edits, not its whole content twice.
    const { stdout } = await exec(
      'git',
      ['diff-tree', '-r', '-M', '--shortstat', mergeBase, 'HEAD'],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    return parseShortstat(stdout);
  } catch {
    // Unknown counts stay absent rather than claiming zero.
    return {};
  }
}

export async function listImportableWorktrees(projectRoot: string): Promise<
  Array<{
    path: string;
    branch_name: string;
    has_committed_changes: boolean;
    has_uncommitted_changes: boolean;
  }>
> {
  if (!(await isGitRepo(projectRoot))) return [];

  const projectRealPath = safeRealpath(projectRoot);
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });

  const candidates = parseWorktreeList(stdout).filter((entry) => {
    if (!entry.path || !entry.branchName || entry.detached) return false;
    return safeRealpath(entry.path) !== projectRealPath;
  });

  const results = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const status = await getWorktreeStatus(entry.path);
        return {
          path: entry.path,
          branch_name: entry.branchName ?? '',
          has_committed_changes: status.has_committed_changes,
          has_uncommitted_changes: status.has_uncommitted_changes,
        };
      } catch {
        return null;
      }
    }),
  );

  const filtered = results.filter(
    (
      entry,
    ): entry is {
      path: string;
      branch_name: string;
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    } => entry !== null,
  );

  filtered.sort(
    (a, b) => a.branch_name.localeCompare(b.branch_name) || a.path.localeCompare(b.path),
  );
  return filtered;
}

/** Stage all changes and commit in a worktree. */
export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: worktreePath });
  await exec('git', ['commit', '-m', message], { cwd: worktreePath });
}

/** Discard all uncommitted changes in a worktree (keeps committed work). */
export async function discardUncommitted(worktreePath: string): Promise<void> {
  await exec('git', ['checkout', '.'], { cwd: worktreePath });
  await exec('git', ['clean', '-fd'], { cwd: worktreePath });
}

/**
 * Where origin's copy of the checked-out branch stands. Reads the local
 * remote-tracking ref without fetching, so it costs no network; pushes from
 * the app update that ref.
 */
async function remoteBranchState(worktreePath: string): Promise<RemoteBranchState | undefined> {
  const read = (args: string[]) =>
    exec('git', args, { cwd: worktreePath }).then(
      ({ stdout }) => stdout.trim(),
      () => undefined,
    );
  const [origin, branch, head] = await Promise.all([
    read(['config', '--get', 'remote.origin.url']),
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['rev-parse', 'HEAD']),
  ]);
  if (!origin || !branch || !head) return undefined;
  const remote = await read(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (!remote) return 'unpushed';
  return remote === head ? 'pushed' : 'differs';
}

/**
 * `projectRoot`, when given, adds the uncommitted changes of the checkout a
 * merge of this task would run in.
 */
export async function checkMergeStatus(
  worktreePath: string,
  baseBranch?: string,
  projectRoot?: string,
): Promise<MergeStatus> {
  const remote = remoteBranchState(worktreePath);
  const status = await checkBaseStatus(worktreePath, baseBranch);
  const [target, divergence] = await Promise.all([
    projectRoot ? mergeTargetChanges(projectRoot, worktreePath, status.base_branch) : undefined,
    baseUpstreamDivergence(worktreePath, status.base_branch).catch((err: unknown) => {
      // The merge does not depend on it; a missing notice must not hide the rest.
      logDebug('git', `baseUpstreamDivergence failed for ${worktreePath}: ${err}`);
      return undefined;
    }),
  ]);
  const state = await remote;
  return {
    ...status,
    ...(state && { remote: state }),
    ...(target && { target_uncommitted: target }),
    ...(divergence && { base_upstream: divergence }),
  };
}

/** Mirrors where `mergeTask` merges: the base's own worktree, else the project root. */
async function mergeTargetChanges(
  projectRoot: string,
  worktreePath: string,
  mainBranch: string,
): Promise<MergeTargetChanges | undefined> {
  try {
    const mergeRoot = (await getBranchWorktreePath(projectRoot, mainBranch))?.path ?? projectRoot;
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    const { files, overlap } = await uncommittedOverlap(mergeRoot, mainBranch, head.trim());
    return files.length ? { path: mergeRoot, files, overlap } : undefined;
  } catch (err) {
    // The merge checks again; a missing notice must not hide the rest of the status.
    logDebug('git', `mergeTargetChanges failed for ${projectRoot}: ${err}`);
    return undefined;
  }
}

async function checkBaseStatus(worktreePath: string, baseBranch?: string): Promise<MergeStatus> {
  const mainBranch = baseBranch ?? (await detectMainBranch(worktreePath));

  // Count main commits not in HEAD, excluding patch-equivalents already
  // applied via rebase/cherry-pick. Mirrors the `--cherry-pick --right-only`
  // filter `refineDiffBaseWithCherryPick` uses on the diff side, so the
  // dialog doesn't demand a needless rebase when HEAD's history already
  // carries main's recent commits with different SHAs. Unlike the diff-side
  // helper we *don't* pass `--no-merges`: it's load-bearing there for `%H %P`
  // single-parent parsing, but here it would silently drop merge commits
  // that brought genuinely-new content into main (so-called "evil merges"),
  // turning a real "rebase first" warning into a quiet zero.
  let mainAheadCount = 0;
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', '--cherry-pick', '--right-only', `HEAD...${mainBranch}`],
      { cwd: worktreePath },
    );
    mainAheadCount = parseInt(stdout.trim(), 10) || 0;
  } catch {
    /* ignore */
  }

  if (mainAheadCount === 0) {
    return { main_ahead_count: 0, conflicting_files: [], base_branch: mainBranch };
  }

  const conflictingFiles: string[] = [];
  try {
    await exec('git', ['merge-tree', '--write-tree', 'HEAD', mainBranch], { cwd: worktreePath });
  } catch (e: unknown) {
    // merge-tree prints its conflict messages to stdout, which Node keeps on
    // the error rather than in its message.
    const stdout = typeof e === 'object' && e !== null ? (e as { stdout?: unknown }).stdout : null;
    const output = `${String(e)}\n${typeof stdout === 'string' ? stdout : ''}`;
    for (const line of output.split('\n')) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  const uncommitted = await uncommittedOverlap(worktreePath, 'HEAD', mainBranch)
    .then((changes) => changes.overlap)
    .catch(() => []);
  return {
    main_ahead_count: mainAheadCount,
    conflicting_files: conflictingFiles,
    base_branch: mainBranch,
    overlapping_files: await overlappingFiles(worktreePath, mainBranch, conflictingFiles),
    ...(uncommitted.length && { uncommitted_overlap: uncommitted }),
  };
}

/**
 * Paths both sides changed since they diverged, minus the conflicting ones.
 * The base side counts only commits `main_ahead_count` counts: one already
 * cherry-picked from this branch changes nothing this branch has not seen.
 */
async function overlappingFiles(
  worktreePath: string,
  mainBranch: string,
  conflictingFiles: string[],
): Promise<string[]> {
  const lines = async (args: string[]): Promise<string[]> => {
    const { stdout } = await exec('git', args, {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
  };
  try {
    const [ours, theirs] = await Promise.all([
      lines(['diff', '--name-only', '--no-renames', `${mainBranch}...HEAD`, '--']),
      lines([
        'log',
        '--format=',
        '--name-only',
        '--no-renames',
        '--cherry-pick',
        '--right-only',
        `HEAD...${mainBranch}`,
        '--',
      ]),
    ]);
    const conflicting = new Set(conflictingFiles);
    const theirSet = new Set(theirs);
    return ours.filter((file) => theirSet.has(file) && !conflicting.has(file));
  } catch {
    return [];
  }
}

export async function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean,
  baseBranch?: string,
  worktreePath?: string,
  mergeWorktreePath?: string,
  /** Merge into a checkout with uncommitted changes by setting them aside. */
  allowDirtyTarget = false,
): Promise<MergeResult> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(projectRoot));

    // Safety check: verify the worktree is actually on the expected branch.
    // AI agents sometimes check out a different branch (or detach HEAD),
    // and merging the original branch would silently discard their work.
    // For imported/external worktrees, the caller passes the real path; for
    // managed ones we fall back to the conventional .worktrees/<branch> layout.
    const checkWorktreePath = worktreePath ?? path.join(projectRoot, '.worktrees', branchName);
    if (fs.existsSync(checkWorktreePath)) {
      const actualBranch = await getCurrentBranchName(checkWorktreePath).catch(() => null);
      if (actualBranch === null) {
        throw new Error(
          `The worktree for '${branchName}' has a detached HEAD. ` +
            `Merging would use the stale branch ref and discard work. ` +
            `Please check out '${branchName}' in the worktree first.`,
        );
      }
      if (actualBranch !== branchName) {
        throw new Error(
          `Branch mismatch: the worktree is on '${actualBranch}' but the task expects '${branchName}'. ` +
            `Changes on '${actualBranch}' would be lost. Please check out '${branchName}' in the worktree first, or update the task branch.`,
        );
      }
    }

    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      mainBranch,
      branchName,
    );

    // When the target branch is already checked out in a worktree (e.g. a coordinator
    // worktree on a feature branch), we can't git checkout it in projectRoot — git
    // refuses to check out a branch that's live elsewhere. Merge in that worktree
    // instead; it's already on the right branch.
    const targetWorktree =
      mergeWorktreePath ?? (await getBranchWorktreePath(projectRoot, mainBranch))?.path;
    const mergeRoot = targetWorktree ?? projectRoot;

    // Verify clean working tree in the merge root. The project's Kanban board
    // (KANBAN.md) is edited in place by the app as tasks move, so its unstaged
    // edits do not block a merge: they are set aside and restored around it.
    // Other changes block it unless the caller allows setting them aside too,
    // and the merge leaves the files they touch alone.
    const local = await uncommittedOverlap(mergeRoot, mainBranch, branchName);
    if (local.files.length && !allowDirtyTarget)
      throw new Error(
        'Working tree has uncommitted changes. Please commit or stash them before merging.',
      );
    if (local.overlap.length)
      throw new Error(
        `Uncommitted changes in ${mergeRoot} touch files this merge changes: ` +
          `${fileList(local.overlap)}. Commit or stash them first.`,
      );
    const restoreKanban = await setAsideKanbanEdits(mergeRoot, local.porcelain);
    let restoreLocal = async (_keep?: boolean): Promise<string | undefined> => undefined;
    let branchRestoreFailed = false;
    // Runs once, from catch on failure or else from finally.
    let restored = false;
    const putBack = () => {
      restored = true;
      return restoreLocal(branchRestoreFailed);
    };
    // Same once-only rule for the board: on failure its warning joins the error.
    let boardRestored = false;
    const putBoardBack = () => {
      boardRestored = true;
      return restoreKanban();
    };
    let result: MergeResult;
    let warning: string | undefined;
    try {
      if (local.files.length) restoreLocal = await setAsideLocalChanges(mergeRoot, branchName);
      // Capture the current branch BEFORE any checkout so we can restore it afterward.
      const originalBranch = targetWorktree
        ? null
        : await getCurrentBranchName(projectRoot).catch(() => null);

      if (!targetWorktree) {
        // Need to checkout the target branch in the main repo
        await exec('git', ['checkout', mainBranch], { cwd: projectRoot });
      }

      const restoreBranch = async () => {
        if (originalBranch) {
          try {
            await exec('git', ['checkout', originalBranch], { cwd: projectRoot });
          } catch (e) {
            branchRestoreFailed = true;
            console.warn(`Failed to restore branch '${originalBranch}':`, e);
          }
        }
      };

      const conflictSources = (files: string[]) =>
        conflictSourcesNote(mergeRoot, { mainBranch, branch: branchName }, files);

      if (squash) {
        try {
          await exec('git', ['merge', '--squash', '--', branchName], { cwd: mergeRoot });
        } catch (e) {
          const conflicts = await conflictedFiles(mergeRoot);
          await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git reset --hard failed during squash recovery:', recoverErr),
          );
          await restoreBranch();
          throw mergeFailure('Squash merge', conflicts, e, await conflictSources(conflicts));
        }
        const msg = message ?? 'Squash merge';
        try {
          await exec('git', ['commit', '-m', msg], { cwd: mergeRoot });
        } catch (e) {
          await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git reset --hard failed during commit recovery:', recoverErr),
          );
          await restoreBranch();
          throw new Error(`Commit failed: ${gitErrorText(e)}`);
        }
      } else {
        // A base that moved on since the task branched would get a merge commit;
        // replaying the task onto it first keeps the base's history linear.
        // Without a worktree there is nowhere to rebase, so it merges as before.
        const rebased = fs.existsSync(checkWorktreePath);
        if (rebased) {
          let failed: Awaited<ReturnType<typeof syncWithBaseUnlocked>>;
          try {
            failed = await syncWithBaseUnlocked(checkWorktreePath, mainBranch, 'rebase');
          } catch (e) {
            await restoreBranch();
            throw e;
          }
          if (failed) {
            await restoreBranch();
            throw mergeFailure(
              'Merge',
              failed.conflicts,
              failed.error,
              await conflictSources(failed.conflicts),
            );
          }
        }
        try {
          const ff = rebased ? ['--ff-only'] : [];
          await exec('git', ['merge', ...ff, '--', branchName], { cwd: mergeRoot });
        } catch (e) {
          const conflicts = await conflictedFiles(mergeRoot);
          await exec('git', ['merge', '--abort'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git merge --abort failed:', recoverErr),
          );
          await restoreBranch();
          throw mergeFailure('Merge', conflicts, e, await conflictSources(conflicts));
        }
      }

      invalidateDiffBaseCache();

      if (cleanup) {
        await removeWorktree(projectRoot, branchName, true, worktreePath);
      }

      await restoreBranch();

      result = { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
    } catch (e) {
      // The merge error alone would leave the user unaware their changes sit in a stash.
      // A merge can land and a later step (worktree cleanup) still fail.
      const kept = [await putBack(), await putBoardBack()].filter(Boolean).join(' ');
      if (kept) throw new Error(`${e instanceof Error ? e.message : String(e)} ${kept}`);
      throw e;
    } finally {
      // After restoreBranch: the changes go back onto the commit they were made on.
      if (!restored) warning = await putBack();
      const boardWarning = boardRestored ? undefined : await putBoardBack();
      if (boardWarning) warning = warning ? `${warning} ${boardWarning}` : boardWarning;
    }
    return warning ? { ...result, warning } : result;
  });
}

/** `sources` names the base commits behind the conflicts; see `conflictSourcesNote`. */
function mergeFailure(operation: string, conflicts: string[], e: unknown, sources = ''): Error {
  return new Error(
    conflicts.length
      ? `${operation} stopped on conflicts in ${fileList(conflicts)}; nothing was merged.${sources}`
      : `${operation} failed: ${gitErrorText(e)}`,
  );
}

export async function getBranchLog(worktreePath: string, baseBranch?: string): Promise<string> {
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    const { stdout } = await exec('git', ['log', `${mergeBase}..HEAD`, '--pretty=format:- %h %s'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
  baseBranch?: string,
): Promise<ChangedFile[]> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, baseBranch);

  let diffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', '-z', diffRange], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    diffStr = stdout;
  } catch {
    return [];
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);

  return changedFilesFromMaps({ statusMap, numstatMap, previousPathMap, committed: true });
}

export async function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const diffBase = await detectDiffBase(projectRoot, branchName, baseBranch);
  const base = diffBase.sha;
  const diffRange = oneWayDiffRange(diffBase, branchName);

  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', diffRange, '--', filePath], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    diff = stdout;
  } catch {
    /* empty */
  }

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at merge base */
  }

  let newContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${branchName}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    newContent = stdout;
  } catch {
    /* file doesn't exist on branch */
  }

  return { diff, oldContent, newContent };
}

export function pushTask(
  notify: Notify,
  projectRoot: string,
  branchName: string,
  channelId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['push', '--progress', '-u', 'origin', '--', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (msg: string) => notify(`channel:${channelId}`, msg);

    proc.stdout?.on('data', (chunk: Buffer) => {
      send(chunk.toString('utf8'));
    });

    // Only the last line is used for error messages — cap the buffer to avoid
    // unbounded growth from verbose git push output (progress, LFS, etc.).
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      if (stderrBuf.length > STDERR_CAP) {
        stderrBuf = stderrBuf.slice(-STDERR_CAP);
      }
      send(text);
    });

    let settled = false;
    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        const lastLine = stderrBuf.trim().split('\n').pop() || '';
        const fallback = signal
          ? `git push killed by signal ${signal}`
          : `git push exited with code ${code}`;
        reject(new Error(lastLine || fallback));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`git push failed: ${err.message}`));
    });
  });
}

/**
 * Brings the base branch into the task branch, by rebase or by merge commit.
 * Uncommitted changes are stashed and put back, unless the base changed the
 * same files. A failure is aborted, so the worktree is never left mid-operation.
 */
async function syncWithBase(
  worktreePath: string,
  baseBranch: string | undefined,
  operation: 'rebase' | 'merge',
): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(worktreePath));
    const failed = await syncWithBaseUnlocked(worktreePath, mainBranch, operation);
    if (!failed) return;
    const label = operation === 'merge' ? 'Merge' : 'Rebase';
    const sources = await conflictSourcesNote(
      worktreePath,
      { mainBranch, branch: 'HEAD' },
      failed.conflicts,
    );
    throw new Error(
      failed.conflicts.length
        ? `${label} stopped on conflicts in ${fileList(failed.conflicts)} and was undone; the branch is unchanged.${sources}`
        : `${label} failed: ${gitErrorText(failed.error)}`,
    );
  });
}

/**
 * `syncWithBase` for callers that already hold the repo's worktree lock.
 * Returns an aborted operation's failure, so each caller can word it.
 */
async function syncWithBaseUnlocked(
  worktreePath: string,
  mainBranch: string,
  operation: 'rebase' | 'merge',
): Promise<{ conflicts: string[]; error: unknown } | null> {
  // Otherwise the autostash would come back with conflict markers in them.
  const { overlap } = await uncommittedOverlap(worktreePath, 'HEAD', mainBranch);
  if (overlap.length)
    throw new Error(
      `Commit or stash your changes to ${fileList(overlap)} first: ${mainBranch} changed them too.`,
    );
  const args =
    operation === 'merge'
      ? ['merge', '--no-edit', '--autostash', mainBranch]
      : ['rebase', '--autostash', mainBranch];
  try {
    await exec('git', args, { cwd: worktreePath });
  } catch (e) {
    const conflicts = await conflictedFiles(worktreePath);
    // --abort also puts the autostash back.
    await exec('git', [operation, '--abort'], { cwd: worktreePath }).catch((recoverErr) =>
      console.warn(`git ${operation} --abort failed:`, recoverErr),
    );
    return { conflicts, error: e };
  }
  invalidateDiffBaseCache();
  return null;
}

/**
 * Points the base branch at its upstream, dropping local commits the
 * upstream lacks; for a base whose local work already landed upstream in
 * another form. Refuses when the base moved since `expectedHead` was read.
 * Uses `reset --keep` in the base's checkout, so uncommitted changes and
 * untracked files survive or the reset stops. Resolves to the old commit.
 */
export async function resetBaseToUpstream(
  projectRoot: string,
  mainBranch: string,
  expectedHead: string,
): Promise<string> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);
  return withWorktreeLock(lockKey, async () => {
    const upstream = await upstreamOf(projectRoot, mainBranch);
    if (!upstream) throw new Error(`${mainBranch} does not track a remote branch.`);
    const { stdout } = await exec('git', ['rev-parse', `refs/heads/${mainBranch}`], {
      cwd: projectRoot,
    });
    const head = stdout.trim();
    if (head !== expectedHead)
      throw new Error(`${mainBranch} changed since it was checked. Review it again first.`);
    const checkout = await getBranchWorktreePath(projectRoot, mainBranch);
    try {
      // `branch -f` itself refuses a branch another worktree is rebasing.
      await (checkout
        ? exec('git', ['reset', '--keep', upstream], { cwd: checkout.path })
        : exec('git', ['branch', '-f', mainBranch, upstream], { cwd: projectRoot }));
    } catch (e) {
      throw new Error(`Could not reset ${mainBranch} to ${upstream}: ${gitErrorText(e)}`);
    }
    invalidateDiffBaseCache();
    return head;
  });
}

export function rebaseTask(worktreePath: string, baseBranch?: string): Promise<void> {
  return syncWithBase(worktreePath, baseBranch, 'rebase');
}

/** Like `rebaseTask`, but keeps the branch history and adds a merge commit. */
export function mergeBaseIntoTask(worktreePath: string, baseBranch?: string): Promise<void> {
  return syncWithBase(worktreePath, baseBranch, 'merge');
}

/** Check whether a directory is the root of a git repository. */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dirPath });
    const toplevel = await fs.promises.realpath(stdout.trim());
    const resolved = await fs.promises.realpath(dirPath);
    return toplevel === resolved;
  } catch {
    return false;
  }
}

// --- Per-commit operations ---

export async function getBranchCommits(
  worktreePath: string,
  baseBranch?: string,
  recentFallback?: number,
): Promise<CommitInfo[]> {
  if (!fs.existsSync(worktreePath)) return [];
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    const { stdout } = await exec(
      'git',
      ['log', `${mergeBase}..HEAD`, '--pretty=format:%H%x00%s', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    if (!stdout.trim()) {
      // No branch-specific commits (e.g. direct mode on main). If a recent
      // fallback count was requested, list the last N commits from HEAD so
      // the user can still navigate commit history.
      if (recentFallback && recentFallback > 0) {
        return getRecentCommits(worktreePath, recentFallback);
      }
      return [];
    }
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const sep = line.indexOf('\0');
        return {
          hash: sep >= 0 ? line.slice(0, sep) : line,
          message: sep >= 0 ? line.slice(sep + 1) : '',
        };
      });
  } catch (err) {
    logDebug('git', `getBranchCommits failed for ${worktreePath}: ${err}`);
    return [];
  }
}

/** Branch commits, oldest first, with their full messages — for squash commit defaults. */
export async function getBranchCommitMessages(
  worktreePath: string,
  baseBranch?: string,
): Promise<CommitInfo[]> {
  if (!fs.existsSync(worktreePath)) return [];
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    // Record separator between commits: bodies can contain newlines.
    const { stdout } = await exec(
      'git',
      ['log', `${mergeBase}..HEAD`, '--pretty=format:%H%x00%s%x00%b%x1e', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    return stdout
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim())
      .map((record) => {
        const [hash = '', message = '', body = ''] = record.split('\0');
        return { hash, message, body: body.trim() };
      });
  } catch (err) {
    logDebug('git', `getBranchCommitMessages failed for ${worktreePath}: ${err}`);
    return [];
  }
}

async function getRecentCommits(worktreePath: string, count: number): Promise<CommitInfo[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['log', `--max-count=${count}`, '--pretty=format:%H%x00%s', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const sep = line.indexOf('\0');
        return {
          hash: sep >= 0 ? line.slice(0, sep) : line,
          message: sep >= 0 ? line.slice(sep + 1) : '',
        };
      });
  } catch (err) {
    logDebug('git', `getRecentCommits failed for ${worktreePath}: ${err}`);
    return [];
  }
}

export async function getCommitChangedFiles(
  worktreePath: string,
  commitHash: string,
): Promise<ChangedFile[]> {
  let diffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--raw', '--numstat', '-z', `${commitHash}^..${commitHash}`],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    diffStr = stdout;
  } catch {
    // Likely the initial commit (no parent). Diff against the empty tree.
    try {
      const { stdout } = await exec(
        'git',
        ['diff', '--raw', '--numstat', '-z', `${EMPTY_TREE}..${commitHash}`],
        { cwd: worktreePath, maxBuffer: MAX_BUFFER },
      );
      diffStr = stdout;
    } catch (err) {
      logDebug('git', `getCommitChangedFiles failed for ${commitHash} in ${worktreePath}: ${err}`);
      return [];
    }
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);

  return changedFilesFromMaps({ statusMap, numstatMap, previousPathMap, committed: true });
}

export async function getCommitDiffs(worktreePath: string, commitHash: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['diff', '-U3', `${commitHash}^..${commitHash}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    // Likely the initial commit (no parent). Diff against the empty tree.
    try {
      const { stdout } = await exec('git', ['diff', '-U3', `${EMPTY_TREE}..${commitHash}`], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      return stdout;
    } catch (err) {
      logDebug('git', `getCommitDiffs failed for ${commitHash} in ${worktreePath}: ${err}`);
      return '';
    }
  }
}
