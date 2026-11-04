import { CHECK_SUITE_LIMITS, type CheckSuite } from '../../electron/shared/checks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Bounds what a suite adds to state.json: check output keeps only its tail. */
export function persistedCheckSuite(pkg: CheckSuite | undefined): CheckSuite | undefined {
  if (!pkg) return undefined;
  const max = CHECK_SUITE_LIMITS.persistedTailChars;
  return {
    ...pkg,
    checks: pkg.checks.map((run) => ({ ...run, outputTail: run.outputTail.slice(-max) })),
  };
}

/**
 * A saved suite from an older or interrupted session. Anything still in
 * flight when the app quit has no process behind it anymore, so it is marked
 * as cancelled rather than restored as running. Malformed data is dropped:
 * the suite can always be run again. Fields of the removed agent claim and
 * model review, and the scan's old test lists, are left behind.
 */
export function restoredCheckSuite(value: unknown): CheckSuite | undefined {
  if (!isRecord(value) || !isRecord(value.scan) || typeof value.scan.headSha !== 'string')
    return undefined;
  if (!Array.isArray(value.checks) || !Array.isArray(value.skipped)) return undefined;
  const pkg = value as unknown as CheckSuite;
  const finishedAt = new Date().toISOString();
  return {
    id: pkg.id,
    assembling: false,
    scan: {
      headSha: pkg.scan.headSha,
      baseSha: pkg.scan.baseSha,
      dirty: pkg.scan.dirty,
      files: pkg.scan.files,
      flags: pkg.scan.flags,
      ...(pkg.scan.truncated && { truncated: true }),
    },
    checks: pkg.checks.map((run) =>
      run.status === 'running'
        ? { ...run, status: 'cancelled', finishedAt, message: 'Interrupted when the app quit.' }
        : run,
    ),
    skipped: pkg.skipped,
  };
}
