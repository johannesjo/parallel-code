/** Agent claims and their server-captured association, shared without Node imports. */
export interface SubtaskVerificationCheck {
  name: string;
  command: string;
  result: 'passed' | 'blocked' | 'failed';
  reason?: string;
}

export interface SubtaskVerification {
  checks: SubtaskVerificationCheck[];
}

export interface CompletionReport {
  summary: string;
  verification?: SubtaskVerification;
  artifacts?: { path: string; label?: string }[];
  unresolvedIssues?: string[];
}

export interface CompletionRecord {
  id: string;
  completedAt: string;
  reviewRevision: number;
  /** Association only: this does not prove checks ran against this commit. */
  sourceCommit?: string;
  snapshotState: 'clean' | 'dirty' | 'unknown';
  result?: CompletionReport;
}

export interface SignalDoneInput {
  result?: CompletionReport;
}

export interface SignalDoneResult {
  ok: true;
  completion: CompletionRecord;
}

export const COMPLETION_REPORT_LIMITS = {
  bytes: 16 * 1024,
  summaryBytes: 4 * 1024,
  maxChecks: 20,
  maxArtifacts: 20,
  maxIssues: 10,
  stringBytes: 1024,
  pathBytes: 1024,
} as const;

const encoder = new TextEncoder();

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`${field} contains an unknown field.`);
}

function text(
  value: unknown,
  field: string,
  bytes: number = COMPLETION_REPORT_LIMITS.stringBytes,
): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be a non-empty string.`);
  if (encoder.encode(value).length > bytes) throw new Error(`${field} exceeds ${bytes} bytes.`);
  return value;
}

function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${field} must be an array of at most ${max} items.`);
  return value;
}

function parseReport(value: unknown): CompletionReport {
  const input = record(value, 'result');
  // Bound the supplied object, including unknown fields, before copying any of it.
  if (encoder.encode(JSON.stringify(input)).length > COMPLETION_REPORT_LIMITS.bytes)
    throw new Error(`result exceeds ${COMPLETION_REPORT_LIMITS.bytes} bytes.`);
  keys(input, ['summary', 'verification', 'artifacts', 'unresolvedIssues'], 'result');
  const result: CompletionReport = {
    summary: text(input.summary, 'result.summary', COMPLETION_REPORT_LIMITS.summaryBytes),
  };
  if (input.verification !== undefined) {
    const verification = record(input.verification, 'result.verification');
    keys(verification, ['checks'], 'result.verification');
    result.verification = {
      checks: list(
        verification.checks,
        'result.verification.checks',
        COMPLETION_REPORT_LIMITS.maxChecks,
      ).map((value) => {
        const check = record(value, 'verification check');
        keys(check, ['name', 'command', 'result', 'reason'], 'verification check');
        if (check.result !== 'passed' && check.result !== 'blocked' && check.result !== 'failed')
          throw new Error('verification check result must be passed, blocked, or failed.');
        return {
          name: text(check.name, 'verification check name'),
          command: text(check.command, 'verification check command'),
          result: check.result as SubtaskVerificationCheck['result'],
          ...(check.reason !== undefined && {
            reason: text(check.reason, 'verification check reason'),
          }),
        };
      }),
    };
  }
  if (input.artifacts !== undefined) {
    result.artifacts = list(
      input.artifacts,
      'result.artifacts',
      COMPLETION_REPORT_LIMITS.maxArtifacts,
    ).map((value) => {
      const artifact = record(value, 'artifact');
      keys(artifact, ['path', 'label'], 'artifact');
      const path = text(artifact.path, 'artifact path', COMPLETION_REPORT_LIMITS.pathBytes);
      if (
        // eslint-disable-next-line no-control-regex -- artifact paths must be inert printable relative paths.
        /[\\:\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('artifact path must be a repository-relative path without traversal.');
      return {
        path,
        ...(artifact.label !== undefined && { label: text(artifact.label, 'artifact label') }),
      };
    });
  }
  if (input.unresolvedIssues !== undefined) {
    result.unresolvedIssues = list(
      input.unresolvedIssues,
      'result.unresolvedIssues',
      COMPLETION_REPORT_LIMITS.maxIssues,
    ).map((value) => text(value, 'unresolved issue'));
  }
  return result;
}

/** Used at every completion boundary before any completion state is mutated. */
export function parseSignalDoneInput(value: unknown): SignalDoneInput {
  const input = record(value === undefined ? {} : value, 'signal_done arguments');
  keys(input, ['result'], 'signal_done arguments');
  return input.result === undefined ? {} : { result: parseReport(input.result) };
}

/** Old or malformed saved metadata must not prevent the task itself from restoring. */
export function parseCompletionRecord(value: unknown): CompletionRecord | undefined {
  try {
    const input = record(value, 'completion');
    if (
      typeof input.id !== 'string' ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input.id) ||
      typeof input.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.completedAt)) ||
      new Date(input.completedAt).toISOString() !== input.completedAt ||
      !Number.isSafeInteger(input.reviewRevision) ||
      (input.reviewRevision as number) < 1 ||
      (input.snapshotState !== 'clean' &&
        input.snapshotState !== 'dirty' &&
        input.snapshotState !== 'unknown') ||
      (input.sourceCommit !== undefined &&
        (typeof input.sourceCommit !== 'string' ||
          !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(input.sourceCommit))) ||
      (input.snapshotState !== 'unknown' && input.sourceCommit === undefined)
    )
      return undefined;
    return {
      id: input.id,
      completedAt: input.completedAt,
      reviewRevision: input.reviewRevision as number,
      snapshotState: input.snapshotState as CompletionRecord['snapshotState'],
      ...(input.sourceCommit !== undefined && { sourceCommit: input.sourceCommit as string }),
      ...parseSignalDoneInput({ result: input.result }),
    };
  } catch {
    return undefined;
  }
}
