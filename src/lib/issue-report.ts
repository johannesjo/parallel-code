const REPO_URL = 'https://github.com/johannesjo/parallel-code';

export type IssueKind = 'bug' | 'feature';

export interface IssueDiagnostics {
  version: string;
  runtime: string;
  agents: string[];
}

// File names in .github/ISSUE_TEMPLATE; the query keys below match field ids there.
const TEMPLATES: Record<IssueKind, string> = {
  bug: 'bug_report.yml',
  feature: 'feature_request.yml',
};

const PLATFORMS: [RegExp, string][] = [
  [/Mac OS X/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

/** Platform and Electron version from the user agent. It carries no paths or
 *  user names, so it is safe for a public issue. The OS version is left out:
 *  Chromium freezes it in the user agent (macOS always reads 10_15_7, and
 *  Windows 10 and 11 look the same), so the form asks the user for it. */
export function describeRuntime(userAgent: string): string {
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const electron = /Electron\/([\d.]+)/.exec(userAgent)?.[1];
  if (!platform || !electron) return '';
  return `${platform} · Electron ${electron}`;
}

/** A GitHub "new issue" URL with the form pre-filled. Only bug reports get
 *  diagnostics; the user still sees and can edit everything before submitting. */
export function buildIssueUrl(kind: IssueKind, diagnostics: IssueDiagnostics): string {
  const params = new URLSearchParams({ template: TEMPLATES[kind] });
  if (kind === 'bug') {
    const fields: [string, string][] = [
      ['version', diagnostics.version],
      ['os', diagnostics.runtime],
      ['agents', diagnostics.agents.join(', ')],
    ];
    for (const [key, value] of fields) if (value) params.set(key, value);
  }
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
