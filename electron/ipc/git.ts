import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';

const exec = promisify(execFile);

// --- Types ---

/** A file entry from a git diff with status and line counts. */
export interface ChangedFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

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
const STDERR_CAP = 4096; // cap for stderr buffers in spawned git processes

// Sweep expired cache entries periodically so stale entries from repos that
// are no longer queried don't accumulate (lazy deletion alone isn't enough).
const CACHE_SWEEP_INTERVAL = 5 * 60_000; // 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mainBranchCache) {
    if (v.expiresAt <= now) mainBranchCache.delete(k);
  }
  for (const [k, v] of mergeBaseCache) {
    if (v.expiresAt <= now) mergeBaseCache.delete(k);
  }
}, CACHE_SWEEP_INTERVAL).unref();

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

/** Read the branch name that refs/remotes/origin/HEAD points to, or null. */
async function resolveOriginHead(repoRoot: string): Promise<string | null> {
  const prefix = 'refs/remotes/origin/';
  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoRoot,
    });
    const refname = stdout.trim();
    return refname.startsWith(prefix) ? refname.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

/** Check whether the remote-tracking ref origin/<branch> exists locally. */
async function remoteTrackingRefExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  // Try remote HEAD reference first
  const branch = await resolveOriginHead(repoRoot);
  if (branch) {
    // Verify the remote-tracking ref exists — refs/remotes/origin/HEAD can go
    // stale when the default branch is changed on the remote.
    if (await remoteTrackingRefExists(repoRoot, branch)) return branch;

    // Stale ref — try refreshing from the remote
    try {
      await exec('git', ['remote', 'set-head', 'origin', '--auto'], {
        cwd: repoRoot,
        timeout: 5_000,
      });
      const refreshed = await resolveOriginHead(repoRoot);
      if (refreshed && (await remoteTrackingRefExists(repoRoot, refreshed))) return refreshed;
    } catch {
      /* no network or no remote — fall through */
    }
  }

  // Check common default branch names
  for (const candidate of ['main', 'master']) {
    if (await remoteTrackingRefExists(repoRoot, candidate)) return candidate;
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

/**
 * Resolve a branch name to whichever ref is further ahead for comparisons:
 * local branch or its remote-tracking counterpart.  Using the most advanced
 * ref prevents diffs from showing files already present on the other side.
 * Falls back to the bare name when no remote ref exists (local-only repos).
 *
 * Note: for merge-base computation, use detectMergeBase() directly — it
 * compares both local and remote merge-bases to pick the closest one.
 */
async function resolveComparisonRef(repoRoot: string, branch: string): Promise<string> {
  if (branch.includes('/')) return branch;
  if (!(await remoteTrackingRefExists(repoRoot, branch))) return branch;

  const remote = `origin/${branch}`;
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `${branch}..${remote}`], {
      cwd: repoRoot,
    });
    const originAhead = parseInt(stdout.trim(), 10) || 0;
    return originAhead > 0 ? remote : branch;
  } catch {
    return branch;
  }
}

async function detectMergeBase(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<string> {
  const branch = baseBranch ?? (await detectMainBranch(repoRoot));
  const headRef = head ?? 'HEAD';
  const key = `${cacheKey(repoRoot)}:${branch}`;
  const cached = mergeBaseCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    mergeBaseCache.delete(key);
  }

  // When a remote-tracking ref exists, compute merge-base against both the
  // local branch and origin/<branch>, then pick whichever is closer to HEAD.
  // This avoids showing extra files when local and remote have diverged.
  const refs = [branch];
  if (!branch.includes('/') && (await remoteTrackingRefExists(repoRoot, branch))) {
    refs.push(`origin/${branch}`);
  }

  let best: string | null = null;
  for (const ref of refs) {
    try {
      const { stdout } = await exec('git', ['merge-base', ref, headRef], { cwd: repoRoot });
      const mb = stdout.trim();
      if (!mb) continue;
      if (!best) {
        best = mb;
        continue;
      }
      if (mb === best) continue;
      // Two different merge-bases: pick the descendant (closer to HEAD).
      // `--is-ancestor A B` succeeds when A is reachable from B.
      const aIsAncestor = await exec('git', ['merge-base', '--is-ancestor', best, mb], {
        cwd: repoRoot,
      }).then(
        () => true,
        () => false,
      );
      if (aIsAncestor) best = mb;
    } catch {
      /* ref may not resolve — skip */
    }
  }

  if (!best) {
    // All merge-base computations failed — fall back to headRef so that
    // callers diff HEAD against itself (empty diff) rather than diffing
    // against the branch tip, which would include the base branch's changes.
    return headRef;
  }

  mergeBaseCache.set(key, { value: best, expiresAt: Date.now() + MERGE_BASE_TTL });
  return best;
}

