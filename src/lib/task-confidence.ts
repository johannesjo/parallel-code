import {
  parseConfidencePayload,
  type ConfidencePayload,
} from '../../electron/shared/task-confidence';
import type { TaskBriefRecord } from './task-brief';

/** A published rating plus when it arrived and which code it rated. */
export interface TaskConfidence extends ConfidencePayload {
  publishedAt: number;
  /** Fingerprint of the diff at publish time; unset until it has been read. */
  fingerprint?: string;
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
    return { ...payload, publishedAt, ...(fingerprint && { fingerprint }) };
  } catch {
    return undefined;
  }
}

/**
 * A rating is out of date once a brief written after it saw different code.
 * Without both fingerprints there is nothing to compare, so it counts as current.
 */
export function isConfidenceStale(
  confidence: Pick<TaskConfidence, 'publishedAt' | 'fingerprint'>,
  brief: Pick<TaskBriefRecord, 'generatedAt' | 'fingerprint'> | undefined,
): boolean {
  if (!brief?.fingerprint || !confidence.fingerprint) return false;
  return brief.generatedAt > confidence.publishedAt && brief.fingerprint !== confidence.fingerprint;
}

export const DEFAULT_CONFIDENCE_PROMPT =
  'Rate your confidence in the current changes on this task without changing any code. ' +
  'Then publish the rating with the confidence_publish tool of the parallel-code MCP server: ' +
  'one or more named scores from 0 to 100, each with a one-line reason, plus findings for gaps, ' +
  'out-of-scope changes and risks. If that tool is not available, say so and give the rating here instead.';
