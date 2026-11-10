// Picks the commit a new task worktree starts from, so projects whose local
// base branch is never updated (work lands through PRs) don't start stale.

import { exec } from './git-exec.js';
import { debug as logDebug, warn as logWarn } from '../log.js';

// Ceiling on how long a slow or unreachable remote delays task creation.
const FETCH_TIMEOUT_MS = 10_000;
// The app has no terminal to answer prompts in; fail instead of hanging.
// SSH_ASKPASS_REQUIRE stops ssh popping a passphrase dialog without
// overriding the user's own ssh command or config.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
};

// Concurrent fetches into one repo race on ref locks; tasks created together share one.
const inFlightFetches = new Map<string, Promise<void>>();

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function readConfig(cwd: string, key: string): Promise<string | undefined> {
  // `git config --get` exits 1 for a missing key, which here just means "unset".
  return gitOut(cwd, ['config', '--get', key]).catch(() => undefined);
}

async function fetchBranch(repoRoot: string, remote: string, mergeRef: string): Promise<void> {
  try {
    // The configured refspec updates the remote-tracking ref; FETCH_HEAD is
    // left alone because PR checkout reads it concurrently.
    await exec('git', ['fetch', '--no-tags', '--no-write-fetch-head', '--', remote, mergeRef], {
      cwd: repoRoot,
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });
  } catch (err) {
    // Offline or no credentials: the last fetched upstream is still a fine start.
    logDebug('git', 'fetch before task creation failed; using last fetched upstream', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function fetchOnce(repoRoot: string, remote: string, mergeRef: string): Promise<void> {
  const key = `${repoRoot}\0${remote}\0${mergeRef}`;
  const pending = inFlightFetches.get(key);
  if (pending) return pending;
  const started = fetchBranch(repoRoot, remote, mergeRef).finally(() =>
    inFlightFetches.delete(key),
  );
  inFlightFetches.set(key, started);
  return started;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd }).then(
    () => true,
    () => false,
  );
}

async function pickStartPoint(repoRoot: string, baseBranch: string): Promise<string | undefined> {
  const remote = await readConfig(repoRoot, `branch.${baseBranch}.remote`);
  const mergeRef = await readConfig(repoRoot, `branch.${baseBranch}.merge`);
  // Diff bases only consider origin/<base> (git-diff-base.ts); any other
  // upstream would make its commits look like the task's own changes.
  if (remote !== 'origin' || mergeRef !== `refs/heads/${baseBranch}`) return undefined;
  await fetchOnce(repoRoot, remote, mergeRef);
  const [local, upstream] = await Promise.all([
    gitOut(repoRoot, ['rev-parse', '--verify', `refs/heads/${baseBranch}`]),
    gitOut(repoRoot, ['rev-parse', '--verify', `${baseBranch}@{upstream}`]),
  ]);
  if (local === upstream) return undefined;
  // Local commits the upstream lacks (e.g. unpushed merges) must not be dropped.
  return (await isAncestor(repoRoot, local, upstream)) ? upstream : undefined;
}

/**
 * Fetches `baseBranch`'s upstream and returns its commit when the local base
 * is strictly behind it; undefined means "start from the local base". A SHA,
 * not `origin/main`, so the new branch doesn't start tracking the upstream.
 * Never throws: any failure falls back to the local base.
 */
export async function resolveFreshStartPoint(
  repoRoot: string,
  baseBranch: string,
): Promise<string | undefined> {
  try {
    return await pickStartPoint(repoRoot, baseBranch);
  } catch (err) {
    logWarn('git', 'could not resolve upstream start point; using local base', {
      baseBranch,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Start commit for a new task worktree: undefined means "start from
 * `baseBranch`" (or HEAD without one). Projects that opt out of fresh starts
 * skip the fetch entirely.
 */
export function taskStartPoint(
  repoRoot: string,
  baseBranch: string | undefined,
  startFromLocalBase: boolean,
): Promise<string | undefined> {
  if (!baseBranch || startFromLocalBase) return Promise.resolve(undefined);
  return resolveFreshStartPoint(repoRoot, baseBranch);
}
