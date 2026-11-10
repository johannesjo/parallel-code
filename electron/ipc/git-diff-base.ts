// Which base a task branch's diff is measured against: the repository's main
// branch, the merge base (refined for rebased and patch-equivalent commits and
// folded upstream merges), and the ranges built from it. Results are cached
// briefly per repository.

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { debug as logDebug } from '../log.js';
import { exec, MAX_BUFFER } from './git-exec.js';

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

export function invalidateDiffBaseCache(): void {
  diffBaseCache.clear();
}

function cacheKey(p: string): string {
  return p.replace(/\/+$/, '');
}

export async function detectMainBranch(repoRoot: string): Promise<string> {
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

export async function findLocalBranchPrefixConflict(
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

export async function getCurrentBranchName(repoRoot: string): Promise<string> {
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

  if (await isAncestor(repoRoot, originMb, localMb)) return { sha: localMb, ref: branch };
  if (await isAncestor(repoRoot, localMb, originMb)) {
    return { sha: originMb, ref: `origin/${branch}` };
  }
  return { sha: localMb, ref: branch };
}

async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
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
 *
 * `compareRef` matches patches against a branch other than `base.ref`; only
 * commits after `base.sha` are then considered (e.g. a child rebased onto main
 * still carries copies of its parent's commits above the rebase target).
 */
async function refineDiffBaseWithCherryPick(
  repoRoot: string,
  base: PickedMergeBase,
  head: string,
  compareRef = base.ref,
): Promise<PickedMergeBase> {
  let unique: string[];
  let oldestParent: string | null = null;
  try {
    const range = [`${compareRef}...${head}`];
    if (compareRef !== base.ref) range.push(`^${base.sha}`);
    const { stdout } = await exec(
      'git',
      [
        'log',
        '--cherry-pick',
        '--right-only',
        '--no-merges',
        '--reverse',
        '--pretty=%H %P',
        ...range,
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
 * Reflog of `head`'s branch as `<sha>\0<subject>` entries, newest first.
 * Empty for a detached head or a missing reflog.
 */
async function readBranchReflog(repoRoot: string, head: string): Promise<string[]> {
  try {
    // A pinned SHA has no symbolic name; it is the checked-out branch's head.
    const { stdout } = await exec('git', ['rev-parse', '--symbolic-full-name', head], {
      cwd: repoRoot,
    });
    const ref = stdout.trim() || `refs/heads/${await getCurrentBranchName(repoRoot)}`;
    if (!ref.startsWith('refs/heads/')) return [];
    const { stdout: reflog } = await exec('git', ['reflog', 'show', '--format=%H%x00%gs', ref], {
      cwd: repoRoot,
      maxBuffer: MAX_BUFFER,
    });
    return reflog.split('\n').filter(Boolean);
  } catch {
    // Missing or expired reflogs are not evidence of a changed branch point.
    return [];
  }
}

/** Commit a branch was created from, read from its oldest reflog entry. */
function findBranchCreationCommit(headReflog: string[]): string | null {
  const [sha, subject] = (headReflog[headReflog.length - 1] ?? '').split('\0');
  return subject?.startsWith('branch: Created from') ? sha : null;
}

/**
 * Where `head`'s branch was created from `branch`, when that is newer than
 * `base`. A parent that amends, squashes or conflict-resolves its commits
 * after a child forked leaves the child holding pre-rewrite copies that
 * neither the merge-base nor the cherry-pick refinement can exclude, so the
 * child would otherwise show all inherited parent work as its own.
 *
 * Deliberately not `git merge-base --fork-point`: the base branch's reflog
 * also remembers the head's own commits after an undone fast-forward merge,
 * which would hide that work. The creation point must instead have been a
 * tip of `branch`; a branch an agent created mid-work never was.
 */
async function findForkPoint(
  repoRoot: string,
  opts: { branch: string; headReflog: string[]; head: string; base: string },
): Promise<string | null> {
  try {
    const created = findBranchCreationCommit(opts.headReflog);
    if (!created || created === opts.base) return null;
    if (!(await isAncestor(repoRoot, opts.base, created))) return null;
    if (!(await isAncestor(repoRoot, created, opts.head))) return null;
    const { stdout } = await exec(
      'git',
      ['reflog', 'show', '--format=%H', `refs/heads/${opts.branch}`],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    return stdout.split('\n').includes(created) ? created : null;
  } catch {
    // Missing or expired base branch reflog.
    return null;
  }
}

// Fixed identity and dates make the synthetic base commit content-addressed:
// refreshing the diff reuses one object instead of piling up dangling commits.
const SYNTHETIC_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Parallel Code',
  GIT_AUTHOR_EMAIL: 'parallel-code@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'Parallel Code',
  GIT_COMMITTER_EMAIL: 'parallel-code@localhost',
  GIT_COMMITTER_DATE: '@0 +0000',
};

interface MainBranchRefs {
  name: string;
  /** Existing local and remote-tracking refs of the main branch. */
  refs: string[];
}

async function resolveMainBranchRefs(repoRoot: string): Promise<MainBranchRefs> {
  const name = await detectMainBranch(repoRoot);
  const [hasLocal, hasOrigin] = await Promise.all([
    localBranchExists(repoRoot, name),
    remoteTrackingRefExists(repoRoot, name),
  ]);
  const refs = [
    ...(hasLocal ? [`refs/heads/${name}`] : []),
    ...(hasOrigin ? [`refs/remotes/origin/${name}`] : []),
  ];
  return { name, refs };
}

async function isOnMainBranch(repoRoot: string, sha: string, main: MainBranchRefs) {
  for (const ref of main.refs) if (await isAncestor(repoRoot, sha, ref)) return true;
  return false;
}

/**
 * Newest main-branch commit that `head`'s own merges brought in on top of
 * `base`. Merges reachable from main are main's history (the head may have
 * fast-forwarded onto main), and merged branches main lacks are the head's own
 * side work; neither counts. Null when there is none or the merged upstream
 * snapshots diverge from each other.
 */
async function findMergedUpstreamTip(
  repoRoot: string,
  base: string,
  head: string,
  main: MainBranchRefs,
): Promise<string | null> {
  if (main.refs.length === 0) return null;
  const { stdout } = await exec(
    'git',
    [
      'rev-list',
      ...['--first-parent', '--merges', '--parents', head, `^${base}`],
      ...main.refs.map((ref) => `^${ref}`),
    ],
    { cwd: repoRoot, maxBuffer: MAX_BUFFER },
  );
  let tip: string | null = null;
  // Newest merge first; each line is `<merge> <first parent> <merged parents...>`.
  for (const merged of stdout.split('\n').flatMap((line) => line.trim().split(' ').slice(2))) {
    if (await isAncestor(repoRoot, merged, base)) continue;
    if (!(await isOnMainBranch(repoRoot, merged, main))) continue;
    if (tip === null || (await isAncestor(repoRoot, tip, merged))) tip = merged;
    else if (!(await isAncestor(repoRoot, merged, tip))) return null;
  }
  return tip;
}

/**
 * Fold main-branch work that `head` merged on top of `base` (a child running
 * `git merge main`) into a synthetic base commit, so the diff shows only the
 * head's own work. Returns null when nothing upstream was merged in, or when
 * the base and that upstream conflict and so have no clean combined snapshot.
 */
async function foldMergedUpstream(
  repoRoot: string,
  opts: { branch: string; base: string; head: string; main: MainBranchRefs },
): Promise<string | null> {
  const { branch, base, head, main } = opts;
  if (branch === main.name) return null;
  try {
    const tip = await findMergedUpstreamTip(repoRoot, base, head, main);
    if (!tip) return null;
    // Exits non-zero on conflicts, which lands in the catch below.
    const { stdout: tree } = await exec('git', ['merge-tree', '--write-tree', base, tip], {
      cwd: repoRoot,
    });
    const { stdout: commit } = await exec(
      'git',
      [
        'commit-tree',
        '--no-gpg-sign',
        ...['-p', base, '-p', tip, '-m', 'Parallel Code diff base'],
        tree.split('\n')[0].trim(),
      ],
      { cwd: repoRoot, env: { ...process.env, ...SYNTHETIC_COMMIT_ENV } },
    );
    return commit.trim() || null;
  } catch {
    return null;
  }
}

interface RecordedRebase {
  target: string;
  previousHead: string;
  fastForward: boolean;
}

// A scan spawns one git call per recorded move, serially. Under endpoint
// security (Jamf on macOS) every spawn blocks the main thread, so a long
// reflog rescanned on each diff refresh froze the app for seconds.
const rebaseScanCache = new Map<string, RecordedRebase[]>();
const REBASE_SCAN_CACHE_MAX = 100;

/**
 * Read rebases (including `git pull --rebase`) and fast-forwards
 * (`git merge`/`git pull` moving the branch onto another tip) oldest first so repeated moves retain the inherited
 * baseline. Reflog entries name fixed commits, so a scan is reused until the reflog changes.
 */
async function findRebases(repoRoot: string, entries: string[]): Promise<RecordedRebase[]> {
  const key = createHash('sha1')
    .update(`${repoRoot}\0${entries.join('\n')}`)
    .digest('hex');
  const cached = rebaseScanCache.get(key);
  if (cached) return cached;
  const rebases = await scanRebases(repoRoot, entries);
  if (!rebases) return [];
  rebaseScanCache.set(key, rebases);
  // Map keeps insertion order, so the first key is the oldest scan.
  const oldest = rebaseScanCache.keys().next().value;
  if (rebaseScanCache.size > REBASE_SCAN_CACHE_MAX && oldest !== undefined) {
    rebaseScanCache.delete(oldest);
  }
  return rebases;
}

/** Null when git fails, so a transient error is not cached as "no rebases". */
async function scanRebases(repoRoot: string, entries: string[]): Promise<RecordedRebase[] | null> {
  try {
    const rebases: RecordedRebase[] = [];
    for (let index = 0; index < entries.length; index++) {
      const fastForward = /^[0-9a-f]{40}\0(?:merge|pull)\b.*: Fast-forward$/.test(entries[index]);
      const target = fastForward
        ? entries[index].split('\0', 1)[0]
        : entries[index].match(
            /^[0-9a-f]{40}\0(?:rebase|pull\b.*) \(finish\): .* onto ([0-9a-f]{40})$/,
          )?.[1];
      if (!target) continue;
      const previousHead = entries[index + 1]?.split('\0', 1)[0];
      if (previousHead && /^[0-9a-f]{40}$/.test(previousHead)) {
        // A reset can reuse the branch for different work. Only trust a target
        // retained by every later branch head, including intermediate resets.
        if (index > 0) {
          const newerHeads = entries.slice(0, index).map((entry) => entry.split('\0', 1)[0]);
          const { stdout: commonBase } = await exec(
            'git',
            ['merge-base', '--octopus', target, ...newerHeads],
            { cwd: repoRoot },
          );
          if (commonBase.trim() !== target) continue;
        }
        rebases.push({ target, previousHead, fastForward });
      }
    }
    return rebases.reverse();
  } catch {
    // Missing or expired reflogs are not evidence of a changed branch point.
    return null;
  }
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
export async function detectDiffBase(
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

  let compareBranch = branch;
  let picked = await pickMergeBase(repoRoot, branch, headRef);
  if (!picked && baseBranch) {
    // The parent branch is gone, usually deleted after landing upstream, so
    // its inherited work can only be recognized on the main branch now.
    compareBranch = await detectMainBranch(repoRoot);
    if (compareBranch !== branch) picked = await pickMergeBase(repoRoot, compareBranch, headRef);
  }
  if (!picked) return { sha: headRef, ref: headRef };

  let refined = await refineDiffBaseWithCherryPick(repoRoot, picked, headRef);
  const headReflog = await readBranchReflog(repoRoot, requestedHead);
  const forkPoint = await findForkPoint(repoRoot, {
    branch: compareBranch,
    headReflog,
    head: headRef,
    base: refined.sha,
  });
  if (forkPoint) refined = { sha: forkPoint, ref: forkPoint };
  if (baseBranch) {
    const beforeRebases = refined.sha;
    const main = await resolveMainBranchRefs(repoRoot);
    // A child may rebase or fast-forward away from its parent. Use that
    // recorded target, not today's main tip: main can subsequently receive the
    // child's own commits. The explicit parent remains the integration target.
    for (const rebase of await findRebases(repoRoot, headReflog)) {
      if (rebase.target === refined.sha) continue;
      // Fast-forwarding onto a branch of its own is the child's work.
      if (rebase.fastForward && !(await isOnMainBranch(repoRoot, rebase.target, main))) continue;
      try {
        await Promise.all([
          exec('git', ['merge-base', '--is-ancestor', refined.sha, rebase.target], {
            cwd: repoRoot,
          }),
          exec('git', ['merge-base', '--is-ancestor', rebase.target, headRef], { cwd: repoRoot }),
        ]);
        // The target may already contain child work (an interactive rewrite,
        // or main landing the child before it rebases). Keep the parent scope
        // if advancing would absorb any earlier child commits or their patches.
        // Exclude previously accepted upstream history from both counts.
        const [before, remaining] = await Promise.all([
          exec(
            'git',
            ['rev-list', '--count', rebase.previousHead, `^${picked.ref}`, `^${refined.sha}`],
            { cwd: repoRoot },
          ),
          exec(
            'git',
            [
              'rev-list',
              '--count',
              '--cherry-pick',
              '--right-only',
              `${rebase.target}...${rebase.previousHead}`,
              `^${picked.ref}`,
              `^${refined.sha}`,
            ],
            { cwd: repoRoot },
          ),
        ]);
        if (parseInt(before.stdout.trim(), 10) === parseInt(remaining.stdout.trim(), 10)) {
          refined = { sha: rebase.target, ref: rebase.target };
        }
      } catch {
        // Ignore obsolete rebase records and targets outside the current ancestry.
      }
    }
    if (refined.sha !== beforeRebases) {
      // A rebase replays copies of parent commits above the target.
      refined = await refineDiffBaseWithCherryPick(repoRoot, refined, headRef, picked.ref);
    }
    const folded = await foldMergedUpstream(repoRoot, {
      branch: compareBranch,
      base: refined.sha,
      head: headRef,
      main,
    });
    if (folded) refined = { sha: folded, ref: folded };
  }
  diffBaseCache.set(key, { value: refined, expiresAt: Date.now() + DIFF_BASE_TTL });
  return refined;
}

/**
 * Resolve the diff base SHA for `head` against `baseBranch` (or the detected
 * main branch). Falls back to `headRef` when no candidate ref resolves so
 * callers diff against themselves (empty diff) rather than against the branch
 * tip.
 */
export async function detectMergeBase(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<string> {
  const headRef = head ?? 'HEAD';
  const result = await detectDiffBase(repoRoot, headRef, baseBranch);
  return result.sha;
}

export function oneWayDiffRange(base: PickedMergeBase, head: string): string {
  // A SHA base is already the exact start point. A synthetic base is not an
  // ancestor of head, so a three-dot range would discard the folded upstream.
  return base.ref === base.sha ? `${base.sha}..${head}` : `${base.ref}...${head}`;
}

export async function detectOneWayDiffRange(
  repoRoot: string,
  head?: string,
  baseBranch?: string,
): Promise<string> {
  const headRef = head ?? 'HEAD';
  return oneWayDiffRange(await detectDiffBase(repoRoot, headRef, baseBranch), headRef);
}

export async function pinHead(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return 'HEAD';
  }
}

export async function detectRepoLockKey(p: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: p });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(p, commonDir);
  try {
    return await fs.promises.realpath(commonPath);
  } catch {
    return commonPath;
  }
}
