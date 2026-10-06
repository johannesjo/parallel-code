import type { EvidencePackage } from '../../electron/shared/evidence';
import type {
  EvidenceConfidence,
  EvidenceConfidenceLevel,
} from '../../electron/shared/evidence-confidence';
import { theme } from './theme';

/** Shared by the Finish dialog and the title bar badge so they agree. */
export const EVIDENCE_LEVEL: Record<EvidenceConfidenceLevel, { label: string; color: string }> = {
  checking: { label: 'Checking', color: theme.fgMuted },
  'not-checked': { label: 'Checks outdated', color: theme.warning },
  low: { label: 'Low confidence', color: theme.error },
  medium: { label: 'Medium confidence', color: theme.warning },
  high: { label: 'High confidence', color: theme.success },
};

/** The same fact at two lengths: the Finish dialog headline and the task status suffix. */
export interface EvidenceSummary {
  headline: string;
  short: string;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Facts first; freshness always takes precedence over historical results. */
export function evidenceSummary(
  confidence: EvidenceConfidence,
  pkg?: EvidencePackage,
): EvidenceSummary {
  if (confidence.level === 'checking') return { headline: 'Checking…', short: 'checking…' };
  if (confidence.level === 'not-checked') return { headline: 'Checks outdated', short: 'outdated' };
  if (!pkg)
    return confidence.level === 'high'
      ? { headline: 'Checks passed', short: 'passed' }
      : { headline: 'Needs attention', short: 'needs attention' };
  const failed = pkg.checks.filter((run) =>
    ['failed', 'timed_out', 'error'].includes(run.status),
  ).length;
  if (failed) return { headline: `${count(failed, 'check')} failed`, short: `${failed} failed` };
  const decisions = pkg.scan.flags.filter(
    (flag) => flag.category !== 'info' && !(flag.id in pkg.acceptedFlags),
  ).length;
  if (decisions)
    return { headline: `${count(decisions, 'decision')} needed`, short: `${decisions} to decide` };
  const notRun = pkg.skipped.length + pkg.checks.filter((run) => run.status === 'cancelled').length;
  if (notRun) return { headline: `${count(notRun, 'check')} not run`, short: `${notRun} not run` };
  if (confidence.level !== 'high') return { headline: 'Needs review', short: 'needs review' };
  return { headline: 'All configured checks passed', short: 'passed' };
}

export function evidenceHeadline(confidence: EvidenceConfidence, pkg?: EvidencePackage): string {
  return evidenceSummary(confidence, pkg).headline;
}

/** Counts every configured check, including checks still queued or never started. */
export function evidenceCheckOutcomes(pkg: EvidencePackage): string {
  const counts = { passed: 0, failed: 0, running: 0, waiting: 0, 'not run': 0 };
  const ids = new Set([
    ...(pkg.configuredChecks ?? []).map((check) => check.id),
    ...pkg.checks.map((check) => check.checkId),
    ...pkg.skipped.map((check) => check.checkId),
  ]);
  for (const id of ids) {
    const run = pkg.checks.find((check) => check.checkId === id);
    if (run?.status === 'passed') counts.passed++;
    else if (run?.status === 'running') counts.running++;
    else if (run && ['failed', 'timed_out', 'error'].includes(run.status)) counts.failed++;
    else if (!run && pkg.assembling && !pkg.skipped.some((check) => check.checkId === id))
      counts.waiting++;
    else counts['not run']++;
  }
  return (
    Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([label, value]) => `${value} ${label}`)
      .join(' · ') || 'No checks configured'
  );
}
