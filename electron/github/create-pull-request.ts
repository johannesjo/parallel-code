/** Opens a pull request for a pushed task branch (`gh pr create`). */
import { listOpenPrUrlsForBranch } from '../ipc/pr-checks.js';
import { errMessage, warn as logWarn } from '../log.js';
import { runGh } from './gh.js';

export interface CreatePullRequestOptions {
  worktreePath: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface CreatedPullRequest {
  url: string;
  /** The branch already had an open PR; nothing was created. */
  existed: boolean;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * Creates the PR, or returns the branch's open PR when gh refuses because one
 * exists: either way the task ends up linked to it. The body goes through
 * stdin, so it never meets argument parsing.
 */
export async function createPullRequest(
  options: CreatePullRequestOptions,
): Promise<CreatedPullRequest> {
  const { worktreePath, head, base, title, body, draft } = options;
  const args = ['pr', 'create', '--head', head, '--base', base, '--title', title];
  args.push('--body-file', '-');
  if (draft) args.push('--draft');
  try {
    const stdout = await runGh(args, worktreePath, body);
    const url = stdout.match(PR_URL)?.[0];
    if (!url) throw new Error('GitHub CLI did not report the new pull request.');
    return { url, existed: false };
  } catch (err) {
    const existing = await findOnlyOpenPr(worktreePath, head);
    if (existing) return { url: existing, existed: true };
    throw err;
  }
}

/** The branch's open PR when it has exactly one; with several, which one gh meant is unknown. */
async function findOnlyOpenPr(worktreePath: string, head: string): Promise<string | null> {
  try {
    const urls = await listOpenPrUrlsForBranch(worktreePath, head);
    return urls.length === 1 ? urls[0] : null;
  } catch (err) {
    // The create error is the one to report; this lookup only rescues "already exists".
    logWarn('github', 'Looking up the branch PR failed', { err: errMessage(err) });
    return null;
  }
}
