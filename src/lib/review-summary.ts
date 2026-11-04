/**
 * The review a task gets before it is finished: what is still a risk, what the
 * agent added without being asked and how confident an independent check is.
 * Built from data the app already keeps (the confidence rating and, where one
 * exists, the brief), so nothing here reads code or calls a model. Pure helpers only.
 */

import type {
  ConfidenceChange,
  ConfidenceFindingKind,
  ConfidenceKeyLine,
} from '../../electron/shared/task-confidence';
import { countLabel } from './plural';
import type { TaskBriefRecord } from './task-brief';
import { LOW_CONFIDENCE_SCORE, isConfidenceOutdated, type TaskConfidence } from './task-confidence';

export type ReviewItemKind = 'risk' | 'extra';

export interface ReviewItem {
  /** Stable while the wording stays, so a dismissal survives a re-render. */
  id: string;
  kind: ReviewItemKind;
  text: string;
  /** Where the item came from, so the reader can weigh it. */
  source: string;
  file?: string;
  /** The score it lowers, when the rating says. */
  axis?: string;
  /** The line the rework prompt sends for it. */
  ask: string;
  /** The rater suspects it but did not confirm it by reading the code. */
  unconfirmed?: boolean;
}

export interface ReviewRisk extends ReviewItem {
  dismissed: boolean;
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
  /** What the rater checked directly, so the reader can tell a grounded score from a guess. */
  verified?: string[];
}

export interface ReviewScores {
  all: ReviewScore[];
  /** The lowest score; like a chain, the review is only as sure as this. */
  weakest?: ReviewScore;
  /** Whether the lowest score is below the bar and should draw the eye. */
  low: boolean;
  source?: string;
  /** The code changed after the rating. */
  stale: boolean;
}

export interface ReviewSummary {
  goal?: string;
  /** What someone using the software will notice. */
  changes: ConfidenceChange[];
  keyLine?: ConfidenceKeyLine;
  /** Every risk, dismissed ones included, in a stable order. */
  risks: ReviewRisk[];
  openRisks: number;
  extras: ReviewItem[];
  scores?: ReviewScores;
}

export interface ReviewSummaryInput {
  brief?: TaskBriefRecord;
  confidence?: TaskConfidence;
  dismissed?: Record<string, ReviewDismissal>;
  /** Newest diff fingerprint read, which ratings are compared against. */
  codeFingerprint?: { fingerprint: string; at: number };
}

