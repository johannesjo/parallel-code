/** The `--head` a task PR names, so PRs pushed to a fork open against its upstream. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { errMessage, warn as logWarn } from '../log.js';
import { asRecord, asString, runGhJson } from './gh.js';
import { resolveGitHubRepository } from './issues.js';
import { parseRemoteUrl } from './pr-checkout.js';

const exec = promisify(execFile);

/** `owner/repo` of a github.com remote URL; null for other hosts or odd paths. */
export function githubRepository(remoteUrl: string): string | null {
  const remote = parseRemoteUrl(remoteUrl);
  if (remote?.url.hostname.toLowerCase() !== 'github.com') return null;
  // A leading dash would reach gh as an option.
  return /^[\w.][\w.-]*\/[\w.-]+$/.test(remote.repo) ? remote.repo : null;
}

/**
 * `owner:branch` when origin is a different repository than `baseRepository`,
 * else the bare branch. Task branches are always pushed to origin, while gh
 * opens the PR in the repository it resolves, which is the upstream one in a
 * fork checkout that has an `upstream` remote.
 */
export function qualifyHead(originRepository: string, baseRepository: string, branch: string) {
  if (originRepository.toLowerCase() === baseRepository.toLowerCase()) return branch;
  return `${originRepository.split('/')[0]}:${branch}`;
}

/** qualifyHead for a worktree; the bare branch when a lookup fails, as before forks were handled. */
export async function resolvePrHead(worktreePath: string, branch: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath });
    const origin = githubRepository(stdout.trim());
    if (!origin) return branch;
    // The canonical name: a remote URL from before a rename or transfer still
    // names the same repository, which must not read as a fork.
    const [canonical, base] = await Promise.all([
      runGhJson(['repo', 'view', origin, '--json', 'nameWithOwner'], worktreePath),
      resolveGitHubRepository(worktreePath),
    ]);
    const originRepository = asString(asRecord(canonical)?.nameWithOwner);
    return originRepository ? qualifyHead(originRepository, base, branch) : branch;
  } catch (err) {
    // gh pr create reports the underlying problem (no remote, gh logged out) itself.
    logWarn('github', 'Could not tell whether origin is a fork', { err: errMessage(err) });
    return branch;
  }
}
