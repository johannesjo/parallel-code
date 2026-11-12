import path from 'path';
import { getMainBranch } from './git.js';
import { exec, MAX_BUFFER } from './git-exec.js';
import { findNestedRepos } from './nested-repos.js';
import {
  fetchPrHead,
  isGhAuthError,
  isGhMissingError,
  isPrUrl,
  listOpenPrUrlsForBranch,
  listPrsForHead,
  type PrHead,
} from './pr-checks.js';
import type { BranchPrDetectionResult, NestedRepo, TaskExtraPr } from './shared-types.js';

/** `failedRepos` entry for the task's own repository. */
const OWN_REPO = '.';

/**
 * Open PRs of a task: the first PR of its branch is the primary one, the rest
 * and the PRs of its nested repositories' checked-out branches are extras.
 * PRs of the remote branch the task branch tracks count as the branch's own.
 * A missing or logged-out `gh` propagates so callers can disable detection;
 * any other failure only loses that repository's PRs and lists it in `failedRepos`.
 * When the branch has no open PR, `printedPrUrl`, a PR link the task's agent
 * printed, or else a merged PR of the tracked branch stands in when it belongs to the task.
 */
export async function detectTaskPrs(
  worktreePath: string,
  branchName: string,
  { printedPrUrl, baseBranch }: TaskPrHints = {},
): Promise<Omit<BranchPrDetectionResult, 'unavailable'>> {
  const [own, pushed, nested] = await Promise.all([
    listOpenPrUrlsForBranch(worktreePath, branchName).catch(ownRepoFailure),
    pushedBranchPrs(worktreePath, branchName, baseBranch).catch(ownRepoFailure),
    findNestedRepos(worktreePath).then((repos) =>
      Promise.all(repos.map((repo) => nestedRepoPrs(worktreePath, repo))),
    ),
  ]);
  const openUrls = [
    ...new Set([
      ...(own ?? []),
      ...(pushed ?? []).filter((pr) => pr.state === 'OPEN').map((pr) => pr.url),
    ]),
  ];
  // Null while a listing failed, so the task's PRs count as unknown and a printed link is retried.
  let ownUrls: string[] | null = null;
  if (own && pushed) {
    ownUrls =
      openUrls.length > 0
        ? openUrls
        : await closedOutPrOfTask(worktreePath, branchName, printedPrUrl, pushed, baseBranch);
  }
  const [url = null, ...otherUrls] = ownUrls ?? openUrls;
  const extras: TaskExtraPr[] = [
    ...otherUrls.map((extraUrl) => ({ url: extraUrl })),
    ...nested.flatMap((n) => n.prs ?? []),
  ];
  const failedRepos = [
    ...(ownUrls ? [] : [OWN_REPO]),
    ...nested.flatMap((n) => (n.prs ? [] : [n.name])),
  ];
  return failedRepos.length > 0 ? { url, extras, failedRepos } : { url, extras };
}

/** What the renderer knows about a task beyond its branch. */
export interface TaskPrHints {
  /** A PR link the task's agent printed while the task had no PR. */
  printedPrUrl?: string;
  /** The branch the task is based on, whose PRs are never the task's. */
  baseBranch?: string;
}

function ownRepoFailure(err: unknown): null {
  if (isGhUnavailable(err)) throw err;
  console.warn('Failed to detect PRs of the task repository:', err);
  return null;
}

/**
 * PRs of the remote branch the task branch tracks, when it has another name:
 * an agent may push `task/x` as `fix/y`, which `--head task/x` cannot match.
 */
