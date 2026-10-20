/** Pull request actions: inspect, collect feedback for the agent, merge. */
import type {
  PrFailedCheck,
  PrMergeMethod,
  PrReviewFeedback,
  PrReviewThread,
  PullRequestDetails,
} from '../ipc/shared-types.js';
import { errMessage, warn as logWarn } from '../log.js';
import {
  asArray,
  asRecord,
  asString,
  authorLogin,
  parseMergeable,
  parsePrRef,
  runGh,
  runGhJson,
  type PrRef,
} from './gh.js';
import { cleanJobLog } from './job-log.js';

const MAX_LOG_JOBS = 3;

export async function getPullRequestDetails(prUrl: string): Promise<PullRequestDetails> {
  const ref = requirePrRef(prUrl);
  const [prRaw, repoRaw] = await Promise.all([
    runGhJson([
      'pr',
      'view',
      prUrl,
      '--json',
      'number,title,url,state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid',
    ]),
    runGhJson([
      'repo',
      'view',
      `${ref.host}/${ref.owner}/${ref.repo}`,
      '--json',
      'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod',
    ]),
  ]);
  const pr = asRecord(prRaw);
  const state = asString(pr?.['state']);
  return {
    number: ref.number,
    title: asString(pr?.['title']) ?? '',
    url: asString(pr?.['url']) ?? prUrl,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    isDraft: pr?.['isDraft'] === true,
    mergeable: parseMergeable(pr?.['mergeable']),
    mergeStateStatus: asString(pr?.['mergeStateStatus']) ?? 'UNKNOWN',
    baseRefName: asString(pr?.['baseRefName']) ?? '',
    headRefName: asString(pr?.['headRefName']) ?? '',
    headRefOid: asString(pr?.['headRefOid']) ?? '',
    mergeMethods: parseMergeMethods(repoRaw),
  };
}

export function parseMergeMethods(raw: unknown): PrMergeMethod[] {
  const r = asRecord(raw);
  const methods: PrMergeMethod[] = [];
  if (r?.['squashMergeAllowed'] === true) methods.push('squash');
  if (r?.['mergeCommitAllowed'] === true) methods.push('merge');
  if (r?.['rebaseMergeAllowed'] === true) methods.push('rebase');
  const preferred = asString(r?.['viewerDefaultMergeMethod'])?.toLowerCase();
  const idx = methods.findIndex((m) => m === preferred);
  if (idx > 0) methods.unshift(...methods.splice(idx, 1));
  return methods;
}

export interface MergePullRequestOptions {
  method: PrMergeMethod;
  headSha: string;
  /** Bypass branch protection (`gh pr merge --admin`); GitHub decides who may. */
  admin?: boolean;
}

/**
 * Merges only if the PR head is still `headSha`, the commit the user saw.
 * Resolves true once GitHub reports the PR merged; false when gh accepted the
 * request but the PR is still open (e.g. queued in a merge queue).
 */
export async function mergePullRequest(
  prUrl: string,
  { method, headSha, admin = false }: MergePullRequestOptions,
): Promise<boolean> {
  requirePrRef(prUrl);
  // No --delete-branch: gh would try to delete the local branch, which fails
  // while the task worktree has it checked out. Closing the task cleans up.
  const args = ['pr', 'merge', prUrl, `--${method}`, '--match-head-commit', headSha];
  await runGh(admin ? [...args, '--admin'] : args);
  try {
    const raw = asRecord(await runGhJson(['pr', 'view', prUrl, '--json', 'state']));
    return asString(raw?.['state']) === 'MERGED';
  } catch (err) {
    // The merge request itself succeeded; only the confirmation is missing.
    logWarn('github', 'PR state check after merge failed', { err: errMessage(err) });
    return false;
  }
}

/** Takes a draft PR out of draft (`gh pr ready`); GitHub refuses drafts a merge. */
export async function markPullRequestReady(prUrl: string): Promise<void> {
  requirePrRef(prUrl);
  await runGh(['pr', 'ready', prUrl]);
}

/** Failed checks of the PR head, with job log tails for GitHub Actions jobs. */
export async function getFailedChecks(prUrl: string): Promise<PrFailedCheck[]> {
  const ref = requirePrRef(prUrl);
  const raw = asRecord(await runGhJson(['pr', 'view', prUrl, '--json', 'statusCheckRollup']));
  const failed = parseFailedChecks(raw?.['statusCheckRollup']);
  // Map runs synchronously, so the budget goes to the first jobs in order.
  let budget = MAX_LOG_JOBS;
  return Promise.all(
    failed.map((check) => {
      const jobId = check.url ? actionsJobId(check.url, ref) : null;
      return jobId && budget-- > 0 ? withLogTail(check, ref, jobId) : check;
    }),
  );
}

