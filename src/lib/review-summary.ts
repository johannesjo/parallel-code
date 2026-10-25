/**
 * The review a task gets before it is finished: what changed, what is still a
 * risk, what the agent decided or added on its own, how the tests moved and
 * how confident an independent check is. Built from data the app already
 * keeps (the brief, the confidence rating and the evidence scan), so nothing
 * here reads code or calls a model. Pure helpers only.
 */

import type {
  EvidencePackage,
  EvidenceTestChange,
  EvidenceTestKind,
} from '../../electron/shared/evidence';
import { countLabel } from './plural';
import type { BriefDecisionState, BriefItem, TaskBriefRecord } from './task-brief';
import { LOW_CONFIDENCE_SCORE, isConfidenceOutdated, type TaskConfidence } from './task-confidence';

export type ReviewItemKind = 'risk' | 'decision' | 'extra';

export interface ReviewItem {
  /** Stable while the wording stays, so a dismissal survives a re-render. */
  id: string;
  kind: ReviewItemKind;
  text: string;
  /** Where the item came from, so the reader can weigh it. */
  source: string;
  file?: string;
  /** The line the rework prompt sends for it. */
  ask: string;
}

export interface ReviewRisk extends ReviewItem {
  /** A claim the diff does not back: the one kind of risk that is marked. */
  urgent: boolean;
  dismissed: boolean;
}

export interface ReviewDecision extends ReviewItem {
  /** What the user already did with it, in the brief. */
  state?: BriefDecisionState;
}

/** A risk the user decided needs no work, with the reason they gave. */
export interface ReviewDismissal {
  text: string;
  reason: string;
}

export interface ReviewScore {
  label: string;
  score: number;
  why: string;
}

export interface ReviewScores {
  /** Below the bar: shown with their reason. */
  low: ReviewScore[];
  fine: ReviewScore[];
  source?: string;
  /** The code changed after the rating. */
  stale: boolean;
}

export interface ReviewTestGroup {
  kind: EvidenceTestKind;
  added: EvidenceTestChange[];
  changed: EvidenceTestChange[];
  removed: EvidenceTestChange[];
}

export interface ReviewTests {
  groups: ReviewTestGroup[];
  /** The scan saw an older commit than the one being finished. */
  outdated: boolean;
}

export interface ReviewSummary {
  goal?: string;
  changes: BriefItem[];
  /** Every risk, dismissed ones included, in a stable order. */
  risks: ReviewRisk[];
  openRisks: number;
  /** Every decision, handled ones included. */
  decisions: ReviewDecision[];
  extras: ReviewItem[];
  scores?: ReviewScores;
  tests?: ReviewTests;
}

export interface ReviewSummaryInput {
  brief?: TaskBriefRecord;
  confidence?: TaskConfidence;
  evidence?: EvidencePackage;
  dismissed?: Record<string, ReviewDismissal>;
  /** Newest diff fingerprint read, which ratings are compared against. */
  codeFingerprint?: { fingerprint: string; at: number };
  /** HEAD of the worktree being finished, to tell an outdated scan. */
  headSha?: string | null;
}

const TEST_KIND_ORDER: EvidenceTestKind[] = ['unit', 'e2e'];

