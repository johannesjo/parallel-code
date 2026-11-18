import {
  parseConfidencePayload,
  type ConfidencePayload,
} from '../../electron/shared/task-confidence';

/**
 * A rating plus when it arrived and which code it rated. The Confidence card
 * holds it as card values; `cardConfidence` reads it back in this shape.
 */
export interface TaskConfidence extends ConfidencePayload {
  publishedAt: number;
  /** Fingerprint of the diff at publish time; unset until it has been read. */
  fingerprint?: string;
  /** `review`: the app's own reviewer wrote it, not the task's agent rating itself. */
  origin?: 'review';
  /** The commit a review read, set only when the worktree had no uncommitted changes. */
  headSha?: string;
  /** Scores below this need attention; the card's own bar, else LOW_CONFIDENCE_SCORE. */
  warnBelow?: number;
}

/**
 * Restores a rating saved as `task.confidence`, before the Confidence card
 * held it; a malformed one is dropped rather than shown.
 */
export function restoreTaskConfidence(value: unknown): TaskConfidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  try {
    const payload = parseConfidencePayload(record);
    const publishedAt = record.publishedAt;
    if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) return undefined;
    const fingerprint =
      typeof record.fingerprint === 'string' ? record.fingerprint.slice(0, 64) : undefined;
    return {
      ...payload,
      publishedAt,
      ...(fingerprint && { fingerprint }),
      ...(record.origin === 'review' && { origin: 'review' as const }),
      ...(typeof record.headSha === 'string' && { headSha: record.headSha.slice(0, 64) }),
    };
  } catch {
    return undefined;
  }
}

/** Scores below this are the ones worth reading; the rest need no attention. */
export const LOW_CONFIDENCE_SCORE = 60;

/**
 * The bar a rating's scores must reach for Finish and the merge check. The
 * Confidence card's own bar can raise it, never lower it.
 */
export function confidenceBar(rating: Pick<TaskConfidence, 'warnBelow'>): number {
  return Math.max(LOW_CONFIDENCE_SCORE, rating.warnBelow ?? LOW_CONFIDENCE_SCORE);
}

/**
 * The order the Confidence card shows scores in: correctness first, so the
 * score that matters most is always in the same place; then the lowest, which
 * stands for the whole; then the rest as published.
 */
export function inConfidenceOrder<T extends { label: string; score: number }>(scores: T[]): T[] {
  const lowest = scores.reduce<T | undefined>(
    (low, entry) => (!low || entry.score < low.score ? entry : low),
    undefined,
  );
  const rank = (entry: T) => (/^correct/i.test(entry.label) ? 0 : entry === lowest ? 1 : 2);
  return [...scores].sort((a, b) => rank(a) - rank(b));
}

/**
 * Whether the code moved on since the rating: the newest diff fingerprint was
 * read after it and differs. Without both fingerprints there is nothing to
 * compare, so it counts as current.
 */
export function isConfidenceOutdated(
  confidence: Pick<TaskConfidence, 'publishedAt' | 'fingerprint'>,
  codeFingerprint: { fingerprint: string; at: number } | undefined,
): boolean {
  if (!codeFingerprint || !confidence.fingerprint) return false;
  return (
    codeFingerprint.at > confidence.publishedAt &&
    codeFingerprint.fingerprint !== confidence.fingerprint
  );
}