async function withLogTail(
  check: PrFailedCheck,
  ref: PrRef,
  jobId: string,
): Promise<PrFailedCheck> {
  const args = [
    'api',
    `repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`,
    '--hostname',
    ref.host,
  ];
  try {
    const log = await runGh(args).catch((err: unknown) => {
      // Newer gh refuses colored output unless asked; older gh lacks the flag,
      // so it is only added when gh asks for it. cleanJobLog strips the colors.
      if (errMessage(err).includes('--allow-escape-sequences')) {
        return runGh([...args, '--allow-escape-sequences']);
      }
      throw err;
    });
    return { ...check, logTail: cleanJobLog(log) };
  } catch (err) {
    // An expired log still leaves the check name and link, useful on their own.
    logWarn('github', 'job log fetch failed', { err: errMessage(err) });
    return check;
  }
}

export function parseFailedChecks(rollup: unknown): PrFailedCheck[] {
  const failed: PrFailedCheck[] = [];
  for (const item of asArray(rollup)) {
    const c = asRecord(item);
    if (!c) continue;
    const conclusion = asString(c['conclusion'])?.toUpperCase();
    const legacyState = asString(c['state'])?.toUpperCase();
    const isFailure =
      conclusion !== undefined && conclusion !== ''
        ? !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion)
        : legacyState === 'FAILURE' || legacyState === 'ERROR';
    if (!isFailure) continue;
    failed.push({
      name: asString(c['name']) ?? asString(c['context']) ?? 'check',
      url: asString(c['detailsUrl']) ?? asString(c['targetUrl']) ?? null,
      logTail: null,
    });
  }
  return failed;
}

/** Job id from an Actions details URL of the PR's own repository. */
export function actionsJobId(
  url: string,
  ref: Pick<PrRef, 'host' | 'owner' | 'repo'>,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.host !== ref.host ||
    parsed.username ||
    parsed.password
  )
    return null;
  const match = /^\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/\d+\/job\/(\d+)(?:\/|$)/.exec(
    parsed.pathname,
  );
  if (!match) return null;
  const sameRepo =
    match[1].toLowerCase() === ref.owner.toLowerCase() &&
    match[2].toLowerCase() === ref.repo.toLowerCase();
  return sameRepo ? match[3] : null;
}

const ACTIONABLE_REVIEW_STATES = new Set(['CHANGES_REQUESTED', 'COMMENTED']);

const REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 30) { nodes { state body author { login } } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 30) { nodes { body author { login } } }
        }
      }
    }
  }
}`;

/** Unresolved review threads and review summaries of a PR. */
export async function getReviewFeedback(prUrl: string): Promise<PrReviewFeedback> {
  const ref = requirePrRef(prUrl);
  const raw = await runGhJson([
    'api',
    'graphql',
    '--hostname',
    ref.host,
    '-f',
    `query=${REVIEW_QUERY}`,
    '-f',
    `owner=${ref.owner}`,
    '-f',
    `repo=${ref.repo}`,
    '-F',
    `number=${ref.number}`,
  ]);
  return parseReviewFeedback(raw);
}

export function parseReviewFeedback(raw: unknown): PrReviewFeedback {
  const pr = asRecord(asRecord(asRecord(asRecord(raw)?.['data'])?.['repository'])?.['pullRequest']);
  const reviewNodes = asArray(asRecord(pr?.['reviews'])?.['nodes']).map((n) => asRecord(n));
  // Reviews come oldest first; a later approval settles that reviewer's earlier asks.
  const lastApproval = new Map<string, number>();
  reviewNodes.forEach((r, i) => {
    if (asString(r?.['state']) === 'APPROVED') lastApproval.set(authorLogin(r?.['author']), i);
  });
  const reviews: PrReviewFeedback['reviews'] = [];
  reviewNodes.forEach((r, i) => {
    const body = asString(r?.['body'])?.trim();
    const author = authorLogin(r?.['author']);
    // Approvals and dismissed reviews ask for nothing.
    if (!r || !body || !ACTIONABLE_REVIEW_STATES.has(asString(r['state']) ?? '')) return;
    if (i < (lastApproval.get(author) ?? -1)) return;
    reviews.push({ author, state: asString(r['state']) ?? '', body });
  });
  const threads: PrReviewThread[] = [];
  for (const node of asArray(asRecord(pr?.['reviewThreads'])?.['nodes'])) {
    const t = asRecord(node);
    if (!t || t['isResolved'] === true) continue;
    const comments = asArray(asRecord(t['comments'])?.['nodes'])
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => !!c && !!asString(c['body'])?.trim())
      .map((c) => ({ author: authorLogin(c['author']), body: asString(c['body'])?.trim() ?? '' }));
    if (comments.length === 0) continue;
    threads.push({
      path: asString(t['path']) ?? '',
      line: typeof t['line'] === 'number' ? t['line'] : null,
      isOutdated: t['isOutdated'] === true,
      comments,
    });
  }
  const pageInfo = asRecord(asRecord(pr?.['reviewThreads'])?.['pageInfo']);
  return { reviews, threads, truncated: pageInfo?.['hasNextPage'] === true };
}

function requirePrRef(prUrl: string): PrRef {
  const ref = parsePrRef(prUrl);
  if (!ref) throw new Error('Not a GitHub pull request URL');
  return ref;
}
