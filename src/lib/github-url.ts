/** Pure GitHub URL parsing utilities — no store or SolidJS dependencies. */

export interface ParsedGitHubUrl {
  org: string;
  repo: string;
  type?: string;
  number?: string;
}

/** GitHub path types that carry a meaningful issue/PR/discussion number. */
const NUMBERED_TYPES = new Set(['issues', 'pull', 'discussions']);

const TYPE_LABELS: Record<string, string> = {
  issues: 'issue',
  pull: 'pr',
  discussions: 'discussion',
  'actions/runs': 'run',
};

/** Extract org, repo, type, number from a GitHub URL. Returns null if not valid. */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    return null;
  // Enterprise hosts can have any name. Recognize their PR path, while keeping
  // ordinary website URLs out of GitHub task naming.
  if (
    parsed.hostname !== 'github.com' &&
    parsed.hostname !== 'www.github.com' &&
    (parsed.protocol !== 'https:' ||
      !/^\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:\/|$)/.test(parsed.pathname))
  )
    return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const result: ParsedGitHubUrl = { org: segments[0], repo: segments[1] };
  if (segments[2] === 'actions' && segments.length >= 5 && segments[3] === 'runs') {
    result.type = 'actions/runs';
    result.number = segments[4];
  } else if (segments.length >= 4 && NUMBERED_TYPES.has(segments[2])) {
    result.type = segments[2];
    result.number = segments[3];
  }
  return result;
}

/** Derive a short task name from a parsed GitHub URL. */
export function taskNameFromGitHubUrl(parsed: ParsedGitHubUrl): string {
  if (parsed.number) {
    const label = TYPE_LABELS[parsed.type ?? ''] ?? parsed.type ?? 'issue';
    return `${label} ${parsed.number}`;
  }
  return parsed.repo;
}

/** Returns true if the string looks like a GitHub URL. */
export function isGitHubUrl(text: string): boolean {
  return parseGitHubUrl(text) !== null;
}

/** Find the first GitHub URL embedded in a string (e.g. a prompt). */
export function extractGitHubUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s)>\]"']+/gi) ?? [];
  return matches.find((url) => parseGitHubUrl(url) !== null) ?? null;
}

/** Issue numbers are only unique within a repository; ignore URL decoration when linking. */
export function sameGitHubIssue(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = parseGitHubUrl(left);
  const b = parseGitHubUrl(right);
  return (
    !!a &&
    !!b &&
    (a.type === 'issues' || a.type === 'pull') &&
    a.type === b.type &&
    !!a.number &&
    /^\d+$/.test(a.number) &&
    a.number === b.number &&
    a.org.toLowerCase() === b.org.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}
