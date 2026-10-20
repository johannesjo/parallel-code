/** Shared vocabulary keeps repository-wide filters and row badges consistent. */
export const TRIAGE_KINDS = {
  all: 'All',
  issue: 'Issues',
  bug: 'Bugs',
  feature: 'Features',
  discussion: 'Discussions',
  pr: 'PRs',
} as const;
export const TRIAGE_SORTS = {
  'updated-desc': 'Recently updated',
  'updated-asc': 'Least recently updated',
  'created-desc': 'Newest first',
  'created-asc': 'Oldest first',
  'comments-desc': 'Most commented',
  'comments-asc': 'Least commented',
  'reactions-desc': 'Most reactions',
  'best-match': 'Best match',
} as const;
export type TriageKind = keyof typeof TRIAGE_KINDS;
export type TriageSort = keyof typeof TRIAGE_SORTS;
export type IssueCategory = 'bug' | 'feature' | 'discussion';

/** Recognize common label conventions (including emoji and type:/kind: prefixes). */
export function issueCategory(name: string): IssueCategory | null {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .replace(/^(?:type|kind|category)\s+/, '');
  if (/^(?:bug|bugs|bug report|defect|regression)$/.test(normalized)) return 'bug';
  if (/^(?:feature|feature request|enhancement|improvement)$/.test(normalized)) return 'feature';
  if (/^(?:discussion|question|rfc)$/.test(normalized)) return 'discussion';
  return null;
}

export function issueCategories(issue: {
  kind: 'issue' | 'pr';
  issueType?: string;
  labels: string[];
}): string[] {
  if (issue.kind === 'pr') return ['pr'];
  const categories = [
    ...new Set(
      [issue.issueType ?? '', ...issue.labels]
        .map(issueCategory)
        .filter((c): c is IssueCategory => c !== null),
    ),
  ];
  return categories.length ? categories : ['issue'];
}
