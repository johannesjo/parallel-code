import type { FileDiff } from './unified-diff-parser';

export type QualityFindingCategory = 'reliability' | 'maintainability';
export type QualityFindingSeverity = 'error' | 'warning' | 'note';
export type QualityFindingState = 'open' | 'dismissed' | 'resolved';
export type QualityFindingFreshness = 'pending' | 'current' | 'stale';

export interface QualityFindingLocation {
  filePath: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface QualityFinding {
  /** Stable provider-defined identifier or fingerprint. */
  id: string;
  source: string;
  ruleId: string;
  category: QualityFindingCategory;
  severity: QualityFindingSeverity;
  location: QualityFindingLocation;
  explanation: string;
  state: QualityFindingState;
  freshness: QualityFindingFreshness;
}

export interface QualityFindingLoadContext {
  /** Stable identity for the task/worktree being reviewed. */
  reviewIdentity: string;
  /** Immutable identity derived from the exact rendered diff. */
  diffIdentity: string;
  /** Parsed files for providers that need to scope or validate fixture data. */
  files: readonly FileDiff[];
}

export interface QualityFindingProvider {
  loadFindings(context: QualityFindingLoadContext): Promise<QualityFinding[]>;
}

function cloneFinding(finding: QualityFinding): QualityFinding {
  return {
    ...finding,
    location: { ...finding.location },
  };
}

/** In-memory provider for component tests and provider integration fixtures. */
export function createFixtureQualityFindingProvider(
  findings: QualityFinding[],
): QualityFindingProvider {
  return {
    async loadFindings(_context) {
      return findings.map(cloneFinding);
    },
  };
}

function findingMatchesDiff(finding: QualityFinding, files: FileDiff[]): boolean {
  const file = files.find((candidate) => candidate.path === finding.location.filePath);
  if (!file || file.status === 'D' || file.binary) return false;

  return file.hunks.some((hunk) =>
    hunk.lines.some((line) => line.newLine === finding.location.startLine),
  );
}

export function reconcileQualityFindingsForDiff(
  findings: QualityFinding[],
  files: FileDiff[],
  diffLoaded: boolean,
  findingsDiffIdentity?: string,
  currentDiffIdentity?: string,
): QualityFinding[] {
  const identityMatches =
    findingsDiffIdentity === undefined && currentDiffIdentity === undefined
      ? true
      : findingsDiffIdentity === currentDiffIdentity;
  if (diffLoaded && identityMatches) return reconcileQualityFindings(findings, files);

  let changed = false;
  const pending = findings.map((finding) => {
    if (finding.freshness === 'pending') return finding;
    changed = true;
    return { ...finding, freshness: 'pending' as const };
  });
  return changed ? pending : findings;
}

/** Mark provider locations stale when they no longer map to the current rendered diff. */
export function reconcileQualityFindings(
  findings: QualityFinding[],
  files: FileDiff[],
): QualityFinding[] {
  let changed = false;
  const reconciled = findings.map((finding) => {
    const freshness: QualityFindingFreshness = findingMatchesDiff(finding, files)
      ? 'current'
      : 'stale';
    if (finding.freshness === freshness) return finding;
    changed = true;
    return { ...finding, freshness };
  });
  return changed ? reconciled : findings;
}

export function dismissQualityFinding(findings: QualityFinding[], id: string): QualityFinding[] {
  return findings.map((finding) =>
    finding.id === id ? { ...finding, state: 'dismissed' } : finding,
  );
}

export function resolveQualityFindings(
  findings: QualityFinding[],
  submittedFindings: QualityFinding[],
): QualityFinding[] {
  const submittedIds = new Set(submittedFindings.map((finding) => finding.id));
  let changed = false;
  const resolved = findings.map((finding) => {
    if (!submittedIds.has(finding.id) || finding.state === 'resolved') return finding;
    changed = true;
    return { ...finding, state: 'resolved' as const };
  });
  return changed ? resolved : findings;
}

export function selectSubmittableFindings(
  findings: QualityFinding[],
  ids: Iterable<string>,
): QualityFinding[] {
  const requested = new Set(ids);
  return findings.filter(
    (finding) =>
      requested.has(finding.id) && finding.state === 'open' && finding.freshness === 'current',
  );
}

export function selectedFindingIdsAfterSubmission(
  selectedIds: ReadonlySet<string>,
  submittedFindings: QualityFinding[],
): ReadonlySet<string> {
  const submittedIds = new Set(submittedFindings.map((finding) => finding.id));
  const remaining = new Set([...selectedIds].filter((id) => !submittedIds.has(id)));
  return remaining.size === selectedIds.size ? selectedIds : remaining;
}

export function formatQualityFindingLocation(finding: QualityFinding): string {
  const location = finding.location;
  const startColumn = location.startColumn ? `:${location.startColumn}` : '';
  let end = '';
  if (location.endLine && location.endLine !== location.startLine) {
    end = `-${location.endLine}${location.endColumn ? `:${location.endColumn}` : ''}`;
  } else if (location.endColumn && location.endColumn !== location.startColumn) {
    end = `-${location.startLine}:${location.endColumn}`;
  }
  return `${location.filePath}:${location.startLine}${startColumn}${end}`;
}

export function compileQualityFindingPrompt(findings: QualityFinding[]): string {
  const lines = ['Structured code-quality findings to remediate:\n'];
  for (const finding of findings) {
    lines.push(
      `## [${finding.severity}] [${finding.category}] ${finding.source}/${finding.ruleId}`,
    );
    lines.push(`Location: ${formatQualityFindingLocation(finding)}`);
    lines.push(finding.explanation);
    lines.push('');
  }
  return lines.join('\n');
}
