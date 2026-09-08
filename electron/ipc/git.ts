import { execFile, execFileSync as _execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { debug as logDebug } from '../log.js';
import {
  appendGitInfoExcludeBlock,
  appendGitInfoExcludeBlockAtPath,
  normalizeExcludeLine,
  resolveGitInfoExcludePath,
} from './git-exclude.js';
import {
  findForeignOwnedEntries,
  foreignOwnedRemovalError,
  reclaimOwnership,
} from './worktree-cleanup.js';
import {
  ensureNodeModulesEntryLinks,
  isManagedNodeModules,
  realpathOrNull,
} from './worktree-node-modules.js';
import type {
  ChangedFile,
  CommitInfo,
  FileDiffResult,
  GitIgnoredEntry,
  WorktreeStatus,
} from './shared-types.js';

export type { ChangedFile, CommitInfo, FileDiffResult, GitIgnoredEntry } from './shared-types.js';

const _exec = promisify(execFile);

/**
 * Trace + run a git command (or any execFile invocation).
 * Emits a `debug` entry under category `git` with the args before
 * execution so verbose logs can reconstruct the command stream.
 */
const exec: typeof _exec = ((cmd: string, args: string[], options?: unknown) => {
  if (cmd === 'git') logDebug('git', args.join(' '));
  return (_exec as unknown as (...a: unknown[]) => unknown)(cmd, args, options);
}) as typeof _exec;

const execFileSync: typeof _execFileSync = ((cmd: string, args: string[], options?: unknown) => {
  if (cmd === 'git') logDebug('git', args.join(' '));
  return (_execFileSync as unknown as (...a: unknown[]) => unknown)(cmd, args, options);
}) as typeof _execFileSync;

// --- TTL Caches ---

interface CacheEntry {
  value: string;
  expiresAt: number;
}

interface PickedMergeBase {
  sha: string;
  ref: string;
}

interface DiffBaseCacheEntry {
  value: PickedMergeBase;
  expiresAt: number;
}

const mainBranchCache = new Map<string, CacheEntry>();
const diffBaseCache = new Map<string, DiffBaseCacheEntry>();
const MAIN_BRANCH_TTL = 60_000; // 60s
const DIFF_BASE_TTL = 30_000; // 30s
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const STDERR_CAP = 4096; // cap for stderr buffers in spawned git processes
/** Git's well-known empty tree SHA — used to diff the initial commit against nothing. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d69f82cf7202';

// Sweep expired cache entries periodically so stale entries from repos that
// are no longer queried don't accumulate (lazy deletion alone isn't enough).
const CACHE_SWEEP_INTERVAL = 5 * 60_000; // 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mainBranchCache) {
    if (v.expiresAt <= now) mainBranchCache.delete(k);
  }
  for (const [k, v] of diffBaseCache) {
    if (v.expiresAt <= now) diffBaseCache.delete(k);
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

function invalidateDiffBaseCache(): void {
  diffBaseCache.clear();
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
  '.cursor',
  '.aider',
  '.copilot',
  '.codeium',
  '.continue',
  '.windsurf',
  '.env',
  'node_modules',
];
const DEFAULT_SYMLINK_CANDIDATES = new Set(SYMLINK_CANDIDATES);

/**
 * Entries inside `.claude/` that must NOT be seeded from the main repo's
 * `.claude/` into new worktrees (per-worktree-local state).
 */
const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'steps.json']);

/**
 * Files Claude Code's sandbox (bwrap) read-only-binds on startup. They must
 * exist at the worktree path or the sandbox fails before Claude launches.
 */
const CLAUDE_REQUIRED_FILES = ['settings.json', 'settings.local.json'];

/**
 * Worktree-root filenames bwrap leaves behind as character-device placeholders
 * when it bind-mounts user-home dotfiles into the Claude Code sandbox. They
 * aren't project files and must not surface in `git status` / changed-files.
 * Mirrored into `.git/info/exclude` so the filter works on branches whose
 * committed `.gitignore` predates the fix. Patterns are root-anchored (`/`)
 * so a legitimate nested file with the same name (e.g. `subproj/.gitmodules`)
 * is still shown.
 */
const SANDBOX_EXCLUDE_PATTERNS = [
  '/.bash_profile',
  '/.bashrc',
  '/.gitconfig',
  '/.gitmodules',
  '/.mcp.json',
  '/.profile',
  '/.ripgreprc',
  '/.zprofile',
  '/.zshrc',
];
const INTERNAL_SYMLINK_EXCLUSIONS = new Set([
  '.claude',
  '.worktrees',
  ...SANDBOX_EXCLUDE_PATTERNS.map((pattern) => pattern.slice(1)),
]);
const SANDBOX_EXCLUDE_HEADER = '# parallel-code: sandbox bind-mount artifacts';
const seededSandboxExcludes = new Set<string>();