/**
 * Resolve the main branch tip ref for one-way diff comparisons.
 * Uses the most advanced ref (local or remote) so diffs show only
 * what would actually change when merged into main.
 */
async function resolveMainTipRef(worktreePath: string, baseBranch?: string): Promise<string> {
  const branch = baseBranch ?? (await detectMainBranch(worktreePath));
  return resolveComparisonRef(worktreePath, branch);
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
    return await fs.promises.realpath(commonPath);
  } catch {
    return commonPath;
  }
}

function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Handle rename/copy "old -> new"
  const destination = trimmed.split(' -> ').pop()?.trim() ?? trimmed;
  return destination.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
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
  const { stdout } = await exec('git', ['diff', '--numstat', `${mainBranch}...${branchName}`], {
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
      // Check for broken symlinks (existsSync returns false for broken ones)
      let dstExists = false;
      try {
        const stat = fs.lstatSync(dst);
        dstExists = true;
        // If it's a broken symlink, remove and recreate
        if (stat.isSymbolicLink()) {
          try {
            fs.realpathSync(dst);
            // Valid symlink — skip
          } catch {
            // Broken symlink — remove and recreate
            fs.unlinkSync(dst);
            dstExists = false;
          }
        }
      } catch {
        // Doesn't exist — create
      }
      if (!dstExists) {
        fs.symlinkSync(src, dst);
      }
    } catch (err) {
      console.warn(`Failed to symlink ${src} -> ${dst}:`, err);
    }
  }
}

