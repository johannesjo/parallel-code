/**
 * A confidence rating an agent (or a skill it runs) publishes for its own task
 * through the `confidence_publish` MCP tool. The scores are named by whoever
 * rates, so one plain "Confidence" score and several custom dimensions both fit.
 * Kept free of Node and Electron imports so both processes can use it.
 */

export type ConfidenceFindingKind = 'gap' | 'extra' | 'risk';

export interface ConfidenceScore {
  label: string;
  /** 0 to 100. */
  score: number;
  why: string;
}

export interface ConfidenceFinding {
  kind: ConfidenceFindingKind;
  text: string;
  file?: string;
}

export interface ConfidencePayload {
  scores: ConfidenceScore[];
  findings: ConfidenceFinding[];
  /** Who rated, e.g. "self-check" or a skill name. */
  source?: string;
}

export const CONFIDENCE_LIMITS = {
  minScores: 1,
  maxScores: 6,
  label: 32,
  why: 240,
  maxFindings: 10,
  findingText: 240,
  file: 300,
  source: 60,
  /** Serialized payload cap; the HTTP route caps its body at the same size. */
  payloadBytes: 32 * 1024,
} as const;

const FINDING_KINDS: readonly ConfidenceFindingKind[] = ['gap', 'extra', 'risk'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return text || undefined;
}

function parseScore(value: unknown, index: number): ConfidenceScore {
  const record = asRecord(value);
  if (!record) throw new Error(`scores[${index}] must be an object.`);
  const score = record.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)
    throw new Error(`scores[${index}].score must be a number from 0 to 100.`);
  return {
    label: requiredText(record.label, `scores[${index}].label`, CONFIDENCE_LIMITS.label),
    score: Math.round(score),
    why: requiredText(record.why, `scores[${index}].why`, CONFIDENCE_LIMITS.why),
  };
}

function parseFinding(value: unknown, index: number): ConfidenceFinding {
  const record = asRecord(value);
  if (!record) throw new Error(`findings[${index}] must be an object.`);
  const kind = record.kind;
  if (typeof kind !== 'string' || !FINDING_KINDS.includes(kind as ConfidenceFindingKind))
    throw new Error(`findings[${index}].kind must be one of ${FINDING_KINDS.join(', ')}.`);
  const file = optionalText(record.file, `findings[${index}].file`, CONFIDENCE_LIMITS.file);
  return {
    kind: kind as ConfidenceFindingKind,
    text: requiredText(record.text, `findings[${index}].text`, CONFIDENCE_LIMITS.findingText),
    ...(file && { file }),
  };
}

/** Validates a published rating; throws a message the agent can act on. */
export function parseConfidencePayload(value: unknown): ConfidencePayload {
  const record = asRecord(value);
  if (!record) throw new Error('The rating must be an object.');
  const { minScores, maxScores, maxFindings } = CONFIDENCE_LIMITS;
  const scores = record.scores;
  if (!Array.isArray(scores) || scores.length < minScores || scores.length > maxScores)
    throw new Error(`scores must be an array of ${minScores} to ${maxScores} scores.`);
  const findings = record.findings ?? [];
  if (!Array.isArray(findings) || findings.length > maxFindings)
    throw new Error(`findings must be an array of at most ${maxFindings} findings.`);
  const source = optionalText(record.source, 'source', CONFIDENCE_LIMITS.source);
  return {
    scores: scores.map(parseScore),
    findings: findings.map(parseFinding),
    ...(source && { source }),
  };
}
