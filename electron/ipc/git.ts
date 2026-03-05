import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const exec = promisify(execFile);

// --- TTL Caches ---

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const mainBranchCache = new Map<string, CacheEntry>();
const mergeBaseCache = new Map<string, CacheEntry>();
const MAIN_BRANCH_TTL = 60_000; // 60s
const MERGE_BASE_TTL = 30_000; // 30s
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

function invalidateMergeBaseCache(): void {
  mergeBaseCache.clear();
}

function cacheKey(p: string): string {
  return p.replace(/\/+$/, '');
}

// --- Worktree lock serialization ---

const worktreeLocks = new Map<string, Promise<void>>();

function withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const voidNext = next.then(
    () => {},
    () => {},
  );
  worktreeLocks.set(key, voidNext);
  voidNext.then(() => {
    if (worktreeLocks.get(key) === voidNext) {
      worktreeLocks.delete(key);
    }
  });
  return next;
}

// --- Symlink candidates ---

const SYMLINK_CANDIDATES = [
  '.claude',
  '.cursor',
  '.aider',
  '.copilot',
  '.codeium',
  '.continue',
  '.windsurf',
  '.env',
  'node_modules',
];

/** Entries inside `.claude` that must NOT be symlinked (kept per-worktree). */
const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'settings.local.json']);

// --- Internal helpers ---

async function detectMainBranch(repoRoot: string): Promise<string> {
  const key = cacheKey(repoRoot);
  const cached = mainBranchCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    mainBranchCache.delete(key);
  }

  const result = await detectMainBranchUncached(repoRoot);
  mainBranchCache.set(key, { value: result, expiresAt: Date.now() + MAIN_BRANCH_TTL });
  return result;
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  // Try remote HEAD reference first
  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoRoot,
    });
    const refname = stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (refname.startsWith(prefix)) return refname.slice(prefix.length);
  } catch {
    /* ignore */
  }

  // Check if 'main' exists
  try {
    await exec('git', ['rev-parse', '--verify', 'main'], { cwd: repoRoot });
    return 'main';
  } catch {
    /* ignore */
  }

  // Fallback to 'master'
  try {
    await exec('git', ['rev-parse', '--verify', 'master'], { cwd: repoRoot });
    return 'master';
  } catch {
    /* ignore */
  }

  // Empty repo (no commits yet) — use configured default branch or fall back to "main"
  try {
    const { stdout } = await exec('git', ['config', '--get', 'init.defaultBranch'], {
      cwd: repoRoot,
    });
    const configured = stdout.trim();
    if (configured) return configured;
  } catch {
    /* ignore */
  }

  return 'main';
}

async function getCurrentBranchName(repoRoot: string): Promise<string> {
  const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

async function detectMergeBase(repoRoot: string, head?: string): Promise<string> {
  const key = cacheKey(repoRoot);
  const cached = mergeBaseCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    mergeBaseCache.delete(key);
  }

  const mainBranch = await detectMainBranch(repoRoot);
  let result: string;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, head ?? 'HEAD'], {
      cwd: repoRoot,
    });
    const hash = stdout.trim();
    result = hash || mainBranch;
  } catch {
    result = mainBranch;
  }

  mergeBaseCache.set(key, { value: result, expiresAt: Date.now() + MERGE_BASE_TTL });
  return result;
}

async function pinHead(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return 'HEAD';
  }
}

async function detectRepoLockKey(p: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: p });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(p, commonDir);
  try {
    return fs.realpathSync(commonPath);
  } catch {
    return commonPath;
  }
}

function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Handle rename/copy "old -> new"
  const destination = trimmed.split(' -> ').pop()?.trim() ?? trimmed;
  return destination.replace(/^"|"$/g, '');
}