async function pushedBranchPrs(
  worktreePath: string,
  branchName: string,
  baseBranch: string | undefined,
): Promise<PrHead[]> {
  let tracked: string;
  try {
    const { stdout } = await exec(
      'git',
      [
        'for-each-ref',
        '--format=%(upstream:remotename) %(upstream:remoteref)',
        `refs/heads/${branchName}`,
      ],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    tracked = stdout.trim();
  } catch (err) {
    // A worktree removed meanwhile; its branch is then looked up by name alone, as before.
    console.warn('[pr-checks] could not read the branch the task branch tracks:', err);
    return [];
  }
  const [remote = '', remoteRef = ''] = tracked.split(' ');
  // No upstream, or a local one such as a coordinator's branch.
  if (!remote || remote === '.' || !remoteRef.startsWith('refs/heads/')) return [];
  const name = remoteRef.slice('refs/heads/'.length);
  if (name === branchName) return [];
  // A task created from `origin/main` tracks it; PRs from the base branch are not the task's.
  if (baseBranch && (name === baseBranch || `${remote}/${name}` === baseBranch)) return [];
  if (name === (await getMainBranch(worktreePath))) return [];
  return listPrsForHead(worktreePath, name);
}

/**
 * The PR that stands in for a branch without open PRs: the printed one if it
 * is open or merged and its head commit is the task's own, which catches a PR
 * pushed under another branch name or merged before the app saw it open; else
 * the newest merged PR of the tracked branch whose head is the task's own.
 * Null when GitHub could not be asked, so it is retried.
 */
async function closedOutPrOfTask(
  worktreePath: string,
  branchName: string,
  printedPrUrl: string | undefined,
  pushed: PrHead[],
  baseBranch: string | undefined,
): Promise<string[] | null> {
  if (printedPrUrl) {
    const printed = await printedPrOfTask(worktreePath, branchName, printedPrUrl, baseBranch);
    if (printed !== false) return printed;
  }
  for (const pr of pushed) {
    // Its open PRs were taken already; a closed one is abandoned work.
    if (pr.state !== 'MERGED') {
      notOwn('pushed', 'not merged', { prUrl: pr.url, state: pr.state });
      continue;
    }
    const reason = await notOwnReason(worktreePath, branchName, pr, baseBranch);
    if (!reason) return [pr.url];
    notOwn('pushed', reason.why, { prUrl: pr.url, ...reason.details });
  }
  return [];
}

/** The printed PR as the task's only PR, false when it is not the task's, null when unknown. */
async function printedPrOfTask(
  worktreePath: string,
  branchName: string,
  prUrl: string,
  baseBranch: string | undefined,
): Promise<string[] | null | false> {
  if (!isPrUrl(prUrl)) return notOwn('printed', 'not a PR link', { prUrl });
  let pr: PrHead;
  try {
    pr = await fetchPrHead(prUrl);
  } catch (err) {
    // Retrying cannot fix a PR gh cannot see, or a host it is not logged into.
    if (isGhAuthError(err) || isGhNotFoundError(err))
      return notOwn('printed', 'gh cannot see it', { prUrl, err });
    console.warn('[pr-checks] printed PR lookup failed:', prUrl, err);
    return null;
  }
  // A PR closed unmerged is abandoned work.
  if (pr.state !== 'OPEN' && pr.state !== 'MERGED')
    return notOwn('printed', 'neither open nor merged', { prUrl, state: pr.state });
  const reason = await notOwnReason(worktreePath, branchName, pr, baseBranch);
  return reason ? notOwn('printed', reason.why, { prUrl, ...reason.details }) : [prUrl];
}

/**
 * Why `pr` is not the task's own, or null when its head commit is: the task
 * branch holds it and no branch but copies of the task branch or the PR head
 * does, apart from those that got it by merging the PR.
 */
async function notOwnReason(
  worktreePath: string,
  branchName: string,
  pr: PrHead,
  baseBranch: string | undefined,
): Promise<{ why: string; details: Record<string, unknown> } | null> {
  if (!pr.headRefOid) return { why: 'no head commit', details: {} };
  // The base branch's PR, such as a coordinator's, holds no commit of the task's own.
  if (pr.headRefName === baseBranch)
    return { why: 'PR of the base branch', details: { baseBranch } };
  const refs = await refsContaining(worktreePath, pr.headRefOid);
  const names = new Set([branchName, pr.headRefName]);
  // A local or pushed copy of the task branch or the PR head; any other ref
  // holding the commit, such as a coordinator's branch or main, makes it shared work.
  const isCopy = (ref: string) =>
    ref.startsWith('refs/heads/')
      ? names.has(ref.slice('refs/heads/'.length))
      : names.has(ref.split('/').slice(3).join('/'));
  const others = refs.filter((ref) => !isCopy(ref));
  if (refs.includes(`refs/heads/${branchName}`)) {
    if (others.length === 0) return null;
    const merged = await refsHoldingMergeOf(worktreePath, pr);
    if (others.every((ref) => merged.has(ref))) return null;
  }
  return {
    why: 'other branches hold its head',
    details: { branchName, headRefName: pr.headRefName, refs },
  };
}

/**
 * Refs holding a merged PR's merge commit. A merge commit brings the PR head
 * into the base branch, so those refs hold the head only by that merge. None
 * when the head was on the base branch already, as when it was pushed there.
 */
async function refsHoldingMergeOf(worktreePath: string, pr: PrHead): Promise<Set<string>> {
  const merge = pr.mergeCommitOid;
  if (pr.state !== 'MERGED' || !merge || merge === pr.headRefOid) return new Set();
  if (await isAncestor(worktreePath, pr.headRefOid, `${merge}^1`)) return new Set();
  return new Set(await refsContaining(worktreePath, merge));
}

/** Logs why a PR is not the task's, so a PR that still goes undetected shows why. */
function notOwn(
  source: 'printed' | 'pushed',
  reason: string,
  details: Record<string, unknown>,
): false {
  const key = `${source} ${String(details['prUrl'])} ${reason}`;
  // The tracked branch's PRs are checked on every probe; their verdict rarely changes.
  if (!loggedVerdicts.has(key)) {
    loggedVerdicts.add(key);
    const what = source === 'printed' ? 'printed PR' : 'PR of the pushed branch';
    console.warn(`[pr-checks] ${what} is not the task’s own (${reason}):`, details);
  }
  return false;
}
const loggedVerdicts = new Set<string>();

function isGhNotFoundError(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  return typeof stderr === 'string' && /could not resolve to a/i.test(stderr);
}

/** Local and remote branches holding `sha`; none when the repository lacks it. */
async function refsContaining(worktreePath: string, sha: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (err) {
    // Expected for a fork's or another repository's PR, whose commits were never fetched.
    console.warn('[pr-checks] could not list branches holding a PR commit:', sha, err);
    return [];
  }
}

/** Whether `ancestor` is reachable from `rev`; false when either is missing. */
async function isAncestor(worktreePath: string, ancestor: string, rev: string): Promise<boolean> {
  try {
    await exec('git', ['merge-base', '--is-ancestor', ancestor, rev], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

function isGhUnavailable(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT' || isGhAuthError(err);
}

/** A nested repository's PRs; `prs` is null when they could not be listed. */
async function nestedRepoPrs(
  worktreePath: string,
  repo: NestedRepo,
): Promise<{ name: string; prs: TaskExtraPr[] | null }> {
  const repoPath = path.join(worktreePath, repo.name);
  try {
    // A PR's head is never the repo's main branch; querying it would match
    // fork PRs from contributors' own main branches.
    if (repo.branch === 'HEAD' || repo.branch === (await getMainBranch(repoPath))) {
      return { name: repo.name, prs: [] };
    }
    const urls = await listOpenPrUrlsForBranch(repoPath, repo.branch);
    return { name: repo.name, prs: urls.map((url) => ({ url, repo: repo.name })) };
  } catch (err) {
    // A missing gh disables detection. gh logs in per host, so an auth error here
    // only fails this repo; the task's own repo decides whether gh is logged out.
    if (isGhMissingError(err)) throw err;
    console.warn(`Failed to detect PRs of nested repository '${repo.name}':`, err);
    return { name: repo.name, prs: null };
  }
}
