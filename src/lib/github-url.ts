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
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null;

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
  const match = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)>\]"']+/i);
  if (!match) return null;
  return parseGitHubUrl(match[0]) ? match[0] : null;
}
