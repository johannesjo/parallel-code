/** An agent-made ordering of one repository's issues and PRs, as published to the GitHub page. */
export interface GitHubCustomList {
  name: string;
  groups: { name: string; items: { url: string; title: string; reason: string }[] }[];
}

const GITHUB_AGENT_TASK_PREFIX = 'gh-agent-';

/** The GitHub page's hidden agent for a code project; the only task that may publish lists. */
export function githubAgentTaskId(projectId: string): string {
  return `${GITHUB_AGENT_TASK_PREFIX}${projectId}`;
}

export function isGitHubAgentTaskId(id: string | null): boolean {
  return id?.startsWith(GITHUB_AGENT_TASK_PREFIX) === true;
}

export const GITHUB_LIST_LIMITS = {
  groups: 25,
  items: 100,
  name: 200,
  title: 500,
  reason: 2_000,
} as const;

const ITEM_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid list format.');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${field} must be non-empty text of at most ${max} characters.`);
  return value.trim();
}

/**
 * Validates agent output before it is rendered or its URLs reach the GitHub API.
 * Every item must belong to one repository, which is returned in lower case.
 */
export function parseGitHubList(value: unknown): { repository: string; list: GitHubCustomList } {
  const root = record(value);
  const caps = GITHUB_LIST_LIMITS;
  if (!Array.isArray(root.groups) || !root.groups.length || root.groups.length > caps.groups)
    throw new Error(`A list needs between 1 and ${caps.groups} groups.`);
  const seen = new Set<string>();
  let repository = '';
  const groups = root.groups.map((rawGroup) => {
    const group = record(rawGroup);
    if (!Array.isArray(group.items) || !group.items.length)
      throw new Error('Groups cannot be empty; drop groups that have no items.');
    const items = group.items.map((rawItem) => {
      const item = record(rawItem);
      const url = text(item.url, 'url', 500);
      const match = ITEM_URL.exec(url);
      // Dot-only segments would turn into path traversal when the URL reaches the GitHub API.
      if (!match || match[1].split('/').some((part) => /^\.+$/.test(part)))
        throw new Error(
          `Not a GitHub issue or PR URL: ${url}. Use exactly https://github.com/OWNER/REPO/issues/N or /pull/N, without query, fragment or trailing slash.`,
        );
      const repo = match[1].toLowerCase();
      if (repository && repo !== repository)
        throw new Error(`All items must come from one repository (${repository}); got ${repo}.`);
      repository = repo;
      // Issues and PRs share numbers, so /issues/2 and /pull/2 are the same item.
      if (seen.has(match[3]))
        throw new Error(`Item #${match[3]} appears more than once; an item can appear only once.`);
      seen.add(match[3]);
      if (seen.size > caps.items) throw new Error(`Lists support up to ${caps.items} items.`);
      return {
        url,
        title: text(item.title, 'title', caps.title),
        reason: text(item.reason, 'reason', caps.reason),
      };
    });
    return { name: text(group.name, 'Group name', caps.name), items };
  });
  return { repository, list: { name: text(root.name, 'name', caps.name), groups } };
}