export function reviewItemId(kind: ReviewItemKind, text: string): string {
  return `${kind}:${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function item(
  kind: ReviewItemKind,
  text: string,
  source: string,
  ask: string,
  where: { file?: string; axis?: string } = {},
): ReviewItem {
  const { file, axis } = where;
  return {
    id: reviewItemId(kind, text),
    kind,
    text,
    source,
    ask,
    ...(file && { file }),
    ...(axis && { axis }),
  };
}

function dedupe<T extends ReviewItem>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id));
}

function scoresOf(input: ReviewSummaryInput, confidence: TaskConfidence): ReviewScores {
  const all = confidence.scores.map(({ label, score, why, verified }) => ({
    label,
    score,
    why,
    ...(verified && { verified }),
  }));
  const weakest = all.reduce<ReviewScore | undefined>(
    (low, entry) => (!low || entry.score < low.score ? entry : low),
    undefined,
  );
  return {
    all,
    ...(weakest && { weakest }),
    low: !!weakest && weakest.score < LOW_CONFIDENCE_SCORE,
    ...(confidence.source && { source: confidence.source }),
    stale: isConfidenceOutdated(confidence, input.codeFingerprint, input.brief),
  };
}

/**
 * Findings listed as risks. A doubt the rater did not confirm goes to the agent
 * as something to check first, so a wrong guess is not "fixed" into the code.
 */
const RISK_WORDING: Partial<Record<ConfidenceFindingKind, { source: string; ask: string }>> = {
  gap: { source: 'Gap found by the confidence check', ask: 'Fill this gap: ' },
  risk: { source: 'From the confidence check', ask: 'Address this risk: ' },
  unverified: {
    source: 'Not confirmed by the confidence check',
    ask: 'Check whether this holds and fix it only if it does: ',
  },
};

export function buildReviewSummary(input: ReviewSummaryInput): ReviewSummary {
  const brief = input.brief?.brief;
  const findings = input.confidence?.findings ?? [];
  const dismissed = input.dismissed;
  const risk = (entry: ReviewItem): ReviewRisk => ({
    ...entry,
    dismissed: !!dismissed && Object.hasOwn(dismissed, entry.id),
  });
  const risks = dedupe([
    ...findings.flatMap((finding) => {
      const as = RISK_WORDING[finding.kind];
      if (!as) return [];
      const where = { file: finding.file, axis: finding.axis };
      const entry = item('risk', finding.text, as.source, `${as.ask}${finding.text}`, where);
      return [risk(finding.kind === 'unverified' ? { ...entry, unconfirmed: true } : entry)];
    }),
  ]);
  // The reviewer reads every prompt, so its reading of the ask wins over a brief's.
  const goal = input.confidence?.asked ?? brief?.goal;
  const keyLine = input.confidence?.keyLine;
  return {
    ...(goal && { goal }),
    changes: input.confidence?.changes ?? [],
    ...(keyLine && { keyLine }),
    risks,
    openRisks: risks.filter((entry) => !entry.dismissed).length,
    extras: dedupe([
      ...findings
        .filter((finding) => finding.kind === 'extra')
        .map((finding) =>
          item(
            'extra',
            finding.text,
            'Not asked for, says the confidence check',
            `Revert this, I didn’t ask for it: ${finding.text}`,
            { file: finding.file, axis: finding.axis },
          ),
        ),
    ]),
    ...(input.confidence && { scores: scoresOf(input, input.confidence) }),
  };
}

export function hasReviewContent(summary: ReviewSummary): boolean {
  return (
    !!summary.goal ||
    summary.risks.length + summary.extras.length + summary.changes.length > 0 ||
    !!summary.scores
  );
}

function verdictHead(summary: ReviewSummary): string {
  // Like the weakest link, the lowest score stands for the review.
  const weakest = summary.scores?.weakest;
  if (weakest) {
    const open = summary.openRisks > 0 ? `${summary.openRisks} open` : 'nothing open';
    return `${weakest.score}% · ${open}`;
  }
  if (summary.openRisks > 0) return countLabel(summary.openRisks, 'open risk');
  // Without a rating, no risks found is not the same as no risks.
  return summary.scores ? 'No open risks' : 'Not rated yet';
}

/** The one line that heads the review. */
export function reviewVerdict(summary: ReviewSummary): string {
  return hasReviewContent(summary) ? verdictHead(summary) : 'Not reviewed yet';
}

// A reviewer can be wrong, and fixing a finding that does not hold adds code
// nobody needed, so each item is checked before it is acted on, the way a
// gap-closing pass works through an audit.
const REWORK_RULES = [
  'The review can be wrong. For each item:',
  '- check it first by reading the code or running it once; if it does not hold, say so and change nothing for it',
  '- for missing or wrong behaviour, write a failing test first, then fix it; if the code is already there, break the code, watch the test fail, then restore it',
  '- if a fix needs more new code than the change itself, stop and tell me before writing it',
  '- remove what I did not ask for by deleting or simplifying, never by adding',
  '- if it is real but not worth fixing now, change nothing for it; say why and leave it for me to decide',
  'Change only what these items need and name any new problem rather than fixing it. Run the tests for the code you touched, then report each item as checked, fixed or left, with the file or command as evidence.',
].join('\n');

/** One line per selected item, then how to work through them. */
export function buildReworkPrompt(items: ReviewItem[]): string {
  const lines = items.map((entry) => `- ${entry.ask}${entry.file ? ` (${entry.file})` : ''}`);
  return ['Please rework this task based on my review:', lines.join('\n'), REWORK_RULES].join(
    '\n\n',
  );
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

/** Keeps only well-formed dismissals from a saved state, capped to the newest. */
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
