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

// An agent rating its own work from memory scores high, so the default asks for
// an audit by a fresh sub-agent where the agent supports one, and for scores
// grounded in the diff and test runs either way.
export const DEFAULT_CONFIDENCE_PROMPT =
  'Rate the current changes on this task without changing any code. ' +
  'Judge the diff against what I asked for, not against your own account of the work. ' +
  'The diff is everything on this branch since it left the base branch, committed or not. ' +
  'If you can start a sub-agent, have one that cannot see this conversation do the audit: ' +
  'quote it every request I made verbatim, later corrections included, and have it read the diff and run the tests covering the changed files. ' +
  'Otherwise re-read my requests, read the full diff and run those tests yourself. Do not update snapshots. ' +
  'Score Correct, Complete and Minimal from 0 to 100, each with a one-line reason naming what keeps it from being higher; ' +
  'count only what was verified. Add findings for gaps, changes I did not ask for, and risks. ' +
  'Publish the rating with the confidence_publish tool of the parallel-code MCP server, ' +
  'with source "sub-agent audit" or "self-check" for whichever ran. ' +
  'If that tool is not available, say so and give the rating here instead.';
