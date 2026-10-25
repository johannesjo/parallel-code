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
import type { BriefItem, TaskBriefRecord } from './task-brief';
import { isConfidenceStale, type TaskConfidence } from './task-confidence';

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
  /** Weakened tests (skip, only, loosened assertions) not yet accepted. */
  weakened: number;
}

export interface ReviewSummary {
  goal?: string;
  changes: BriefItem[];
  risks: ReviewItem[];
  dismissed: ReviewItem[];
  decisions: ReviewItem[];
  extras: ReviewItem[];
  scores?: ReviewScores;
  tests?: ReviewTests;
}

export interface ReviewSummaryInput {
  brief?: TaskBriefRecord;
  confidence?: TaskConfidence;
  evidence?: EvidencePackage;
  dismissed?: Record<string, ReviewDismissal>;
}

/** Scores under this read as a reason to look; the rest fold into one line. */
export const LOW_SCORE = 75;

const TEST_KIND_ORDER: EvidenceTestKind[] = ['unit', 'e2e'];

export function reviewItemId(kind: ReviewItemKind, text: string): string {
  return `${kind}:${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
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

function dedupe(items: ReviewItem[]): ReviewItem[] {
  const seen = new Set<string>();
  return items.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

function scoresOf(confidence: TaskConfidence, brief: TaskBriefRecord | undefined): ReviewScores {
  const scores = confidence.scores.map(({ label, score, why }) => ({ label, score, why }));
  return {
    low: scores.filter((entry) => entry.score < LOW_SCORE),
    fine: scores.filter((entry) => entry.score >= LOW_SCORE),
    ...(confidence.source && { source: confidence.source }),
    stale: isConfidenceStale(confidence, brief),
  };
}

function testsOf(evidence: EvidencePackage): ReviewTests | undefined {
  const { tests, flags } = evidence.scan;
  const weakened = flags.filter(
    (flag) => flag.category === 'test-weakened' && !Object.hasOwn(evidence.acceptedFlags, flag.id),
  ).length;
  if (tests.length === 0 && weakened === 0) return undefined;
  const groups = TEST_KIND_ORDER.map((kind) => {
    const ofKind = tests.filter((test) => test.kind === kind);
    return {
      kind,
      added: ofKind.filter((test) => test.change === 'added'),
      changed: ofKind.filter((test) => test.change === 'changed'),
      removed: ofKind.filter((test) => test.change === 'removed'),
    };
  }).filter((group) => group.added.length + group.changed.length + group.removed.length > 0);
  return { groups, weakened };
}

export function buildReviewSummary(input: ReviewSummaryInput): ReviewSummary {
  const brief = input.brief?.brief;
  const findings = input.confidence?.findings ?? [];
  const risks = dedupe([
    ...(brief?.unbacked ?? []).map((entry) =>
      item(
        'risk',
        entry.text,
        'The agent says so, but the diff doesn’t show it',
        `Back up or correct this claim: ${entry.text}`,
        entry.file,
      ),
    ),
    ...findings
      .filter((finding) => finding.kind === 'risk' || finding.kind === 'gap')
      .map((finding) =>
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
      ),
    ...(brief?.open ?? []).map((entry) =>
      item(
        'risk',
        entry.text,
        'Still open, from the brief',
        `Finish this: ${entry.text}`,
        entry.file,
      ),
    ),
  ]);
  const dismissedIds = input.dismissed ?? {};
  const decisionStates = input.brief?.decisions ?? {};
  return {
    ...(brief?.goal && { goal: brief.goal }),
    changes: brief?.changed ?? [],
    risks: risks.filter((risk) => !Object.hasOwn(dismissedIds, risk.id)),
    dismissed: risks.filter((risk) => Object.hasOwn(dismissedIds, risk.id)),
    // A decision the user kept or already corrected needs nothing more.
    decisions: (brief?.decided ?? [])
      .filter((entry) => !decisionStates[entry.text])
      .map((entry) =>
        item(
          'decision',
          entry.text,
          'Decided by the agent without asking',
          `Reconsider this decision: ${entry.text}`,
          entry.file,
        ),
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
    ...(input.confidence && { scores: scoresOf(input.confidence, input.brief) }),
    ...(input.evidence && { tests: testsOf(input.evidence) }),
  };
}

export function hasReviewContent(summary: ReviewSummary): boolean {
  return (
    !!summary.goal ||
    summary.changes.length > 0 ||
    summary.risks.length + summary.dismissed.length > 0 ||
    summary.decisions.length + summary.extras.length > 0 ||
    !!summary.scores ||
    !!summary.tests
  );
}

/** The one line that heads the review. */
export function reviewVerdict(summary: ReviewSummary, failingChecks: number): string {
  const failing = failingChecks > 0 ? countLabel(failingChecks, 'check') + ' failing' : '';
  if (!hasReviewContent(summary)) return failing || 'Not reviewed yet';
  const risks = summary.risks.length;
  const head = risks === 0 ? 'No open risks' : countLabel(risks, 'open risk');
  return failing ? `${head} · ${failing}` : head;
}

/** One line per selected item, then the user's own note. */
export function buildReworkPrompt(items: ReviewItem[], note: string): string {
  const lines = items.map((entry) => `- ${entry.ask}${entry.file ? ` (${entry.file})` : ''}`);
  const extra = note.trim();
  return ['Please rework this task based on my review:', lines.join('\n'), extra]
    .filter(Boolean)
    .join('\n\n');
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

const DISMISSAL_LIMITS = { entries: 50, text: 240, reason: 300 } as const;

/** Keeps only well-formed dismissals from a saved state. */
export function restoreReviewDismissed(
  value: unknown,
): Record<string, ReviewDismissal> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ReviewDismissal> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length === DISMISSAL_LIMITS.entries) break;
    if (!entry || typeof entry !== 'object') continue;
    const { text, reason } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) continue;
    out[id] = {
      text: text.slice(0, DISMISSAL_LIMITS.text),
      reason: typeof reason === 'string' ? reason.slice(0, DISMISSAL_LIMITS.reason) : '',
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const REVIEW_REASON_MAX = DISMISSAL_LIMITS.reason;
