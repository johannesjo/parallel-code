import path from 'path';
import { getMainBranch } from './git.js';
import { findNestedRepos } from './nested-repos.js';
import { isGhAuthError, isGhMissingError, listOpenPrUrlsForBranch } from './pr-checks.js';
import type { BranchPrDetectionResult, NestedRepo, TaskExtraPr } from './shared-types.js';

/** `failedRepos` entry for the task's own repository. */
const OWN_REPO = '.';

/**
 * Open PRs of a task: the first PR of its branch is the primary one, the rest
 * and the PRs of its nested repositories' checked-out branches are extras.
 * A missing or logged-out `gh` propagates so callers can disable detection;
 * any other failure only loses that repository's PRs and lists it in `failedRepos`.
 */
export async function detectTaskPrs(
  worktreePath: string,
  branchName: string,
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
  const [url = null, ...otherUrls] = own ?? [];
  const extras: TaskExtraPr[] = [
    ...otherUrls.map((extraUrl) => ({ url: extraUrl })),
    ...nested.flatMap((n) => n.prs ?? []),
  ];
  const failedRepos = [
    ...(own ? [] : [OWN_REPO]),
    ...nested.flatMap((n) => (n.prs ? [] : [n.name])),
  ];
  return failedRepos.length > 0 ? { url, extras, failedRepos } : { url, extras };
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