/** Parse combined `git diff --raw --numstat` output into status and numstat maps. */
function parseDiffRawNumstat(output: string): {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
} {
  const statusMap = new Map<string, string>();
  const numstatMap = new Map<string, [number, number]>();

  for (const line of output.split('\n')) {
    if (line.startsWith(':')) {
      // --raw format: ":old_mode new_mode old_hash new_hash status\tpath"
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const statusLetter = parts[0].split(/\s+/).pop()?.charAt(0) ?? 'M';
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) statusMap.set(p, statusLetter);
      }
      continue;
    }
    // --numstat format: "added\tremoved\tpath"
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      if (!isNaN(added) && !isNaN(removed)) {
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) numstatMap.set(p, [added, removed]);
      }
    }
  }

  return { statusMap, numstatMap };
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
  const { stdout } = await exec('git', ['diff', '--numstat', `${mainBranch}..${branchName}`], {
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

/**
 * "Shallow-symlink" a directory: create a real directory at `target` and
 * symlink each entry from `source` into it, EXCEPT entries in `exclude`.
 */
function shallowSymlinkDir(source: string, target: string, exclude: Set<string>): void {
  fs.mkdirSync(target, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (err) {
    console.warn(`Failed to read directory ${source} for shallow-symlink:`, err);
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    try {
      if (!fs.existsSync(dst)) {
        fs.symlinkSync(src, dst);
      }
    } catch {
      /* ignore */
    }
  }
}

// --- Public functions (used by tasks.ts and register.ts) ---

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  forceClean = false,
): Promise<{ path: string; branch: string }> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (forceClean) {
    // Clean up stale worktree/branch from a previous session that wasn't properly removed
    if (fs.existsSync(worktreePath)) {
      try {
        await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      await exec('git', ['worktree', 'prune'], { cwd: repoRoot }).catch((e) =>
        console.warn('git worktree prune failed:', e),
      );
    }

    // Delete stale branch ref if it still exists
    try {
      await exec('git', ['branch', '-D', branchName], { cwd: repoRoot });
    } catch {
      // Branch doesn't exist — fine
    }
  }

  // Create fresh worktree with new branch
  await exec('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoRoot });

  // Symlink selected directories
  for (const name of symlinkDirs) {
    // Reject names that could escape the worktree directory
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') continue;
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    try {
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) continue;

      if (name === '.claude') {
        // Shallow-symlink: real dir with per-entry symlinks, excluding per-worktree entries
        shallowSymlinkDir(source, target, CLAUDE_DIR_EXCLUDE);
      } else {
        fs.symlinkSync(source, target);
      }
    } catch {
      /* ignore */
    }
  }

  return { path: worktreePath, branch: branchName };
}

export async function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean,
): Promise<void> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (!fs.existsSync(repoRoot)) return;

  if (fs.existsSync(worktreePath)) {
    try {
      await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    } catch {
      // Fallback: direct directory removal
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Prune stale worktree entries
  try {
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  } catch {
    /* ignore */
  }

  if (deleteBranch) {
    try {
      await exec('git', ['branch', '-D', '--', branchName], { cwd: repoRoot });
    } catch (e: unknown) {
      const msg = String(e);
      if (!msg.toLowerCase().includes('not found')) throw e;
    }
  }
}

// --- IPC command functions ---

export async function getGitIgnoredDirs(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  for (const name of SYMLINK_CANDIDATES) {
    const dirPath = path.join(projectRoot, name);
    try {
      fs.statSync(dirPath); // throws if entry doesn't exist
    } catch {
      continue;
    }
    try {
      await exec('git', ['check-ignore', '-q', name], { cwd: projectRoot });
      results.push(name);
    } catch {
      /* not ignored */
    }
  }
  return results;
}

export async function getMainBranch(projectRoot: string): Promise<string> {
  return detectMainBranch(projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function getChangedFiles(worktreePath: string): Promise<
  Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>
> {
  // Pin HEAD first so merge-base and diff use the same immutable commit
  const headHash = await pinHead(worktreePath);
  const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

  // git diff --raw --numstat <base> <head> — committed changes only (immutable)
  let diffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', base, headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    diffStr = stdout;
  } catch {
    /* empty */
  }

  const { statusMap: committedStatusMap, numstatMap: committedNumstatMap } =
    parseDiffRawNumstat(diffStr);

  // git status --porcelain for uncommitted/untracked paths
  let statusStr = '';
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    statusStr = stdout;
  } catch {
    /* empty */
  }

  const uncommittedPaths = new Map<string, string>(); // path -> status letter
  const untrackedPaths = new Set<string>();
  for (const line of statusStr.split('\n')) {
    if (line.length < 3) continue;
    const p = normalizeStatusPath(line.slice(3));
    if (!p) continue;
    if (line.startsWith('??')) {
      untrackedPaths.add(p);
      uncommittedPaths.set(p, '?');
    } else {
      // Prefer working tree status, fall back to index status
      const wtStatus = line[1];
      const indexStatus = line[0];
      uncommittedPaths.set(p, wtStatus !== ' ' ? wtStatus : indexStatus);
    }
  }

  const files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }> = [];
  const seen = new Set<string>();

  // Committed files from diff base..HEAD
  for (const [p, [added, removed]] of committedNumstatMap) {
    const status = committedStatusMap.get(p) ?? 'M';
    // If also in uncommitted paths, mark as uncommitted (has local changes on top)
    const committed = !uncommittedPaths.has(p);
    seen.add(p);
    files.push({ path: p, lines_added: added, lines_removed: removed, status, committed });
  }

  // Uncommitted-only files (in status but not in committed diff)
  for (const [p, statusLetter] of uncommittedPaths) {
    if (seen.has(p)) continue;
    const fullPath = path.join(worktreePath, p);
    let added = 0;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isFile() && stat.size < MAX_BUFFER) {
        const content = await fs.promises.readFile(fullPath, 'utf8');
        added = content.split('\n').length;
      }
    } catch {
      /* ignore */
    }
    files.push({
      path: p,
      lines_added: added,
      lines_removed: 0,
      status: statusLetter,
      committed: false,
    });
  }

  files.sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return files;
}

interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export async function getFileDiff(worktreePath: string, filePath: string): Promise<FileDiffResult> {
  // Pin HEAD first so merge-base and all reads use the same immutable commit
  const headHash = await pinHead(worktreePath);
  const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

  // Old content from merge base
  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at base — new file */
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

  // Generate diff between base and HEAD for committed files (immutable, no race)
  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', base, headHash, '--', filePath], {
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
    const lines = newContent.split('\n');
    let pseudo = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      pseudo += `+${line}\n`;
    }
    diff = pseudo;
  }

  // Uncommitted deletion with no committed diff — build deletion pseudo-diff
  if (!diff && isUncommittedDeletion && oldContent) {
    const lines = oldContent.split('\n');
    let pseudo = `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n`;
    for (const line of lines) {
      pseudo += `-${line}\n`;
    }
    diff = pseudo;
  }

  return { diff, oldContent, newContent };
}

export async function getWorktreeStatus(
  worktreePath: string,
): Promise<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }> {
  const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    maxBuffer: MAX_BUFFER,
  });
  const hasUncommittedChanges = statusOut.trim().length > 0;

  const mainBranch = await detectMainBranch(worktreePath).catch(() => 'HEAD');
  let hasCommittedChanges = false;
  try {
    const { stdout: logOut } = await exec('git', ['log', `${mainBranch}..HEAD`, '--oneline'], {
      cwd: worktreePath,
    });
    hasCommittedChanges = logOut.trim().length > 0;
  } catch {
    /* ignore */
  }

  return {
    has_committed_changes: hasCommittedChanges,
    has_uncommitted_changes: hasUncommittedChanges,
  };
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

export async function checkMergeStatus(
  worktreePath: string,
): Promise<{ main_ahead_count: number; conflicting_files: string[] }> {
  const mainBranch = await detectMainBranch(worktreePath);

  let mainAheadCount = 0;
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `HEAD..${mainBranch}`], {
      cwd: worktreePath,
    });
    mainAheadCount = parseInt(stdout.trim(), 10) || 0;
  } catch {
    /* ignore */
  }

  if (mainAheadCount === 0) return { main_ahead_count: 0, conflicting_files: [] };

  const conflictingFiles: string[] = [];
  try {
    await exec('git', ['merge-tree', '--write-tree', 'HEAD', mainBranch], { cwd: worktreePath });
  } catch (e: unknown) {
    // merge-tree outputs conflict info on failure
    const output = String(e);
    for (const line of output.split('\n')) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  return { main_ahead_count: mainAheadCount, conflicting_files: conflictingFiles };
}

