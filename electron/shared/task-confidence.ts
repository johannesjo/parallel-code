/**
 * A confidence rating an agent (or a skill it runs) publishes for its own task
 * through the `confidence_publish` MCP tool. The scores are named by whoever
 * rates, so one plain "Confidence" score and several custom dimensions both fit.
 * Kept free of Node and Electron imports so both processes can use it.
 */

/** `unverified`: a doubt the rater did not confirm by reading the code, kept apart from confirmed gaps and risks. */
export type ConfidenceFindingKind = 'gap' | 'extra' | 'risk' | 'unverified';

export interface ConfidenceScore {
  label: string;
  /** 0 to 100. */
  score: number;
  why: string;
  /** What the rater checked directly that backs the score, e.g. "read both callers". */
  verified?: string[];
}

export interface ConfidenceFinding {
  kind: ConfidenceFindingKind;
  text: string;
  file?: string;
  /** The label of the score it lowers, e.g. "Complete". */
  axis?: string;
}

/** One change a user of the software would notice. */
export interface ConfidenceChange {
  /** What happens now, e.g. "After sign-in you land where you were going". */
  now: string;
  /** What happened before, e.g. "instead of always on /dashboard". */
  before?: string;
  /** The kinds of tests in the diff that cover it, e.g. "unit, integration". */
  tested?: string;
}

/** The line the change depends on most, which a reviewer should read first. */
export interface ConfidenceKeyLine {
  file: string;
  /** Line number in the changed file. */
  line?: number;
  why: string;
}

export interface ConfidencePayload {
  scores: ConfidenceScore[];
  findings: ConfidenceFinding[];
  /** Who rated, e.g. "self-check" or a skill name. */
  source?: string;
  /** What the user asked for, in one sentence. */
  asked?: string;
  changes?: ConfidenceChange[];
  keyLine?: ConfidenceKeyLine;
}

export const CONFIDENCE_LIMITS = {
  minScores: 1,
  maxScores: 6,
  label: 32,
  why: 240,
  maxVerified: 3,
  verified: 120,
  maxFindings: 10,
  findingText: 240,
  file: 300,
  source: 60,
  asked: 240,
  maxChanges: 6,
  changeText: 200,
  tested: 60,
  /** Serialized payload cap; the HTTP route caps its body at the same size. */
  payloadBytes: 32 * 1024,
} as const;

const FINDING_KINDS: readonly ConfidenceFindingKind[] = ['gap', 'extra', 'risk', 'unverified'];

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

function parseVerified(value: unknown, index: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const { maxVerified, verified: max } = CONFIDENCE_LIMITS;
  if (!Array.isArray(value) || value.length > maxVerified)
    throw new Error(`scores[${index}].verified must be an array of at most ${maxVerified} items.`);
  const items = value
    .map((entry, at) => optionalText(entry, `scores[${index}].verified[${at}]`, max))
    .filter((entry): entry is string => !!entry);
  return items.length > 0 ? items : undefined;
}

function parseScore(value: unknown, index: number): ConfidenceScore {
  const record = asRecord(value);
  if (!record) throw new Error(`scores[${index}] must be an object.`);
  const score = record.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)
    throw new Error(`scores[${index}].score must be a number from 0 to 100.`);
  const verified = parseVerified(record.verified, index);
  return {
    label: requiredText(record.label, `scores[${index}].label`, CONFIDENCE_LIMITS.label),
    score: Math.round(score),
    why: requiredText(record.why, `scores[${index}].why`, CONFIDENCE_LIMITS.why),
    ...(verified && { verified }),
  };
}

function parseFinding(value: unknown, index: number): ConfidenceFinding {
  const record = asRecord(value);
  if (!record) throw new Error(`findings[${index}] must be an object.`);
  const kind = record.kind;
  if (typeof kind !== 'string' || !FINDING_KINDS.includes(kind as ConfidenceFindingKind))
    throw new Error(`findings[${index}].kind must be one of ${FINDING_KINDS.join(', ')}.`);
  const file = optionalText(record.file, `findings[${index}].file`, CONFIDENCE_LIMITS.file);
  const axis = optionalText(record.axis, `findings[${index}].axis`, CONFIDENCE_LIMITS.label);
  return {
    kind: kind as ConfidenceFindingKind,
    text: requiredText(record.text, `findings[${index}].text`, CONFIDENCE_LIMITS.findingText),
    ...(file && { file }),
    ...(axis && { axis }),
  };
}

function parseChange(value: unknown, index: number): ConfidenceChange {
  const record = asRecord(value);
  if (!record) throw new Error(`changes[${index}] must be an object.`);
  const { changeText, tested: testedMax } = CONFIDENCE_LIMITS;
  const before = optionalText(record.before, `changes[${index}].before`, changeText);
  const tested = optionalText(record.tested, `changes[${index}].tested`, testedMax);
  return {
    now: requiredText(record.now, `changes[${index}].now`, changeText),
    ...(before && { before }),
    ...(tested && { tested }),
  };
}

function parseChanges(value: unknown): ConfidenceChange[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > CONFIDENCE_LIMITS.maxChanges)
    throw new Error(`changes must be an array of at most ${CONFIDENCE_LIMITS.maxChanges} changes.`);
  return value.length > 0 ? value.map(parseChange) : undefined;
}

function parseKeyLine(value: unknown): ConfidenceKeyLine | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (!record) throw new Error('keyLine must be an object.');
  const line = record.line;
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1))
    throw new Error('keyLine.line must be a positive whole number.');
  return {
    file: requiredText(record.file, 'keyLine.file', CONFIDENCE_LIMITS.file),
    ...(line !== undefined && { line }),
    why: requiredText(record.why, 'keyLine.why', CONFIDENCE_LIMITS.why),
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
  const asked = optionalText(record.asked, 'asked', CONFIDENCE_LIMITS.asked);
  const changes = parseChanges(record.changes);
  const keyLine = parseKeyLine(record.keyLine);
  return {
    scores: scores.map(parseScore),
    findings: findings.map(parseFinding),
    ...(source && { source }),
    ...(asked && { asked }),
    ...(changes && { changes }),
    ...(keyLine && { keyLine }),
  };
}
