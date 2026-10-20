/** GitHub issue browsing and explicit triage writes through the user's gh login. */
import type {
  GitHubIssueActivityPage,
  GitHubIssueChange,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubIssueSummary,
} from '../ipc/shared-types.js';
import { issueCategory } from '../shared/github-triage.js';
import { asArray, asRecord, asString, authorLogin, runGhJson } from './gh.js';

const PAGE_SIZE = 25;
const SEARCH_LIMIT = 1_000;

/** Strict canonical identity, also used to keep API paths and write targets bounded. */
export function issueApiPath(url: string, allowPr = false): string {
  const parsed = new URL(url);
  const match = /^\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/([1-9]\d*)\/?$/.exec(parsed.pathname);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !match ||
    (!allowPr && match[3] !== 'issues')
  )
    throw new Error('Expected a canonical github.com issue URL');
  return `repos/${match[1]}/${match[2]}/issues/${match[4]}`;
}

function names(value: unknown, key: string): string[] {
  return asArray(value).flatMap((v) => {
    const name = asString(asRecord(v)?.[key]);
    return name ? [name] : [];
  });
}

function parseIssue(value: unknown): GitHubIssueSummary {
  const r = asRecord(value);
  const url = asString(r?.html_url) ?? '';
  issueApiPath(url, true);
  if (!Number.isSafeInteger(r?.number)) throw new Error('Invalid GitHub issue');
  return {
    kind: r?.pull_request ? 'pr' : 'issue',
    issueType: asString(asRecord(r?.type)?.name),
    isDraft: r?.draft === true,
    commentCount: typeof r?.comments === 'number' ? r.comments : 0,
    reactionCount:
      typeof asRecord(r?.reactions)?.total_count === 'number'
        ? (asRecord(r?.reactions)?.total_count as number)
        : 0,
    createdAt: asString(r?.created_at) ?? '',
    number: r?.number as number,
    title: asString(r?.title) ?? '',
    body: asString(r?.body) ?? '',
    url,
    state: asRecord(r?.pull_request)?.merged_at
      ? 'merged'
      : r?.state === 'closed'
        ? 'closed'
        : 'open',
    author: authorLogin(r?.user),
    updatedAt: asString(r?.updated_at) ?? '',
    labels: names(r?.labels, 'name'),
    assignees: names(r?.assignees, 'login'),
  };
}

/** The project's github.com repository as `gh` resolves it, e.g. `owner/name`. */
export async function resolveGitHubRepository(projectRoot: string): Promise<string> {
  const repo = asRecord(
    await runGhJson(['repo', 'view', '--json', 'nameWithOwner,url'], projectRoot),
  );
  const repository = asString(repo?.nameWithOwner) ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repo?.url !== `https://github.com/${repository}`) {
    throw new Error(
      'The issue browser supports github.com repositories. Check gh repo set-default.',
    );
  }
  return repository;
}

