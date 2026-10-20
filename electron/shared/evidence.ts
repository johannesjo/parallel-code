/**
 * Evidence packages: what the app observed about a task's change, what the
 * agent claims about it, and what an optional model thinks. Renderer-safe: no
 * Node or Electron imports. See docs/evidence-packages.md.
 */
import type { VerificationRun } from '../ipc/shared-types.js';

export type EvidenceCheckKind = 'unit' | 'e2e' | 'static' | 'custom';

/** A command the app runs in the task worktree. Lives in app state, never in a
 *  repo file, for the same reason as `Project.verifyCommand`. */
/** A repository file read so a model can suggest a project's checks. */
export interface CheckSource {
  path: string;
  text: string;
}

export interface ProjectCheck {
  id: string;
  name: string;
  kind: EvidenceCheckKind;
  command: string;
  /** `auto` runs on every handoff the execution gate allows; `on-demand` only on click. */
  run: 'auto' | 'on-demand';
}

/** Id of the implicit check backed by `Project.verifyCommand`. */
export const VERIFY_CHECK_ID = 'verify';
export const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type EvidenceModelWhen = 'off' | 'manual' | 'handoff' | 'risky';
export type EvidenceModelProvider = 'claude' | 'codex';

export interface EvidenceModelSettings {
  when: EvidenceModelWhen;
  provider: EvidenceModelProvider;
  model?: string;
  effort?: string;
  /** Project guidance for the model, kept in app state rather than read from the repo. */
  guidance?: string;
}

export type EvidenceFlagCategory = 'test-weakened' | 'needs-decision' | 'info';

export interface EvidenceFlag {
  /** Stable across rebuilds while the flagged content is unchanged, so an
   *  accepted flag stays accepted until that content changes again. */
  id: string;
  category: EvidenceFlagCategory;
  rule: string;
  file: string;
  line?: number;
  detail: string;
}

export type EvidenceTestKind = 'unit' | 'e2e';

export interface EvidenceTestChange {
  file: string;
  kind: EvidenceTestKind;
  title: string;
  change: 'added' | 'removed' | 'changed';
}

export type EvidenceFileRole = 'test' | 'source' | 'execution-surface' | 'other';

export interface EvidenceFileChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: number;
  removed: number;
  role: EvidenceFileRole;
}

/** Static facts about the committed change; nothing in it executes repo code. */
export interface EvidenceScan {
  headSha: string;
  baseSha: string;
  /** Uncommitted changes existed when the scan ran. */
  dirty: boolean;
  files: EvidenceFileChange[];
  flags: EvidenceFlag[];
  tests: EvidenceTestChange[];
  /** Unchanged test files that import a changed source file. */
  coveringTests: string[];
  /** Changed source files with no test change or covering test. */
  sourceWithoutTests: string[];
  /** Lists were cut to their caps. */
  truncated?: boolean;
}

export interface EvidenceCheckRun extends VerificationRun {
  checkId: string;
  name: string;
  kind: EvidenceCheckKind;
  /** Taken over from the task's manual verify run on the same commit. */
  reused?: boolean;
}

export type EvidenceSkipReason =
  | 'on-demand'
  | 'docker'
  | 'execution-surface'
  | 'dirty'
  | 'incomplete';

export interface EvidenceSkippedCheck {
  checkId: string;
  name: string;
  kind: EvidenceCheckKind;
  reason: EvidenceSkipReason;
}

export type ClaimedCheckResult = 'passed' | 'failed' | 'not-run';

/** What the agent says. Shown, compared where structured, never trusted. */
export interface EvidenceSubmission {
  summary?: string;
  notVerified?: string[];
  risks?: string[];
  checkResults?: { checkId: string; result: ClaimedCheckResult }[];
}

export interface EvidenceClaim extends EvidenceSubmission {
  submittedAt: string;
}

export interface EvidenceFinding {
  id: string;
  severity: 'blocker' | 'concern';
  file: string;
  line: number;
  text: string;
}

export interface EvidenceReview {
  status: 'running' | 'done' | 'error';
  provider: EvidenceModelProvider;
  model?: string;
  effort?: string;
  headSha: string;
  testSummary?: string;
  findings: EvidenceFinding[];
  error?: string;
  finishedAt?: string;
}

