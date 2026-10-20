import type { GitHubIssuePage, GitHubIssueQuery, GitHubIssueSummary } from '../ipc/types';

/** Browser state that survives switching between the issue page and task workspace. */
export interface BrowserSession {
  query: GitHubIssueQuery;
  result?: GitHubIssuePage;
  selectedUrl: string | null;
  scrollTop: number;
  selected: GitHubIssueSummary[];
}
