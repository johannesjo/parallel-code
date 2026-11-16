import {
  parseConfidencePayload,
  type ConfidencePayload,
} from '../../electron/shared/task-confidence';

/** A published rating plus when it arrived and which code it rated. */
export interface TaskConfidence extends ConfidencePayload {
  publishedAt: number;
  /** Fingerprint of the diff at publish time; unset until it has been read. */
  fingerprint?: string;
  /** `review`: the app's own reviewer wrote it, not the task's agent rating itself. */
  origin?: 'review';
  /** The commit a review read, set only when the worktree had no uncommitted changes. */
  headSha?: string;
}

/** Restores a persisted rating; a malformed one is dropped rather than shown. */
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
