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
} from './pr-checks.js';
import type { BranchPrDetectionResult, NestedRepo, TaskExtraPr } from './shared-types.js';

/** `failedRepos` entry for the task's own repository. */
const OWN_REPO = '.';

/**
 * Open PRs of a task: the first PR of its branch is the primary one, the rest
 * and the PRs of its nested repositories' checked-out branches are extras.
 * A missing or logged-out `gh` propagates so callers can disable detection;
 * any other failure only loses that repository's PRs and lists it in `failedRepos`.
 * `printed.url`, a PR link the task's agent printed, stands in for a branch
 * without PRs when it belongs to the task.
 */
export async function detectTaskPrs(
  worktreePath: string,
  branchName: string,
  printed?: PrintedPr,
): Promise<Omit<BranchPrDetectionResult, 'unavailable'>> {
  const [own, nested] = await Promise.all([
    listOpenPrUrlsForBranch(worktreePath, branchName).catch((err: unknown) => {
      if (isGhUnavailable(err)) throw err;
      console.warn('Failed to detect PRs of the task repository:', err);
      return null;
    }),
    findNestedRepos(worktreePath).then((repos) =>
      Promise.all(repos.map((repo) => nestedRepoPrs(worktreePath, repo))),
    ),
  ]);
  const ownUrls =
    own?.length === 0 && printed ? await printedPrOfTask(worktreePath, branchName, printed) : own;
  const [url = null, ...otherUrls] = ownUrls ?? [];
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

/** A PR link the task's agent printed, and the branch the task is based on. */
export interface PrintedPr {
  url: string;
  baseBranch?: string;
}

/**
 * The printed PR as the task's only PR if it is open and its head commit is the
 * task's own. That catches a PR pushed under another branch name, which
 * `--head` cannot match. Null when GitHub could not be asked, so it is retried.
 */
async function printedPrOfTask(
  worktreePath: string,
  branchName: string,
  { url: prUrl, baseBranch }: PrintedPr,
): Promise<string[] | null> {
  if (!isPrUrl(prUrl)) return notOwn('not a PR link', { prUrl });
  let pr: Awaited<ReturnType<typeof fetchPrHead>>;
  try {
    pr = await fetchPrHead(prUrl);
  } catch (err) {
    // Retrying cannot fix a PR gh cannot see, or a host it is not logged into.
    if (isGhAuthError(err) || isGhNotFoundError(err))
      return notOwn('gh cannot see it', { prUrl, err });
    console.warn('[pr-checks] printed PR lookup failed:', prUrl, err);
    return null;
  }
  if (pr.state !== 'OPEN' || !pr.headRefOid) return notOwn('not open', { prUrl, state: pr.state });
  // The base branch's PR, such as a coordinator's, holds no commit of the task's own.
  if (pr.headRefName === baseBranch) return notOwn('PR of the base branch', { prUrl, baseBranch });
  const refs = await refsContaining(worktreePath, pr.headRefOid);
  const names = new Set([branchName, pr.headRefName]);
  // A local or pushed copy of the task branch or the PR head; any other ref
  // holding the commit, such as a coordinator's branch or main, makes it shared work.
  const isCopy = (ref: string) =>
    ref.startsWith('refs/heads/')
      ? names.has(ref.slice('refs/heads/'.length))
      : names.has(ref.split('/').slice(3).join('/'));
  if (refs.includes(`refs/heads/${branchName}`) && refs.every(isCopy)) return [prUrl];
  return notOwn('other branches hold its head', {
    prUrl,
    branchName,
    headRefName: pr.headRefName,
    refs,
  });
}

/** No PR for the task; logged so a PR that still goes undetected shows why. */
function notOwn(reason: string, details: Record<string, unknown>): string[] {
  console.warn(`[pr-checks] printed PR is not the task’s own (${reason}):`, details);
  return [];
}

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
    console.warn('[pr-checks] could not list branches holding a printed PR head:', sha, err);
    return [];
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