export interface EvidencePackage {
  id: string;
  createdAt: string;
  /** `auto` is the background build after an agent turn; it never calls the model. */
  trigger: 'agent' | 'manual' | 'auto';
  /** True while the scan or checks are in flight. */
  assembling: boolean;
  scan: EvidenceScan;
  /** Snapshot of the project checks when this package was assembled. */
  configuredChecks?: ProjectCheck[];
  checks: EvidenceCheckRun[];
  skipped: EvidenceSkippedCheck[];
  claim?: EvidenceClaim;
  review?: EvidenceReview;
  /** Flag id → the reviewer's reason for accepting it. */
  acceptedFlags: Record<string, string>;
  dismissedFindings: string[];
  /** Delivered repair requests for this package; fresh evidence starts a new list. */
  sentToAgent?: string[];
}

/** A high-effort review of a whole change can take a while. */
export const EVIDENCE_MODEL_TIMEOUT_MS = 10 * 60_000;
/** Character budget for the evidence prompt: diff, test changes, flags, check tails. */
export const EVIDENCE_MODEL_PROMPT_LIMIT = 300_000;

export const EVIDENCE_LIMITS = {
  submissionBytes: 16 * 1024,
  summaryBytes: 4 * 1024,
  stringBytes: 1024,
  maxItems: 10,
  maxCheckResults: 20,
  /** Per check output kept on a persisted package. */
  persistedTailChars: 8 * 1024,
  maxFindings: 5,
  maxFlags: 50,
  maxTests: 200,
  maxFiles: 300,
  maxCovering: 30,
} as const;

const encoder = new TextEncoder();

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, bytes: number = EVIDENCE_LIMITS.stringBytes): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be a non-empty string.`);
  if (encoder.encode(value).length > bytes) throw new Error(`${field} exceeds ${bytes} bytes.`);
  return value;
}

function texts(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > EVIDENCE_LIMITS.maxItems)
    throw new Error(`${field} must be an array of at most ${EVIDENCE_LIMITS.maxItems} items.`);
  return value.map((item) => text(item, `${field} item`));
}

function checkResults(value: unknown): NonNullable<EvidenceSubmission['checkResults']> {
  if (!Array.isArray(value) || value.length > EVIDENCE_LIMITS.maxCheckResults)
    throw new Error(
      `checkResults must be an array of at most ${EVIDENCE_LIMITS.maxCheckResults} items.`,
    );
  return value.map((item) => {
    const entry = record(item, 'checkResults item');
    if (Object.keys(entry).some((key) => key !== 'checkId' && key !== 'result'))
      throw new Error('checkResults item contains an unknown field.');
    if (typeof entry.checkId !== 'string' || !CHECK_ID_PATTERN.test(entry.checkId))
      throw new Error('checkResults checkId must be one of the ids get_evidence lists.');
    if (entry.result !== 'passed' && entry.result !== 'failed' && entry.result !== 'not-run')
      throw new Error('checkResults result must be passed, failed, or not-run.');
    return { checkId: entry.checkId, result: entry.result };
  });
}

const SUBMISSION_KEYS = ['summary', 'notVerified', 'risks', 'checkResults'];

/**
 * Validates `submit_evidence` arguments at every boundary. Unknown fields are
 * rejected, which is what keeps an agent from supplying app-owned facts such
 * as check results, flags or confidence.
 */
export function parseEvidenceSubmission(value: unknown): EvidenceSubmission {
  const input = record(value === undefined ? {} : value, 'submit_evidence arguments');
  if (encoder.encode(JSON.stringify(input)).length > EVIDENCE_LIMITS.submissionBytes)
    throw new Error(`submit_evidence arguments exceed ${EVIDENCE_LIMITS.submissionBytes} bytes.`);
  const unknown = Object.keys(input).filter((key) => !SUBMISSION_KEYS.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `submit_evidence does not accept ${unknown.join(', ')}; the app observes checks, flags and confidence itself.`,
    );
  return {
    ...(input.summary !== undefined && {
      summary: text(input.summary, 'summary', EVIDENCE_LIMITS.summaryBytes),
    }),
    ...(input.notVerified !== undefined && {
      notVerified: texts(input.notVerified, 'notVerified'),
    }),
    ...(input.risks !== undefined && { risks: texts(input.risks, 'risks') }),
    ...(input.checkResults !== undefined && { checkResults: checkResults(input.checkResults) }),
  };
}
