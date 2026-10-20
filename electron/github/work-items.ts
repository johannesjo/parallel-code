/** Open issues and pull requests that a task can start from. */
import type { GitHubIssueDetails, GitHubWorkItem } from '../ipc/shared-types.js';
import { asArray, asRecord, asString, authorLogin, runGhJson } from './gh.js';

const LIST_LIMIT = 30;
/** Issue bodies become prompt text; keep pasted prompts a sane size. */
const MAX_ISSUE_BODY = 8_000;

/** Lists open issues and PRs of the project's GitHub repo, newest activity first. */
export async function listGitHubWorkItems(
  projectRoot: string,
  search?: string,
): Promise<GitHubWorkItem[]> {
  const common = ['--state', 'open', '--limit', String(LIST_LIMIT)];
  const query = search ? scopeToRepo(search) : '';
  if (query) common.push('--search', query);
  const [issues, prs] = await Promise.all([
    runGhJson(
      ['issue', 'list', ...common, '--json', 'number,title,url,updatedAt,author,labels'],
      projectRoot,
    ),
    runGhJson(
      [
        'pr',
        'list',
        ...common,
        '--json',
        'number,title,url,updatedAt,author,labels,isDraft,baseRefName,isCrossRepository',
      ],
      projectRoot,
    ),
  ]);
  return [...parseWorkItems(issues, 'issue'), ...parseWorkItems(prs, 'pr')].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Drops qualifiers that would list another repo's items: a picked PR is
 *  checked out by number from the project's own repo. */
export function scopeToRepo(search: string): string {
  return search
    .replace(/(?:^|\s)-?(?:repo|org|user|owner):\S*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseWorkItems(raw: unknown, kind: GitHubWorkItem['kind']): GitHubWorkItem[] {
  const items: GitHubWorkItem[] = [];
  for (const entry of asArray(raw)) {
    const r = asRecord(entry);
    const number = r?.['number'];
    const title = asString(r?.['title']);
    const url = asString(r?.['url']);
    if (!r || typeof number !== 'number' || !title || !url) continue;
    items.push({
      kind,
      number,
      title,
      url,
      author: authorLogin(r['author']),
      updatedAt: asString(r['updatedAt']) ?? '',
      labels: asArray(r['labels'])
        .map((l) => asString(asRecord(l)?.['name']))
        .filter((l): l is string => !!l),
      ...(kind === 'pr'
        ? {
            isDraft: r['isDraft'] === true,
            baseRefName: asString(r['baseRefName']) ?? '',
            isCrossRepository: r['isCrossRepository'] === true,
          }
        : {}),
    });
  }
  return items;
}

export async function getGitHubIssue(
  projectRoot: string,
  number: number,
): Promise<GitHubIssueDetails> {
  const raw = asRecord(
    await runGhJson(
      ['issue', 'view', String(number), '--json', 'number,title,body,url'],
      projectRoot,
    ),
  );
  const body = asString(raw?.['body']) ?? '';
  return {
    number,
    title: asString(raw?.['title']) ?? `Issue #${number}`,
    url: asString(raw?.['url']) ?? '',
    body: body.length > MAX_ISSUE_BODY ? `${body.slice(0, MAX_ISSUE_BODY)}\n…(truncated)` : body,
  };
}