export async function browseGitHubIssues(
  projectRoot: string,
  query: GitHubIssueQuery,
): Promise<GitHubIssuePage> {
  const repository = await resolveGitHubRepository(projectRoot);
  const labelPages = await runGhJson(
    [
      'api',
      '--hostname',
      'github.com',
      `repos/${repository}/labels?per_page=100`,
      '--paginate',
      '--slurp',
    ],
    projectRoot,
  );
  const labels = asArray(labelPages).flatMap((page) => names(page, 'name'));
  const categoryLabels = labels.filter((label) => issueCategory(label) === query.kind);
  const typeFilter =
    query.kind === 'bug'
      ? 'type:Bug'
      : query.kind === 'feature'
        ? 'type:Feature'
        : query.kind === 'discussion'
          ? 'type:Discussion'
          : '';
  const categoryFilter = typeFilter
    ? `(${[typeFilter, ...(categoryLabels.length ? [`label:${categoryLabels.map((l) => JSON.stringify(l)).join(',')}`] : [])].join(' OR ')})`
    : '';
  // Quote user text so OR/repo qualifiers cannot change the repository scope.
  // GitHub has no escape for `"`, and a stray one makes the query match nothing.
  const words = query.search.replace(/"/g, ' ').trim().split(/\s+/).filter(Boolean);
  const q = [
    `repo:${repository}`,
    query.kind === 'all' ? '' : query.kind === 'pr' ? 'is:pr' : 'is:issue',
    categoryFilter,
    query.state !== 'all' ? `is:${query.state}` : '',
    words.map((word) => JSON.stringify(word)).join(' '),
    query.label === '@none'
      ? 'no:label'
      : query.label
        ? `label:${JSON.stringify(query.label)}`
        : '',
    query.assignee === '@none'
      ? 'no:assignee'
      : query.assignee
        ? `assignee:${JSON.stringify(query.assignee)}`
        : '',
    query.author ? `author:${JSON.stringify(query.author)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const result = asRecord(
    await runGhJson(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        'search/issues',
        '-f',
        `q=${q}`,
        '-f',
        'advanced_search=true',
        ...(query.sort === 'best-match'
          ? []
          : [
              '-f',
              `sort=${query.sort.split('-')[0]}`,
              '-f',
              `order=${query.sort.endsWith('-asc') ? 'asc' : 'desc'}`,
            ]),
        '-F',
        `per_page=${PAGE_SIZE}`,
        '-F',
        `page=${query.page}`,
      ],
      projectRoot,
    ),
  );
  const total = typeof result?.total_count === 'number' ? result.total_count : 0;
  const items = asArray(result?.items)
    .map(parseIssue)
    .filter((issue) =>
      issueApiPath(issue.url, true)
        .toLowerCase()
        .startsWith(`repos/${repository.toLowerCase()}/issues/`),
    );
  return {
    repository,
    labels,
    items,
    total,
    hasMore: query.page * PAGE_SIZE < Math.min(total, SEARCH_LIMIT),
    limited: total > SEARCH_LIMIT || result?.incomplete_results === true,
  };
}

export async function readGitHubIssue(url: string): Promise<GitHubIssueSummary> {
  const issue = parseIssue(
    await runGhJson(['api', '--hostname', 'github.com', issueApiPath(url, true)]),
  );
  if (issue.kind === 'pr') {
    const pr = asRecord(
      await runGhJson(['pr', 'view', url, '--json', 'baseRefName,isCrossRepository,isDraft,state']),
    );
    issue.baseRefName = asString(pr?.baseRefName);
    issue.isCrossRepository = pr?.isCrossRepository === true;
    issue.isDraft = pr?.isDraft === true;
    if (pr?.state === 'MERGED') issue.state = 'merged';
  }
  return issue;
}

export async function readGitHubIssueActivity(
  url: string,
  page: number,
): Promise<GitHubIssueActivityPage> {
  const rows = asArray(
    await runGhJson([
      'api',
      '--hostname',
      'github.com',
      `${issueApiPath(url, true)}/timeline?per_page=${PAGE_SIZE}&page=${page}`,
    ]),
  );
  return {
    items: rows.map((value, index) => {
      const r = asRecord(value);
      const event = asString(r?.event) ?? 'activity';
      const label = asString(asRecord(r?.label)?.name);
      const assignee = asString(asRecord(r?.assignee)?.login);
      const source = asRecord(asRecord(r?.source)?.issue);
      const detail = label ?? assignee ?? asString(source?.title) ?? '';
      return {
        id: String(r?.id ?? `${page}-${index}`),
        author: authorLogin(r?.actor ?? r?.user),
        createdAt: asString(r?.created_at) ?? asString(r?.submitted_at) ?? '',
        event: event.replace(/[_-]/g, ' ') + (detail ? ` · ${detail}` : ''),
        // PR reviews carry their summary in `body` and date it `submitted_at`.
        body: event === 'commented' || event === 'reviewed' ? (asString(r?.body) ?? '') : '',
      };
    }),
    hasMore: rows.length === PAGE_SIZE,
  };
}

export async function updateGitHubIssue(
  url: string,
  change: GitHubIssueChange,
): Promise<GitHubIssueSummary> {
  const path = issueApiPath(url, change.field !== 'state');
  const patch =
    change.field === 'state'
      ? { state: change.value, state_reason: change.value === 'open' ? null : change.reason }
      : { [change.field]: change.values };
  return parseIssue(
    await runGhJson(
      ['api', '--hostname', 'github.com', '--method', 'PATCH', path, '--input', '-'],
      undefined,
      JSON.stringify(patch),
    ),
  );
}