export function reviewItemId(kind: ReviewItemKind, text: string): string {
  return `${kind}:${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/** Whether a brief or rating item was set aside in the review. */
export function isRiskDismissed(
  dismissed: Record<string, ReviewDismissal> | undefined,
  text: string,
): boolean {
  return !!dismissed && Object.hasOwn(dismissed, reviewItemId('risk', text));
}

function item(
  kind: ReviewItemKind,
  text: string,
  source: string,
  ask: string,
  file?: string,
): ReviewItem {
  return { id: reviewItemId(kind, text), kind, text, source, ask, ...(file && { file }) };
}

function dedupe<T extends ReviewItem>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

function scoresOf(input: ReviewSummaryInput, confidence: TaskConfidence): ReviewScores {
  const scores = confidence.scores.map(({ label, score, why }) => ({ label, score, why }));
  return {
    low: scores.filter((entry) => entry.score < LOW_CONFIDENCE_SCORE),
    fine: scores.filter((entry) => entry.score >= LOW_CONFIDENCE_SCORE),
    ...(confidence.source && { source: confidence.source }),
    stale: isConfidenceOutdated(confidence, input.codeFingerprint, input.brief),
  };
}

function testsOf(
  evidence: EvidencePackage,
  headSha: string | null | undefined,
): ReviewTests | undefined {
  const { tests } = evidence.scan;
  if (tests.length === 0) return undefined;
  const groups = TEST_KIND_ORDER.map((kind) => {
    const ofKind = tests.filter((test) => test.kind === kind);
    return {
      kind,
      added: ofKind.filter((test) => test.change === 'added'),
      changed: ofKind.filter((test) => test.change === 'changed'),
      removed: ofKind.filter((test) => test.change === 'removed'),
    };
  }).filter((group) => group.added.length + group.changed.length + group.removed.length > 0);
  return { groups, outdated: !!headSha && evidence.scan.headSha !== headSha };
}

export function buildReviewSummary(input: ReviewSummaryInput): ReviewSummary {
  const brief = input.brief?.brief;
  const findings = input.confidence?.findings ?? [];
  const dismissed = input.dismissed;
  const risk = (entry: ReviewItem, urgent: boolean): ReviewRisk => ({
    ...entry,
    urgent,
    dismissed: !!dismissed && Object.hasOwn(dismissed, entry.id),
  });
  const risks = dedupe([
    ...(brief?.unbacked ?? []).map((entry) =>
      risk(
        item(
          'risk',
          entry.text,
          'The agent says so, but the diff doesn’t show it',
          `Back up or correct this claim: ${entry.text}`,
          entry.file,
        ),
        true,
      ),
    ),
    ...findings
      .filter((finding) => finding.kind === 'risk' || finding.kind === 'gap')
      .map((finding) =>
        risk(
          item(
            'risk',
            finding.text,
            finding.kind === 'gap'
              ? 'Gap found by the confidence check'
              : 'From the confidence check',
            finding.kind === 'gap'
              ? `Fill this gap: ${finding.text}`
              : `Address this risk: ${finding.text}`,
            finding.file,
          ),
          false,
        ),
      ),
    ...(brief?.open ?? []).map((entry) =>
      risk(
        item(
          'risk',
          entry.text,
          'Still open, from the brief',
          `Finish this: ${entry.text}`,
          entry.file,
        ),
        false,
      ),
    ),
  ]);
  const decisionStates = input.brief?.decisions ?? {};
  return {
    ...(brief?.goal && { goal: brief.goal }),
    changes: brief?.changed ?? [],
    risks,
    openRisks: risks.filter((entry) => !entry.dismissed).length,
    decisions: dedupe(
      (brief?.decided ?? []).map((entry) => {
        const state = decisionStates[entry.text];
        return {
          ...item(
            'decision',
            entry.text,
            'Decided by the agent without asking',
            `Reconsider this decision: ${entry.text}`,
            entry.file,
          ),
          ...(state && { state }),
        };
      }),
    ),
    extras: dedupe([
      ...(brief?.extra ?? []).map((entry) =>
        item(
          'extra',
          entry.text,
          'Not asked for',
          `Revert this, I didn’t ask for it: ${entry.text}`,
          entry.file,
        ),
      ),
      ...findings
        .filter((finding) => finding.kind === 'extra')
        .map((finding) =>
          item(
            'extra',
            finding.text,
            'Not asked for, says the confidence check',
            `Revert this, I didn’t ask for it: ${finding.text}`,
            finding.file,
          ),
        ),
    ]),
    ...(input.confidence && { scores: scoresOf(input, input.confidence) }),
    ...(input.evidence && { tests: testsOf(input.evidence, input.headSha) }),
  };
}

export function hasReviewContent(summary: ReviewSummary): boolean {
  return (
    !!summary.goal ||
    summary.changes.length > 0 ||
    summary.risks.length > 0 ||
    summary.decisions.length + summary.extras.length > 0 ||
    !!summary.scores ||
    !!summary.tests
  );
}

/** The one line that heads the review. */
export function reviewVerdict(summary: ReviewSummary, verifyFailed: boolean): string {
  const failed = verifyFailed ? 'Verify failed' : '';
  if (!hasReviewContent(summary)) return failed || 'Not reviewed yet';
  const risks = summary.openRisks;
  const head = risks === 0 ? 'No open risks' : countLabel(risks, 'open risk');
  return failed ? `${failed} · ${head.charAt(0).toLowerCase()}${head.slice(1)}` : head;
}

/** One line per selected item. */
export function buildReworkPrompt(items: ReviewItem[]): string {
  const lines = items.map((entry) => `- ${entry.ask}${entry.file ? ` (${entry.file})` : ''}`);
  return ['Please rework this task based on my review:', lines.join('\n')].join('\n\n');
}

/**
 * Appends what the user already reviewed and set aside, so the next rating
 * does not raise the same risk again.
 */
export function withReviewNotes(prompt: string, dismissed: ReviewDismissal[]): string {
  if (dismissed.length === 0) return prompt;
  const lines = dismissed.map(({ text, reason }) => `- ${text}${reason ? ` (${reason})` : ''}`);
  return [
    prompt,
    'I already reviewed these and decided they need no work, so leave them out unless the code changed them:',
    lines.join('\n'),
  ].join('\n\n');
}

const DISMISSAL_LIMITS = { entries: 50, id: 300, text: 240, reason: 300 } as const;

export const REVIEW_REASON_MAX = DISMISSAL_LIMITS.reason;

/** Keeps the newest dismissals within the cap; insertion order is age order. */
export function capReviewDismissals(
  record: Record<string, ReviewDismissal>,
): Record<string, ReviewDismissal> {
  const entries = Object.entries(record);
  if (entries.length <= DISMISSAL_LIMITS.entries) return record;
  return Object.fromEntries(entries.slice(-DISMISSAL_LIMITS.entries));
}

/** Keeps only well-formed dismissals from a saved state, newest first to survive the cap. */
export function restoreReviewDismissed(
  value: unknown,
): Record<string, ReviewDismissal> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ReviewDismissal> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!id.startsWith('risk:') || id.length > DISMISSAL_LIMITS.id) continue;
    if (!entry || typeof entry !== 'object') continue;
    const { text, reason } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) continue;
    out[id] = {
      text: text.slice(0, DISMISSAL_LIMITS.text),
      reason: typeof reason === 'string' ? reason.slice(0, DISMISSAL_LIMITS.reason) : '',
    };
  }
  const capped = capReviewDismissals(out);
  return Object.keys(capped).length > 0 ? capped : undefined;
}
