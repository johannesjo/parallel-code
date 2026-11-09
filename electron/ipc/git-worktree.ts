// Task worktrees: creating and removing them, the symlinks and Claude sandbox
// files they get from the main checkout, the .git/info/exclude entries that
// keep those out of commits, and the per-worktree lock that serializes git
// operations on one worktree.

import fs from 'fs';
import path from 'path';
import { exec, execFileSync, MAX_BUFFER } from './git-exec.js';
import { findLocalBranchPrefixConflict } from './git-diff-base.js';
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
  linkNestedNodeModules,
  realpathOrNull,
} from './worktree-node-modules.js';
import type { GitIgnoredEntry } from './shared-types.js';

const worktreeLocks = new Map<string, Promise<void>>();

const sandboxSetups = new Map<string, Promise<void>>();

const worktreeRemovals = new Map<string, Promise<void>>();

export function withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
// `steps.json` belonged to the retired Steps panel; old worktrees may still hold one.
// `worktrees` holds Claude Code's nested worktree checkouts. Their `.git` gitlink
// files survive the copy, so git commands in a seeded copy would write to the
// original worktree's index.
const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'steps.json', 'worktrees']);

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

export function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.slice(0, -1) : lines;
}

export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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
  const key = safeRealpath(path.resolve(worktreePath));
  const existing = worktreeRemovals.get(key);
  if (existing) return existing;

  // Copies must settle before deletion; cancelling a PTY launch does not stop
  // its filesystem writes. Reject new setup requests while removal is pending.
  const removal = (async () => {
    await sandboxSetups.get(key);
    await removeWorktreeDir(repoRoot, worktreePath);
  })();
  worktreeRemovals.set(key, removal);
  try {
    await removal;
  } finally {
    worktreeRemovals.delete(key);
  }
}

async function removeWorktreeDir(repoRoot: string, worktreePath: string): Promise<void> {
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

/** Where `createWorktree` puts the worktree for a branch. */
export function worktreePathFor(repoRoot: string, branchName: string): string {
  return `${repoRoot}/.worktrees/${branchName}`;
}

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  baseBranch?: string,
  forceClean = false,
): Promise<{ path: string; branch: string }> {
  const worktreePath = worktreePathFor(repoRoot, branchName);

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
        linkNestedNodeModules(repoRoot, worktreePath);
      } else {
        fs.symlinkSync(source, target);
      }
      createdSymlinks.push(name);
    } catch (err) {
      console.warn(`Failed to symlink directory '${name}' into worktree:`, err);
    }
  }

  await ensureClaudeSandboxFiles(worktreePath, repoRoot);
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
export async function ensureClaudeSandboxFiles(
  worktreePath: string,
  repoRoot?: string | null,
): Promise<void> {
  const key = safeRealpath(path.resolve(worktreePath));
  if (worktreeRemovals.has(key)) throw new Error('Worktree is being removed');
  const existing = sandboxSetups.get(key);
  if (existing) return existing;

  // AI and shell agents can start together. A destination directory existing
  // during a recursive copy does not mean its contents are ready yet.
  const setup = seedClaudeSandboxFiles(worktreePath, repoRoot);
  sandboxSetups.set(key, setup);
  try {
    await setup;
  } finally {
    sandboxSetups.delete(key);
  }
}

async function seedClaudeSandboxFiles(
  worktreePath: string,
  repoRoot?: string | null,
): Promise<void> {
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
          // Recursive copies can be large; never block Electron's main thread.
          await fs.promises.cp(path.join(source, entry.name), dst, {
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
 * installed in the main checkout since the worktree was created, including
 * workspace packages' own installs. Only acts on
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
  linkNestedNodeModules(root, worktreePath);
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
  const worktreePath = explicitWorktreePath ?? worktreePathFor(repoRoot, branchName);

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

interface ListedWorktree {
  path: string;
  head: string | null;
  branchName: string | null;
  detached: boolean;
}

export function parseWorktreeList(output: string): ListedWorktree[] {
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
