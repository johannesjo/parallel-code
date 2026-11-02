import { isConfidenceOutdated, type TaskConfidence } from './task-confidence';
import type { TaskBriefRecord } from './task-brief';

export type FinishReportKind = 'review' | 'tour' | 'screens';

/** A report Finish can show, and whether the code moved on since it was made. */
export interface FinishReport {
  kind: FinishReportKind;
  label: string;
  outdated: boolean;
}

/** When a change tour was generated, and the diff it explains. */
export interface TourBasis {
  generatedAt: number;
  fingerprint: string;
}

export interface FinishReportsInput {
  confidence?: TaskConfidence;
  codeFingerprint?: { fingerprint: string; at: number };
  brief?: TaskBriefRecord;
  /** The latest finished capture, and how many screens it took. */
  screens?: CapturedScreens & { count: number };
  /** The ready change tour of the whole task, and how many stops it has. */
  tour?: TourBasis & { stops: number };
  /** The task's current commit; unknown counts as unchanged, as for verify runs. */
  headSha?: string | null;
}

/** When a capture ran, and on what code: the commit, and the diff it saw then. */
export interface CapturedScreens {
  headSha: string;
  capturedAt: number;
  fingerprint?: string;
}

/**
 * Whether the code moved on since the capture: a new commit, or a newer read of
 * the diff that differs (uncommitted edits). Unknown counts as unchanged.
 */
export function areScreensOutdated(
  screens: CapturedScreens,
  code: Pick<FinishReportsInput, 'codeFingerprint' | 'brief' | 'headSha'>,
): boolean {
  if (code.headSha && screens.headSha !== code.headSha) return true;
  const capture = { publishedAt: screens.capturedAt, fingerprint: screens.fingerprint };
  return isConfidenceOutdated(capture, code.codeFingerprint, code.brief);
}

function reviewLabel(confidence: TaskConfidence): string {
  const scores = confidence.scores.map((entry) => entry.score);
  return scores.length ? `Review (lowest score ${Math.min(...scores)}%)` : 'Review';
}

/** Whether the task's diff changed since the tour was generated. Unknown counts as unchanged. */
export function isTourOutdated(
  tour: TourBasis,
  code: Pick<FinishReportsInput, 'codeFingerprint' | 'brief'>,
): boolean {
  const generated = { publishedAt: tour.generatedAt, fingerprint: tour.fingerprint };
  return isConfidenceOutdated(generated, code.codeFingerprint, code.brief);
}

/** The reports Finish can show for the task, in Finish's order. */
export function finishReports(input: FinishReportsInput): FinishReport[] {
  const reports: FinishReport[] = [];
  const { confidence, tour, screens } = input;
  if (confidence) {
    reports.push({
      kind: 'review',
      label: reviewLabel(confidence),
      outdated: isConfidenceOutdated(confidence, input.codeFingerprint, input.brief),
    });
  }
  if (tour && tour.stops > 0) {
    const noun = tour.stops === 1 ? 'stop' : 'stops';
    reports.push({
      kind: 'tour',
      label: `Tour (${tour.stops} ${noun})`,
      outdated: isTourOutdated(tour, input),
    });
  }
  if (screens && screens.count > 0) {
    const noun = screens.count === 1 ? 'screen' : 'screens';
    reports.push({
      kind: 'screens',
      label: `Before & after (${screens.count} ${noun})`,
      outdated: areScreensOutdated(screens, input),
    });
  }
  return reports;
}

/** The Finish button's tooltip: the current reports, the outdated ones, and those being generated. */
export function finishReportsTitle(
  base: string,
  reports: FinishReport[],
  generating: string[] = [],
): string {
  const lines = [base];
  const current = reports.filter((r) => !r.outdated);
  const outdated = reports.filter((r) => r.outdated);
  if (current.length) {
    lines.push('Current for the latest commit:', ...current.map((r) => `· ${r.label}`));
  }
  if (outdated.length) {
    lines.push('Out of date, the code changed since:', ...outdated.map((r) => `· ${r.label}`));
  }
  if (generating.length) lines.push(`Generating: ${generating.join(', ')}`);
  return lines.join('\n');
}