const WORKTREE_CONTAINER_EXCLUDE_HEADER = '# parallel-code: task worktree container';
const WORKTREE_CONTAINER_EXCLUDE = '/.worktrees/';

/**
 * Header written once per repo when symlink excludes are first added. Each
 * symlinked name is appended individually on subsequent calls so new names
 * added in later worktrees are also covered.
 */
const SYMLINK_EXCLUDE_HEADER = '# parallel-code: worktree symlinks';

/**
 * Single name-validation rule shared by the symlink producer
 * (`getSymlinkCandidates`) and consumer (`createWorktree`) — anything the
 * dialog can offer must be creatable, and anything creatable must pass here.
 * `..` is only rejected as a full name: as a substring (`foo..bar`) it is a
 * legal filename, not a traversal.
 */
export function isValidSymlinkName(name: string): boolean {
  if (name.length === 0 || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // CR/LF would inject arbitrary rules when written to .git/info/exclude.
  if (name.includes('\n') || name.includes('\r')) return false;
  return true;
}

/** Escape a filename so it matches literally as a gitignore pattern. */
function escapeGitignoreLiteral(name: string): string {
  const escaped = name.replace(/[\\*?[\]]/g, '\\$&');
  const anchored = escaped.startsWith('!') || escaped.startsWith('#') ? `\\${escaped}` : escaped;
  // Gitignore strips unescaped trailing spaces — escape each so a name like
  // `foo ` matches itself instead of `foo`.
  return anchored.replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
}

/** Whether the repo treats paths case-insensitively (macOS default). */
async function getCoreIgnoreCase(repoRoot: string): Promise<boolean> {
  try {
    // --bool normalizes yes/on/1 and case variants to true/false; an invalid
    // value exits non-zero and lands in the catch below.
    const { stdout } = await exec('git', ['config', '--bool', '--get', 'core.ignorecase'], {
      cwd: repoRoot,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Reserved/default names are all-lowercase; fold the candidate when the fs is case-insensitive. */
function isReservedSymlinkName(name: string, ignoreCase: boolean): boolean {
  return INTERNAL_SYMLINK_EXCLUSIONS.has(ignoreCase ? name.toLowerCase() : name);
}

function isDefaultSymlinkCandidate(name: string, ignoreCase: boolean): boolean {
  return DEFAULT_SYMLINK_CANDIDATES.has(ignoreCase ? name.toLowerCase() : name);
}

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

/** Check whether a local branch ref exists. */
async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function findLocalBranchPrefixConflict(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  const parts = branchName.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (await localBranchExists(repoRoot, prefix)) return prefix;
  }
  return null;
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

  // Check common default branch names (remote-tracking first, then local)
  for (const candidate of ['main', 'master']) {
    if (await remoteTrackingRefExists(repoRoot, candidate)) return candidate;
  }
  for (const candidate of ['main', 'master']) {
    if (await localBranchExists(repoRoot, candidate)) return candidate;
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
 * Pick the merge-base SHA closest to HEAD between local `<branch>` and
 * `origin/<branch>`.
 *
 * Either ref can be stale relative to the other: local can be ahead of origin
 * (the user merged a PR locally without pushing) or origin can be ahead of
 * local (the user fetched without pulling). Whichever ref's merge-base with
 * HEAD is a *descendant* of the other's is the more recent branch point and
 * gives the smallest correct diff. When neither merge-base is an ancestor of
 * the other (the two refs have themselves diverged), the local merge-base is
 * preferred — origin can carry teammate work the user has not seen yet.
 *
 * Returns null when neither ref exists or both merge-base lookups fail.
 */
async function pickMergeBase(
  repoRoot: string,
  branch: string,
  head: string,
): Promise<PickedMergeBase | null> {
  const [hasLocal, hasOrigin] = await Promise.all([
    localBranchExists(repoRoot, branch),
    remoteTrackingRefExists(repoRoot, branch),
  ]);

  if (!hasLocal && !hasOrigin) return null;

  const mergeBaseFor = async (ref: string): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', ['merge-base', ref, head], { cwd: repoRoot });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };

  const [localMb, originMb] = await Promise.all([
    hasLocal ? mergeBaseFor(branch) : Promise.resolve(null),
    hasOrigin ? mergeBaseFor(`origin/${branch}`) : Promise.resolve(null),
  ]);

  if (!localMb && !originMb) return null;
  if (!localMb && originMb) return { sha: originMb, ref: `origin/${branch}` };
  if (!originMb && localMb) return { sha: localMb, ref: branch };
  if (!localMb || !originMb) return null;
  if (localMb === originMb) return { sha: localMb, ref: branch };

  const isAncestor = async (anc: string, desc: string): Promise<boolean> => {
    try {
      await exec('git', ['merge-base', '--is-ancestor', anc, desc], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  };

  if (await isAncestor(originMb, localMb)) return { sha: localMb, ref: branch };
  if (await isAncestor(localMb, originMb)) return { sha: originMb, ref: `origin/${branch}` };
  return { sha: localMb, ref: branch };
}

/**
 * Refine a picked merge-base by dropping commits that are patch-equivalent
 * to ones already on `base.ref` (rebased duplicates from a prior `git merge`
 * of the upstream that was later rebased onto a new base).
 *
 * Uses git's built-in patch-id detection via `--cherry-pick --right-only`.
 * The first call's `%H %P` format embeds the oldest unique commit's parent
 * SHA so we don't need a separate `rev-parse` step.
 *
 * Three outcomes:
 *  - **No unique commits** (branch is fully merged upstream): collapse the
 *    diff range to `head...head` (empty) so the user sees zero changes
 *    instead of the noisy patch-equivalent set.
 *  - **Unique commits contiguous at the tip** (the common case for
 *    agent-driven branches): refine the base to the oldest unique commit's
 *    parent so the diff range only contains real branch work.
 *  - **Interleaved** (a patch-equivalent commit sits between unique ones):
 *    keep the picked base — accepting the noise is cheaper than stitching
 *    per-commit patches. Logged for diagnostics.
 *
 * Any git invocation failure falls back to the picked base unchanged.
 *
 * Dual-side counterpart: `checkMergeStatus` applies `--cherry-pick
 * --right-only` to `HEAD...<main>` to count *main's* unique commits not in
 * HEAD (i.e. how stale HEAD is relative to main), so the merge dialog's
 * "Rebase first" prompt agrees with this filter.
 */
async function refineDiffBaseWithCherryPick(
  repoRoot: string,
  base: PickedMergeBase,
  head: string,
): Promise<PickedMergeBase> {
  let unique: string[];
  let oldestParent: string | null = null;
  try {
    const { stdout } = await exec(
      'git',
      [
        'log',
        '--cherry-pick',
        '--right-only',
        '--no-merges',
        '--reverse',
        '--pretty=%H %P',
        `${base.ref}...${head}`,
      ],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    const lines = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    unique = lines.map((line) => line.split(' ', 1)[0]);
    if (lines.length > 0) {
      // First line is the oldest unique commit (--reverse). With --no-merges
      // every commit has exactly one parent, so the first SHA after the
      // commit hash is that parent.
      const parts = lines[0].split(' ');
      oldestParent = parts[1] ?? null;
    }
  } catch {
    return base;
  }

  if (unique.length === 0) {
    // Fully merged upstream — every branch commit is patch-equivalent to
    // one already on the base. Collapse the diff range to empty so the
    // user sees no changes (instead of the noisy duplicated patch set
    // that `base.ref...HEAD` would produce).
    return { sha: head, ref: head };
  }

  if (!oldestParent) return base;

  let rangeCount: number;
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', '--no-merges', `${oldestParent}..${head}`],
      { cwd: repoRoot },
    );
    rangeCount = parseInt(stdout.trim(), 10);
    if (isNaN(rangeCount)) return base;
  } catch {
    return base;
  }

  if (rangeCount === unique.length) {
    return { sha: oldestParent, ref: oldestParent };
  }

  logDebug(
    'git',
    `cherry-pick refine: interleaved (unique=${unique.length}, range=${rangeCount}) — keeping ${base.ref}`,
  );
  return base;
}

/**
 * Resolve both sides needed for one-way diffs.
 *
 * Git's three-dot diff is directional: `git diff base...head` means
 * `git diff $(git merge-base base head) head`, while `git diff head...base`
 * shows base-only commits. Keep the picked base ref around so committed-only
 * diffs can use the correctly ordered three-dot range.
 *
 * Working-tree diffs are different: `git diff base...` still compares against
 * HEAD, not the dirty working tree. For those callers, use `base.sha` as the
 * single diff start point (`git diff <merge-base-sha>`) so tracked local edits
 * remain visible.
 *
 * Result is post-refinement: rebased patch-equivalent commits are dropped from
 * the diff range when possible. See `refineDiffBaseWithCherryPick`.
 */
async function detectDiffBase(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<PickedMergeBase> {
  const branch = baseBranch ?? (await detectMainBranch(repoRoot));
  // Resolve the literal 'HEAD' to its commit SHA so the cache key tracks
  // HEAD movement. Otherwise a cached `{sha:'HEAD', ref:'HEAD'}` (returned
  // by refineDiffBaseWithCherryPick when the branch was fully patch-
  // equivalent to base) survives a new commit on the branch — callers then
  // run `git log HEAD..HEAD` against the literal and see no commits, even
  // though HEAD just moved forward.
  const requestedHead = head ?? 'HEAD';
  const headRef = requestedHead === 'HEAD' ? await pinHead(repoRoot) : requestedHead;
  const key = `${cacheKey(repoRoot)}:${branch}:${headRef}`;
  const cached = diffBaseCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    diffBaseCache.delete(key);
  }

  const picked = await pickMergeBase(repoRoot, branch, headRef);
  if (!picked) return { sha: headRef, ref: headRef };

  const refined = await refineDiffBaseWithCherryPick(repoRoot, picked, headRef);
  diffBaseCache.set(key, { value: refined, expiresAt: Date.now() + DIFF_BASE_TTL });
  return refined;
}

/**
 * Resolve the diff base SHA for `head` against `baseBranch` (or the detected
 * main branch). Falls back to `headRef` when no candidate ref resolves so
 * callers diff against themselves (empty diff) rather than against the branch
 * tip.
 */
async function detectMergeBase(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<string> {
  const headRef = head ?? 'HEAD';
  const result = await detectDiffBase(repoRoot, headRef, baseBranch);
  return result.sha;
}

function oneWayDiffRange(base: PickedMergeBase, head: string): string {
  return `${base.ref}...${head}`;
}

async function detectOneWayDiffRange(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<string> {
  const headRef = head ?? 'HEAD';
  return oneWayDiffRange(await detectDiffBase(repoRoot, headRef, baseBranch), headRef);
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

    const added = Number.parseInt(field.slice(0, firstTab), 10);
    const removed = Number.parseInt(field.slice(firstTab + 1, secondTab), 10);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;

    let destinationPath = field.slice(secondTab + 1);
    if (!destinationPath) {
      const previousPath = fields[++index] ?? '';
      destinationPath = fields[++index] ?? '';
      if (destinationPath && previousPath && !previousPathMap.has(destinationPath)) {
        previousPathMap.set(destinationPath, previousPath);
      }
    }
    if (destinationPath) numstatMap.set(destinationPath, [added, removed]);
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

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.slice(0, -1) : lines;
}

export async function countReadableTextLines(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size >= MAX_BUFFER) return 0;
    return splitContentLines(await fs.promises.readFile(filePath, 'utf8')).length;
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

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

interface ListedWorktree {
  path: string;
  head: string | null;
  branchName: string | null;
  detached: boolean;
}

function parseWorktreeList(output: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current?.path) entries.push(current);
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.path) entries.push(current);
      current = {
        path: line.slice('worktree '.length).trim(),
        head: null,
        branchName: null,
        detached: false,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || null;
      continue;
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      const prefix = 'refs/heads/';
      current.branchName = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      continue;
    }
    if (line === 'detached') {
      current.detached = true;
    }
  }

  if (current?.path) entries.push(current);
  return entries;
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

/**
 * Remove a worktree directory, trying progressively harder:
 * `git worktree remove` → direct removal (retried, because Docker Desktop's
 * VirtioFS bind-mount may still be releasing after the container exits) →
 * ownership reclaim for files a root container left behind.
 *
 * Throws with an actionable message when the leftovers need `sudo` to clear.
 */
async function forceRemoveWorktreeDir(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    return;
  } catch {
    // Fall through to direct removal.
  }

  const rmError = await removeDirWithRetries(worktreePath);
  if (!rmError) return;

  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const foreign = findForeignOwnedEntries(worktreePath, uid);
  if (foreign.length === 0) throw rmError;

  const reclaimFailure = await reclaimOwnership(worktreePath, uid, gid);
  if (!reclaimFailure) {
    const retryError = await removeDirWithRetries(worktreePath);
    if (!retryError) return;
  }
  // Either the reclaim could not run, or it ran without freeing the files
  // (macOS bind mounts can drop the chown). Both need the same manual step.
  throw foreignOwnedRemovalError(
    worktreePath,
    foreign,
    reclaimFailure ?? 'ownership reclaim did not release the files',
  );
}

/** Delete a directory tree, retrying with backoff. Returns the last error, or undefined on success. */
async function removeDirWithRetries(dirPath: string): Promise<unknown> {
  const delays = [0, 500, 1500, 3000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return undefined;
    } catch (e) {
      lastErr = e;
    }
  }
  return lastErr;
}

// --- Public functions (used by tasks.ts and register.ts) ---

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  baseBranch?: string,
  forceClean = false,
): Promise<{ path: string; branch: string }> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (forceClean) {
    // Clean up stale worktree/branch from a previous session that wasn't properly removed
    if (fs.existsSync(worktreePath)) {
      await forceRemoveWorktreeDir(repoRoot, worktreePath);
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

  // Validate the start-point ref exists before attempting worktree creation
  const startRef = baseBranch || 'HEAD';
  try {
    await exec('git', ['rev-parse', '--verify', startRef], { cwd: repoRoot });
  } catch {
    const isEmptyRepo = await exec('git', ['rev-list', '-n1', '--all'], { cwd: repoRoot })
      .then(({ stdout }) => !stdout.trim())
      .catch(() => true);
    if (isEmptyRepo) {
      throw new Error(
        'Cannot create a worktree in a repository with no commits. ' +
          'Please make an initial commit first.',
      );
    }
    throw new Error(
      `Branch "${startRef}" does not exist. ` +
        'Please select a valid base branch or create the branch first.',
    );
  }

  // Create fresh worktree with new branch
  const conflictingBranch = await findLocalBranchPrefixConflict(repoRoot, branchName);
  if (conflictingBranch) {
    throw new Error(
      `Cannot create branch "${branchName}" because local branch "${conflictingBranch}" already exists. ` +
        `Choose a branch prefix other than "${conflictingBranch}" or "${conflictingBranch}/...".`,
    );
  }

  // Before `worktree add`: a `git status` racing creation must never see it.
  ensureWorktreeContainerExclude(repoRoot);

  const worktreeArgs = ['worktree', 'add', '-b', branchName, worktreePath];
  if (baseBranch) worktreeArgs.push(baseBranch);
  await exec('git', worktreeArgs, { cwd: repoRoot });

  // Symlink selected directories. Reserved names (`.claude`, the `.worktrees`
  // container, sandbox bind-mount artifacts) are rejected here as a defensive
  // backstop — the backend does not trust the UI's candidate list. `.claude`
  // in particular can never be a symlink: Claude Code's bwrap sandbox binds
  // specific entries inside it and refuses to bind-mount at symlink paths.
  // Comparisons fold case when the repo's core.ignorecase says the filesystem
  // is case-insensitive, so `.WORKTREES`/`.CLAUDE` variants can't slip through.
  const ignoreCase = await getCoreIgnoreCase(repoRoot);
  const createdSymlinks: string[] = [];
  for (const name of symlinkDirs) {
    // Reject names that could escape the worktree directory or inject rules
    // into .git/info/exclude
    if (!isValidSymlinkName(name)) continue;
    if (isReservedSymlinkName(name, ignoreCase)) continue;
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    try {
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) continue;
      if (name === 'node_modules') {
        // Not a whole-dir symlink: per-entry links, so root-level cache writes
        // (vite's `.vite-temp`/`.vite`, `.cache`) land inside the worktree —
        // the only path agent sandboxes allow writes to.
        if (!ensureNodeModulesEntryLinks(source, target)) continue;
      } else {
        fs.symlinkSync(source, target);
      }
      createdSymlinks.push(name);
    } catch (err) {
      console.warn(`Failed to symlink directory '${name}' into worktree:`, err);
    }
  }

  ensureClaudeSandboxFiles(worktreePath, repoRoot);
  ensureSandboxExcludes(worktreePath);
  ensureSymlinkExcludes(worktreePath, createdSymlinks);

  return { path: worktreePath, branch: branchName };
}

/**
 * Ensure the worktree's `.claude/` is bwrap-safe and seeded from the main
 * repo's `.claude/`, matching Claude Code's `/worktree` model: each worktree
 * gets an independent real `.claude/` directory (no symlinks), one-time
 * copied from the source at creation. bwrap's `create_file` cannot place a
 * bind-mount placeholder at a symlink destination — it fails with
 * "Can't create file at … .claude/X: No such file or directory" — so every
 * entry must be a real file or directory.
 *
 * Also runs as a backfill on agent spawn: deletes any symlinks left over
 * from the previous shallow-symlink behavior and seeds any newly-missing
 * entries from the source.
 */
export function ensureClaudeSandboxFiles(worktreePath: string, repoRoot?: string | null): void {
  const claudeDir = path.join(worktreePath, '.claude');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    console.warn(`Failed to create ${claudeDir}:`, err);
    return;
  }

  // Remove any symlinks under .claude/ — they're leftover from the old
  // shallow-symlink behavior and bwrap cannot bind to them. Real files/dirs
  // are preserved (may contain worktree-local edits).
  let existing: fs.Dirent[] = [];
  try {
    existing = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Failed to readdir ${claudeDir}:`, err);
  }
  for (const entry of existing) {
    if (!entry.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(path.join(claudeDir, entry.name));
    } catch (err) {
      console.warn(`Failed to unlink ${path.join(claudeDir, entry.name)}:`, err);
    }
  }

  // Seed missing entries from the main repo's .claude/. Dereferences any
  // symlinks in the source so the copy is pure real files (bwrap-safe).
  const root = repoRoot === undefined ? detectRepoRoot(worktreePath) : repoRoot;
  if (root && root !== worktreePath) {
    const source = path.join(root, '.claude');
    if (fs.existsSync(source)) {
      let srcEntries: fs.Dirent[] = [];
      try {
        srcEntries = fs.readdirSync(source, { withFileTypes: true });
      } catch (err) {
        console.warn(`Failed to readdir ${source}:`, err);
      }
      for (const entry of srcEntries) {
        if (CLAUDE_DIR_EXCLUDE.has(entry.name)) continue;
        const dst = path.join(claudeDir, entry.name);
        if (fs.existsSync(dst)) continue;
        try {
          fs.cpSync(path.join(source, entry.name), dst, {
            recursive: true,
            dereference: true,
          });
        } catch (err) {
          console.warn(`Failed to seed ${dst} from source:`, err);
        }
      }
    }
  }

  // Ensure required settings placeholders exist — bwrap binds them even when
  // absent from both worktree and source.
  for (const file of CLAUDE_REQUIRED_FILES) {
    const p = path.join(claudeDir, file);
    if (fs.existsSync(p)) continue;
    try {
      fs.writeFileSync(p, '{}\n');
    } catch (err) {
      console.warn(`Failed to create placeholder ${p}:`, err);
    }
  }
}

/**
 * Keep the worktree container out of the project's `git status`. `.worktrees/`
 * sits inside the repo's own working tree, so in a project whose `.gitignore`
 * doesn't list it every task leaves the root dirty — and merging then fails on
 * the clean-tree guard with "Working tree has uncommitted changes". Writing to
 * `.git/info/exclude` leaves a tracked `.gitignore` alone; the leading `/`
 * keeps a nested `foo/.worktrees/` visible. Also runs as a backfill on agent
 * spawn, for worktrees created before this rule existed. `pathInRepo` may be
 * the repo root or any worktree — both resolve to the shared exclude file.
 */
export function ensureWorktreeContainerExclude(pathInRepo: string): void {
  appendGitInfoExcludeBlock(
    pathInRepo,
    WORKTREE_CONTAINER_EXCLUDE,
    `${WORKTREE_CONTAINER_EXCLUDE_HEADER}\n${WORKTREE_CONTAINER_EXCLUDE}\n`,
    (err) => console.warn(`Failed to git-exclude ${WORKTREE_CONTAINER_EXCLUDE}:`, err),
  );
}

/**
 * Append `SANDBOX_EXCLUDE_PATTERNS` to the shared `.git/info/exclude` so the
 * bwrap-left char-device placeholders at the worktree root are filtered out
 * of `git status` / `git ls-files` regardless of what the branch's committed
 * `.gitignore` looks like. Uses the header line as an idempotency marker;
 * safe to call on every agent spawn. Memoized per common git dir for the
 * process lifetime.
 */
export function ensureSandboxExcludes(worktreePath: string): void {
  const excludePath = resolveGitInfoExcludePath(worktreePath, execFileSync);
  if (!excludePath || seededSandboxExcludes.has(excludePath)) return;
  const result = appendGitInfoExcludeBlockAtPath(
    excludePath,
    SANDBOX_EXCLUDE_HEADER,
    `${SANDBOX_EXCLUDE_HEADER}\n${SANDBOX_EXCLUDE_PATTERNS.join('\n')}\n`,
    (err) => console.warn(`Failed to append to ${excludePath}:`, err),
  );
  if (result === 'appended' || result === 'present') seededSandboxExcludes.add(excludePath);
}

/**
 * Add root-anchored exclude entries for symlinked directory names to
 * `.git/info/exclude`. This ensures the symlink is invisible to git even when
 * the project's `.gitignore` uses a trailing-slash form (e.g. `node_modules/`)
 * which only matches real directories, not symlinks. Entries are added
 * incrementally — new names from later worktrees are appended without
 * duplicating already-present entries.
 */
export function ensureSymlinkExcludes(worktreePath: string, symlinkNames: string[]): void {
  // Names containing CR/LF would inject arbitrary ignore rules — refuse them
  // outright rather than writing a corrupted exclude file.
  const validNames = symlinkNames.filter((name) => {
    if (isValidSymlinkName(name)) return true;
    console.warn(`Refusing to exclude invalid symlink name: ${JSON.stringify(name)}`);
    return false;
  });
  if (validNames.length === 0) return;

  const excludePath = resolveGitInfoExcludePath(worktreePath);
  if (!excludePath) return;
  let existing = '';
  try {
    existing = fs.readFileSync(excludePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`Failed to read ${excludePath}:`, err);
      return;
    }
  }

  // Root-anchored, no trailing slash — matches the symlink file itself, not
  // just directories, so `node_modules/` gitignore entries can't sneak through.
  // Names are escaped to gitignore literals so `*`/`?` in a filename can't act
  // as wildcards against unrelated files. Dedup compares Git-normalized lines
  // (CRLF and unescaped trailing ASCII spaces stripped) — exact match would
  // rewrite a hand-written `/foo ` line, and substring matching would let an
  // existing `/foobar` swallow a needed `/foo`.
  const existingLines = new Set(splitContentLines(existing).map(normalizeExcludeLine));
  const toAdd = validNames
    .map((name) => `/${escapeGitignoreLiteral(name)}`)
    .filter((pattern) => !existingLines.has(pattern));

  if (toAdd.length === 0) return;

  const needsHeader = !existing.includes(SYMLINK_EXCLUDE_HEADER);
  const header = needsHeader ? SYMLINK_EXCLUDE_HEADER + '\n' : '';
  appendGitInfoExcludeBlockAtPath(
    excludePath,
    toAdd[0],
    `${header}${toAdd.join('\n')}\n`,
    (err) => console.warn(`Failed to append to ${excludePath}:`, err),
    existing,
    // `toAdd` already holds exactly the missing lines — the helper's
    // single-marker recheck must not gate this multi-line block.
    true,
  );
}

/**
 * Find the main repository root for a worktree via `git rev-parse
 * --git-common-dir`. Returns null when the cwd isn't inside a git repo.
 */
export function detectRepoRoot(worktreePath: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    const abs = path.isAbsolute(out) ? out : path.join(worktreePath, out);
    return path.dirname(abs);
  } catch {
    return null;
  }
}

/**
 * Spawn-time backfill for a worktree's `node_modules`: converts the legacy
 * whole-dir symlink to per-entry links and tops up links for packages
 * installed in the main checkout since the worktree was created. Only acts on
 * a `node_modules` this app manages (`isManagedNodeModules`) — the main
 * checkout's real install, a worktree-local `npm ci`, and a foreign symlink
 * are all left untouched. The ownership check also backstops the main-repo
 * path guard: a real install has no entry links into itself, so it can never
 * be classified as managed.
 *
 * Pass `repoRoot` when the caller already resolved it (null meaning "not a
 * repo") to avoid a redundant `git rev-parse` subprocess.
 */
export function refreshWorktreeNodeModules(worktreePath: string, repoRoot?: string | null): void {
  const root = repoRoot === undefined ? detectRepoRoot(worktreePath) : repoRoot;
  if (!root) return;
  // Realpath comparison so a symlinked alias of the main checkout can't slip
  // past the same-directory guard.
  const rootReal = realpathOrNull(root) ?? path.resolve(root);
  const worktreeReal = realpathOrNull(worktreePath) ?? path.resolve(worktreePath);
  if (rootReal === worktreeReal) return;
  const source = path.join(root, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  if (!isManagedNodeModules(source, target)) return;
  ensureNodeModulesEntryLinks(source, target);
}

export async function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean,
  explicitWorktreePath?: string,
): Promise<void> {
  // After the user adopts a branch the agent switched the worktree to, the
  // folder keeps its original branch-derived name — callers that know the real
  // path must pass it, deriving from branchName is only a fallback.
  const worktreePath = explicitWorktreePath ?? `${repoRoot}/.worktrees/${branchName}`;

  if (!fs.existsSync(repoRoot)) return;

  if (fs.existsSync(worktreePath)) {
    await forceRemoveWorktreeDir(repoRoot, worktreePath);
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

export async function getSymlinkCandidates(projectRoot: string): Promise<GitIgnoredEntry[]> {
  try {
    const ignoreCase = await getCoreIgnoreCase(projectRoot);
    // Single git call returning the full candidate set: root-level, ignored,
    // untracked. The `:(glob)` pathspec magic keeps `*` from crossing `/`, so
    // `:(glob)*` matches only root-level non-dot entries and `:(glob).*`
    // catches root-level dotfiles (glob `*` skips a leading dot). Output size
    // is bounded by the root entry count, nested ignored files inside tracked
    // directories never appear, and `--others` excludes tracked files — so no
    // per-candidate check-ignore re-verification is needed.
    const { stdout } = await exec(
      'git',
      [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--',
        ':(glob)*',
        ':(glob).*',
      ],
      { cwd: projectRoot, maxBuffer: MAX_BUFFER },
    );
    return stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
      .filter((name) => isValidSymlinkName(name) && !isReservedSymlinkName(name, ignoreCase))
      .map((name) => ({ name, isDefault: isDefaultSymlinkCandidate(name, ignoreCase) }));
  } catch (err) {
    // Degrade, never fail: a missing git binary or broken repo must not block
    // task creation — the worktree is simply created without symlinks.
    console.warn(`Failed to probe symlink candidates in ${projectRoot}:`, err);
    return [];
  }
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

  // Use the picked merge-base as the stats anchor so the file list matches
  // the all-changes diff body, including tracked local edits on top of HEAD.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let finalDiffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', '-z', diffBase.sha], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
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
  // Compares HEAD tree directly to the working tree, so it does not need the index
  // write lock and works reliably even while an agent holds it.
  // git ls-files --others --exclude-standard — untracked files (no index lock needed).
  // Both commands run in parallel since they are independent.
  const [uncommittedResult, untrackedResult] = await Promise.all([
    exec('git', ['diff', '--raw', '--numstat', '-z', headHash], {
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

async function buildUntrackedPseudoDiffs(worktreePath: string): Promise<string[]> {
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
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile() || stat.size >= MAX_BUFFER) continue;
      if (await isBinaryFile(fullPath)) {
        parts.push(
          `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary files /dev/null and b/${filePath} differ\n`,
        );
        continue;
      }
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const lines = splitContentLines(content);
      const pseudoLines: string[] = [];
      pseudoLines.push(`diff --git a/${filePath} b/${filePath}`);
      pseudoLines.push('new file mode 100644');
      pseudoLines.push('--- /dev/null');
      pseudoLines.push(`+++ b/${filePath}`);
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

export async function getAllFileDiffs(worktreePath: string, baseBranch?: string): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // For working-tree output, use the merge-base SHA as a single diff start
  // point. `git diff base...` would stop at HEAD and hide tracked local edits.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let combinedDiff = '';
  try {
    const { stdout } = await exec('git', ['diff', '-U3', diffBase.sha], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedFileDiffs(worktreePath: string): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // Diff against HEAD captures only tracked uncommitted changes (working tree
  // vs HEAD), excluding committed work. Uses the HEAD SHA directly so it does
  // not need the index lock and works while an agent holds it.
  let combinedDiff = '';
  try {
    const { stdout } = await exec('git', ['diff', '-U3', headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const headHash = await pinHead(worktreePath);
  let diffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', '-z', headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
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

export async function getWorktreeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<WorktreeStatus> {
  if (!fs.existsSync(worktreePath)) {
    return UNREADABLE_WORKTREE_STATUS;
  }
  let statusOut: string;
  try {
    ({ stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    }));
  } catch {
    // Worktree removed between existsSync and exec (race condition)
    return UNREADABLE_WORKTREE_STATUS;
  }
  const hasUncommittedChanges = statusOut.trim().length > 0;

  // Resolved base branch name, so the frontend can tell "agent switched to a
  // feature branch" (adoptable) apart from "agent is sitting on main" (not).
  const [currentBranch, resolvedBaseBranch, headSha] = await Promise.all([
    getCurrentBranchName(worktreePath).catch(() => null),
    baseBranch ?? detectMainBranch(worktreePath).catch(() => null),
    exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null),
  ]);

  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', resolvedBaseBranch ?? undefined);
  let hasCommittedChanges = false;
  try {
    const { stdout: logOut } = await exec('git', ['log', `${mergeBase}..HEAD`, '--oneline'], {
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
    base_branch: resolvedBaseBranch,
    head_sha: headSha,
  };
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

/** Resolve an already checked-out local branch without creating or switching worktrees. */
export async function getBranchWorktreePath(
  projectRoot: string,
  branchName: string,
): Promise<{ path: string; head: string; headCommittedAt: string | null } | null> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
  const match = parseWorktreeList(stdout).find(
    (entry) => !entry.detached && entry.branchName === branchName,
  );
  if (!match?.path || !match.head) return null;
  try {
    const { stdout } = await exec('git', ['show', '-s', '--format=%cI', match.head], {
      cwd: match.path,
    });
    const timestamp = new Date(stdout.trim());
    return {
      path: match.path,
      head: match.head,
      headCommittedAt: Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString(),
    };
  } catch {
    return { path: match.path, head: match.head, headCommittedAt: null };
  }
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
): Promise<{ main_ahead_count: number; conflicting_files: string[]; base_branch: string }> {
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
    // merge-tree outputs conflict info on failure
    const output = String(e);
    for (const line of output.split('\n')) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  return {
    main_ahead_count: mainAheadCount,
    conflicting_files: conflictingFiles,
    base_branch: mainBranch,
  };
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
): Promise<{ main_branch: string; lines_added: number; lines_removed: number }> {
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
    // refuses to check out a branch that's live elsewhere. Use mergeWorktreePath as the
    // working directory for merge ops when provided; it's already on the right branch.
    const mergeRoot = mergeWorktreePath ?? projectRoot;

    // Verify clean working tree in the merge root
    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
      cwd: mergeRoot,
    });
    if (statusOut.trim())
      throw new Error(
        'Working tree has uncommitted changes. Please commit or stash them before merging.',
      );

    // Capture the current branch BEFORE any checkout so we can restore it afterward.
    const originalBranch = mergeWorktreePath
      ? null
      : await getCurrentBranchName(projectRoot).catch(() => null);

    if (!mergeWorktreePath) {
      // Need to checkout the target branch in the main repo
      await exec('git', ['checkout', mainBranch], { cwd: projectRoot });
    }

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
        await exec('git', ['merge', '--squash', '--', branchName], { cwd: mergeRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during squash recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Squash merge failed: ${e}`);
      }
      const msg = message ?? 'Squash merge';
      try {
        await exec('git', ['commit', '-m', msg], { cwd: mergeRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during commit recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Commit failed: ${e}`);
      }
    } else {
      try {
        await exec('git', ['merge', '--', branchName], { cwd: mergeRoot });
      } catch (e) {
        await exec('git', ['merge', '--abort'], { cwd: mergeRoot }).catch((recoverErr) =>
          console.warn('git merge --abort failed:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Merge failed: ${e}`);
      }
    }

    invalidateDiffBaseCache();

    if (cleanup) {
      await removeWorktree(projectRoot, branchName, true, worktreePath);
    }

    await restoreBranch();

    return { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
  });
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
    invalidateDiffBaseCache();
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