export async function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean,
): Promise<{ main_branch: string; lines_added: number; lines_removed: number }> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(projectRoot);
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      mainBranch,
      branchName,
    );

    // Verify clean working tree
    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
      cwd: projectRoot,
    });
    if (statusOut.trim())
      throw new Error(
        'Project root has uncommitted changes. Please commit or stash them before merging.',
      );

    const originalBranch = await getCurrentBranchName(projectRoot).catch(() => null);

    // Checkout main
    await exec('git', ['checkout', mainBranch], { cwd: projectRoot });

    const restoreBranch = async () => {
      if (originalBranch) {
        try {
          await exec('git', ['checkout', originalBranch], { cwd: projectRoot });
        } catch (e) {
          console.warn(`Failed to restore branch '${originalBranch}':`, e);
        }
      }
    };

    if (squash) {
      try {
        await exec('git', ['merge', '--squash', '--', branchName], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during squash recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Squash merge failed: ${e}`);
      }
      const msg = message ?? 'Squash merge';
      try {
        await exec('git', ['commit', '-m', msg], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during commit recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Commit failed: ${e}`);
      }
    } else {
      try {
        await exec('git', ['merge', '--', branchName], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['merge', '--abort'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git merge --abort failed:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Merge failed: ${e}`);
      }
    }

    invalidateMergeBaseCache();

    if (cleanup) {
      await removeWorktree(projectRoot, branchName, true);
    }

    await restoreBranch();

    return { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
  });
}

export async function getBranchLog(worktreePath: string): Promise<string> {
  const mainBranch = await detectMainBranch(worktreePath).catch(() => 'HEAD');
  try {
    const { stdout } = await exec('git', ['log', `${mainBranch}..HEAD`, '--pretty=format:- %s'], {
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
): Promise<
  Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>
> {
  const mainBranch = await detectMainBranch(projectRoot);

  let diffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--raw', '--numstat', `${mainBranch}...${branchName}`],
      { cwd: projectRoot, maxBuffer: MAX_BUFFER },
    );
    diffStr = stdout;
  } catch {
    return [];
  }

  const { statusMap, numstatMap } = parseDiffRawNumstat(diffStr);

  const files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }> = [];

  for (const [p, [added, removed]] of numstatMap) {
    const status = statusMap.get(p) ?? 'M';
    files.push({ path: p, lines_added: added, lines_removed: removed, status, committed: true });
  }

  // Include files in statusMap but not in numstat (e.g. binary files)
  for (const [p, status] of statusMap) {
    if (numstatMap.has(p)) continue;
    files.push({ path: p, lines_added: 0, lines_removed: 0, status, committed: true });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
): Promise<FileDiffResult> {
  const mainBranch = await detectMainBranch(projectRoot);

  let diff = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', `${mainBranch}...${branchName}`, '--', filePath],
      { cwd: projectRoot, maxBuffer: MAX_BUFFER },
    );
    diff = stdout;
  } catch {
    /* empty */
  }

  // Find the merge base for content retrieval
  let mergeBase = mainBranch;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, branchName], {
      cwd: projectRoot,
    });
    if (stdout.trim()) mergeBase = stdout.trim();
  } catch {
    /* use mainBranch as fallback */
  }

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${mergeBase}:${filePath}`], {
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

export async function pushTask(projectRoot: string, branchName: string): Promise<void> {
  await exec('git', ['push', '-u', 'origin', '--', branchName], { cwd: projectRoot });
}

export async function rebaseTask(worktreePath: string): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(worktreePath);
    try {
      await exec('git', ['rebase', mainBranch], { cwd: worktreePath });
    } catch (e) {
      await exec('git', ['rebase', '--abort'], { cwd: worktreePath }).catch((recoverErr) =>
        console.warn('git rebase --abort failed:', recoverErr),
      );
      throw new Error(`Rebase failed: ${e}`);
    }
    invalidateMergeBaseCache();
  });
}