// --- Public functions (used by tasks.ts and register.ts) ---

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  baseBranch?: string,
  forceClean = true,
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
  const worktreeArgs = ['worktree', 'add', '-b', branchName, worktreePath];
  if (baseBranch) worktreeArgs.push(baseBranch);
  await exec('git', worktreeArgs, { cwd: repoRoot });

  // Symlink selected directories
  for (const name of symlinkDirs) {
    // Reject names that could escape the worktree directory
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') continue;
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    try {
      if (!fs.existsSync(source)) continue;

      // Check for broken symlinks (existsSync returns false for broken ones)
      let targetExists = false;
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
          try {
            fs.realpathSync(target);
            targetExists = true; // Valid symlink exists
          } catch {
            fs.unlinkSync(target); // Broken symlink — remove
          }
        } else {
          targetExists = true; // Real file/dir exists
        }
      } catch {
        // Doesn't exist — proceed to create
      }
      if (targetExists) continue;

      if (name === '.claude') {
        // Shallow-symlink: real dir with per-entry symlinks, excluding per-worktree entries
        shallowSymlinkDir(source, target, CLAUDE_DIR_EXCLUDE);
      } else {
        fs.symlinkSync(source, target);
      }
    } catch (err) {
      console.warn(`Failed to symlink directory '${name}' into worktree:`, err);
    }
  }

  // Verify symlinks
  const created: string[] = [];
  const failed: string[] = [];
  for (const name of symlinkDirs) {
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') continue;
    const target = path.join(worktreePath, name);
    try {
      fs.lstatSync(target);
      created.push(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.warn(
      `Worktree symlink verification — created: [${created.join(', ')}], failed: [${failed.join(', ')}]`,
    );
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
      await fs.promises.stat(dirPath); // throws if entry doesn't exist
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

  // Resolve merge-base (for feature file set) and main tip (for actual diff) in parallel.
  const [base, mainTip] = await Promise.all([
    detectMergeBase(worktreePath, headHash, baseBranch).catch(() => headHash),
    resolveMainTipRef(worktreePath, baseBranch).catch(() => headHash),
  ]);

  // Feature file set: which files the feature branch actually modified (merge-base → HEAD).
  // Used to filter the main-tip diff so files changed only on main are excluded.
  let featureFileSet: Set<string> | null = null;
  if (base !== mainTip) {
    try {
      const { stdout } = await exec('git', ['diff', '--name-only', base, headHash], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      featureFileSet = new Set(
        stdout
          .split('\n')
          .map((l) => normalizeStatusPath(l))
          .filter(Boolean),
      );
    } catch {
      /* fall through — treat as unfiltered */
    }
  }

  // Diff main-tip → HEAD: shows what would actually change on main after merge.
  // When base === mainTip (main hasn't moved), this equals the old merge-base diff.
  let diffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', mainTip, headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    diffStr = stdout;
  } catch {
    /* empty */
  }

  const { statusMap: committedStatusMap, numstatMap: committedNumstatMap } =
    parseDiffRawNumstat(diffStr);

  // Filter to feature-branch files only (skip files changed only on main).
  if (featureFileSet) {
    for (const p of [...committedNumstatMap.keys()]) {
      if (!featureFileSet.has(p)) committedNumstatMap.delete(p);
    }
    for (const p of [...committedStatusMap.keys()]) {
      if (!featureFileSet.has(p)) committedStatusMap.delete(p);
    }
  }

  // git diff --raw --numstat <headHash> — tracked uncommitted changes (HEAD vs working tree).
  // Compares HEAD tree directly to the working tree, so it does not need the index
  // write lock and works reliably even while an agent holds it.
  // git ls-files --others --exclude-standard — untracked files (no index lock needed).
  // Both commands run in parallel since they are independent.
  const [uncommittedResult, untrackedResult] = await Promise.all([
    exec('git', ['diff', '--raw', '--numstat', headHash], {
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

  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  // Committed files from diff base..HEAD
  for (const [p, [added, removed]] of committedNumstatMap) {
    const status = committedStatusMap.get(p) ?? 'M';
    // If also in uncommitted diff, mark as uncommitted (has local changes on top)
    const committed =
      !uncommittedNumstatMap.has(p) && !uncommittedStatusMap.has(p) && !untrackedPaths.has(p);
    seen.add(p);
    files.push({ path: p, lines_added: added, lines_removed: removed, status, committed });
  }

  // Committed binary/special files (in statusMap but not numstatMap)
  for (const [p, status] of committedStatusMap) {
    if (seen.has(p)) continue;
    const committed =
      !uncommittedNumstatMap.has(p) && !uncommittedStatusMap.has(p) && !untrackedPaths.has(p);
    seen.add(p);
    files.push({ path: p, lines_added: 0, lines_removed: 0, status, committed });
  }

  // Tracked uncommitted files not in committed diff
  for (const [p, [added, removed]] of uncommittedNumstatMap) {
    if (seen.has(p)) continue;
    const status = uncommittedStatusMap.get(p) ?? 'M';
    seen.add(p);
    files.push({ path: p, lines_added: added, lines_removed: removed, status, committed: false });
  }

  // Uncommitted binary/special files (in statusMap but not numstatMap)
  for (const [p, status] of uncommittedStatusMap) {
    if (seen.has(p) || uncommittedNumstatMap.has(p)) continue;
    seen.add(p);
    files.push({ path: p, lines_added: 0, lines_removed: 0, status, committed: false });
  }

  // Untracked (new) files: count all lines as added
  for (const p of untrackedPaths) {
    if (seen.has(p)) continue;
    let added = 0;
    const fullPath = path.join(worktreePath, p);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isFile() && stat.size < MAX_BUFFER) {
        const content = await fs.promises.readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        added = content.endsWith('\n') ? lines.length - 1 : lines.length;
      }
    } catch {
      /* ignore */
    }
    files.push({ path: p, lines_added: added, lines_removed: 0, status: '?', committed: false });
  }

  files.sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return files;
}

export async function getAllFileDiffs(worktreePath: string, baseBranch?: string): Promise<string> {
  const headHash = await pinHead(worktreePath);

  const [base, mainTip] = await Promise.all([
    detectMergeBase(worktreePath, headHash, baseBranch).catch(() => headHash),
    resolveMainTipRef(worktreePath, baseBranch).catch(() => headHash),
  ]);

  // Build file filter: union of committed feature files + uncommitted tracked files.
  // This ensures uncommitted-only edits still appear in the diff viewer.
  let filterFiles: string[] | null = null;
  if (base !== mainTip) {
    try {
      const [committedResult, uncommittedResult] = await Promise.all([
        exec('git', ['diff', '--name-only', base, headHash], {
          cwd: worktreePath,
          maxBuffer: MAX_BUFFER,
        }),
        exec('git', ['diff', '--name-only', headHash], {
          cwd: worktreePath,
          maxBuffer: MAX_BUFFER,
        }).catch(() => ({ stdout: '' })),
      ]);

      const allPaths = new Set<string>();
      for (const line of committedResult.stdout.split('\n')) {
        const p = normalizeStatusPath(line);
        if (p) allPaths.add(p);
      }
      for (const line of uncommittedResult.stdout.split('\n')) {
        const p = normalizeStatusPath(line);
        if (p) allPaths.add(p);
      }
      filterFiles = [...allPaths];
    } catch {
      /* fall through — unfiltered */
    }
  }

  // Diff main-tip to working tree, filtered to feature-branch + uncommitted files.
  // When filterFiles is empty, produce no committed diff (avoid phantom main-only diffs).
  let combinedDiff = '';
  if (filterFiles === null || filterFiles.length > 0) {
    try {
      const args = ['diff', '-U3', mainTip];
      if (filterFiles) {
        args.push('--', ...filterFiles);
      }
      const { stdout } = await exec('git', args, {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      combinedDiff = stdout;
    } catch {
      /* empty */
    }
  }

  // Untracked files: build pseudo-diffs
  const untrackedParts: string[] = [];
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('??')) continue;
      const filePath = normalizeStatusPath(line.slice(3));
      if (!filePath) continue;
      const fullPath = path.join(worktreePath, filePath);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile() || stat.size >= MAX_BUFFER) continue;
        if (await isBinaryFile(fullPath)) {
          untrackedParts.push(
            `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ\n`,
          );
          continue;
        }
        const content = await fs.promises.readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
        const pseudoLines: string[] = [];
        pseudoLines.push(`diff --git a/${filePath} b/${filePath}`);
        pseudoLines.push('new file mode 100644');
        pseudoLines.push('--- /dev/null');
        pseudoLines.push(`+++ b/${filePath}`);
        pseudoLines.push(`@@ -0,0 +1,${lineCount} @@`);
        for (let i = 0; i < lineCount; i++) {
          pseudoLines.push(`+${lines[i]}`);
        }
        untrackedParts.push(pseudoLines.join('\n') + '\n');
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* empty */
  }

  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getAllFileDiffsFromBranch(
  projectRoot: string,
  branchName: string,
  baseBranch?: string,
): Promise<string> {
  const mainBranch = await resolveComparisonRef(
    projectRoot,
    baseBranch ?? (await detectMainBranch(projectRoot)),
  );
  try {
    const { stdout } = await exec('git', ['diff', '-U3', `${mainBranch}...${branchName}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const headHash = await pinHead(worktreePath);
  const mainTip = await resolveMainTipRef(worktreePath, baseBranch).catch(() => headHash);

  // Old content from main tip (what main currently has)
  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${mainTip}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist on main — new file */
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

  // Generate diff between main tip and HEAD for committed files
  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', mainTip, headHash, '--', filePath], {
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
      const lines = newContent.split('\n');
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
    const lines = oldContent.split('\n');
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

export async function getWorktreeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<{
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  current_branch: string | null;
}> {
  const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    maxBuffer: MAX_BUFFER,
  });
  const hasUncommittedChanges = statusOut.trim().length > 0;

  const currentBranch = await getCurrentBranchName(worktreePath).catch(() => null);

  const mainBranch = await resolveComparisonRef(
    worktreePath,
    baseBranch ?? (await detectMainBranch(worktreePath).catch(() => 'HEAD')),
  );
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
    current_branch: currentBranch,
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
  baseBranch?: string,
): Promise<{ main_ahead_count: number; conflicting_files: string[] }> {
  const mainBranch = await resolveComparisonRef(
    worktreePath,
    baseBranch ?? (await detectMainBranch(worktreePath)),
  );

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
  baseBranch?: string,
): Promise<{ main_branch: string; lines_added: number; lines_removed: number }> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(projectRoot));

    // Safety check: verify the worktree is actually on the expected branch.
    // AI agents sometimes check out a different branch (or detach HEAD),
    // and merging the original branch would silently discard their work.
    const worktreePath = path.join(projectRoot, '.worktrees', branchName);
    if (fs.existsSync(worktreePath)) {
      const actualBranch = await getCurrentBranchName(worktreePath).catch(() => null);
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

    const comparisonRef = await resolveComparisonRef(projectRoot, mainBranch);
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      comparisonRef,
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

    // Checkout main (bare branch name, not remote-tracking ref)
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

export async function getBranchLog(worktreePath: string, baseBranch?: string): Promise<string> {
  const mainBranch = await resolveComparisonRef(
    worktreePath,
    baseBranch ?? (await detectMainBranch(worktreePath).catch(() => 'HEAD')),
  );
  try {
    const { stdout } = await exec(
      'git',
      ['log', `${mainBranch}..HEAD`, '--pretty=format:- %h %s'],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
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
  const mainBranch = await resolveComparisonRef(
    projectRoot,
    baseBranch ?? (await detectMainBranch(projectRoot)),
  );

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

  const files: ChangedFile[] = [];

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
  baseBranch?: string,
): Promise<FileDiffResult> {
  const mainBranch = await resolveComparisonRef(
    projectRoot,
    baseBranch ?? (await detectMainBranch(projectRoot)),
  );

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

export function pushTask(
  win: BrowserWindow,
  projectRoot: string,
  branchName: string,
  channelId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['push', '--progress', '-u', 'origin', '--', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (msg: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send(`channel:${channelId}`, msg);
      }
    };

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

export async function rebaseTask(worktreePath: string, baseBranch?: string): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(worktreePath));
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
