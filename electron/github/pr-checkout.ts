/** Resolves what a task needs to check out an existing pull request. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { errMessage, warn as logWarn } from '../log.js';
import { validateBranchName } from '../mcp/validation.js';
import { asRecord, asString, parsePrRef, runGhJson, type PrRef } from './gh.js';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface PrCheckout {
  /** Commit the worktree starts from; verified to be the PR head. */
  headSha: string;
  /** The PR branch, or null when it is not a name we can safely pass to git. */
  headRefName: string | null;
  baseRefName: string;
  isCrossRepository: boolean;
  url: string;
  /** Remote the PR head was fetched from; pushes go to "origin" regardless. */
  remote: string;
}

export async function resolvePrCheckout(projectRoot: string, number: number): Promise<PrCheckout> {
  const pr = asRecord(
    await runGhJson(
      [
        'pr',
        'view',
        String(number),
        '--json',
        'url,state,headRefName,headRefOid,baseRefName,isCrossRepository',
      ],
      projectRoot,
    ),
  );
  const headSha = asString(pr?.['headRefOid']) ?? '';
  if (asString(pr?.['state']) !== 'OPEN') throw new Error(`PR #${number} is not open`);

  const url = asString(pr?.['url']) ?? '';
  const ref = parsePrRef(url);
  const remote = ref ? await remoteForRepo(projectRoot, ref) : 'origin';
  // GitHub exposes every PR head, including fork PRs, as refs/pull/N/head.
  await exec('git', ['fetch', '--no-tags', remote, `refs/pull/${number}/head`], {
    cwd: projectRoot,
    timeout: GIT_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw new Error(`Could not fetch PR #${number} from ${remote}: ${gitErrorLine(err)}`);
  });
  const { stdout } = await exec('git', ['rev-parse', 'FETCH_HEAD'], { cwd: projectRoot });
  // Guards against no remote being the PR's repo and against a concurrent
  // fetch overwriting FETCH_HEAD; both would check out the wrong commit.
  if (stdout.trim() !== headSha) {
    throw new Error(
      `Fetched commit does not match PR #${number}'s head. Make sure a git remote points to the PR's repository, or retry if the PR was just updated.`,
    );
  }

  return {
    headSha,
    headRefName: safeBranchName(asString(pr?.['headRefName'])),
    baseRefName: asString(pr?.['baseRefName']) ?? '',
    isCrossRepository: pr?.['isCrossRepository'] === true,
    url,
    remote,
  };
}

/** The PR's repository remote, preferring "origin"; "origin" when none matches. */
async function remoteForRepo(projectRoot: string, ref: PrRef): Promise<string> {
  // On failure, origin keeps the old behavior and the fetch reports the real error.
  const { stdout } = await exec('git', ['remote', '-v'], { cwd: projectRoot }).catch(
    (err: unknown) => {
      logWarn('github', 'git remote -v failed', { err: errMessage(err) });
      return { stdout: '' };
    },
  );
  const matches = pickRepoRemotes(stdout, ref);
  return matches.includes('origin') ? 'origin' : (matches[0] ?? 'origin');
}

/** Names of remotes in `git remote -v` output whose URL is the host and repo of `ref`. */
export function pickRepoRemotes(
  remoteV: string,
  ref: Pick<PrRef, 'host' | 'owner' | 'repo'>,
): string[] {
  const want = `${ref.owner}/${ref.repo}`.toLowerCase();
  const webUrl = new URL(`https://${ref.host}`);
  const names = new Set<string>();
  for (const line of remoteV.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (!url) continue;
    let remoteUrl: URL;
    try {
      // Convert scp-style git@host:owner/repo into an SSH URL.
      remoteUrl = new URL(url.includes('://') ? url : url.replace(/^([^/]+):/, 'ssh://$1/'));
    } catch {
      continue;
    }
    // SSH ports belong to the Git transport, not the enterprise web server.
    const sameHost = ['http:', 'https:'].includes(remoteUrl.protocol)
      ? remoteUrl.host === webUrl.host
      : remoteUrl.hostname.toLowerCase() === webUrl.hostname;
    const repo = remoteUrl.pathname
      .replace(/^\//, '')
      .replace(/(?:\.git)?\/?$/, '')
      .toLowerCase();
    // A leading dash would turn the remote name into a `git fetch` option.
    if (name && !name.startsWith('-') && sameHost && repo === want) names.add(name);
  }
  return [...names];
}

export async function localBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectRoot,
    });
    return true;
  } catch {
    return false;
  }
}

function safeBranchName(name: string | undefined): string | null {
  try {
    return validateBranchName(name, 'PR head branch');
  } catch {
    return null;
  }
}

function gitErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const line = typeof stderr === 'string' ? stderr.trim().split('\n').pop() : undefined;
  return line || (err instanceof Error ? err.message : String(err));
}
